import { useEffect } from 'react';
import { create } from 'zustand';
import type { CommentAnchor } from '@/engine/commentAnchor';
import { threadId, type CommentsFile } from '@/engine/comments';
import {
  deleteComment as deleteCommentIpc,
  deleteCommentThread,
  listComments,
  listenCommentsChanged,
  replyToCommentThread,
  setCommentThreadResolved,
  startCommentThread,
} from '@/lib/ipc';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';

/**
 * Each open page's comment threads (M70.2), one slot per page path.
 *
 * A slot is loading, ready with the page's file, or unavailable with the
 * sentence that says why (CV-05): a sidecar that can't be read is never shown
 * as "no comments". A re-read keeps a ready slot on screen until its answer
 * lands. Every action answers the whole file as written, which becomes the
 * slot; on failure it toasts `Couldn't <act>: <reason>` once, reloads the
 * page and returns null or false (CV-03). A vault switch clears every slot,
 * and an answer that lands after one is dropped. One listener, bound on the
 * first load, reloads the pages the watcher names (`comments-changed`), or
 * every loaded page when it names none.
 */
export type CommentsSlot =
  | { kind: 'loading' }
  | { kind: 'ready'; file: CommentsFile }
  | { kind: 'unavailable'; reason: string };

interface CommentsState {
  slots: Record<string, CommentsSlot>;
  /** Read `path`'s threads. Never throws. */
  load(path: string): Promise<void>;
  /** The new thread's id, or null. */
  startThread(path: string, anchor: CommentAnchor | null, body: string): Promise<string | null>;
  /** The new comment's id, or null. */
  reply(path: string, thread: string, body: string): Promise<string | null>;
  setResolved(path: string, thread: string, resolved: boolean): Promise<boolean>;
  deleteComment(path: string, thread: string, comment: string): Promise<boolean>;
  deleteThread(path: string, thread: string): Promise<boolean>;
  /** Forget every slot (a vault switch). */
  clear(): void;
}

/** Bumped by `clear`, so an answer for the previous vault never lands. */
let epoch = 0;
/** The newest request per page: an older answer never lands over a newer. */
const latest = new Map<string, number>();
let tickets = 0;
let listening: Promise<() => void> | null = null;

const LOADING: CommentsSlot = { kind: 'loading' };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function take(path: string): { ticket: number; epoch: number } {
  tickets += 1;
  latest.set(path, tickets);
  return { ticket: tickets, epoch };
}

const current = (path: string, mine: { ticket: number; epoch: number }): boolean =>
  mine.epoch === epoch && latest.get(path) === mine.ticket;

export const useCommentsStore = create<CommentsState>()((set, get) => {
  const land = (path: string, slot: CommentsSlot) =>
    set((s) => ({ slots: { ...s.slots, [path]: slot } }));

  function listen(): void {
    if (listening !== null) return;
    listening = listenCommentsChanged((pages) => {
      const loaded = Object.keys(get().slots);
      for (const page of pages ?? loaded) {
        if (loaded.includes(page)) void get().load(page);
      }
    }).catch(() => {
      // Not bound: the next load tries again.
      listening = null;
      return () => undefined;
    });
  }

  /** One write: land the file it answers, or toast once and reload. */
  async function act<T>(
    path: string,
    what: string,
    call: (vault: string) => Promise<CommentsFile>,
    pick: (file: CommentsFile) => T,
  ): Promise<T | null> {
    const vault = useVaultStore.getState().vaultPath;
    if (vault === null) {
      useUiStore.getState().toast(`Couldn't ${what}: no vault is open`);
      return null;
    }
    const mine = take(path);
    try {
      const file = await call(vault);
      if (mine.epoch !== epoch) return null;
      if (current(path, mine)) land(path, { kind: 'ready', file });
      return pick(file);
    } catch (err) {
      if (mine.epoch !== epoch) return null;
      useUiStore.getState().toast(`Couldn't ${what}: ${message(err)}`);
      void get().load(path);
      return null;
    }
  }

  return {
    slots: {},

    async load(path) {
      const vault = useVaultStore.getState().vaultPath;
      if (vault === null) return;
      listen();
      const mine = take(path);
      if (get().slots[path]?.kind !== 'ready') land(path, LOADING);
      try {
        const file = await listComments(vault, path);
        if (current(path, mine)) land(path, { kind: 'ready', file });
      } catch (err) {
        if (current(path, mine)) land(path, { kind: 'unavailable', reason: message(err) });
      }
    },

    startThread: (path, anchor, body) =>
      act(
        path,
        'comment',
        (vault) => startCommentThread(vault, path, anchor, body),
        (file) => threadId(file.threads[file.threads.length - 1]),
      ),

    reply: (path, thread, body) =>
      act(
        path,
        'reply',
        (vault) => replyToCommentThread(vault, path, thread, body),
        (file) => {
          const comments = file.threads.find((t) => threadId(t) === thread)?.comments ?? [];
          return comments[comments.length - 1]?.id ?? null;
        },
      ),

    setResolved: async (path, thread, resolved) =>
      (await act(
        path,
        resolved ? 'resolve the thread' : 'reopen the thread',
        (vault) => setCommentThreadResolved(vault, path, thread, resolved),
        () => true,
      )) ?? false,

    deleteComment: async (path, thread, comment) =>
      (await act(
        path,
        'delete the comment',
        (vault) => deleteCommentIpc(vault, path, thread, comment),
        () => true,
      )) ?? false,

    deleteThread: async (path, thread) =>
      (await act(
        path,
        'delete the thread',
        (vault) => deleteCommentThread(vault, path, thread),
        () => true,
      )) ?? false,

    clear() {
      epoch += 1;
      latest.clear();
      set({ slots: {} });
    },
  };
});

// A vault switch clears every slot; answers for the old vault are dropped.
useVaultStore.subscribe((state, previous) => {
  if (state.vaultPath !== previous.vaultPath) useCommentsStore.getState().clear();
});

/**
 * `path`'s comment slot, loaded on mount and whenever the path or the vault
 * changes. Loading until the first answer; null for no path.
 */
export function useCommentsSlot(path: string | null): CommentsSlot | null {
  const vault = useVaultStore((s) => s.vaultPath);
  const load = useCommentsStore((s) => s.load);
  useEffect(() => {
    if (path !== null && vault !== null) void load(path);
  }, [path, vault, load]);
  return useCommentsStore((s) => (path === null ? null : (s.slots[path] ?? LOADING)));
}
