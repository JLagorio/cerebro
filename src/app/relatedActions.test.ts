import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { __resetOpenPages, registerHold } from '@/editor/openPages';
import { BULK_CHANGED, BULK_FAILED, BULK_UNREADABLE } from '@/engine/bulkPlan';
import { getSchema, useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { addExistingToHost, writeReciprocal } from './relatedActions';

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const entryAt = (path: string) =>
  useVaultStore.getState().entries.find((entry) => entry.path === path)!;
const host = () => entryAt('records/projects/guided-onboarding-ga.md');
const selection = () => [
  entryAt('projects/field-app-launch-campaign/items/lnc-1.md'),
  entryAt('projects/field-app-launch-campaign/items/lnc-2.md'),
];
const schema = () => getSchema(useVaultStore.getState().entries);

beforeEach(async () => {
  vi.restoreAllMocks();
  resetMockFs();
  __resetOpenPages();
  await useVaultStore.getState().openVault('/demo-vault');
  useUiStore.setState({ toasts: [] });
  useUndoStore.getState().clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetOpenPages();
});

describe('Add existing', () => {
  it('moves limit-1 owners in one labelled batch with exact-byte Undo', async () => {
    const before = new Map(fs());
    const apply = vi.spyOn(ipc, 'applyBatch');
    const rows = selection();
    expect(await addExistingToHost({ host: host(), field: 'project' }, rows, schema())).toEqual({
      failed: new Map(),
      moved: 2,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1]).toEqual(
      rows.map((entry) => ({
        op: 'patch',
        path: entry.path,
        set: { project: ['[[guided-onboarding-ga]]'] },
        expectHash: entry.hash,
      })),
    );
    expect(useUiStore.getState().toasts.map((toast) => toast.message)).toContain(
      'Added 2 records to “Guided onboarding GA”',
    );
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(new Map(fs())).toEqual(before);
  });

  it('keeps changed and unreadable rows with their reasons and batches the rest', async () => {
    const rows = [...selection(), entryAt('projects/field-app-launch-campaign/items/lnc-3.md')];
    const changed = fs().get(rows[0].path)! + '\nNewer edit\n';
    fs().set(rows[0].path, changed);
    const original = ipc.readNoteSource;
    vi.spyOn(ipc, 'readNoteSource').mockImplementation((vault, path) =>
      path === rows[1].path ? Promise.reject(new Error('unreadable')) : original(vault, path),
    );
    const apply = vi.spyOn(ipc, 'applyBatch');
    expect(await addExistingToHost({ host: host(), field: 'project' }, rows, schema())).toEqual({
      failed: new Map([
        [rows[0].path, BULK_CHANGED],
        [rows[1].path, BULK_UNREADABLE],
      ]),
      moved: 1,
    });
    expect(apply.mock.calls[0][1]).toHaveLength(1);
    expect(fs().get(rows[0].path)).toBe(changed);
    expect(entryAt(rows[1].path).relationships.project).toEqual(['field-app-launch-campaign']);
  });

  it('a refused batch fails all ready rows, reports no moved rows and never throws', async () => {
    const rows = selection();
    const before = new Map(fs());
    vi.spyOn(ipc, 'applyBatch').mockRejectedValueOnce(new Error('refused'));
    expect(await addExistingToHost({ host: host(), field: 'project' }, rows, schema())).toEqual({
      failed: new Map(rows.map((entry) => [entry.path, BULK_FAILED])),
      moved: 0,
    });
    expect(new Map(fs())).toEqual(before);
  });

  it('skips rows already filed and refuses held rows without a write', async () => {
    const rows = selection();
    registerHold(() => rows[0].path);
    const apply = vi.spyOn(ipc, 'applyBatch');
    const already = entryAt('projects/guided-onboarding-ga/items/fld-1.md');
    expect(
      await addExistingToHost({ host: host(), field: 'project' }, [rows[0], already], schema()),
    ).toEqual({ failed: new Map([[rows[0].path, 'has changes waiting on you']]), moved: 0 });
    expect(apply).not.toHaveBeenCalled();
  });

  it('a vault switch during reads writes nowhere', async () => {
    const rows = selection();
    const apply = vi.spyOn(ipc, 'applyBatch');
    vi.spyOn(ipc, 'readNoteSource').mockImplementationOnce(async () => {
      useVaultStore.setState({ vaultPath: '/other' });
      throw new Error('switched');
    });
    expect(
      (await addExistingToHost({ host: host(), field: 'project' }, rows, schema())).failed.size,
    ).toBe(2);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('reciprocal editing', () => {
  it('adds and removes owner links in one unlabelled batch, replacing limit-1 links', async () => {
    const state = useVaultStore.getState();
    const apply = vi.spyOn(ipc, 'applyBatch');
    expect(
      await writeReciprocal(
        host(),
        { type: 'Work item', field: 'project' },
        ['lnc-1', 'lnc-2'],
        state.entries,
        schema(),
      ),
    ).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1]).toHaveLength(14);
    expect(
      apply.mock.calls[0][1].every((op) => op.op === 'patch' && typeof op.expectHash === 'string'),
    ).toBe(true);
    expect(selection().map((entry) => entry.relationships.project)).toEqual([
      ['guided-onboarding-ga'],
      ['guided-onboarding-ga'],
    ]);
    expect(
      entryAt('projects/guided-onboarding-ga/items/fld-1.md').relationships.project,
    ).toBeUndefined();
    expect(useUndoStore.getState().past).toHaveLength(0);
  });

  it('refuses the whole reciprocal edit when any owner has changed', async () => {
    const state = useVaultStore.getState();
    const rows = selection();
    fs().set(rows[0].path, fs().get(rows[0].path)! + '\nNewer edit\n');
    const before = new Map(fs());
    const apply = vi.spyOn(ipc, 'applyBatch');
    expect(
      await writeReciprocal(
        host(),
        { type: 'Work item', field: 'project' },
        ['lnc-1', 'lnc-2'],
        state.entries,
        schema(),
      ),
    ).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(new Map(fs())).toEqual(before);
  });

  it('never throws when the writer rejects', async () => {
    const state = useVaultStore.getState();
    vi.spyOn(ipc, 'applyBatch').mockRejectedValueOnce(new Error('refused'));
    expect(
      await writeReciprocal(
        host(),
        { type: 'Work item', field: 'project' },
        ['lnc-1'],
        state.entries,
        schema(),
      ),
    ).toBe(false);
  });
});

it('Add existing and reciprocal filing each carry inherited agents in their owning-side patch', async () => {
  await useVaultStore.getState().patchFrontmatter(host().path, { agents: ['[[release-scout]]'] });
  const apply = vi.spyOn(ipc, 'applyBatch');
  const [first, second] = selection();
  expect(
    (await addExistingToHost({ host: host(), field: 'project' }, [first], schema())).failed.size,
  ).toBe(0);
  expect(apply.mock.calls[0][1]).toEqual([
    {
      op: 'patch',
      path: first.path,
      expectHash: first.hash,
      set: { project: ['[[guided-onboarding-ga]]'], agent: ['[[release-scout]]'] },
    },
  ]);
  const current = useVaultStore.getState().entries;
  const wanted = current
    .filter(
      (entry) =>
        entry.type === 'Work item' && entry.relationships.project?.includes('guided-onboarding-ga'),
    )
    .map((entry) => entry.filename.replace(/\.md$/, ''));
  expect(
    await writeReciprocal(
      host(),
      { type: 'Work item', field: 'project' },
      [...wanted, second.filename.replace(/\.md$/, '')],
      current,
      schema(),
    ),
  ).toBe(true);
  expect(apply.mock.calls[1][1]).toEqual([
    {
      op: 'patch',
      path: second.path,
      expectHash: second.hash,
      set: { project: ['[[guided-onboarding-ga]]'], agent: ['[[release-scout]]'] },
    },
  ]);
});
