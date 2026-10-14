// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentsFile } from '@/engine/comments';

const { ipc, heard } = vi.hoisted(() => ({
  ipc: {
    listComments: vi.fn(),
    startCommentThread: vi.fn(),
    replyToCommentThread: vi.fn(),
    setCommentThreadResolved: vi.fn(),
    deleteComment: vi.fn(),
    deleteCommentThread: vi.fn(),
    listenCommentsChanged: vi.fn(),
  },
  heard: { handler: null as ((pages: string[] | null) => void) | null },
}));
vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  ...ipc,
}));

import { useCommentsSlot, useCommentsStore } from './commentsStore';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';

const PAGE = 'notes/plan.md';
const OTHER = 'notes/other.md';
const T1 = '0000000000000001';
const C2 = '0000000000000002';

const comment = (id: string, body = 'x') => ({
  id,
  author: 'human:owner',
  created: '2026-10-14T09:00:00Z',
  body,
});
const one: CommentsFile = { format: 1, threads: [{ comments: [comment(T1)] }] };
const replied: CommentsFile = {
  format: 1,
  threads: [{ comments: [comment(T1), comment(C2, 'Yes.')] }],
};
const UNREADABLE =
  "Comments for notes/plan.md can't be read: it has unresolved merge conflict markers.";

const toast = vi.fn();

