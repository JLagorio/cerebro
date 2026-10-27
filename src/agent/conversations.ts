import { sha256Hex } from '@/lib/sha256';
import { isPlace, placeKey, placeLabel, type Place } from '@/engine/place';
import { isGenerationRequestKey } from '@/agent/generationObservation';
import type {
  ChatMessage,
  Conversation,
  FailureNotice,
  MessagePart,
  RunReach,
  StepStatus,
  SubagentRun,
  ToolCall,
} from '@/agent/types';
import { isChangeset } from '@/engine/changeset';
import { effortRefusal, isUnset, modelRefusal } from '@/engine/runOptions';
import type { Decision } from '@/lib/policy/toolApproval';

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
/** The most of a subagent's answer a thread keeps (M91.4): what its
 * summary line shows. Rust sends no more. */
const SUMMARY_CHARS = 500;
/** `summary` cut to `SUMMARY_CHARS` characters as Rust counts them, by code
 * point, so an emoji is never split in half. */
const clipSummary = (summary: string): string =>
  summary.length <= SUMMARY_CHARS ? summary : Array.from(summary).slice(0, SUMMARY_CHARS).join('');
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
  if (!isPlace(place)) return { ...conversation, place: null, placeLabel: undefined };
  // A bare destination's label is the table's, never the stored one (M59.1):
  // a thread written as "Pulse" or "Workspace" reads History or Work. A
  // subject keeps the name it had (the M17.5 rule), so a deleted List still
  // reads as what it was.
  if (placeKey(place) === place.kind) return { ...conversation, placeLabel: placeLabel(place) };
  if (typeof conversation.placeLabel === 'string') return conversation;
  // A valid place whose label went missing is worth keeping — re-derive it.
  return { ...conversation, placeLabel: placeLabel(place) };
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

/**
 * Keep a stored branch point only as this build writes one (M91.6): a source
 * session and an anchor Rust would accept, on a thread with no session of
 * its own yet. A malformed one goes, and so does one whose thread has a
 * session by now: that session is the branch, already forked.
 */
function healFork(conversation: Conversation): Conversation {
  if (!('fork' in conversation)) return conversation;
  const raw = conversation.fork as unknown;
  const fork = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  const from = fork?.from;
  const at = fork?.at;
  if (
    conversation.sessionId === null &&
    typeof from === 'string' &&
    SESSION_ID.test(from) &&
    typeof at === 'string' &&
    SESSION_ID.test(at)
  ) {
    return Object.keys(fork ?? {}).length === 2
      ? conversation
      : { ...conversation, fork: { from, at } };
  }
  const { fork: _spent, ...rest } = conversation;
  return rest;
}

/**
 * `conversation` holding `sessionId`, the session its chat hook holds. A
 * branch's fork (M91.6) is spent once the thread has a session of its own,
 * the one Rust minted and forked, so it goes then.
 */
