import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import cases from '../../src-tauri/fixtures/pr-cases.json';
import type { PrRead } from '@/engine/pullRequest';
import { __resetOpenPages, registerHold } from '@/editor/openPages';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { useVaultStore } from '@/stores/vaultStore';
import { setMergedStatus } from './pullRequestActions';
const path = 'work/pr-work.md';
const raw =
  '---\ntype: PR work\nstatus: active\n---\n\n# PR work\n\nhttps://github.com/acme/notes/pull/42\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const merged = cases.cases.find((c) => c.name === 'merged')!.expect as PrRead;
let hash: string;
beforeEach(async () => {
  vi.restoreAllMocks();
  __resetOpenPages();
  resetMockFs();
  fs().set(
    'types/pr-work.md',
    '---\ntype: Type\nfields:\n  status: status\nstatuses:\n  - {id: active, group: active}\n  - {id: done, group: done}\n---\n\n# PR work\n',
  );
  fs().set(path, raw);
  await useVaultStore.getState().openVault('/demo-vault');
  hash = (await ipc.readNoteSource('/demo-vault', path)).hash;
  useUndoStore.getState().clear();
  useUiStore.setState({ toasts: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetOpenPages();
});
it('writes one hash-guarded status patch and Undo restores exact bytes', async () => {
  const apply = vi.spyOn(ipc, 'applyBatch');
  expect(await setMergedStatus(path, hash, [merged], () => true)).toBe(true);
  expect(apply).toHaveBeenCalledOnce();
  expect(apply.mock.calls[0][1]).toEqual([
    { op: 'patch', path, set: { status: 'done' }, expectHash: hash },
  ]);
  expect(useUndoStore.getState().past[0].label).toBe(
    'Status set to “Done” — its pull request merged',
  );
  expect(fs().get(path)).toContain('status: done');
  expect(await useUndoStore.getState().undo()).toBe(true);
  expect(fs().get(path)).toBe(raw);
});
it.each(['scanVault', 'readNoteSource'] as const)('a failed %s never writes', async (method) => {
  vi.spyOn(ipc, method).mockRejectedValueOnce(new Error('disk'));
  const apply = vi.spyOn(ipc, 'applyBatch');
  expect(await setMergedStatus(path, hash, [merged], () => true)).toBe(false);
  expect(apply).not.toHaveBeenCalled();
  expect(fs().get(path)).toBe(raw);
});
it('refuses stale bytes, held saves and an unmounted owner', async () => {
  fs().set(path, raw + 'changed');
  expect(await setMergedStatus(path, hash, [merged], () => true)).toBe(false);
  fs().set(path, raw);
  registerHold(() => path);
  expect(await setMergedStatus(path, hash, [merged], () => true)).toBe(false);
  __resetOpenPages();
  expect(await setMergedStatus(path, hash, [merged], () => false)).toBe(false);
  expect(fs().get(path)).toBe(raw);
});
it('a synchronous vault round trip during the scan retires the action', async () => {
  const scan = ipc.scanVault;
  vi.spyOn(ipc, 'scanVault').mockImplementationOnce(async (vault) => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: vault });
    return scan(vault);
  });
  expect(await setMergedStatus(path, hash, [merged], () => true)).toBe(false);
  expect(fs().get(path)).toBe(raw);
});

it('a merged response for another PR cannot complete this page', async () => {
  if (merged.state !== 'read') throw new Error('fixture');
  expect(
    await setMergedStatus(
      path,
      hash,
      [
        {
          ...merged,
          pr: { ...merged.pr, url: 'https://github.com/acme/notes/pull/99', number: 99 },
        },
      ],
      () => true,
    ),
  ).toBe(false);
  expect(fs().get(path)).toBe(raw);
});
