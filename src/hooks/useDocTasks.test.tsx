import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useDocTasks } from './useDocTasks';
const { readNoteSource, saveNote } = vi.hoisted(() => ({
  readNoteSource: vi.fn(),
  saveNote: vi.fn(async () => 'saved-hash'),
}));
vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  readNoteSource,
  saveNote,
}));
let version = 0;
beforeEach(() => {
  vi.clearAllMocks();
  version++;
  useVaultStore.setState({
    vaultPath: '/a',
    entriesVault: '/a',
    status: 'ready',
    error: null,
    entries: [makeEntry({ path: 'notes/plan.md', hash: `v${version}` })],
    rescan: vi.fn(async () => {}),
  });
  readNoteSource.mockResolvedValue({ content: '- [ ] Call vendor', hash: `v${version}` });
});
describe('document task reads', () => {
  it('keeps the whole-file version on rows and sends it with a body-only tick', async () => {
    readNoteSource.mockResolvedValue({
      content: '---\ntitle: Plan\n---\n- [ ] Call vendor',
      hash: `v${version}`,
    });
    const { result } = renderHook(useDocTasks);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(result.current.tasks[0].version).toBe(`v${version}`);
    await act(async () => result.current.toggle(result.current.tasks[0], true));
    expect(saveNote).toHaveBeenCalledWith(
      '/a',
      'notes/plan.md',
      '- [x] Call vendor',
      `v${version}`,
    );
    expect(result.current.tasks[0]).toMatchObject({ done: true, version: 'saved-hash' });
  });
  it('never reads a diagram as a task source', async () => {
    useVaultStore.setState({ entries: [makeEntry({ path: 'diagram.mmd' })] });
    const { result } = renderHook(useDocTasks);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(readNoteSource).not.toHaveBeenCalled();
  });
  it('refreshes without retrying if the file changes after the fresh read', async () => {
    const toast = vi.fn();
    useUiStore.setState({ toast });
    saveNote.mockRejectedValueOnce(
      'stale_content: notes/plan.md changed since it was read, so nothing was saved.',
    );
    const { result } = renderHook(useDocTasks);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    await act(async () => result.current.toggle(result.current.tasks[0], true));
    expect(saveNote).toHaveBeenCalledOnce();
    expect(useVaultStore.getState().rescan).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("the tick wasn't saved"));
    expect(result.current.tasks[0].done).toBe(false);
  });
  it('scopes body caches to the vault even with matching paths and timestamps', async () => {
    const { result } = renderHook(useDocTasks);
    await waitFor(() => expect(result.current.tasks[0]?.text).toBe('Call vendor'));
    readNoteSource.mockResolvedValue({ content: '- [ ] Book room', hash: `b${version}` });
    act(() => useVaultStore.setState({ vaultPath: '/b', entriesVault: '/b' }));
    await waitFor(() => expect(result.current.tasks[0]?.text).toBe('Book room'));
    expect(readNoteSource).toHaveBeenCalledWith('/b', 'notes/plan.md');
  });
  it('names a failed body and retains readable tasks', async () => {
    useVaultStore.setState({
      entries: [
        makeEntry({ path: 'good.md', hash: `v${version}` }),
        makeEntry({ path: 'bad.md', hash: `v${version}` }),
      ],
    });
    readNoteSource.mockImplementation(async (_vault, path) => {
      if (path === 'bad.md') throw Error('disk');
      return { content: '- [ ] Call vendor', hash: `v${version}` };
    });
    const { result } = renderHook(useDocTasks);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unreadable).toEqual(['bad.md']);
    expect(result.current.tasks).toHaveLength(1);
  });
  it('does not read the previous vault scan and ignores a late old-vault answer', async () => {
    let finish!: (body: { content: string; hash: string }) => void;
    readNoteSource.mockImplementationOnce(
      () =>
        new Promise<{ content: string; hash: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(useDocTasks);
    act(() => useVaultStore.setState({ vaultPath: '/b' }));
    await act(async () => finish({ content: '- [ ] Old vault', hash: 'old' }));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(readNoteSource).toHaveBeenCalledOnce();
    act(() =>
      useVaultStore.setState({
        entriesVault: '/b',
        entries: [makeEntry({ path: 'notes/plan.md', hash: `new${version}` })],
      }),
    );
    await waitFor(() => expect(result.current.tasks[0]?.text).toBe('Call vendor'));
  });
  it('refuses a checklist item that moved onto another task before its click', async () => {
    const toast = vi.fn();
    useUiStore.setState({ toast });
    const { result } = renderHook(useDocTasks);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    readNoteSource.mockResolvedValue({
      content: '- [ ] Different task\n- [ ] Call vendor',
      hash: 'different',
    });
    await act(async () => result.current.toggle(result.current.tasks[0], true));
    expect(saveNote).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "“Call vendor” changed since this list was read, so the tick wasn't saved. The list is refreshed — tick it again.",
    );
    expect(useVaultStore.getState().rescan).toHaveBeenCalledOnce();
  });
});
