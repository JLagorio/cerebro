import { beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { installPack } from './packActions';
const io = vi.hoisted(() => ({ scan: vi.fn(), flush: vi.fn(), held: vi.fn() }));
vi.mock('@/lib/ipc', () => ({ scanVault: io.scan }));
vi.mock('@/editor/openPages', () => ({ flushOpenPages: io.flush, heldOpenPages: io.held }));
const apply = vi.fn();
beforeEach(() => {
  io.scan.mockReset().mockResolvedValue([]);
  io.flush.mockReset().mockResolvedValue(undefined);
  io.held.mockReset().mockReturnValue([]);
  apply.mockReset().mockResolvedValue({ files: [], batchId: 'one' });
  useVaultStore.setState({
    vaultPath: '/vault',
    entriesVault: '/vault',
    status: 'ready',
    entries: [],
    applyBatch: apply,
  });
  useUiStore.setState({ toasts: [] });
});
it('installs both types in one labelled batch after flushing and a fresh scan', async () => {
  expect(await installPack()).toBe(true);
  expect(io.flush).toHaveBeenCalledOnce();
  expect(io.scan).toHaveBeenCalledWith('/vault');
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    [
      expect.objectContaining({ op: 'create', path: 'types/company.md' }),
      expect.objectContaining({ op: 'create', path: 'types/person.md' }),
    ],
    { undo: 'Installed People and companies' },
  );
});
it('contains conflicts and failures and never writes a partial pack', async () => {
  io.scan.mockResolvedValue([makeEntry({ path: 'types/company.md' })]);
  expect(await installPack()).toBe(false);
  expect(apply).not.toHaveBeenCalled();
  io.scan.mockRejectedValue(new Error('disk'));
  expect(await installPack()).toBe(false);
  expect(useUiStore.getState().toasts.at(-1)?.message).toContain('disk');
});
it('retires even a vault round trip during its read', async () => {
  io.scan.mockImplementation(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: '/vault' });
    return [];
  });
  expect(await installPack()).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
it('refuses held page saves before reads and after the read', async () => {
  io.held.mockReturnValue(['types/person.md']);
  expect(await installPack()).toBe(false);
  expect(io.scan).not.toHaveBeenCalled();
  io.held.mockReturnValueOnce([]).mockReturnValueOnce(['types/person.md']);
  expect(await installPack()).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
