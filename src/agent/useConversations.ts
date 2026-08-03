import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadActiveId,
  loadConversations,
  newConversation,
  ordered,
  retitle,
  saveActiveId,
  saveConversations,
} from '@/agent/conversations';
import type { AgentChat } from '@/agent/useAgentChat';
import type { Conversation } from '@/agent/types';

export interface ConversationState {
  conversations: Conversation[];
  activeId: string;
  active: Conversation | null;
  start(): void;
  select(id: string): void;
  rename(id: string, title: string): void;
  remove(id: string): void;
}

/**
 * Many named conversations instead of one ephemeral thread (M9.5).
 *
 * The live transcript stays in `useAgentChat` — this owns the LIST and
 * mirrors the active transcript into it. Splitting them that way is what
 * lets switching conversations be a `restore` call rather than a rebuild of
 * the streaming machinery.
 */
export function useConversations(chat: AgentChat): ConversationState {
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

  return {
    conversations: ordered(conversations),
    activeId,
    active: conversations.find((c) => c.id === activeId) ?? null,
    start,
    select,
    rename,
    remove,
  };
}
