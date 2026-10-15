import { useCallback, useEffect, useRef, useState } from 'react';
import {
  anchor,
  loadActiveId,
  loadConversations,
  newConversation,
  ordered,
  retitle,
  saveActiveId,
  saveConversations,
} from '@/agent/conversations';
import {
  cancelInteraction,
  listInteractions,
  readCliTranscript,
  stopAgent,
} from '@/agent/agentIpc';
import { healFromTranscript, replayTranscript } from '@/agent/transcript';
import { placeLabel, samePlace, type Place } from '@/engine/place';
import type { AgentChat } from '@/agent/useAgentChat';
import type { Conversation } from '@/agent/types';
import type { RunChoice } from '@/engine/runOptions';
import { useReviewNotesStore } from '@/stores/reviewNotesStore';
import { useUiStore } from '@/stores/uiStore';

/**
 * Where the active thread's transcript stands (M56.3): not asked for
 * (`idle`, also a cache the file had nothing to add to), being read, rebuilt
 * from Claude Code's session file, its cache healed from it, or unavailable
 * with Rust's typed reason.
 */
export type TranscriptStatus =
  | { state: 'idle' | 'reading' | 'rebuilt' | 'healed' }
  | { state: 'unavailable'; reason: string; retentionDays: number | null; detail?: string };

/** Why the active thread cannot take another turn (Q7): Claude Code no longer
 * has its session (`cleared`, `expired`), or it was had in another vault. */
export type ThreadBlock = 'cleared' | 'expired' | 'elsewhere' | null;

export interface ConversationState {
  conversations: Conversation[];
  activeId: string;
  active: Conversation | null;
  /** Where the user is standing right now (M17.5) — what an unanchored thread
   * will be stamped with, and what "here" means in the switcher. */
  here: Place;
  hereLabel: string;
  /**
   * Where the active thread STARTED, when that is somewhere else.
   *
   * Not a prompt to do anything about it — the panel briefly asked the user to
   * start a new conversation when they walked away, which was the app making
   * its own bookkeeping their problem. It is a fact the agent is told (see
   * `startedIn` in the snapshot), and a label in the switcher. Nothing else.
   */
  startedElsewhere: string | null;
  /** Stamp the active thread with the current place if it has none. Called at
   * SEND, never after: a turn navigates, so anchoring when it ends would
   * record wherever the agent left you. */
  anchorNow(): void;
  start(): void;
  select(id: string): void;
  rename(id: string, title: string): void;
  remove(id: string): void;
  /** Set a conversation's model and effort (M56.5). They persist with it
   * and ride every turn sent in it; null is Claude Code's default. */
  setRunOptions(id: string, choice: RunChoice): void;
  /** What reading the active thread's transcript found (M56.3). */
  transcript: TranscriptStatus;
  /** Why the active thread cannot continue, or null when it can. */
  blocked: ThreadBlock;
}

/** What `placeLabel` resolves names against — the vault, when the caller has it. */
export type PlaceLookup = Parameters<typeof placeLabel>[1];

/**
 * Many named conversations instead of one ephemeral thread (M9.5).
 *
 * The live transcript stays in `useAgentChat` — this owns the LIST and
 * mirrors the active transcript into it. Splitting them that way is what
 * lets switching conversations be a `restore` call rather than a rebuild of
 * the streaming machinery.
 *
 * The list holds a cached copy of each thread; the transcript is Claude
 * Code's session file (M56.3). Opening a thread restores the copy at once,
 * then reads the file: a thread with no copy is rebuilt from it, a copy is
 * healed from it (Q6: unfinished tool rows and, M56.8, the whole payloads
 * the copy never keeps; the wording kept), and a
 * file Claude Code no longer has blocks the thread rather than letting a send
 * fail with the CLI's own error (Q7).
 *
 * A turn outlives its panel (M57.6). Switching threads, starting a new one
 * and closing the panel detach a running turn, and every save of the active
 * thread carries the turn's `live` with its messages (`saveActive`), so the
 * thread re-attaches when it opens again. Deleting a thread is the one way
 * this list ends a turn: its run is stopped and its card cancelled.
 */