export function withSession(conversation: Conversation, sessionId: string | null): Conversation {
  if (sessionId === null || !('fork' in conversation)) return { ...conversation, sessionId };
  const { fork: _spent, ...rest } = conversation;
  return { ...rest, sessionId };
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

/**
 * Keep a reply's stored changesets only as this build reads them (M58.3):
 * an array of changesets whose every field it renders. A malformed entry is
 * dropped, and a field that is no array goes, so a stale build's write never
 * draws a footer that says something the run did not.
 */
function healChangesets(conversation: Conversation): Conversation {
  let changed = false;
  const messages = conversation.messages.map((m) => {
    const raw = (m as unknown as Record<string, unknown>).changesets;
    if (raw === undefined) return m;
    const kept = Array.isArray(raw) ? raw.filter(isChangeset) : [];
    if (Array.isArray(raw) && kept.length === raw.length) return m;
    changed = true;
    const { changesets: _dropped, ...rest } = m;
    return kept.length > 0 ? { ...rest, changesets: kept } : rest;
  });
  return changed ? { ...conversation, messages } : conversation;
}

/** An attach key as either backend mints one (M57.6): a durable run id, or
 * the browser's `mock-<page>-<run>`. */
const ATTACH_KEY = /^[A-Za-z0-9-]{1,80}$/;

/**
 * Keep a stored live turn only as this build writes one (M57.6): a safe
 * integer run, an attach key, and a reply this thread still holds. Anything
 * else would re-attach to nothing, or to a bubble that is not there, so it
 * reads as no live turn. A reply's cursor stays only as a non-negative
 * integer, and its gap mark only as `true`.
 */
function healLive(conversation: Conversation): Conversation {
  let changed = false;
  const messages = conversation.messages.map((m) => {
    const raw = m as unknown as Record<string, unknown>;
    const badSeq = 'seq' in raw && !(Number.isSafeInteger(raw.seq) && (raw.seq as number) >= 0);
    const badGap = 'gap' in raw && raw.gap !== true;
    const badChildTrace = 'childTraceUnavailable' in raw && raw.childTraceUnavailable !== true;
    if (!badSeq && !badGap && !badChildTrace) return m;
    changed = true;
    const kept = { ...raw };
    if (badSeq) delete kept.seq;
    if (badGap) delete kept.gap;
    if (badChildTrace) delete kept.childTraceUnavailable;
    return kept as unknown as ChatMessage;
  });
  const live = conversation.live as unknown;
  let keepLive = live === undefined || live === null;
  if (!keepLive && typeof live === 'object') {
    const l = live as Record<string, unknown>;
    keepLive =
      Number.isSafeInteger(l.run) &&
      typeof l.attach === 'string' &&
      ATTACH_KEY.test(l.attach) &&
      typeof l.assistantId === 'string' &&
      messages.some((m) => m.id === l.assistantId);
  }
  if (!changed && keepLive) return conversation;
  return { ...conversation, messages, ...(keepLive ? {} : { live: null }) };
}

/** A count of milliseconds as this build stores one. */
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Keep a reply's working time only as this build writes it (M92.2): a sum as
 * a count of milliseconds, or null for a reply a run left without one. A sum
 * this build cannot read is no sum it can show, so it reads null. The count
 * of the run still writing a reply stays only on the reply a live turn writes
 * into, as a part of its sum: only that run's Changeset can close it, and on
 * any other reply the count already stands in the sum.
 */
function healWorked(conversation: Conversation): Conversation {
  const fresh = conversation.live?.assistantId ?? null;
  let changed = false;
  const messages = conversation.messages.map((m) => {
    const raw = m as unknown as Record<string, unknown>;
    const badSum = 'workedMs' in raw && raw.workedMs !== null && !isCount(raw.workedMs);
    const badRun =
      'workedRun' in raw &&
      (m.id !== fresh ||
        badSum ||
        !isCount(raw.workedRun) ||
        !isCount(raw.workedMs) ||
        raw.workedRun > raw.workedMs);
    if (!badSum && !badRun) return m;
    changed = true;
    const kept = { ...raw };
    if (badSum) kept.workedMs = null;
    if (badRun) delete kept.workedRun;
    return kept as unknown as ChatMessage;
  });
  return changed ? { ...conversation, messages } : conversation;
}

/** The words a step's status is stored in (M91.10's `StepStatus`). */
const STEP_STATUSES: ReadonlySet<string> = new Set<StepStatus>([
  'running',
  'done',
  'failed',
  'interrupted',
  'waiting',
  'cancelled',
  'not_run',
  'paused',
]);

/** A recorded time as this build reads one: a string that parses. */
const isTime = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * A stored subagent as this build writes one (M91.4): its summary, with a
 * type, a task and a status in words this build draws, and its counts as
 * recorded. Its steps were never saved, and heal back from the session file.
 * One still running or waiting reads interrupted or not run unless `fresh`,
 * the reply a live turn writes into: nothing feeds it any more. Null for
 * anything else.
 */
function storedRun(raw: unknown, fresh: boolean): SubagentRun | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== 'string' || typeof r.description !== 'string') return null;
  if (typeof r.status !== 'string' || !STEP_STATUSES.has(r.status)) return null;
  const stale = !fresh && (r.status === 'running' || r.status === 'waiting');
  const run: SubagentRun = {
    type: r.type,
    description: r.description,
    status: stale ? (r.status === 'running' ? 'interrupted' : 'not_run') : (r.status as StepStatus),
    parts: [],
    tools: [],
  };
  if (typeof r.agentId === 'string') run.agentId = r.agentId;
  if (Number.isSafeInteger(r.toolUses) && (r.toolUses as number) >= 0) {
    run.toolUses = r.toolUses as number;
  }
  if (typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0) {
    run.durationMs = r.durationMs;
  }
  if (typeof r.summary === 'string') run.summary = clipSummary(r.summary);
  if (typeof r.model === 'string') run.model = r.model;
  return run;
}

