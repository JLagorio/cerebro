import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { __resetOpenPages } from '@/editor/openPages';
import { BULK_CHANGED, BULK_FAILED } from '@/engine/bulkPlan';
import { getSchema, useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { bulkDelete, bulkDuplicate, bulkSetField } from './bulkActions';

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const rows = () =>
  useVaultStore
    .getState()
    .entries.filter((entry) => entry.type === 'Work item')
    .slice(0, 3);
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

describe('bulk actions', () => {
  it('sets only ready records in one labelled batch and preserves the changed record', async () => {
    const selected = rows();
    const before = new Map(fs());
    fs().set(selected[1].path, fs().get(selected[1].path)! + '\nNewer edit\n');
    const apply = vi.spyOn(ipc, 'applyBatch');
    const result = await bulkSetField(
      selected,
      'priority',
      'low',
      getSchema(useVaultStore.getState().entries),
    );
    expect([...result.failed]).toEqual([[selected[1].path, BULK_CHANGED]]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(
      apply.mock.calls[0][1].every(
        (op) =>
          op.op === 'patch' && op.path !== selected[1].path && typeof op.expectHash === 'string',
      ),
    ).toBe(true);
    expect(fs().get(selected[1].path)).toBe(before.get(selected[1].path)! + '\nNewer edit\n');
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(await useUndoStore.getState().undo()).toBe(true);
    before.set(selected[1].path, before.get(selected[1].path)! + '\nNewer edit\n');
    expect(new Map(fs())).toEqual(before);
  });

  it('deletes the unchanged rows together and keeps the newer one', async () => {
    const selected = rows();
    fs().set(selected[1].path, fs().get(selected[1].path)! + '\nNewer edit\n');
    const apply = vi.spyOn(ipc, 'applyBatch');
    const result = await bulkDelete(selected);
    expect([...result.failed]).toEqual([[selected[1].path, BULK_CHANGED]]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(fs().has(selected[0].path)).toBe(false);
    expect(fs().has(selected[2].path)).toBe(false);
    expect(fs().has(selected[1].path)).toBe(true);
  });

  it('a refused batch reports every ready row and throws nothing', async () => {
    const selected = rows();
    vi.spyOn(ipc, 'applyBatch').mockRejectedValueOnce(new Error('write refused'));
    const result = await bulkDelete(selected);
    expect([...result.failed]).toEqual(selected.map((entry) => [entry.path, BULK_FAILED]));
    expect(selected.every((entry) => fs().has(entry.path))).toBe(true);
  });

  it('duplicates quietly per row and emits one success count', async () => {
    const selected = rows();
    const read = vi.spyOn(ipc, 'readNote');
    read.mockRejectedValueOnce(new Error('unavailable'));
    const result = await bulkDuplicate(selected);
    expect([...result.failed]).toEqual([[selected[0].path, BULK_FAILED]]);
    expect(useUiStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Duplicated 2 records',
    ]);
  });

  it('a vault switch while reading never writes into either vault', async () => {
    const selected = rows();
    const before = new Map(fs());
    const apply = vi.spyOn(ipc, 'applyBatch');
    vi.spyOn(ipc, 'readNoteSource').mockImplementationOnce(async () => {
      useVaultStore.setState({ vaultPath: '/other' });
      throw new Error('vault changed');
    });
    const result = await bulkDelete(selected);
    expect(result.failed.size).toBe(selected.length);
    expect(apply).not.toHaveBeenCalled();
    expect(new Map(fs())).toEqual(before);
  });
});

it('bulk Set files each row with inherited agents in that same patch and Undo removes both', async () => {
  await useVaultStore
    .getState()
    .patchFrontmatter('records/projects/guided-onboarding-ga.md', {
      agents: ['[[release-scout]]'],
    });
  const selected = useVaultStore
    .getState()
    .entries.filter(
      (entry) =>
        entry.type === 'Work item' &&
        entry.relationships.project?.includes('field-app-launch-campaign'),
    )
    .slice(0, 2);
  const apply = vi.spyOn(ipc, 'applyBatch');
  const before = new Map(selected.map((entry) => [entry.path, fs().get(entry.path)]));
  expect(
    (
      await bulkSetField(
        selected,
        'project',
        ['[[guided-onboarding-ga]]'],
        getSchema(useVaultStore.getState().entries),
      )
    ).failed.size,
  ).toBe(0);
  expect(apply.mock.calls[0][1]).toEqual(
    selected.map((entry) => ({
      op: 'patch',
      path: entry.path,
      set: { project: ['[[guided-onboarding-ga]]'], agent: ['[[release-scout]]'] },
      expectHash: entry.hash,
    })),
  );
  expect(await useUndoStore.getState().undo()).toBe(true);
  for (const [path, text] of before) expect(fs().get(path)).toBe(text);
});