export function useConversations(
  chat: AgentChat,
  /** Where the panel is standing. Threads are stamped with it at their first
   * turn (M17.5) so a thread can be found again by what it was about. */
  here: Place = { kind: 'home' },
  lookup?: PlaceLookup,
  /** The open vault, whose Claude Code folder a thread's transcript is read
   * from, and which a thread is stamped with at its first turn (M56.3). */
  vault: string | null = null,
): ConversationState {
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const stored = loadConversations();
    return stored.length > 0 ? stored : [newConversation()];
  });
  // Seeded from the remembered choice, and from `conversations` — NOT from a
  // second loadConversations() call, which on a first run minted a whole
  // second conversation whose id matched nothing in the list, so the mirror
  // effect below had no record to write the transcript into (M15).
  // A thread the run list asked for (M57.6) beats the remembered one, and is
  // taken once.
  const [activeId, setActiveId] = useState<string>(() => {
    const requested = useUiStore.getState().takePanelConversation();
    if (requested !== null && conversations.some((c) => c.id === requested)) return requested;
    const remembered = loadActiveId();
    return remembered !== null && conversations.some((c) => c.id === remembered)
      ? remembered
      : conversations[0].id;
  });

  // One writer for every path that changes the active conversation — start,
  // select, remove and the initial seed all end up here.
  useEffect(() => {
    saveActiveId(activeId);
  }, [activeId]);

  // Opening a thread (M56.3): the cached copy at once, then its transcript.
  // The epoch is bumped by every restore and every send, so a read that
  // lands after either changes nothing; so does one that lands mid-turn.
  const restore = chat.restore;
  const streamingRef = useRef(chat.streaming);
  streamingRef.current = chat.streaming;
  const restoreEpoch = useRef(0);
  const [transcript, setTranscript] = useState<TranscriptStatus>({ state: 'idle' });
  const [readBlock, setReadBlock] = useState<'cleared' | 'expired' | null>(null);
  const restoreThread = useCallback(
    (c: Conversation) => {
      restoreEpoch.current += 1;
      const epoch = restoreEpoch.current;
      restore(c.messages, c.sessionId, undefined, c.live ?? null);
      setReadBlock(null);
      const session = c.sessionId;
      // A thread with a turn still running re-attaches to it (M57.6), and
      // the run's own events, or its rebuild at the end, say what the file
      // would: a heal read now would race the re-attach.
      if (session === null || vault === null || c.live != null) {
        setTranscript({ state: 'idle' });
        return;
      }
      setTranscript({ state: 'reading' });
      void readCliTranscript(c.vault ?? vault, session, c.updatedAt ?? c.createdAt).then((read) => {
        if (restoreEpoch.current !== epoch || streamingRef.current) return;
        if (read.state === 'unavailable') {
          setTranscript({
            state: 'unavailable',
            reason: read.reason,
            retentionDays: read.retention_days,
            ...(read.detail === undefined ? {} : { detail: read.detail }),
          });
          const reason = read.reason;
          if (reason === 'cleared' || reason === 'expired') {
            setReadBlock(reason === 'cleared' ? 'cleared' : 'expired');
          }
          return;
        }
        const replayed = replayTranscript(read.events, session);
        const facts = { model: replayed.model, prLinks: replayed.prLinks };
        if (c.messages.length === 0) {
          restore(replayed.messages, session, facts);
          setTranscript({ state: 'rebuilt' });
          return;
        }
        const healed = healFromTranscript(c.messages, replayed.messages);
        restore(healed, session, facts);
        setTranscript({ state: healed === c.messages ? 'idle' : 'healed' });
      });
    },
    [restore, vault],
  );

  // First render restores the stored thread into the chat hook once, and
  // reads its transcript.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const first = conversations.find((c) => c.id === activeId);
    if (first !== undefined) restoreThread(first);
  }, [activeId, conversations, restoreThread]);

  const messages = chat.messages;
  const sessionId = chat.sessionId;
  const streaming = chat.streaming;
  const turnEndedAt = chat.turnEndedAt;
  const live = chat.live;

  /**
   * Write the active thread as the chat hook holds it (M57.6): its messages,
   * its session and the turn it has running, read when this is called, never
   * later, so a save before a thread switch writes the thread being left.
   * The one writer every save of the active thread goes through, so `live`
   * and the reply's cursor never disagree with the messages they belong to.
   */
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const saveActive = useCallback((id: string, extra: Partial<Conversation> = {}) => {
    const { messages: held, sessionId: session, live: turn } = chatRef.current;
    setConversations((prev) => {
      const next = prev.map((c) =>
        c.id === id
          ? retitle({ ...c, messages: held, sessionId: session, live: turn, ...extra })
          : c,
      );
      saveConversations(next);
      return next;
    });
  }, []);

  // Mirror the transcript into the active record, and auto-title from the
  // first user message. Skipped while streaming: the turn's skeleton was
  // saved with its `live` when the run started (below), and the turn's end
  // saves it whole.
  useEffect(() => {
    if (!hydrated.current || streaming) return;
    saveActive(activeId, turnEndedAt === null ? {} : { updatedAt: turnEndedAt });
  }, [messages, sessionId, streaming, activeId, turnEndedAt, saveActive]);

  // A turn that just got its run (M57.6): the skeleton, the question and its
  // empty reply, is saved with `live`, so a reload mid-turn re-attaches.
  useEffect(() => {
    if (!hydrated.current || live === null) return;
    saveActive(activeId);
  }, [live, activeId, saveActive]);

  // …except the session id, which is stored the moment the run names it,
  // streaming or not (M56.3): a reload mid-turn must still know which session
  // file the thread rebuilds from.
  useEffect(() => {
    if (!hydrated.current || sessionId === null) return;
    setConversations((prev) => {
      const current = prev.find((c) => c.id === activeId);
      if (current === undefined || current.sessionId === sessionId) return prev;
      const next = prev.map((c) => (c.id === activeId ? { ...c, sessionId } : c));
      saveConversations(next);
      return next;
    });
  }, [sessionId, activeId]);

  // …and once more as the panel closes, streaming or not (M15): the turn
  // detaches and keeps running (M57.6), so the thread is saved with its
  // `live` and its reply's cursor, and reopening re-attaches from there. A
  // reply streaming with no live turn was a send still parked before its
  // child, which the close cancels: it reopens saying it was cut off.
  const snapshot = useRef({ conversations, activeId, messages, sessionId, live });
  snapshot.current = { conversations, activeId, messages, sessionId, live };
  useEffect(() => {
    return () => {
      const s = snapshot.current;
      if (!hydrated.current || s.messages.length === 0) return;
      const kept =
        s.live !== null
          ? s.messages
          : s.messages.map((m) =>
              m.streaming === true ? { ...m, streaming: false, interrupted: true } : m,
            );
      saveConversations(
        s.conversations.map((c) =>
          c.id === s.activeId
            ? retitle({ ...c, messages: kept, sessionId: s.sessionId, live: s.live })
            : c,
        ),
      );
    };
  }, []);

  // Closed over directly rather than read through a latest-value ref. The refs
  // were there to guard against a send queued a render earlier stamping a
  // stale place — but `here` and `lookup` are this hook's own arguments, so
  // every caller of `anchorNow` is recreated when they change and there is no
  // stale version to call. A render-phase ref write also defeats the compiler
  // (react-hooks/preserve-manual-memoization) for a guarantee already held.
  const anchorNow = useCallback(() => {
    // A send: a transcript read still in flight answers a thread that has
    // moved on (M56.3).
    restoreEpoch.current += 1;
    setConversations((prev) => {
      const current = prev.find((c) => c.id === activeId);
      if (current === undefined) return prev;
      // Already anchored: where a thread STARTED is a fact about the thread,
      // and walking somewhere else mid-conversation does not change it. The
      // vault it was had in is stamped the same way, once (M56.3).
      const stampVault = current.vault === undefined && vault !== null;
      if (current.place != null && !stampVault) return prev;
      const next = prev.map((c) => {
        if (c.id !== activeId) return c;
        const anchored = anchor(c, here, lookup);
        return stampVault && vault !== null ? { ...anchored, vault } : anchored;
      });
      saveConversations(next);
      return next;
    });
  }, [activeId, here, lookup, vault]);

  const start = useCallback(() => {
    const created = newConversation();
    // The thread being left keeps its turn running (M57.6): saved with it.
    setConversations((prev) => [created, ...prev]);
    saveActive(activeId);
    setActiveId(created.id);
    restoreEpoch.current += 1;
    setTranscript({ state: 'idle' });
    setReadBlock(null);
    chat.reset();
  }, [activeId, chat, saveActive]);

  const select = useCallback(
    (id: string) => {
      if (id === activeId) return;
      const target = conversations.find((c) => c.id === id);
      if (target === undefined) return;
      // The thread being left keeps its turn running (M57.6): saved with it.
      saveActive(activeId);
      setActiveId(id);
      restoreThread(target);
    },
    [activeId, conversations, restoreThread, saveActive],
  );

  // A thread the run list asks for while the panel is open (M57.6).
  const requested = useUiStore((s) => s.panelConversation);
  useEffect(() => {
    if (requested === null) return;
    const id = useUiStore.getState().takePanelConversation();
    if (id !== null) select(id);
  }, [requested, select]);

  const rename = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    setConversations((prev) => {
      // usesDefaultTitle flips false so auto-titling never overwrites a name
      // the user chose.
      const next = prev.map((c) =>
        c.id === id ? { ...c, title: trimmed, usesDefaultTitle: false } : c,
      );
      saveConversations(next);
      return next;
    });
  }, []);

  const setRunOptions = useCallback((id: string, choice: RunChoice) => {
    setConversations((prev) => {
      const next = prev.map((c) =>
        c.id === id ? { ...c, model: choice.model, effort: choice.effort } : c,
      );
      saveConversations(next);
      return next;
    });
  }, []);

  const remove = useCallback(
    (id: string) => {
      // Deleting a thread ends its turn (M57.6), active or not: its run is
      // stopped and the card it waits on cancelled, since nothing could
      // answer either once the thread is gone.
      const doomed = conversations.find((c) => c.id === id);
      const turn = id === activeId ? chat.live : (doomed?.live ?? null);
      const session = id === activeId ? chat.sessionId : (doomed?.sessionId ?? null);
      if (turn != null) void stopAgent(turn.run).catch(() => undefined);
      if (session !== null && vault !== null) {
        void listInteractions(vault)
          .then((cards) => {
            for (const card of cards) {
              if (card.session_id === session) void cancelInteraction(card.id);
            }
          })
          .catch(() => undefined);
      }
      // Its review notes go with it (M58.5): nothing could send them now.
      useReviewNotesStore.getState().prune(id);
      setConversations((prev) => {
        const remaining = prev.filter((c) => c.id !== id);
        const next = remaining.length > 0 ? remaining : [newConversation()];
        saveConversations(next);
        if (id === activeId) {
          const fallback = next[0];
          setActiveId(fallback.id);
          restoreThread(fallback);
        }
        return next;
      });
    },
    [activeId, chat.live, chat.sessionId, conversations, restoreThread, vault],
  );

  const active = conversations.find((c) => c.id === activeId) ?? null;
  return {
    conversations: ordered(conversations),
    activeId,
    active,
    here,
    hereLabel: placeLabel(here, lookup),
    // Null for an unanchored thread: it has not started anywhere yet, so
    // there is nothing to say about where it started.
    startedElsewhere:
      active?.place != null && !samePlace(active.place, here)
        ? (active.placeLabel ?? placeLabel(active.place, lookup))
        : null,
    anchorNow,
    start,
    select,
    rename,
    remove,
    setRunOptions,
    transcript,
    // Another vault's thread keys its session under that vault, so it
    // cannot resume here, whatever the file says.
    blocked:
      active?.vault !== undefined && vault !== null && active.vault !== vault
        ? 'elsewhere'
        : readBlock,
  };
}