/**
 * Keep a stored call's M91.4 fields only as this build writes them: its
 * times while they read as times, a denial in words, and its subagent as a
 * summary (`storedRun`). Its structured result is memory only, and a call on
 * a reply's own list is the main thread's, which names no parent. The same
 * call when nothing changed.
 */
function storedCall(tool: ToolCall, fresh: boolean): ToolCall {
  const raw = tool as unknown as Record<string, unknown>;
  const stray = [
    ...(['startedAt', 'endedAt'] as const).filter((key) => key in raw && !isTime(raw[key])),
    ...('denied' in raw && typeof raw.denied !== 'string' ? ['denied'] : []),
    ...(['parent', 'result'] as const).filter((key) => key in raw),
  ];
  if (stray.length === 0 && !('subagent' in raw)) return tool;
  const kept = { ...raw };
  for (const key of stray) delete kept[key];
  if ('subagent' in raw) {
    const run = storedRun(raw.subagent, fresh);
    if (run === null) delete kept.subagent;
    else kept.subagent = run;
  }
  return kept as unknown as ToolCall;
}

/**
 * A stored reply's parts as this build writes them (M91.4): a text part
 * with its id and words, the answer's taking its words from the reply's own
 * text (saved once), and a part naming one of its calls, once each.
 * Reasoning is memory only. A malformed entry is dropped, a call no part
 * names is added at the end, so no call is hidden, and a reply left with no
 * parts keeps none.
 */
function storedParts(raw: unknown, message: ChatMessage): MessagePart[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls = message.tools.map((tool) => tool.id);
  const named = new Set<string>();
  const ids = new Set<string>();
  const parts: MessagePart[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const part = entry as Record<string, unknown>;
    if (part.kind === 'tool') {
      const id = part.toolId;
      if (typeof id === 'string' && calls.includes(id) && !named.has(id)) {
        named.add(id);
        parts.push({ kind: 'tool', toolId: id });
      }
      continue;
    }
    if (part.kind !== 'text' || typeof part.id !== 'string' || part.id === '') continue;
    const text = part.text === undefined ? message.text : part.text;
    if (typeof text !== 'string' || text === '' || ids.has(part.id)) continue;
    ids.add(part.id);
    parts.push({ kind: 'text', id: part.id, text });
  }
  for (const id of calls) if (!named.has(id)) parts.push({ kind: 'tool', toolId: id });
  return parts.length === 0 ? undefined : parts;
}

/** Every word a plan decides a tool by, held to `Decision` by its type: a
 * word added there fails the typecheck here until it is added. */
const DECISION_WORDS: Readonly<Record<Decision, true>> = {
  allow: true,
  ask: true,
  deny: true,
  refuse: true,
  cli: true,
  queue: true,
};
const DECISIONS: ReadonlySet<string> = new Set(Object.keys(DECISION_WORDS));

/** A list of `{name, <second>}` entries, each of them text. */
function namedPairs(raw: unknown, second: string): boolean {
  return (
    Array.isArray(raw) &&
    raw.every((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const pair = entry as Record<string, unknown>;
      return typeof pair.name === 'string' && typeof pair[second] === 'string';
    })
  );
}

/** A stored reach as this build writes one (M92.8): every fact `RunReach`
 * names, each of its type, and each family's decisions in the plan's words. */
function isReach(raw: unknown): raw is RunReach {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  const families = r.families;
  return (
    namedPairs(r.connectors, 'status') &&
    namedPairs(r.missing, 'reason') &&
    Number.isSafeInteger(r.missing_more) &&
    (r.missing_more as number) >= 0 &&
    typeof r.inherits === 'boolean' &&
    typeof r.permission_mode === 'string' &&
    typeof r.cerebro === 'boolean' &&
    typeof families === 'object' &&
    families !== null &&
    !Array.isArray(families) &&
    Object.values(families).every(
      (decided: unknown) =>
        Array.isArray(decided) &&
        decided.every((word: unknown) => typeof word === 'string' && DECISIONS.has(word)),
    )
  );
}

