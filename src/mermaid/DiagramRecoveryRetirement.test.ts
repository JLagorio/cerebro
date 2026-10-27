import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { __resetOpenPages } from '@/editor/openPages';
import { useVaultStore } from '@/stores/vaultStore';
import { readNote, saveNote } from '@/lib/ipc';
import { useDiagramFile } from './useDiagramFile';
vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  readNote: vi.fn(),
  saveNote: vi.fn(),
}));
beforeEach(() => {
  __resetOpenPages();
  useVaultStore.setState({ vaultPath: '/diagram-test' });
  vi.mocked(readNote).mockResolvedValue('graph TD\n  A[old]\n');
  vi.mocked(saveNote).mockReset().mockResolvedValue('written-hash');
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
});

it('a discarded presentation callback cannot edit a freshly restored same-key diagram owner', async () => {
  const { discardRecovery, recoveryDrafts } = await import('@/editor/deletedDraftRecovery');
  const { makeEntry } = await import('@/test/factories');
  useVaultStore.setState({ entries: [] });
  const { result } = renderHook(() => useDiagramFile('a.mmd'));
  await waitFor(() => expect(result.current.code).not.toBeNull());
  const oldChange = result.current.handleChange;
  act(() => result.current.handleChange('local retired source'));
  act(() => {
    expect(
      discardRecovery(recoveryDrafts({ vaultId: '/diagram-test', path: 'a.mmd' })[0].ref).kind,
    ).toBe('discarded');
  });
  expect(result.current.code).toBeNull();
  vi.mocked(readNote).mockResolvedValue('fresh restored source');
  act(() =>
    useVaultStore.setState({ entries: [makeEntry({ path: 'a.mmd', hash: 'restored-hash' })] }),
  );
  await waitFor(() => expect(result.current.code).toBe('fresh restored source'));
  act(() => oldChange('late OLD source'));
  expect(result.current.code).toBe('fresh restored source');
  expect(saveNote).not.toHaveBeenCalled();
});

it('StrictMode binds the retained source writer to the memo value React actually uses', async () => {
  const { result } = renderHook(() => useDiagramFile('strict.mmd'), { wrapper: StrictMode });
  await waitFor(() => expect(result.current.code).not.toBeNull());
  act(() => result.current.handleChange('Strict exact diagram'));
  expect(result.current.code).toBe('Strict exact diagram');
});
