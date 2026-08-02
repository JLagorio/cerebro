import type { ChatMessage, Conversation } from '@/agent/types';

/**
 * Named conversations (M9.5).
 *
 * Stored in localStorage rather than the vault, deliberately: a transcript
 * is a tool log, not a note. Writing it into the vault would put it in the
 * corpus the background distiller reads, so the assistant would end up
 * learning from its own output — the exact loop M8's "nothing speaks first"
 * model exists to avoid.
 */

const KEY = 'cerebro.conversations';
/** Which conversation the panel was last showing (M15). Without it, closing
 * and reopening the panel silently swapped you into the newest thread. */
const ACTIVE_KEY = 'cerebro.activeConversation';
/** Enough to find last week's thread; not enough to bloat localStorage. */
const MAX_KEPT = 30;
export const DEFAULT_TITLE = 'New conversation';

let counter = 0;
export function newConversationId(): string {
  counter += 1;
  return `c${Date.now().toString(36)}-${counter}`;
}

export function newConversation(): Conversation {
  return {
    id: newConversationId(),
    title: DEFAULT_TITLE,
    usesDefaultTitle: true,
    sessionId: null,
    messages: [],
    createdAt: new Date().toISOString(),
    archived: false,
  };
}

/**
 * Title a conversation from its first user message.
 *
 * Generated locally rather than by asking the agent: a title is not worth a
 * round trip, and one that arrives three seconds late reads as a glitch.
 */
export function titleFrom(messages: ChatMessage[]): string | null {
  const first = messages.find((m) => m.role === 'user');
  if (first === undefined) return null;
  const text = first.text.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  if (text.length <= 42) return text;
  // Cut at a word boundary so the title does not end mid-word.
  const cut = text.slice(0, 42);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/** Apply the auto-title, unless the user has named it themselves. */
export function retitle(conversation: Conversation): Conversation {
  if (!conversation.usesDefaultTitle) return conversation;
  const title = titleFrom(conversation.messages);
  return title === null ? conversation : { ...conversation, title };
}

function isConversation(raw: unknown): raw is Conversation {
  if (typeof raw !== 'object' || raw === null) return false;
  const c = raw as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.title === 'string' && Array.isArray(c.messages);
}

/**
 * Transcripts written before M15 recorded every tool twice — `["t-1","t-1"]` —
 * because `ToolStart` appended without checking the id. Those rows are already
 * on disk, so fixing the writer is not enough: React still logs a duplicate-key
 * error and paints every tool row twice for anyone with existing history. First
 * write of an id wins; a later one only fills in a field the first one lacked.
 */
function healToolIds(conversation: Conversation): Conversation {
  let changed = false;
  const messages = conversation.messages.map((m) => {
    if (m.tools.length < 2) return m;
    const byId = new Map<string, (typeof m.tools)[number]>();
    for (const tool of m.tools) {
      const seen = byId.get(tool.id);
      if (seen === undefined) byId.set(tool.id, tool);
      else
        byId.set(tool.id, {
          ...seen,
          done: seen.done || tool.done,
          failed: seen.failed || tool.failed,
          output: seen.output ?? tool.output,
        });
    }
    if (byId.size === m.tools.length) return m;
    changed = true;
    return { ...m, tools: [...byId.values()] };
  });
  return changed ? { ...conversation, messages } : conversation;
}

export function loadConversations(): Conversation[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Tolerant like every other load path: one malformed record must not
    // take the whole history with it.
    return parsed.filter(isConversation).map(healToolIds);
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    // Streaming flags are per-session; persisting one leaves a conversation
    // that reopens claiming to still be thinking.
    const clean = conversations.slice(0, MAX_KEPT).map((c) => ({
      ...c,
      messages: c.messages.map(({ streaming: _s, ...m }) => m),
    }));
    window.localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    // Storage unavailable (private mode): conversations stay session-only.
  }
}

/** The id of the conversation that was last open, if one was recorded. */
export function loadActiveId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveId(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // Storage unavailable (private mode): the choice stays session-only.
  }
}

/** Most recent first, archived last. */
export function ordered(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}
