import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { DocumentOwner, type NoteWriteAck } from '@/editor/documentOwner';
import { __resetOpenPages, onExternalWrite, registerSaveParticipant } from '@/editor/openPages';
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
  __resetOpenPages();
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
  useUiStore.setState({ toast: vi.fn() });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function registerOwner(write: (body: string) => Promise<NoteWriteAck>) {
  const owner = new DocumentOwner(
    { vaultId: '/a', path: 'notes/plan.md', ownerId: 'open-page' },
    '- [ ] Call vendor',
    write,
  );
  registerSaveParticipant({
    key: owner.key,
    prepare: () => {},
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  return owner;
}
describe('document task reads', () => {
  it('retains a failed open draft and refuses the dependent checkbox write', async () => {
    const writer = vi.fn(async (): Promise<NoteWriteAck> => {
      throw Error('disk full');
    });
    const owner = registerOwner(writer);
    owner.edit('- [ ] Call vendor\n\nExact unsaved body.');
    const { result } = renderHook(useDocTasks);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    await act(async () => result.current.toggle(result.current.tasks[0], true));
    expect(writer).toHaveBeenCalledOnce();
    expect(saveNote).not.toHaveBeenCalled();
    expect(owner.snapshot()).toMatchObject({
      latestDraft: '- [ ] Call vendor\n\nExact unsaved body.',
      acknowledgedGeneration: 0,
    });
  });

  it('refreshes an old checkbox after the open owner acknowledges a newer body', async () => {
    const owner = registerOwner(async (body) => {
      readNoteSource.mockResolvedValue({ content: body, hash: 'owner-saved' });
      return { kind: 'file', contentHash: 'owner-saved' };
    });
    const { result } = renderHook(useDocTasks);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    owner.edit('- [ ] Call vendor\n\nNew paragraph.');
    await act(async () => result.current.toggle(result.current.tasks[0], true));
    expect(owner.snapshot().acknowledgedGeneration).toBe(1);
    expect(saveNote).not.toHaveBeenCalled();
    expect(useVaultStore.getState().rescan).toHaveBeenCalledOnce();
  });

  it.each(['applied', 'refused'] as const)(
    'holds the open owner before the fresh read through completion (%s)',
    async (outcome) => {
      const writer = vi.fn(async (): Promise<NoteWriteAck> => ({
        kind: 'file',
        contentHash: 'body',
      }));
      const owner = registerOwner(writer);
      const pending = vi.fn(() => owner.holdForReconcile());
      const settled = vi.fn(() => owner.finishReconcile());
      onExternalWrite('notes/plan.md', { pending, settled });
      const { result } = renderHook(useDocTasks);
      await waitFor(() => expect(result.current.tasks).toHaveLength(1));
      const read = deferred<{ content: string; hash: string }>();
      const scan = deferred<void>();
      readNoteSource.mockImplementationOnce(() => read.promise);
      useVaultStore.setState({ rescan: vi.fn(() => scan.promise) });
      if (outcome === 'refused') saveNote.mockRejectedValueOnce(Error('refused'));
      let toggle!: Promise<void>;
      act(() => {
        toggle = result.current.toggle(result.current.tasks[0], true);
      });
      await waitFor(() => expect(readNoteSource).toHaveBeenCalledTimes(2));
      expect(pending).toHaveBeenCalledOnce();
      owner.edit('- [ ] Call vendor\n\nTyped during tick.');
      expect(await owner.flush()).toMatchObject({ kind: 'blocked', reason: 'reconcile' });
      expect(writer).not.toHaveBeenCalled();
      await act(async () => read.resolve({ content: '- [ ] Call vendor', hash: `v${version}` }));
      if (outcome === 'applied') {
        await waitFor(() => expect(useVaultStore.getState().rescan).toHaveBeenCalledOnce());
        expect(settled).not.toHaveBeenCalled();
      }
      await act(async () => {
        scan.resolve();
        await toggle;
      });
      expect(settled).toHaveBeenCalledOnce();
      expect(owner.snapshot().latestDraft).toContain('Typed during tick.');
    },
  );

  it.each(['round-trip', 'unmount'] as const)(
    'retires a pending checkbox read after %s',
    async (retire) => {
      const { result, unmount } = renderHook(useDocTasks);
      await waitFor(() => expect(result.current.tasks).toHaveLength(1));
      const read = deferred<{ content: string; hash: string }>();
      readNoteSource.mockImplementationOnce(() => read.promise);
      let toggle!: Promise<void>;
      act(() => {
        toggle = result.current.toggle(result.current.tasks[0], true);
      });
      await waitFor(() => expect(readNoteSource).toHaveBeenCalledTimes(2));
      if (retire === 'unmount') unmount();
      else
        act(() => {
          useVaultStore.setState({ vaultPath: '/b' });
          useVaultStore.setState({ vaultPath: '/a' });
        });
      await act(async () => {
        read.resolve({ content: '- [ ] Call vendor', hash: `v${version}` });
        await toggle;
      });
      expect(saveNote).not.toHaveBeenCalled();
      expect(useVaultStore.getState().rescan).not.toHaveBeenCalled();
      expect(useUiStore.getState().toast).not.toHaveBeenCalled();
    },
  );

  it('keeps an acknowledged tick when its following refresh fails', async () => {
    useVaultStore.setState({
      rescan: vi.fn(async () => {
        throw Error('scan refused');
      }),
    });
    const { result } = renderHook(useDocTasks);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    await act(async () => result.current.toggle(result.current.tasks[0], true));
    expect(saveNote).toHaveBeenCalledOnce();
    expect(result.current.tasks[0]).toMatchObject({ done: true, version: 'saved-hash' });
    expect(useUiStore.getState().toast).toHaveBeenCalledWith(
      "Task saved, but the list couldn't refresh.",
    );
    expect(useUiStore.getState().toast).not.toHaveBeenCalledWith("Couldn't update task");
  });
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
