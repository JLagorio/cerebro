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
import { readCliTranscript } from '@/agent/agentIpc';
import { healFromTranscript, replayTranscript } from '@/agent/transcript';
import { placeLabel, samePlace, type Place } from '@/engine/place';
import type { AgentChat } from '@/agent/useAgentChat';
import type { Conversation } from '@/agent/types';
import type { RunChoice } from '@/engine/runOptions';

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
  const [activeId, setActiveId] = useState<string>(() => {
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
      restore(c.messages, c.sessionId);
      setReadBlock(null);
      const session = c.sessionId;
      if (session === null || vault === null) {
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

  // Mirror the live transcript into the active record, and auto-title from
  // the first user message. Skipped while streaming: persisting a half-
  // written reply would restore a conversation frozen mid-sentence.
  const messages = chat.messages;
  const sessionId = chat.sessionId;
  const streaming = chat.streaming;
  const turnEndedAt = chat.turnEndedAt;
  useEffect(() => {
    if (!hydrated.current || streaming) return;
    setConversations((prev) => {
      const next = prev.map((c) =>
        c.id === activeId
          ? retitle({
              ...c,
              messages,
              sessionId,
              ...(turnEndedAt === null ? {} : { updatedAt: turnEndedAt }),
            })
          : c,
      );
      saveConversations(next);
      return next;
    });
  }, [messages, sessionId, streaming, activeId, turnEndedAt]);

  // …except the session id, which is stored the moment it is known, streaming
  // or not (M56.3): a reload mid-turn must still know which session file the
  // thread rebuilds from.
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

  // …but the panel can be closed MID-TURN, and the effect above deliberately
  // skips streaming, so the question and everything already written were
  // thrown away on the way out (M15). Persist once more as this unmounts,
  // streaming or not — saveConversations strips the streaming flags, so what
  // comes back reads as a finished turn rather than one frozen mid-sentence.
  const snapshot = useRef({ conversations, activeId, messages, sessionId });
  snapshot.current = { conversations, activeId, messages, sessionId };
  useEffect(() => {
    return () => {
      const s = snapshot.current;
      if (!hydrated.current || s.messages.length === 0) return;
      // A reply still streaming was cut off by the close: it reopens saying
      // so rather than as a finished turn.
      const kept = s.messages.map((m) =>
        m.streaming === true ? { ...m, streaming: false, interrupted: true } : m,
      );
      saveConversations(
        s.conversations.map((c) =>
          c.id === s.activeId ? retitle({ ...c, messages: kept, sessionId: s.sessionId }) : c,
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
    setConversations((prev) => {
      const next = [created, ...prev];
      saveConversations(next);
      return next;
    });
    setActiveId(created.id);
    restoreEpoch.current += 1;
    setTranscript({ state: 'idle' });
    setReadBlock(null);
    chat.reset();
  }, [chat]);

  const select = useCallback(
    (id: string) => {
      if (id === activeId) return;
      const target = conversations.find((c) => c.id === id);
      if (target === undefined) return;
      setActiveId(id);
      restoreThread(target);
    },
    [activeId, conversations, restoreThread],
  );

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
    [activeId, restoreThread],
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