/** A promise this test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  for (const fn of Object.values(ipc)) fn.mockReset();
  ipc.listenCommentsChanged.mockImplementation(
    async (handler: (pages: string[] | null) => void) => {
      heard.handler = handler;
      return () => undefined;
    },
  );
  useUiStore.setState({ toast });
  useVaultStore.setState({ vaultPath: '/vault' });
  useCommentsStore.getState().clear();
});

afterEach(() => {
  toast.mockReset();
});

const slot = (path: string) => useCommentsStore.getState().slots[path];

describe('commentsStore (M70.2)', () => {
  it('an absent sidecar is ready and empty', async () => {
    ipc.listComments.mockResolvedValue({ format: 1, threads: [] });
    await useCommentsStore.getState().load(PAGE);
    expect(ipc.listComments).toHaveBeenCalledWith('/vault', PAGE);
    expect(slot(PAGE)).toEqual({ kind: 'ready', file: { format: 1, threads: [] } });
  });

  it('a seeded sidecar is ready with its threads', async () => {
    ipc.listComments.mockResolvedValue(one);
    await useCommentsStore.getState().load(PAGE);
    expect(slot(PAGE)).toEqual({ kind: 'ready', file: one });
  });

  it('a conflicted sidecar is unavailable with its sentence, never empty', async () => {
    ipc.listComments.mockRejectedValue(UNREADABLE);
    await useCommentsStore.getState().load(PAGE);
    expect(slot(PAGE)).toEqual({ kind: 'unavailable', reason: UNREADABLE });
    expect(toast).not.toHaveBeenCalled();
  });

  it('a reload keeps a ready slot on screen until its answer lands', async () => {
    ipc.listComments.mockResolvedValueOnce(one);
    await useCommentsStore.getState().load(PAGE);
    const later = deferred<CommentsFile>();
    ipc.listComments.mockReturnValueOnce(later.promise);
    const reloading = useCommentsStore.getState().load(PAGE);
    expect(slot(PAGE)).toEqual({ kind: 'ready', file: one });
    later.resolve(replied);
    await reloading;
    expect(slot(PAGE)).toEqual({ kind: 'ready', file: replied });
  });

  it('startThread returns the new thread id, and reply the new comment id', async () => {
    ipc.startCommentThread.mockResolvedValue(one);
    const anchor = { quote: 'after the freeze', occurrence: 1, before: '', after: '.' };
    expect(await useCommentsStore.getState().startThread(PAGE, anchor, 'Hm?')).toBe(T1);
    expect(ipc.startCommentThread).toHaveBeenCalledWith('/vault', PAGE, anchor, 'Hm?');
    expect(slot(PAGE)).toEqual({ kind: 'ready', file: one });
    ipc.replyToCommentThread.mockResolvedValue(replied);
    expect(await useCommentsStore.getState().reply(PAGE, T1, 'Yes.')).toBe(C2);
    expect(slot(PAGE)).toEqual({ kind: 'ready', file: replied });
  });

  it('a failing action toasts once, returns false and reloads', async () => {
    ipc.setCommentThreadResolved.mockRejectedValue(
      new Error('No comment thread 0000000000000009 on notes/plan.md.'),
    );
    ipc.listComments.mockResolvedValue(one);
    const ok = await useCommentsStore.getState().setResolved(PAGE, '0000000000000009', true);
    expect(ok).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "Couldn't resolve the thread: No comment thread 0000000000000009 on notes/plan.md.",
    );
    await vi.waitFor(() => expect(slot(PAGE)).toEqual({ kind: 'ready', file: one }));
    expect(ipc.listComments).toHaveBeenCalledTimes(1);
  });

  it('every action names what failed', async () => {
    ipc.listComments.mockResolvedValue(one);
    for (const fn of [
      ipc.startCommentThread,
      ipc.replyToCommentThread,
      ipc.setCommentThreadResolved,
      ipc.deleteComment,
      ipc.deleteCommentThread,
    ]) {
      fn.mockRejectedValue('no note at notes/plan.md');
    }
    const store = useCommentsStore.getState();
    expect(await store.startThread(PAGE, null, 'x')).toBeNull();
    expect(await store.reply(PAGE, T1, 'x')).toBeNull();
    expect(await store.setResolved(PAGE, T1, false)).toBe(false);
    expect(await store.deleteComment(PAGE, T1, T1)).toBe(false);
    expect(await store.deleteThread(PAGE, T1)).toBe(false);
    expect(toast.mock.calls.map(([words]) => words)).toEqual([
      "Couldn't comment: no note at notes/plan.md",
      "Couldn't reply: no note at notes/plan.md",
      "Couldn't reopen the thread: no note at notes/plan.md",
      "Couldn't delete the comment: no note at notes/plan.md",
      "Couldn't delete the thread: no note at notes/plan.md",
    ]);
  });

  it('a vault switch clears the slots', async () => {
    ipc.listComments.mockResolvedValue(one);
    await useCommentsStore.getState().load(PAGE);
    useVaultStore.setState({ vaultPath: '/other-vault' });
    expect(useCommentsStore.getState().slots).toEqual({});
  });

  it('an answer that lands after a vault switch is dropped', async () => {
    const late = deferred<CommentsFile>();
    ipc.listComments.mockReturnValueOnce(late.promise);
    const loading = useCommentsStore.getState().load(PAGE);
    const write = deferred<CommentsFile>();
    ipc.deleteCommentThread.mockReturnValueOnce(write.promise);
    const deleting = useCommentsStore.getState().deleteThread(OTHER, T1);
    useVaultStore.setState({ vaultPath: '/other-vault' });
    late.resolve(one);
    write.resolve(one);
    await loading;
    expect(await deleting).toBe(false);
    expect(useCommentsStore.getState().slots).toEqual({});
    expect(toast).not.toHaveBeenCalled();
  });

  it('the listener reloads the named pages, and null reloads them all', async () => {
    ipc.listComments.mockResolvedValue(one);
    await useCommentsStore.getState().load(PAGE);
    await useCommentsStore.getState().load(OTHER);
    // One lazy binding for the module, made by whichever load came first.
    expect(heard.handler).not.toBeNull();
    expect(ipc.listenCommentsChanged.mock.calls.length).toBeLessThanOrEqual(1);
    ipc.listComments.mockClear();
    heard.handler?.([OTHER, 'notes/never-loaded.md']);
    expect(ipc.listComments.mock.calls).toEqual([['/vault', OTHER]]);
    ipc.listComments.mockClear();
    heard.handler?.(null);
    expect(ipc.listComments.mock.calls.map(([, path]) => path).sort()).toEqual([OTHER, PAGE]);
  });

  it('useCommentsSlot loads on mount and again when the path changes', async () => {
    ipc.listComments.mockResolvedValue(one);
    const { result, rerender } = renderHook(({ path }) => useCommentsSlot(path), {
      initialProps: { path: PAGE as string | null },
    });
    expect(result.current).toEqual({ kind: 'loading' });
    await act(async () => undefined);
    expect(result.current).toEqual({ kind: 'ready', file: one });
    rerender({ path: OTHER });
    await act(async () => undefined);
    expect(ipc.listComments.mock.calls.map(([, path]) => path)).toEqual([PAGE, OTHER]);
    rerender({ path: null });
    expect(result.current).toBeNull();
  });
});