/**
 * Keep a thread's reach only as this build writes it (M92.8): the thread's
 * own fact while it reads as one, and none on its replies, where it is
 * memory only. A reach this build cannot read is none it can show, so it
 * goes, and the thread reads as not recorded rather than as reaching
 * nothing (CV-05).
 */
function healReach(conversation: Conversation): Conversation {
  const stray = conversation.messages.some((m) => 'reach' in m);
  const unread = 'reach' in conversation && !isReach(conversation.reach);
  if (!stray && !unread) return conversation;
  const messages = stray
    ? conversation.messages.map((m) => {
        if (!('reach' in m)) return m;
        const { reach: _memoryOnly, ...rest } = m;
        return rest;
      })
    : conversation.messages;
  if (!unread) return { ...conversation, messages };
  const { reach: _unread, ...rest } = conversation;
  return { ...rest, messages };
}

/**
 * What a thread's runs last said they reach (M92.8): its newest reply's
 * Reach, else the one the thread saved. Null when no run of it has said, so
 * the rail reads it as not recorded (CV-05). The thread saves it as its own
 * small fact, so a reload, or a body trimmed to fit, still knows it.
 */
export function threadReach(
  conversation: Pick<Conversation, 'messages' | 'reach'>,
): RunReach | null {
  for (let at = conversation.messages.length - 1; at >= 0; at -= 1) {
    const reach = conversation.messages[at].reach;
    if (reach !== undefined) return reach;
  }
  return conversation.reach ?? null;
}

/**
 * Keep a reply's M91.4 fields only as this build writes them: its parts
 * (`storedParts`), its calls (`storedCall`), and its anchor as a session and
 * a line uuid, each one Rust would accept, or none.
 */
function healSteps(conversation: Conversation): Conversation {
  const fresh = conversation.live?.assistantId ?? null;
  let changed = false;
  const messages = conversation.messages.map((m) => {
    const raw = m as unknown as Record<string, unknown>;
    const kept: Record<string, unknown> = { ...raw };
    let touched = false;
    if ('anchor' in raw) {
      // A line's uuid is a lowercase UUID, as its session's id is.
      const a = raw.anchor as Record<string, unknown> | null;
      const valid =
        typeof a === 'object' &&
        a !== null &&
        typeof a.sessionId === 'string' &&
        SESSION_ID.test(a.sessionId) &&
        typeof a.uuid === 'string' &&
        SESSION_ID.test(a.uuid);
      if (!valid) {
        delete kept.anchor;
        touched = true;
      }
    }
    const tools = m.tools.map((tool) => storedCall(tool, m.id === fresh));
    if (tools.some((tool, at) => tool !== m.tools[at])) {
      kept.tools = tools;
      touched = true;
    }
    if ('parts' in raw) {
      // Always rebuilt: the answer's words come back from the reply's text.
      const parts = storedParts(raw.parts, { ...m, tools });
      if (parts === undefined) delete kept.parts;
      else kept.parts = parts;
      touched = true;
    }
    if (!touched) return m;
    changed = true;
    return kept as unknown as ChatMessage;
  });
  return changed ? { ...conversation, messages } : conversation;
}

/** An omission marker is a fact only while exactly true. */
function healCache(conversation: Conversation): Conversation {
  if (!('cacheTrimmed' in conversation) || conversation.cacheTrimmed === true) return conversation;
  const { cacheTrimmed: _invalid, ...rest } = conversation;
  return rest;
}

/** Cached observations are not fresh native facts. Retain only a valid
 * logical-send key; neither that key nor cached metadata can reattach work. */
