import { create } from 'zustand';
import {
  claimHead,
  edit as editEntry,
  enqueue as enqueueEntry,
  remove as removeEntry,
  toFront,
  type ResolvedText,
  type UpNextEntry,
} from '@/agent/upNextQueue';

/**
 * Up next per conversation (M57.5), in memory only (M57 Q24): a reload
 * clears it, because persisting would mean re-taking each entry's context,
 * which breaks frozen-at-enqueue.
 *
 * `held` is set after a turn a person stopped or one that failed: nothing
 * starts until Resume (M57 Q23). It only means something while entries wait,
 * so a queue that empties is no longer held. `steering` names the entry Steer
 * moved first, which starts once the stopped run's Done arrives; `editing`
 * names the entry whose editor is open, which never starts while it is.
 */
export interface UpNextQueue {
  entries: UpNextEntry[];
  held: boolean;
  steering: string | null;
  editing: string | null;
}

export const EMPTY_QUEUE: UpNextQueue = { entries: [], held: false, steering: null, editing: null };

interface UpNextState {
  queues: Record<string, UpNextQueue>;
  /** Queue `entry` last, or answer 'full' at the cap and keep nothing. */
  enqueue(conversation: string, entry: UpNextEntry): 'queued' | 'full';
  /** Replace a typed entry's text; false when it is refused. */
  edit(conversation: string, id: string, text: string, resolved: ResolvedText): boolean;
  remove(conversation: string, id: string): void;
  /** Move `id` first and mark it the one Steer starts next. */
  markSteer(conversation: string, id: string): void;
  /** Take the head, or null when nothing waits. */
  claim(conversation: string): UpNextEntry | null;
  /** Take the entry `id`, or null when it is not queued. */
  claimById(conversation: string, id: string): UpNextEntry | null;
  setHeld(conversation: string, held: boolean): void;
  setEditing(conversation: string, id: string | null): void;
  /** Drop the queues of every conversation not named. */
  prune(conversations: string[]): void;
  /** Drop the entries queued in any vault but `vault`. */
  keepVault(vault: string): void;
  /** Whether any conversation's Up next still holds the entry `id` (M58.5):
   * a review note it holds reads waiting until then. */
  has(id: string): boolean;
}

/** `queue` with `entries`: a queue that empties lets go of its hold, and of a
 * steer or an editor naming an entry it no longer holds. */
function withEntries(queue: UpNextQueue, entries: UpNextEntry[]): UpNextQueue {
  const holds = (id: string | null) => id !== null && entries.some((e) => e.id === id);
  return {
    entries,
    held: entries.length > 0 && queue.held,
    steering: holds(queue.steering) ? queue.steering : null,
    editing: holds(queue.editing) ? queue.editing : null,
  };
}

export const useUpNextStore = create<UpNextState>()((set, get) => {
  const queueOf = (conversation: string): UpNextQueue => get().queues[conversation] ?? EMPTY_QUEUE;
  const put = (conversation: string, queue: UpNextQueue) =>
    set((s) => ({ queues: { ...s.queues, [conversation]: queue } }));
  const take = (conversation: string, id: string | null): UpNextEntry | null => {
    const queue = queueOf(conversation);
    const entry =
      id === null
        ? (claimHead(queue.entries)?.entry ?? null)
        : (queue.entries.find((e) => e.id === id) ?? null);
    if (entry === null) return null;
    put(conversation, withEntries(queue, removeEntry(queue.entries, entry.id)));
    return entry;
  };
  return {
    queues: {},
    enqueue: (conversation, entry) => {
      const queue = queueOf(conversation);
      const next = enqueueEntry(queue.entries, entry);
      if (next === 'full') return 'full';
      put(conversation, withEntries(queue, next));
      return 'queued';
    },
    edit: (conversation, id, text, resolved) => {
      const queue = queueOf(conversation);
      const next = editEntry(queue.entries, id, text, resolved);
      if (next === queue.entries) return false;
      put(conversation, withEntries(queue, next));
      return true;
    },
    remove: (conversation, id) => {
      const queue = queueOf(conversation);
      put(conversation, withEntries(queue, removeEntry(queue.entries, id)));
    },
    markSteer: (conversation, id) => {
      const queue = queueOf(conversation);
      if (!queue.entries.some((e) => e.id === id)) return;
      put(conversation, { ...queue, entries: toFront(queue.entries, id), steering: id });
    },
    claim: (conversation) => take(conversation, null),
    claimById: (conversation, id) => take(conversation, id),
    setHeld: (conversation, held) => {
      const queue = queueOf(conversation);
      const next = held && queue.entries.length > 0;
      if (queue.held !== next) put(conversation, { ...queue, held: next });
    },
    setEditing: (conversation, id) => {
      const queue = queueOf(conversation);
      const next = id !== null && queue.entries.some((e) => e.id === id) ? id : null;
      if (queue.editing !== next) put(conversation, { ...queue, editing: next });
    },
    prune: (conversations) =>
      set((s) => {
        const kept = Object.fromEntries(
          Object.entries(s.queues).filter(([id]) => conversations.includes(id)),
        );
        return Object.keys(kept).length === Object.keys(s.queues).length ? s : { queues: kept };
      }),
    keepVault: (vault) =>
      set((s) => {
        let changed = false;
        const queues: Record<string, UpNextQueue> = {};
        for (const [id, queue] of Object.entries(s.queues)) {
          const entries = queue.entries.filter((e) => e.vault === vault);
          if (entries.length !== queue.entries.length) changed = true;
          queues[id] =
            entries.length === queue.entries.length ? queue : withEntries(queue, entries);
        }
        return changed ? { queues } : s;
      }),
    has: (id) => Object.values(get().queues).some((q) => q.entries.some((e) => e.id === id)),
  };
});
