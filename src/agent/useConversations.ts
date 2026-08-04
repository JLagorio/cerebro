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
import { placeLabel, samePlace, type Place } from '@/engine/place';
import type { AgentChat } from '@/agent/useAgentChat';
import type { Conversation } from '@/agent/types';

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
 */
export function useConversations(
  chat: AgentChat,
  /** Where the panel is standing. Threads are stamped with it at their first
   * turn (M17.5) so a thread can be found again by what it was about. */
  here: Place = { kind: 'home' },
  lookup?: PlaceLookup,
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

  // First render restores the stored transcript into the chat hook once.
  const hydrated = useRef(false);
  const restore = chat.restore;
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const first = conversations.find((c) => c.id === activeId);
    if (first !== undefined && first.messages.length > 0) {
      restore(first.messages, first.sessionId);
    }
  }, [activeId, conversations, restore]);

  // Mirror the live transcript into the active record, and auto-title from
  // the first user message. Skipped while streaming: persisting a half-
  // written reply would restore a conversation frozen mid-sentence.
  const messages = chat.messages;
  const sessionId = chat.sessionId;
  const streaming = chat.streaming;
  useEffect(() => {
    if (!hydrated.current || streaming) return;
    setConversations((prev) => {
      const next = prev.map((c) =>
        c.id === activeId ? retitle({ ...c, messages, sessionId }) : c,
      );
      saveConversations(next);
      return next;
    });
  }, [messages, sessionId, streaming, activeId]);

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
      saveConversations(
        s.conversations.map((c) =>
          c.id === s.activeId ? retitle({ ...c, messages: s.messages, sessionId: s.sessionId }) : c,
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
    setConversations((prev) => {
      const current = prev.find((c) => c.id === activeId);
      // Already anchored: where a thread STARTED is a fact about the thread,
      // and walking somewhere else mid-conversation does not change it.
      if (current === undefined || current.place != null) return prev;
      const next = prev.map((c) => (c.id === activeId ? anchor(c, here, lookup) : c));
      saveConversations(next);
      return next;
    });
  }, [activeId, here, lookup]);

  const start = useCallback(() => {
    const created = newConversation();
    setConversations((prev) => {
      const next = [created, ...prev];
      saveConversations(next);
      return next;
    });
    setActiveId(created.id);
    chat.reset();
  }, [chat]);

  const select = useCallback(
    (id: string) => {
      if (id === activeId) return;
      const target = conversations.find((c) => c.id === id);
      if (target === undefined) return;
      setActiveId(id);
      chat.restore(target.messages, target.sessionId);
    },
    [activeId, chat, conversations],
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

  const remove = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const remaining = prev.filter((c) => c.id !== id);
        const next = remaining.length > 0 ? remaining : [newConversation()];
        saveConversations(next);
        if (id === activeId) {
          const fallback = next[0];
          setActiveId(fallback.id);
          chat.restore(fallback.messages, fallback.sessionId);
        }
        return next;
      });
    },
    [activeId, chat],
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
  };
}
