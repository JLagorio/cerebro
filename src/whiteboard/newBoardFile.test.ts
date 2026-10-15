import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { newBoardFile } from './newBoardFile';

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(() => {
  vi.restoreAllMocks();
  resetMockFs();
  useVaultStore.setState({ vaultPath: '/demo-vault' });
});
afterEach(() => vi.restoreAllMocks());
it('creates an empty board through the guarded door, dedupes and rescans each result', async () => {
  const rescan = vi.spyOn(useVaultStore.getState(), 'rescan').mockResolvedValue();
  expect(await newBoardFile('/demo-vault', 'boards/plan.canvas')).toBe('boards/plan.canvas');
  expect(await newBoardFile('/demo-vault', 'boards/plan.canvas')).toBe('boards/plan-2.canvas');
  expect(JSON.parse(fs().get('boards/plan.canvas')!)).toMatchObject({ nodes: [], edges: [] });
  expect(rescan).toHaveBeenCalledTimes(2);
});
it('carries refusal words and never rescans or writes a refused board', async () => {
  const rescan = vi.spyOn(useVaultStore.getState(), 'rescan').mockResolvedValue();
  await expect(newBoardFile('/demo-vault', 'knowledge/plan.canvas')).rejects.toThrow(
    'Knowledge boards are read-only here.',
  );
  expect(rescan).not.toHaveBeenCalled();
  expect(fs().has('knowledge/plan.canvas')).toBe(false);
});
it.each([false, true])(
  'does not rescan after an old-vault create (roundtrip=%s)',
  async (roundtrip) => {
    let settle!: (value: ipc.CanvasResult<{ path: string; hash: string | null }>) => void;
    vi.spyOn(ipc, 'createCanvasFile').mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const rescan = vi.spyOn(useVaultStore.getState(), 'rescan').mockResolvedValue();
    const pending = newBoardFile('/demo-vault', 'plan.canvas');
    useVaultStore.setState({ vaultPath: '/other' });
    if (roundtrip) useVaultStore.setState({ vaultPath: '/demo-vault' });
    settle({ ok: true, path: 'plan.canvas', hash: 'saved' });
    expect(await pending).toBe('plan.canvas');
    expect(rescan).not.toHaveBeenCalled();
  },
);
