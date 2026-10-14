import { isPlace, placeLabel, type Place } from '@/engine/place';
import type { ChatMessage, Conversation, FailureNotice } from '@/agent/types';
import { effortRefusal, isUnset, modelRefusal } from '@/engine/runOptions';

/**
 * Named conversations (M9.5).
 *
 * The list, and a cached copy of each thread's messages, live in
 * localStorage. The transcript itself is Claude Code's session file, which
 * the panel folds back when the copy is gone (M56.3, `useConversations`).
 * Neither goes in the vault, deliberately: a transcript is a tool log, not a
 * note. Writing it into the vault would put it in the corpus the background
 * distiller reads, so the assistant would end up learning from its own
 * output — the exact loop M8's "nothing speaks first" model exists to avoid.
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
    // Deliberately unanchored. A thread is stamped at its first TURN (M17.5),
    // not at creation: an empty thread is not about anywhere, and anchoring it
    // on open would file every thread under whatever surface the panel was
    // opened from — including the surface the agent had just navigated to.
    place: null,
  };
}

/**
 * Stamp a conversation with the place its first turn happened in (M17.5).
 *
 * Idempotent by design: an already-anchored thread keeps its anchor even if
 * the user walks somewhere else and keeps typing. Where a conversation STARTED
 * is a fact about it; following the user's feet would make it a fact about the
 * user instead, and the thread would be un-findable by what it was about.
 */
export function anchor(
  conversation: Conversation,
  place: Place,
  lookup?: Parameters<typeof placeLabel>[1],
): Conversation {
  if (conversation.place != null) return conversation;
  return { ...conversation, place, placeLabel: placeLabel(place, lookup) };
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
  // Cut at a word boundary so the title does not end mid-word — nor on the
  // separator of a labelled ask ("… about this? ·", M52.4).
  const cut = text.slice(0, 42);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[\s·—:-]+$/, '')}…`;
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

/**
 * Drop a stored place this build cannot read (M17.5).
 *
 * localStorage holds whatever an older — or newer — build wrote, and a place
 * is a Selection, whose kinds the app keeps retiring: `view` (M10), `project`
 * (M12.5), `review` (M33.3), `pipeline` (M33.4), `status` (M33a.2) and `docs`
 * (M38.3). An unreadable anchor reads as "not anchored", which renders as
 * nothing; the transcript itself is never at risk over it.
 */
function healPlace(conversation: Conversation): Conversation {
  const { place } = conversation;
  if (place == null) return conversation;
  if (isPlace(place) && typeof conversation.placeLabel === 'string') return conversation;
  // A valid place whose label went missing is worth keeping — re-derive it.
  if (isPlace(place)) return { ...conversation, placeLabel: placeLabel(place) };
  return { ...conversation, place: null, placeLabel: undefined };
}

/** A Claude Code session id as Rust accepts one: a lowercase UUID. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Drop a stored session id that is not one (M56.3). Older mock builds stored
 * `mock-session`, and Rust refuses any id that is not a UUID before a run
 * starts; a thread holding one would refuse every send. Read as never
 * recorded, it starts a new session instead.
 */
function healSessionId(conversation: Conversation): Conversation {
  const { sessionId } = conversation;
  if (sessionId === null || (typeof sessionId === 'string' && SESSION_ID.test(sessionId))) {
    return conversation;
  }
  return { ...conversation, sessionId: null };
}

/** A stored notice the card can render: its words are strings, and each
 * optional field is a string or null (M56.4). */
function isNotice(raw: unknown): raw is FailureNotice {
  if (typeof raw !== 'object' || raw === null) return false;
  const n = raw as Record<string, unknown>;
  const optional = (v: unknown) => v === undefined || v === null || typeof v === 'string';
  return (
    typeof n.kind === 'string' &&
    typeof n.title === 'string' &&
    typeof n.body === 'string' &&
    optional(n.action) &&
    optional(n.resets_at) &&
    optional(n.window) &&
    optional(n.cli_version)
  );
}

/**
 * Drop a stored failure notice that is not one (M56.4). localStorage holds
 * whatever a build wrote; a notice whose words are missing would draw an
 * empty card, while dropping it leaves the raw error, which says something.
 */
function healNotices(conversation: Conversation): Conversation {
  let changed = false;
  const messages = conversation.messages.map((m) => {
    if (m.notice === undefined || isNotice(m.notice)) return m;
    changed = true;
    const { notice: _dropped, ...rest } = m;
    return rest;
  });
  return changed ? { ...conversation, messages } : conversation;
}

/**
 * Drop a stored model or effort Rust would refuse (M56.5). localStorage holds
 * whatever a build wrote; a pick that refuses every send would leave the
 * thread unusable, while dropping it falls back to Claude Code's default.
 */
function healRunOptions(conversation: Conversation): Conversation {
  const keep = (value: unknown, refusal: (v: string) => string | null) =>
    typeof value === 'string' && !isUnset(value) && refusal(value) === null ? value : null;
  const model = keep(conversation.model, modelRefusal);
  const effort = keep(conversation.effort, effortRefusal);
  if ((conversation.model ?? null) === model && (conversation.effort ?? null) === effort) {
    return conversation;
  }
  return { ...conversation, model, effort };
}

/**
 * Keep a stored call's deferral marks only as this build writes them (M57.1):
 * `deferred` and `cancelled` while true, and nothing else. `paused` is memory
 * only, and a value some build wrote that is not `true` would draw a status
 * the call never had, so it is dropped.
 */
function healDeferred(conversation: Conversation): Conversation {
  let changed = false;
  const messages = conversation.messages.map((m) => {
    let touched = false;
    const tools = m.tools.map((tool) => {
      const raw = tool as unknown as Record<string, unknown>;
      const stray = (['deferred', 'cancelled'] as const).filter(
        (key) => key in raw && raw[key] !== true,
      );
      if (stray.length === 0 && !('paused' in raw)) return tool;
      touched = true;
      const kept = { ...raw };
      for (const key of [...stray, 'paused']) delete kept[key];
      return kept as unknown as typeof tool;
    });
    if (!touched) return m;
    changed = true;
    return { ...m, tools };
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
    return parsed
      .filter(isConversation)
      .map(healToolIds)
      .map(healPlace)
      .map(healSessionId)
      .map(healNotices)
      .map(healRunOptions)
      .map(healDeferred);
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    // Streaming flags are per-session; persisting one leaves a conversation
    // that reopens claiming to still be thinking. The reducer's live state
    // (M56.3) is memory only, for the same reason. So are whole tool payloads
    // (M56.8, Q21): the threads share localStorage's quota, and Claude Code's
    // session file holds them, so a reload heals them back while it exists
    // and the copy keeps the previews. A hook outside Cerebro's pause
    // (M57.1) is memory only too: after a reload the call reads not run.
    const clean = conversations.slice(0, MAX_KEPT).map((c) => ({
      ...c,
      messages: c.messages.map(({ streaming: _s, live: _l, ...m }) =>
        m.tools.some((t) => t.payload !== undefined || t.paused !== undefined)
          ? { ...m, tools: m.tools.map(({ payload: _p, paused: _q, ...t }) => t) }
          : m,
      ),
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