function healGenerationMetadata(conversation: Conversation): Conversation {
  let changed = false;
  const messages = conversation.messages.map((message) => {
    const { generationObservation, generationRequestKey, nativeRecoveryRoot, ...rest } = message;
    const keepKey = message.role === 'assistant' && isGenerationRequestKey(generationRequestKey);
    if (
      nativeRecoveryRoot === undefined &&
      generationObservation === undefined &&
      (generationRequestKey === undefined || keepKey)
    ) {
      return message;
    }
    changed = true;
    return { ...rest, ...(keepKey ? { generationRequestKey } : {}) };
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
      .map(healCache)
      .map(healGenerationMetadata)
      .map(healToolIds)
      .map(healPlace)
      .map(healSessionId)
      .map(healFork)
      .map(healNotices)
      .map(healRunOptions)
      .map(healDeferred)
      .map(healLive)
      .map(healWorked)
      .map(healChangesets)
      .map(healSteps)
      .map(healReach);
  } catch {
    return [];
  }
}

/** A part as a thread saves it (M91.4): the answer's text part without its
 * words, which the reply's own text holds. */
type SavedPart = { kind: 'text'; id: string; text?: string } | { kind: 'tool'; toolId: string };

/** A subagent as a thread saves it (M91.4): its summary, the answer cut to
 * what its line shows. Its steps, its error and what only the live stream
 * said of it are memory only. */
function savedRun(run: SubagentRun) {
  const {
    background: _background,
    depth: _depth,
    progress: _progress,
    lastTool: _lastTool,
    error: _error,
    parts: _parts,
    tools: _tools,
    summary,
    ...kept
  } = run;
  return {
    ...kept,
    ...(summary === undefined ? {} : { summary: clipSummary(summary) }),
  };
}

/** A call as a thread saves it: its whole payload, a hook's pause, its
 * structured result and its subagent's steps are memory only. */
function savedCall({
  payload: _payload,
  paused: _paused,
  result: _result,
  subagent,
  ...call
}: ToolCall) {
  return subagent === undefined ? call : { ...call, subagent: savedRun(subagent) };
}

/** A reply's parts as a thread saves them: its calls and its words, the
 * answer's (the last part that reads as the reply's text) without them. */
function savedParts(parts: MessagePart[] | undefined, text: string): SavedPart[] | undefined {
  if (parts === undefined) return undefined;
  let answer = -1;
  parts.forEach((part, at) => {
    if (part.kind === 'text' && part.text === text) answer = at;
  });
  return parts.flatMap((part, at): SavedPart[] => {
    if (part.kind === 'reasoning') return [];
    if (part.kind === 'tool') return [part];
    return [at === answer ? { kind: 'text', id: part.id } : part];
  });
}

/** A message as a thread saves it: a reply's reach is the thread's to keep. */
function savedMessage({
  streaming: _streaming,
  live: _live,
  reach: _reach,
  generationObservation: _generationObservation,
  nativeRecoveryRoot: _nativeRecoveryRoot,
  generationRequestKey,
  parts,
  ...m
}: ChatMessage) {
  // This content was read back from the native archive. Keep only its selector;
  // a browser copy must not outlive that message's recorded expiry.
  if (
    m.archiveRecord !== undefined &&
    ['retained', 'expired'].includes(m.archiveRecord.persistence)
  ) {
    return {
      id: m.id,
      role: m.role,
      text: '',
      tools: [],
      archiveRecord: m.archiveRecord,
      ...(m.anchor === undefined ? {} : { anchor: m.anchor }),
      ...(m.role === 'assistant' && isGenerationRequestKey(generationRequestKey)
        ? { generationRequestKey }
        : {}),
    };
  }
  const saved = savedParts(parts, m.text);
  return {
    ...m,
    ...(m.role === 'assistant' && isGenerationRequestKey(generationRequestKey)
      ? { generationRequestKey }
      : {}),
    tools: m.tools.map(savedCall),
    ...(saved === undefined ? {} : { parts: saved }),
  };
}

type SavedThread = Omit<Conversation, 'messages'> & { messages: ReturnType<typeof savedMessage>[] };

/** A thread as it is saved: its messages as `savedMessage` keeps them, and
 * what its runs last said they reach (M92.8) once, as its own fact, which a
 * trim leaves standing. */
function savedThread(conversation: Conversation): SavedThread {
  const reach = threadReach(conversation);
  const { reach: _held, ...rest } = conversation;
  return {
    ...rest,
    ...(conversation.archiveTitle === true ? { title: DEFAULT_TITLE } : {}),
    ...(reach === null ? {} : { reach }),
    messages: conversation.messages.map(savedMessage),
  };
}

/** Is `err` the browser saying its storage is full? */
function isQuotaExceeded(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

/**
 * `threads` with one more thread's body trimmed (M91.4), or null when there
 * is none left to trim. The oldest thread by its last turn loses its
 * messages: Claude Code's session file still holds them, and opening the
 * thread rebuilds it; a thread with no session file goes only after every
 * thread with one. A thread with a turn running goes last, and keeps the
 * question and the reply its turn writes into, which a re-attach needs
 * (CV-30).
 */
function trimmed(threads: SavedThread[]): SavedThread[] | null {
  const age = (thread: SavedThread) => thread.updatedAt ?? thread.createdAt;
  const oldest = (candidates: SavedThread[]) =>
    candidates.reduce<SavedThread | null>(
      (old, thread) => (old === null || age(thread) < age(old) ? thread : old),
      null,
    );
  const bodies = threads.filter((t) => t.live == null && t.messages.length > 0);
  // A thread with no session has no file to rebuild it from: it goes after
  // every thread that has one.
  const idle = oldest(bodies.filter((t) => t.sessionId != null)) ?? oldest(bodies);
  if (idle !== null) {
    return threads.map((t) => (t === idle ? { ...t, messages: [], cacheTrimmed: true } : t));
  }
  const core = (thread: SavedThread) => {
    const at = thread.messages.findIndex((m) => m.id === thread.live?.assistantId);
    let asked = at - 1;
    while (asked >= 0 && thread.messages[asked].role !== 'user') asked -= 1;
    return thread.messages.filter((_, i) => i === at || (i === asked && at !== -1));
  };
  const busy = oldest(threads.filter((t) => t.live != null && core(t).length < t.messages.length));
  if (busy !== null) {
    return threads.map((t) => (t === busy ? { ...t, messages: core(t), cacheTrimmed: true } : t));
  }
  return null;
}

/** A successful quota decision, with no copied bodies or growing ID list.
 * At most MAX_KEPT source-array references and two retained IDs per entry.
 * Those arrays stay alive until the next successful save or invalidation. */
interface CacheAdmission {
  source: ChatMessage[];
  before: number;
  retained: string[];
  sessionId: string | null;
  vault: string | undefined;
  createdAt: string;
  assistantId: string | undefined;
}
let admissions = new Map<string, CacheAdmission>();
let admittedStorage: string | null | undefined;
let admittedOrder: string[] = [];

export function saveConversations(conversations: Conversation[]): void {
  // Streaming flags are per-session; persisting one leaves a conversation
  // that reopens claiming to still be thinking. A turn still running keeps
  // `live` and its reply's `seq` instead (M57.6): reopening re-attaches to
  // it and sets its own flag from what the run says. The reducer's live state
  // (M56.3) is memory only, for the same reason. So are whole tool payloads
  // (M56.8, Q21): the threads share localStorage's quota, and Claude Code's
  // session file holds them, so a reload heals them back while it exists
  // and the copy keeps the previews. A hook outside Cerebro's pause
  // (M57.1) is memory only too: after a reload the call reads not run. So
  // are a turn's reasoning, its calls' structured results and its
  // subagents' steps (M91.4), which heal back the same way; a subagent is
  // saved as its summary, and the answer's words once, as the reply's text.
  // What a run reached (M92.8) is live only and no file heals it, so the
  // thread keeps the latest as its own fact rather than on each reply.
  try {
    const sources = conversations.slice(0, MAX_KEPT);
    const order = sources.map((c) => c.id);
    // An external overwrite/clear, or a changed list, is a new admission.
    if (
      window.localStorage.getItem(KEY) !== admittedStorage ||
      order.length !== admittedOrder.length ||
      order.some((id, at) => id !== admittedOrder[at])
    ) {
      admissions.clear();
    }
    let threads: SavedThread[] = sources.map((c) => {
      const prior = admissions.get(c.id);
      if (
        prior === undefined ||
        prior.sessionId !== c.sessionId ||
        prior.vault !== c.vault ||
        prior.createdAt !== c.createdAt ||
        (c.live != null && c.live.assistantId !== prior.assistantId) ||
        c.messages.length < prior.before ||
        prior.source.slice(0, prior.before).some((m, at) => c.messages[at] !== m)
      ) {
        return savedThread(c);
      }
      // Compare object identity before reading body fields: a real heal or
      // replacement, even with the same IDs, must try admission afresh.
      return savedThread({
        ...c,
        reach: threadReach(c),
        cacheTrimmed: true,
        messages: c.messages.filter((m, at) => at >= prior.before || prior.retained.includes(m.id)),
      });
    });
    for (;;) {
      try {
        const raw = JSON.stringify(threads);
        window.localStorage.setItem(KEY, raw);
        // Only successful writes make a decision reusable. Trimming removes
        // a prefix except for at most the live question and reply.
        const next = new Map<string, CacheAdmission>();
        sources.forEach((c, at) => {
          const kept = new Set(threads[at].messages.map((m) => m.id));
          let before = 0;
          c.messages.forEach((m, index) => {
            if (!kept.has(m.id)) before = index + 1;
          });
          if (before === 0) return;
          const retained = c.messages
            .slice(0, before)
            .filter((m) => kept.has(m.id))
            .map((m) => m.id);
          if (retained.length > 2) return;
          next.set(c.id, {
            source: c.messages,
            before,
            retained,
            sessionId: c.sessionId,
            vault: c.vault,
            createdAt: c.createdAt,
            assistantId: c.live?.assistantId,
          });
        });
        admissions = next;
        admittedStorage = raw;
        admittedOrder = order;
        return;
      } catch (err) {
        // Full (M91.4): the oldest threads' bodies go until the rest fits,
        // so a save never leaves a running turn's `live` unsaved.
        const fewer = isQuotaExceeded(err) ? trimmed(threads) : null;
        if (fewer === null) throw err;
        threads = fewer;
      }
    }
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

/** A committed native deletion removes only this known vault's cached copy.
 * Unknown-vault and other-vault legacy records cannot be silently claimed. */
const archiveDeletionListeners = new Set<(vault: string, thread: string) => void>();
export function onArchivedConversationDeleted(
  listener: (vault: string, thread: string) => void,
): () => void {
  archiveDeletionListeners.add(listener);
  return () => {
    archiveDeletionListeners.delete(listener);
  };
}
export function forgetArchivedConversation(vault: string, thread: string): void {
  saveConversations(
    loadConversations().filter((item) => item.id !== thread || item.vault !== vault),
  );
  for (const listener of [...archiveDeletionListeners]) listener(vault, thread);
}

/** The existing cache reader, applied to one record so a malformed neighbor stays opaque. */
export function readCachedConversation(raw: unknown): Conversation | null {
  if (!isConversation(raw)) return null;
  try {
    const messages = raw.messages
      .filter((message) => !('parent' in message) || message.parent == null)
      .map((message) => {
        const excluded = new Set(
          message.tools.filter((tool) => tool.parent != null).map((tool) => tool.id),
        );
        return {
          ...message,
          tools: message.tools.filter((tool) => tool.parent == null),
          ...(message.parts === undefined
            ? {}
            : {
                parts: message.parts.filter(
                  (part) =>
                    (!('parent' in part) || part.parent == null) &&
                    (part.kind !== 'tool' || !excluded.has(part.toolId)),
                ),
              }),
        };
      });
    let value = { ...raw, messages };
    for (const heal of [
      healCache,
      healGenerationMetadata,
      healToolIds,
      healPlace,
      healSessionId,
      healFork,
      healNotices,
      healRunOptions,
      healDeferred,
      healLive,
      healWorked,
      healChangesets,
      healSteps,
      healReach,
    ])
      value = heal(value);
    return value;
  } catch {
    return null;
  }
}
function rawPairFingerprint(
  raw: unknown,
  vault: string,
  thread: string,
  user: string,
  assistant: string,
): string | null {
  if (!isConversation(raw) || raw.vault !== vault || raw.id !== thread) return null;
  try {
    const questions = raw.messages.filter((message) => message.id === user);
    const answers = raw.messages.filter((message) => message.id === assistant);
    if (
      questions.length !== 1 ||
      answers.length !== 1 ||
      questions[0].role !== 'user' ||
      answers[0].role !== 'assistant'
    )
      return null;
    return sha256Hex(JSON.stringify([questions[0], answers[0]]));
  } catch {
    return null;
  }
}
export interface CacheImportRead {
  records: Conversation[];
  unreadable: number;
  fingerprint(vault: string, thread: string, user: string, assistant: string): string | null;
}
export function readCacheForImport(): CacheImportRead {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return { records: [], unreadable: 1, fingerprint: () => null };
    let unreadable = 0;
    const records = raw.flatMap((item) => {
      const decoded = readCachedConversation(item);
      if (decoded === null) {
        unreadable += 1;
        return [];
      }
      return [decoded];
    });
    return {
      records,
      unreadable,
      fingerprint: (vault, thread, user, assistant) => {
        const candidates = raw.filter(
          (item) => isConversation(item) && item.id === thread && item.vault === vault,
        );
        return candidates.length === 1
          ? rawPairFingerprint(candidates[0], vault, thread, user, assistant)
          : null;
      },
    };
  } catch {
    return { records: [], unreadable: 1, fingerprint: () => null };
  }
}

export interface ArchiveReadbackMark {
  messageId: string;
  record: NonNullable<ChatMessage['archiveRecord']>;
}
type ImportedListener = (
  vault: string,
  thread: string,
  marks: readonly ArchiveReadbackMark[],
) => void;
const importedListeners = new Set<ImportedListener>();
export function onImportedCacheReadback(listener: ImportedListener): () => void {
  importedListeners.add(listener);
  return () => {
    importedListeners.delete(listener);
  };
}
/** Preserve opaque/unknown neighbors byte-for-value; change only snapshot-matching pairs.
 * Does not trim the cache or claim success when storage/readback failed. */
export function clearImportedCacheBodies(
  vault: string,
  confirmed: readonly import('@/lib/generated/conversations').ImportedIdentity[],
  matches: (
    thread: Conversation,
    user: string,
    assistant: string,
    rawFingerprint: string | null,
  ) => boolean,
): number {
  try {
    const original = window.localStorage.getItem(KEY);
    const parsed: unknown = JSON.parse(original ?? '[]');
    if (!Array.isArray(parsed)) return 0;
    const notifications: { thread: string; marks: ArchiveReadbackMark[] }[] = [];
    let cleared = 0;
    const next = parsed.map((raw) => {
      if (!isConversation(raw)) return raw;
      const thread = readCachedConversation(raw);
      if (thread === null || thread.vault !== vault) return raw;
      const pairs = confirmed.filter(
        (item) =>
          item.threadId === thread.id &&
          matches(
            thread,
            item.userMessageId,
            item.assistantMessageId,
            rawPairFingerprint(raw, vault, thread.id, item.userMessageId, item.assistantMessageId),
          ),
      );
      if (pairs.length === 0) return raw;
      const marks = pairs.flatMap((item) => {
        const completedAt =
          'completedAt' in item &&
          (typeof item.completedAt === 'string' || item.completedAt === null)
            ? item.completedAt
            : undefined;
        const record = {
          attemptId: item.attemptId,
          expiresAt: item.expiresAt,
          persistence: 'retained' as const,
          origin: 'browser_cache' as const,
          importedAt: item.importedAt,
          ...(completedAt === undefined ? {} : { completedAt }),
        };
        return [
          { messageId: item.userMessageId, record },
          { messageId: item.assistantMessageId, record },
        ];
      });
      const byId = new Map(marks.map((mark) => [mark.messageId, mark.record]));
      notifications.push({ thread: thread.id, marks });
      cleared += pairs.length;
      // The decoder is only a validation view. Keep the current raw carrier and
      // every unconfirmed message unchanged, including fields the decoder cannot
      // understand. Only a confirmed exact original pair becomes minimal markers.
      const decodedById = new Map(thread.messages.map((message) => [message.id, message]));
      return {
        ...raw,
        archiveBacked: true,
        messages: raw.messages.map((message) => {
          const record = byId.get(message.id);
          if (record === undefined) return message;
          const decoded = decodedById.get(message.id);
          if (decoded === undefined) throw new Error('Confirmed cache message unavailable');
          return savedMessage({ ...decoded, archiveRecord: record });
        }),
      };
    });
    if (cleared === 0 || window.localStorage.getItem(KEY) !== original) return 0;
    const encoded = JSON.stringify(next);
    window.localStorage.setItem(KEY, encoded);
    if (window.localStorage.getItem(KEY) !== encoded) return 0;
    for (const item of notifications)
      for (const listener of [...importedListeners]) listener(vault, item.thread, item.marks);
    return cleared;
  } catch {
    return 0;
  }
}
