import type { AgentResultData, StepStatus } from '@/engine/ai/types';
import { upsertChangeset } from '@/engine/changeset';
import { cliTool } from '@/lib/policy/tools';
import type {
  AgentStreamEvent,
  ChatMessage,
  MessagePart,
  PrLink,
  SubagentRun,
  ToolCall,
  ToolPayload,
} from './types';

/**
 * The one reducer from agent events to messages (M56.3, CV-27).
 *
 * Claude Code's live stream and the session file it writes fold, in Rust
 * (src-tauri/src/agent/fold.rs), into one event vocabulary. This turns those
 * events into chat messages, for a turn being watched ('live') and for a
 * thread rebuilt from the file ('replay') alike, so a restored thread reads
 * the way the live one did. Pure: no DOM, no store, no IPC.
 *
 * The text rule: a turn's reply is its LAST message's text. A turn narrates
 * as it works ("Reading both notes.") before it answers, and the narration is
 * not the answer. Live, the deltas show as they stream, and TurnEnded swaps in
 * the final message's text; replayed, the text is every message's text until
 * the turn's end says which was last. A turn that never ended (stopped, or
 * cut off) keeps all of it, and reads interrupted. A turn suspended on a
 * deferred call (M57.1) has not ended either, and is not interrupted: its
 * call reads waiting, cancelled or not run (transcriptRows.ts), and the
 * resume that answers it goes on in the same bubble. A turn a person stopped
 * (Rust's Cancelled, M57.5, live only) reads cancelled and keeps what it
 * wrote; the session file never says it, so a replay reads it interrupted.
 *
 * The parts (M91.4) keep the turn in order: each message's text, each
 * reasoning block and each main-thread call, by id. Text parts are one per
 * message, so a continuation's answer never erases the one before it. Live,
 * deltas stream into an open part that the whole block then settles: a
 * Thinking replaces what its ThinkingDeltas wrote, never adds to it. Thinking
 * with no words draws no part. A part's id is its place among its kind, so a
 * live turn and its replay name the same parts.
 *
 * A subagent's events name the Agent call that started it as their `parent`
 * (M91.3b) and land in that call's SubagentRun, made at its start and
 * searched for through nested runs, never in the turn's own text, calls or
 * error. Its identity and progress come from the live-only Subagent* events,
 * its report from the call's ToolResult; one still running when its message
 * stops streaming reads interrupted.
 *
 * Times are the CLI's own (`at`). A duration the reducer measures is the
 * difference of two of them and nothing else (CV-05): a reasoning block's
 * runs from the step before it on its thread, a subagent's first from its
 * call's start. One Claude Code counted itself, a subagent's or a run's, is
 * kept as it said it.
 *
 * A tool call's input and output arrive as previews; where a preview cut
 * one, a ToolPayload follows with the whole (M56.8), and it lands on the tool
 * by id in either mode. Payloads stay in memory: conversations.ts saves the
 * previews only.
 *
 * A run's Changeset (M58.3, live only) lands on the reply, one per run by its
 * run id: a resume after a held call is a second run, so a second entry.
 *
 * What a run reaches (M92.8, live only) lands on the reply too, as its Reach
 * said it: the latest run's, so a resume's stands in place of the held
 * run's, and the same Reach heard again changes nothing.
 *
 * How long Claude Code worked on a reply (M92.2) is the sum of its runs' own
 * counts, `duration_ms`, from each run's Result or, when a hook held it, its
 * ToolDeferred. The count is upserted by run: a later count of the same run
 * replaces its earlier one, and the run's Changeset, its last word, closes
 * it, so a resume adds its own once. A run that closed with no count beside
 * one that gave a count leaves no sum (CV-05), and a session file counts
 * nothing, so a replayed reply has none.
 */

export type ReduceMode = 'live' | 'replay';

type Live = NonNullable<ChatMessage['live']>;
type Event<K extends AgentStreamEvent['kind']> = Extract<AgentStreamEvent, { kind: K }>;
type TextPart = Extract<MessagePart, { kind: 'text' }>;
type ReasoningPart = Extract<MessagePart, { kind: 'reasoning' }>;

const EMPTY_LIVE: Live = { messageId: null, finalText: '', allText: '', ended: false };

/** The main thread's key among a turn's threads; a subagent's is the id of
 * the Agent call that started it. */
const MAIN = '';

/** How Claude Code words a subagent's end (its task notification and its
 * report's status), as a step's status. A word it does not list changes
 * nothing. */
const RUN_ENDS: Readonly<Record<string, StepStatus>> = {
  completed: 'done',
  failed: 'failed',
  killed: 'interrupted',
};

/** A subagent that has not reached an end of its own. */
const UNENDED: ReadonlySet<StepStatus> = new Set(['running', 'waiting']);

const join = (a: string, b: string): string => (a === '' ? b : `${a}\n\n${b}`);

/** `text`, unless it is empty: the fold sends "" for a word the CLI never
 * gave, and nothing prints it. */
const named = (text: string | undefined): text is string => text !== undefined && text !== '';

/**
 * The time from one recorded `at` to another, in milliseconds (M91.4): absent
 * when either is missing or unreadable, or when they run backwards, never 0
 * for a time nobody recorded (CV-05). The one rule for a duration, here and
 * in what draws one.
 */
export function durationBetween(
  from: string | undefined,
  to: string | undefined,
): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

/** Is `name` the CLI's subagent tool, by its row or an alias (`Agent`,
 * `Task`)? The manifest says (CV-04). */
function startsSubagent(name: string): boolean {
  return cliTool(name)?.renderer === 'subagent';
}

/** A call's input preview as an object, or an empty one. */
function inputOf(call: ToolCall): Record<string, unknown> {
  if (call.input === null) return {};
  try {
    const parsed: unknown = JSON.parse(call.input);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The run an Agent call starts, as its input names it: its type and what it
 * was asked, empty where the input names neither. */
function runOf(call: ToolCall): SubagentRun {
  const input = inputOf(call);
  const words = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  return {
    type: words('subagent_type'),
    description: words('description'),
    status: call.done ? (call.failed ? 'failed' : 'done') : 'running',
    parts: [],
    tools: [],
  };
}

/** The call `id`, wherever it is: the main thread's calls first, then each
 * subagent's, depth first. */
export function findCall(tools: readonly ToolCall[], id: string): ToolCall | null {
  for (const call of tools) {
    if (call.id === id) return call;
    if (call.subagent !== undefined) {
      const inner = findCall(call.subagent.tools, id);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/** `tools` with the call `id` replaced by `change` of it, wherever it is; null
 * when no call has that id. */
function updateCall(
  tools: ToolCall[],
  id: string,
  change: (call: ToolCall) => ToolCall,
): ToolCall[] | null {
  for (let at = 0; at < tools.length; at++) {
    const call = tools[at];
    let next: ToolCall | null = null;
    if (call.id === id) {
      next = change(call);
    } else if (call.subagent !== undefined) {
      const inner = updateCall(call.subagent.tools, id, change);
      if (inner !== null) next = { ...call, subagent: { ...call.subagent, tools: inner } };
    }
    if (next !== null) {
      const updated = tools.slice();
      updated[at] = next;
      return updated;
    }
  }
  return null;
}

/** `tools` with the run of the Agent call `id` changed, made from the call
 * when it has none yet; null when no call has that id. */
function updateRun(
  tools: ToolCall[],
  id: string,
  change: (run: SubagentRun) => SubagentRun,
): ToolCall[] | null {
  return updateCall(tools, id, (call) => ({
    ...call,
    subagent: change(call.subagent ?? runOf(call)),
  }));
}

/** One thread of a turn: the main thread's parts and calls, or a
 * subagent's. */
interface Chain {
  parts: MessagePart[];
  tools: ToolCall[];
}

/**
 * A message's parts. One saved before M91.4 has none, and starts from what
 * it shows, its text and then its calls, so a part added to it later never
 * hides them.
 */
function partsOf(message: ChatMessage): MessagePart[] {
  if (message.parts !== undefined) return message.parts;
  const parts: MessagePart[] = message.tools.map((tool) => ({ kind: 'tool', toolId: tool.id }));
  return message.text === ''
    ? parts
    : [{ kind: 'text', id: 'text-1', text: message.text }, ...parts];
}

/** `message` with the thread `parent` names changed: the main thread when it
 * names none, else the run of that Agent call. Null when no call has that
 * id: a subagent's event never lands on the turn itself. */
function withChain(
  message: ChatMessage,
  parent: string | undefined,
  change: (chain: Chain) => Chain,
): ChatMessage | null {
  if (parent === undefined) {
    const next = change({ parts: partsOf(message), tools: message.tools });
    return { ...message, parts: next.parts, tools: next.tools };
  }
  const tools = updateRun(message.tools, parent, (run) => {
    const next = change({ parts: run.parts, tools: run.tools });
    return { ...run, parts: next.parts, tools: next.tools };
  });
  return tools === null ? null : { ...message, tools };
}

/** The id the next `kind` part of a thread takes: its place among that
 * kind's, so a live turn and its replay name it alike; a subagent's carry its
 * call, so no two parts of a turn share one. */
function partId(parts: readonly MessagePart[], kind: 'text' | 'reasoning', key: string): string {
  const taken = new Set(parts.flatMap((part) => (part.kind === 'tool' ? [] : [part.id])));
  let n = parts.filter((part) => part.kind === kind).length + 1;
  const idOf = (count: number) => (key === MAIN ? `${kind}-${count}` : `${key}:${kind}-${count}`);
  while (taken.has(idOf(n))) n += 1;
  return idOf(n);
}

/** `parts` with every reasoning block that was streaming settled as it
 * stands: the same array when none was. */
function closeReasoning(parts: MessagePart[]): MessagePart[] {
  if (!parts.some((part) => part.kind === 'reasoning' && part.streaming === true)) return parts;
  return parts.map((part) => {
    if (part.kind !== 'reasoning' || part.streaming !== true) return part;
    const { streaming: _streaming, ...settled } = part;
    return settled;
  });
}

/** `record` with `key` at `value`, or without it when there is none: a step
 * nobody timed leaves the next one untimed. */
function stamp(
  record: Record<string, string> | undefined,
  key: string,
  value: string | undefined,
): Record<string, string> | undefined {
  if (value !== undefined) return { ...record, [key]: value };
  if (record === undefined || !(key in record)) return record;
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

/** `live` with nothing streaming into a text part. */
function closed(live: Live): Live {
  if (live.openText === undefined) return live;
  const { openText: _open, ...rest } = live;
  return rest;
}

/**
 * Place one text block of message `messageId` on the thread `key`: a second
 * block of the message its last text part holds joins that part, as the text
 * rule joins them; any other starts a part. Live, the deltas wrote it into
 * the open part already, which takes the block's words (or joins the part
 * before it).
 */
function placeText(
  parts: MessagePart[],
  live: Live,
  key: string,
  messageId: string,
  text: string,
): { parts: MessagePart[]; live: Live } {
  const open =
    key === MAIN && live.openText !== undefined
      ? parts.findIndex((part) => part.kind === 'text' && part.id === live.openText)
      : -1;
  const before = open === -1 ? parts.length - 1 : open - 1;
  const previous = before >= 0 ? parts[before] : undefined;
  const textOf = live.textOf ?? {};
  const next: Live = {
    ...(key === MAIN ? closed(live) : live),
    textOf: { ...textOf, [key]: messageId },
  };
  if (previous?.kind === 'text' && textOf[key] === messageId) {
    const joined = parts.slice();
    joined[before] = { ...previous, text: join(previous.text, text) };
    if (open !== -1) joined.splice(open, 1);
    return { parts: joined, live: next };
  }
  if (open !== -1) {
    const settled = parts.slice();
    settled[open] = { ...(parts[open] as TextPart), text };
    return { parts: settled, live: next };
  }
  return { parts: [...parts, { kind: 'text', id: partId(parts, 'text', key), text }], live: next };
}

/** One reasoning block as its whole Thinking says it, timed from the step
 * before it on its thread. */
function reasoningPart(
  id: string,
  event: Event<'Thinking'>,
  since: string | undefined,
): ReasoningPart {
  const durationMs = durationBetween(since, event.at);
  return {
    kind: 'reasoning',
    id,
    text: event.text,
    ...(event.redacted === true ? { redacted: true as const } : {}),
    ...(event.at === undefined ? {} : { at: event.at }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

/** A run with what its Agent call's report says (M91.3a): who it was, how it
 * ended and how much it did, and its answer. */
function reported(run: SubagentRun, data: AgentResultData): SubagentRun {
  const status = data.status === undefined ? undefined : RUN_ENDS[data.status];
  return {
    ...run,
    ...(named(data.agent_id) ? { agentId: data.agent_id } : {}),
    ...(named(data.agent_type) ? { type: data.agent_type } : {}),
    ...(status === undefined ? {} : { status }),
    ...(data.tool_uses === undefined ? {} : { toolUses: data.tool_uses }),
    ...(data.duration_ms === undefined ? {} : { durationMs: data.duration_ms }),
    ...(named(data.model) ? { model: data.model } : {}),
    ...(named(data.summary) ? { summary: data.summary } : {}),
  };
}

/** A count of milliseconds, as Claude Code gives one. */
const isCount = (ms: unknown): ms is number =>
  typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;

/**
 * `message` with the count the run writing it gave of how long it worked
 * (M92.2): the run's count stands in `workedMs` once, a later count of the
 * same run replacing its earlier one. A reply that holds a run with no count
 * keeps no sum: one marked so stays so, and so does one whose earlier run
 * closed before any run counted (a reply saved before M92.2 among them).
 * Only the live stream counts: a session file holds no result line.
 */
function counted(message: ChatMessage, ms: number | undefined, mode: ReduceMode): ChatMessage {
  if (mode !== 'live' || !isCount(ms) || message.workedMs === null) return message;
  if (message.workedMs === undefined && (message.changesets?.length ?? 0) > 0) {
    return { ...message, workedMs: null };
  }
  return {
    ...message,
    workedMs: (message.workedMs ?? 0) - (message.workedRun ?? 0) + ms,
    workedRun: ms,
  };
}

/**
 * `message` with the run writing it closed (M92.2), at its Changeset: a
 * count it gave stands in the sum, and a run that gave none beside one that
 * did leaves the reply with no sum. The same message when nothing changed.
 */
function closeCount(message: ChatMessage): ChatMessage {
  if (message.workedRun !== undefined) {
    const { workedRun: _closed, ...rest } = message;
    return rest;
  }
  return typeof message.workedMs === 'number' ? { ...message, workedMs: null } : message;
}

/** Parent-tagged child evidence must belong to an Agent call in this turn.
 * Call IDs alone cannot move a result between different child threads.
 * CLI denials deliberately name no parent and keep their existing global
 * lookup; the four tool events below carry an explicit thread contract. */
function hasUnownedChildEvidence(message: ChatMessage, event: AgentStreamEvent): boolean {
  if ('parent' in event && event.parent !== undefined) {
    const parent = findCall(message.tools, event.parent);
    if (parent === null || !startsSubagent(parent.name)) return true;
  }
  switch (event.kind) {
    case 'ToolStart':
    case 'ToolDone':
    case 'ToolPayload':
    case 'ToolResult': {
      const call = findCall(message.tools, event.tool_id);
      if (event.kind === 'ToolResult' && event.data.type === 'agent') {
        if (call === null || !startsSubagent(call.name)) return true;
        const recorded = call.subagent?.agentId;
        if (named(recorded) && named(event.data.agent_id) && recorded !== event.data.agent_id) {
          return true;
        }
      }
      if (call !== null) {
        if (
          event.kind === 'ToolStart' &&
          call.name !== event.tool_name &&
          (event.parent !== undefined ||
            startsSubagent(call.name) ||
            startsSubagent(event.tool_name))
        )
          return true;
        return call.parent !== event.parent;
      }
      return event.kind !== 'ToolStart' && event.parent !== undefined;
    }
    case 'SubagentStarted':
    case 'SubagentProgress':
    case 'SubagentDone': {
      const call = findCall(message.tools, event.tool_id);
      if (call === null || !startsSubagent(call.name)) return true;
      const recorded = call.subagent?.agentId;
      return (
        event.kind === 'SubagentStarted' &&
        named(recorded) &&
        named(event.agent_id) &&
        recorded !== event.agent_id
      );
    }
    default:
      return false;
  }
}

/** Apply one event to the assistant message of its turn. Unknown kinds, and
 * kinds that are not about the message (Init, UserPrompt, PrLink,
 * Interaction, Done), change nothing. `session` is the turn's Claude Code
 * session, which a branch anchor names. */
export function applyEvent(
  message: ChatMessage,
  event: AgentStreamEvent,
  mode: ReduceMode,
  session: string | null = null,
): ChatMessage {
  if (hasUnownedChildEvidence(message, event)) {
    return message.childTraceUnavailable === true
      ? message
      : { ...message, childTraceUnavailable: true };
  }
  const live = message.live ?? EMPTY_LIVE;
  switch (event.kind) {
    case 'TextDelta': {
      // Deltas exist only live, and only the main thread streams. Once the
      // turn has ended its text is settled: a continuation's words reach its
      // parts and wait for its own end.
      const parts = partsOf(message);
      const last = parts.length - 1;
      const open =
        live.openText !== undefined
          ? parts.findIndex((part) => part.kind === 'text' && part.id === live.openText)
          : // A reply restored mid-turn (M57.6) lost which part was open: its
            // last, when that is text, is the block still streaming, which
            // its Text then settles whole.
            message.live === undefined && parts[last]?.kind === 'text'
            ? last
            : -1;
      let next: MessagePart[];
      let openText: string;
      if (open === -1) {
        openText = partId(parts, 'text', MAIN);
        next = [...closeReasoning(parts), { kind: 'text', id: openText, text: event.text }];
      } else {
        const part = parts[open] as TextPart;
        openText = part.id;
        next = parts.slice();
        next[open] = { ...part, text: part.text + event.text };
      }
      return {
        ...message,
        parts: next,
        live: { ...live, openText },
        ...(live.ended ? {} : { text: message.text + event.text }),
      };
    }
    case 'Text': {
      const key = event.parent ?? MAIN;
      const timed: Live = { ...live, lastAt: stamp(live.lastAt, key, event.at) };
      if (event.parent !== undefined) {
        // A subagent's words are its own, never the turn's reply.
        const call = findCall(message.tools, event.parent);
        if (call === null || event.text === '') return message;
        const placed = placeText(
          (call.subagent ?? runOf(call)).parts,
          timed,
          key,
          event.message_id,
          event.text,
        );
        const next = withChain(message, event.parent, (chain) => ({
          ...chain,
          parts: placed.parts,
        }));
        return next === null ? message : { ...next, live: placed.live };
      }
      const same = live.messageId === event.message_id;
      const words: Live = {
        ...timed,
        messageId: event.message_id,
        finalText: same ? join(live.finalText, event.text) : event.text,
        allText: join(live.allText, event.text),
      };
      const placed =
        event.text === ''
          ? { parts: message.parts, live: words }
          : placeText(partsOf(message), words, MAIN, event.message_id, event.text);
      const next: ChatMessage = {
        ...message,
        live: placed.live,
        ...(placed.parts === undefined ? {} : { parts: placed.parts }),
      };
      // Live text keeps its deltas until the turn's end; replayed text shows
      // all of it until then.
      return mode === 'replay' ? { ...next, text: placed.live.allText } : next;
    }
    case 'ThinkingDelta': {
      // Live only, and never a subagent's (M91.3a): it writes into the open
      // reasoning part, which its Thinking then settles.
      const parts = partsOf(message);
      const open = parts.findIndex((part) => part.kind === 'reasoning' && part.streaming === true);
      if (open === -1) {
        const id = partId(parts, 'reasoning', MAIN);
        return {
          ...message,
          parts: [...parts, { kind: 'reasoning', id, text: event.text, streaming: true }],
        };
      }
      const next = parts.slice();
      const part = parts[open] as ReasoningPart;
      next[open] = { ...part, text: part.text + event.text };
      return { ...message, parts: next };
    }
    case 'Thinking': {
      const key = event.parent ?? MAIN;
      const since = live.lastAt?.[key];
      const timed: Live = { ...live, lastAt: stamp(live.lastAt, key, event.at) };
      // Thinking Claude Code kept to itself draws nothing; withheld thinking
      // still says it was there.
      const shows = event.text !== '' || event.redacted === true;
      if (event.parent !== undefined) {
        const next = withChain(message, event.parent, (chain) =>
          shows
            ? {
                ...chain,
                parts: [
                  ...chain.parts,
                  reasoningPart(partId(chain.parts, 'reasoning', key), event, since),
                ],
              }
            : chain,
        );
        return next === null ? message : { ...next, live: timed };
      }
      const parts = message.parts;
      const open =
        parts === undefined
          ? -1
          : parts.findIndex((part) => part.kind === 'reasoning' && part.streaming === true);
      if (open !== -1 && parts !== undefined) {
        // The whole block settles what its deltas wrote: it replaces it.
        const next = parts.slice();
        if (shows) next[open] = reasoningPart((parts[open] as ReasoningPart).id, event, since);
        else next.splice(open, 1);
        return { ...message, parts: next, live: timed };
      }
      if (!shows) return { ...message, live: timed };
      const base = partsOf(message);
      return {
        ...message,
        parts: [...base, reasoningPart(partId(base, 'reasoning', MAIN), event, since)],
        live: timed,
      };
    }
    case 'ToolStart': {
      // A tool id is unique within a turn, so a repeat is a redelivery of the
      // same call and never a second row, and a redelivery never un-finishes
      // a row ToolDone already finished (M15, PR #7): only what the start
      // knows is refreshed, wherever the call is.
      const refreshed = updateCall(message.tools, event.tool_id, (call) => ({
        ...call,
        name: event.tool_name,
        input: event.input ?? call.input,
        ...(call.startedAt === undefined && event.at !== undefined ? { startedAt: event.at } : {}),
      }));
      if (refreshed !== null) return { ...message, tools: refreshed };
      const key = event.parent ?? MAIN;
      const call: ToolCall = {
        id: event.tool_id,
        name: event.tool_name,
        input: event.input ?? null,
        output: null,
        done: false,
        failed: false,
        ...(event.parent === undefined ? {} : { parent: event.parent }),
        ...(event.at === undefined ? {} : { startedAt: event.at }),
      };
      let lastAt = stamp(live.lastAt, key, event.at);
      if (startsSubagent(event.tool_name)) {
        call.subagent = runOf(call);
        // Its subagent's first step is timed from the call's start.
        lastAt = stamp(lastAt, call.id, event.at);
      }
      const next = withChain(message, event.parent, (chain) => ({
        // A call ends the reasoning before it.
        parts: [...closeReasoning(chain.parts), { kind: 'tool', toolId: call.id }],
        tools: [...chain.tools, call],
      }));
      return next === null ? message : { ...next, live: { ...live, lastAt } };
    }
    case 'ToolDone': {
      const found = findCall(message.tools, event.tool_id);
      if (found === null) return message;
      const failed = event.is_error === true;
      const tools = updateCall(message.tools, event.tool_id, (call) => {
        const done: ToolCall = {
          ...call,
          done: true,
          output: event.output ?? null,
          failed,
          ...(event.at === undefined ? {} : { endedAt: event.at }),
        };
        // A foreground subagent ends when its call returns; one in the
        // background goes on, and its own notice says how it ended.
        const run = call.subagent;
        if (run !== undefined && run.background !== true && UNENDED.has(run.status)) {
          done.subagent = { ...run, status: failed ? 'failed' : 'done' };
        }
        return done;
      });
      return {
        ...message,
        tools: tools ?? message.tools,
        live: { ...live, lastAt: stamp(live.lastAt, found.parent ?? MAIN, event.at) },
      };
    }
    case 'ToolDeferred': {
      // M92.2: the held run's result counted how long it worked till then.
      const worked = counted(message, event.duration_ms, mode);
      const tools = updateCall(worked.tools, event.tool_id, (call) => ({
        ...call,
        deferred: true,
        ...(call.subagent !== undefined &&
        call.subagent.status === 'running' &&
        call.subagent.agentId === undefined
          ? { subagent: { ...call.subagent, status: 'waiting' as const } }
          : {}),
      }));
      if (tools !== null) return { ...worked, tools };
      // A deferral read without its start still gets a row.
      return {
        ...worked,
        tools: [
          ...worked.tools,
          {
            id: event.tool_id,
            name: event.tool_name,
            input: null,
            output: null,
            done: false,
            failed: false,
            deferred: true,
          },
        ],
        parts: [...partsOf(worked), { kind: 'tool', toolId: event.tool_id }],
      };
    }
    case 'ToolCancelled': {
      const tools = updateCall(message.tools, event.tool_id, (call) =>
        call.done
          ? call
          : {
              ...call,
              cancelled: true,
              ...(call.subagent !== undefined && UNENDED.has(call.subagent.status)
                ? { subagent: { ...call.subagent, status: 'cancelled' as const } }
                : {}),
            },
      );
      return tools === null ? message : { ...message, tools };
    }
    case 'ToolPayload': {
      const tools = updateCall(message.tools, event.tool_id, (call) => ({
        ...call,
        payload: withPart(call.payload, event),
      }));
      return tools === null ? message : { ...message, tools };
    }
    case 'ToolResult': {
      const tools = updateCall(message.tools, event.tool_id, (call) => ({
        ...call,
        result: event.data,
        ...(event.data.type === 'agent'
          ? { subagent: reported(call.subagent ?? runOf(call), event.data) }
          : {}),
      }));
      return tools === null ? message : { ...message, tools };
    }
    case 'ToolDenied': {
      // It names no thread: the call is found wherever it is, and one the
      // turn never started gets no row.
      const tools = updateCall(message.tools, event.tool_id, (call) => ({
        ...call,
        denied: event.message,
      }));
      return tools === null ? message : { ...message, tools };
    }
    case 'SubagentStarted': {
      const tools = updateRun(message.tools, event.tool_id, (run) => ({
        ...run,
        ...(named(event.agent_id) ? { agentId: event.agent_id } : {}),
        // What its call asked for stands; the CLI's words fill a gap.
        ...(run.type === '' && named(event.subagent_type) ? { type: event.subagent_type } : {}),
        ...(run.description === '' && named(event.description)
          ? { description: event.description }
          : {}),
        background: event.background,
        ...(event.depth === undefined ? {} : { depth: event.depth }),
        ...(run.status === 'waiting' ? { status: 'running' as const } : {}),
      }));
      return tools === null ? message : { ...message, tools };
    }
    case 'SubagentProgress': {
      const tools = updateRun(message.tools, event.tool_id, (run) => ({
        ...run,
        ...(named(event.description) ? { progress: event.description } : {}),
        ...(named(event.last_tool) ? { lastTool: event.last_tool } : {}),
        ...(event.tool_uses === undefined ? {} : { toolUses: event.tool_uses }),
        ...(event.duration_ms === undefined ? {} : { durationMs: event.duration_ms }),
      }));
      return tools === null ? message : { ...message, tools };
    }
    case 'SubagentDone': {
      const status = RUN_ENDS[event.status];
      const tools = updateRun(message.tools, event.tool_id, (run) => ({
        ...run,
        ...(status === undefined ? {} : { status }),
        ...(event.tool_uses === undefined ? {} : { toolUses: event.tool_uses }),
        ...(event.duration_ms === undefined ? {} : { durationMs: event.duration_ms }),
      }));
      return tools === null ? message : { ...message, tools };
    }
    case 'ModelChanged':
      return { ...message, model: event.model };
    case 'Reach':
      // M92.8: what the run writing this reply reaches, as Rust said it once
      // the run's first init was admitted.
      return { ...message, reach: event.reach };
    case 'Result': {
      // M92.2: how long the run worked, as its result counted it.
      const worked = counted(message, event.duration_ms, mode);
      // The final message's text is the reply; with none (a reply no Text
      // event carried), the result's text, which also settles the part its
      // deltas streamed or stands as the turn's one text part; with neither,
      // what streamed.
      if (live.finalText !== '') return { ...worked, text: live.finalText };
      if (event.text.trim() === '') return worked;
      const parts = partsOf(worked);
      const open =
        live.openText === undefined
          ? -1
          : parts.findIndex((part) => part.kind === 'text' && part.id === live.openText);
      if (open !== -1) {
        const next = parts.slice();
        next[open] = { ...(parts[open] as TextPart), text: event.text };
        return { ...worked, text: event.text, parts: next, live: closed(live) };
      }
      if (parts.some((part) => part.kind === 'text')) return { ...worked, text: event.text };
      return {
        ...worked,
        text: event.text,
        parts: [...parts, { kind: 'text', id: partId(parts, 'text', MAIN), text: event.text }],
      };
    }
    case 'TurnEnded': {
      // A branch starts from the turn's last main-thread line (M91.4); a
      // continuation's end moves it there.
      const anchor =
        named(event.last_uuid) && session !== null && session !== ''
          ? { sessionId: session, uuid: event.last_uuid }
          : message.anchor;
      return {
        ...message,
        ...(message.parts === undefined ? {} : { parts: closeReasoning(message.parts) }),
        live: { ...closed(live), ended: true },
        text: live.finalText !== '' ? live.finalText : message.text,
        ...(anchor === undefined ? {} : { anchor }),
      };
    }
    case 'TurnInterrupted':
      return {
        ...message,
        ...(message.parts === undefined ? {} : { parts: closeReasoning(message.parts) }),
        live: { ...closed(live), ended: true },
        interrupted: true,
      };
    case 'Cancelled':
      // M57.5: the partial text stays; the bubble says a person stopped it.
      return { ...message, cancelled: true };
    case 'Changeset': {
      // A run's last word (M58.3). One from a run this reply had not heard
      // close closes its count of how long it worked (M92.2); one it holds
      // already only brings it up to date. A run with no durable id names no
      // run the reply could hold.
      const run = event.changeset.run_id;
      const heard = run !== null && (message.changesets ?? []).some((c) => c.run_id === run);
      const next = { ...message, changesets: upsertChangeset(message.changesets, event.changeset) };
      return heard ? next : closeCount(next);
    }
    case 'Error': {
      if (event.parent !== undefined) {
        // A subagent's own failure (M91.3b): its run reads failed, in its
        // words, and the turn's bubble never says it.
        const tools = updateRun(message.tools, event.parent, (run) => ({
          ...run,
          status: 'failed',
          error: event.message,
        }));
        return tools === null ? message : { ...message, tools };
      }
      // The notice rides beside the raw words (M56.4): the card shows both.
      return event.notice != null
        ? { ...message, error: event.message, notice: event.notice }
        : { ...message, error: event.message };
    }
    default:
      return message;
  }
}

/** `payload` with one part whole, as a ToolPayload carried it. */
function withPart(payload: ToolPayload | undefined, event: Event<'ToolPayload'>): ToolPayload {
  return event.part === 'input'
    ? {
        ...payload,
        input: event.text,
        inputBytes: event.bytes,
        inputTruncated: event.truncated,
      }
    : {
        ...payload,
        output: event.text,
        outputBytes: event.bytes,
        outputTruncated: event.truncated,
      };
}

/** `tools` with every subagent still running read interrupted, through
 * nested runs: the same array when none was. */
function interruptRuns(tools: ToolCall[]): ToolCall[] {
  let changed = false;
  const next = tools.map((call) => {
    const run = call.subagent;
    if (run === undefined) return call;
    const inner = interruptRuns(run.tools);
    const running = run.status === 'running';
    if (!running && inner === run.tools) return call;
    changed = true;
    return {
      ...call,
      subagent: { ...run, tools: inner, ...(running ? { status: 'interrupted' as const } : {}) },
    };
  });
  return changed ? next : tools;
}

/** A message nothing streams into any more (M91.4): its open reasoning
 * settles as it stands and a subagent still running reads interrupted. The
 * same message when there was nothing to settle. */
function quieted(message: ChatMessage): ChatMessage {
  const parts = message.parts === undefined ? undefined : closeReasoning(message.parts);
  const tools = interruptRuns(message.tools);
  const live = message.live === undefined ? undefined : closed(message.live);
  if (parts === message.parts && tools === message.tools && live === message.live) return message;
  return {
    ...message,
    tools,
    ...(parts === undefined ? {} : { parts }),
    ...(live === undefined ? {} : { live }),
  };
}

/** A reply that stopped streaming for a reason of its own, a stop or a read
 * that failed (M91.4): what it streamed settles as it stands, and a subagent
 * still running reads interrupted. */
export function stopStreaming(message: ChatMessage): ChatMessage {
  return { ...quieted(message), streaming: false };
}

/** Is the message's turn suspended on a deferred call (M57.1): one it holds
 * deferred and unfinished? */
export function suspendedOn(message: ChatMessage): ToolCall | null {
  return message.tools.find((t) => t.deferred === true && !t.done) ?? null;
}

/** A live turn's run is over (its Done): it stops streaming, and a turn that
 * never said it ended reads interrupted, unless it is suspended on a
 * deferred call (M57.1), whose row says what became of it. */
export function endLiveTurn(message: ChatMessage): ChatMessage {
  const ended = message.live?.ended === true || suspendedOn(message) !== null;
  return stopStreaming(
    ended || message.interrupted === true ? message : { ...message, interrupted: true },
  );
}

export interface Replayed {
  messages: ChatMessage[];
  /** The last model Claude Code reported, if any. */
  model: string | null;
  prLinks: PrLink[];
}

/** Drop the reducer's in-memory state from a finished message; an `open`
 * one, still going, keeps its running subagents running. */
function settled(message: ChatMessage, open = false): ChatMessage {
  const quiet = open
    ? {
        ...message,
        ...(message.parts === undefined ? {} : { parts: closeReasoning(message.parts) }),
      }
    : quieted(message);
  const { live: _live, streaming: _streaming, ...rest } = quiet;
  return rest;
}

/** Rebuild a thread from its folded session file: a user bubble and an
 * assistant bubble per prompt, ids derived from the session so a rebuild is
 * stable. With `open`, the file's run is still going: its last turn's
 * subagents still running read running, not interrupted. */
export function replayTranscript(
  events: AgentStreamEvent[],
  sessionId: string,
  options: { open?: boolean } = {},
): Replayed {
  const messages: ChatMessage[] = [];
  const prLinks: PrLink[] = [];
  let model: string | null = null;
  let turn = 0;
  // The open turn's assistant bubble, in a holder so the helpers below can
  // replace it.
  const open: { assistant: ChatMessage | null } = { assistant: null };
  const close = () => {
    if (open.assistant !== null) messages.push(settled(open.assistant));
    open.assistant = null;
  };
  const begin = (text: string | null): ChatMessage => {
    close();
    turn += 1;
    if (text !== null) {
      messages.push({ id: `${sessionId}-t${turn}-u`, role: 'user', text, tools: [] });
    }
    const assistant: ChatMessage = {
      id: `${sessionId}-t${turn}-a`,
      role: 'assistant',
      text: '',
      tools: [],
    };
    open.assistant = assistant;
    return assistant;
  };
  for (const event of events) {
    switch (event.kind) {
      case 'UserPrompt':
        begin(event.text);
        break;
      case 'PrLink':
        if (!prLinks.some((link) => link.url === event.url)) {
          prLinks.push({ number: event.number, url: event.url, repository: event.repository });
        }
        break;
      case 'Init':
      case 'Done':
      case 'ThinkingDelta':
        break;
      default: {
        if (event.kind === 'ModelChanged') model = event.model;
        const assistant = open.assistant ?? begin(null);
        open.assistant = applyEvent(assistant, event, 'replay', sessionId);
      }
    }
  }
  if (open.assistant !== null) messages.push(settled(open.assistant, options.open === true));
  return { messages, model, prLinks };
}

/** A part's key among its message's parts: a call by its id, a text or
 * reasoning part by its own. */
const partKey = (part: MessagePart): string =>
  part.kind === 'tool' ? `tool:${part.toolId}` : `${part.kind}:${part.id}`;

/**
 * `cached` parts with the reasoning `rebuilt` holds put back where it was
 * (M91.4), or null when there is none to add or the two do not hold the same
 * text and calls in the same order: reasoning is memory only, so a reloaded
 * copy has none, and its words are kept as they are.
 */
function withReasoning(cached: MessagePart[], rebuilt: MessagePart[]): MessagePart[] | null {
  if (cached.some((part) => part.kind === 'reasoning')) return null;
  if (!rebuilt.some((part) => part.kind === 'reasoning')) return null;
  const others = rebuilt.filter((part) => part.kind !== 'reasoning');
  if (
    others.length !== cached.length ||
    others.some((part, at) => partKey(part) !== partKey(cached[at]))
  ) {
    return null;
  }
  let at = 0;
  return rebuilt.map((part) => (part.kind === 'reasoning' ? part : cached[at++]));
}

/**
 * Heal a cached thread from its rebuild (Q6): the cached copy stays on
 * screen, wording and all, and a tool row it holds unfinished (a reload
 * mid-turn) takes its completion from the rebuilt row with the same tool id.
 * A row the cache holds without its payload (the cache keeps previews only,
 * M56.8), its structured result or its times takes the rebuilt row's, and so
 * do a subagent's calls, at any depth (M91.4). A subagent the cache keeps as
 * its summary takes its steps back from the rebuild, and one it left
 * unfinished takes how it ended. A reply the rebuild also holds (by id,
 * anchor or a call) takes back its reasoning, its anchor, and, when it had
 * none, its parts, if its answer reads the same. The same array comes back
 * when nothing changed. Healing uses only one matched reply and requires
 * compatible call names, parents and known child identities. Conflicting or
 * ambiguous attribution keeps the cached reply's content and marks its child
 * details unavailable; a partial rebuild never grafts another child's words.
 */
export function healFromTranscript(cached: ChatMessage[], rebuilt: ChatMessage[]): ChatMessage[] {
  // null records an ambiguous key rather than letting the last row win.
  const index = <T>(map: Map<string, T | null>, key: string, value: T) => {
    map.set(key, map.has(key) && map.get(key) !== value ? null : value);
  };
  const rowsOf = (tools: ToolCall[]): Map<string, ToolCall | null> => {
    const rows = new Map<string, ToolCall | null>();
    const collect = (list: ToolCall[]) => {
      for (const tool of list) {
        index(rows, tool.id, tool);
        if (tool.subagent !== undefined) collect(tool.subagent.tools);
      }
    };
    collect(tools);
    return rows;
  };
  const byId = new Map<string, ChatMessage | null>();
  const byAnchor = new Map<string, ChatMessage | null>();
  const byCall = new Map<string, ChatMessage | null>();
  const anchorKey = (anchor: NonNullable<ChatMessage['anchor']>) =>
    JSON.stringify([anchor.sessionId, anchor.uuid]);
  for (const message of rebuilt) {
    if (message.role !== 'assistant') continue;
    index(byId, message.id, message);
    if (message.anchor !== undefined) index(byAnchor, anchorKey(message.anchor), message);
    for (const tool of message.tools) index(byCall, tool.id, message);
  }

  const healTools = (tools: ToolCall[], rows: Map<string, ToolCall | null>): ToolCall[] => {
    let touched = false;
    const next = tools.map((tool) => {
      const healed = healTool(tool, rows);
      if (healed !== tool) touched = true;
      return healed;
    });
    return touched ? next : tools;
  };

  const healRun = (
    run: SubagentRun,
    row: SubagentRun | undefined,
    rows: Map<string, ToolCall | null>,
  ): SubagentRun => {
    let next = run;
    if (row !== undefined && run.parts.length === 0 && run.tools.length === 0) {
      if (row.parts.length > 0 || row.tools.length > 0) {
        next = { ...next, parts: row.parts, tools: row.tools };
      }
    } else {
      const tools = healTools(run.tools, rows);
      if (tools !== run.tools) next = { ...next, tools };
    }
    if (row === undefined) return next;
    const fill: Partial<SubagentRun> = {};
    if (run.agentId === undefined && row.agentId !== undefined) fill.agentId = row.agentId;
    if (run.model === undefined && row.model !== undefined) fill.model = row.model;
    if (run.summary === undefined && row.summary !== undefined) fill.summary = row.summary;
    if (run.toolUses === undefined && row.toolUses !== undefined) fill.toolUses = row.toolUses;
    if (run.durationMs === undefined && row.durationMs !== undefined) {
      fill.durationMs = row.durationMs;
    }
    if (run.type === '' && row.type !== '') fill.type = row.type;
    if (run.description === '' && row.description !== '') fill.description = row.description;
    const unfinished = !['done', 'failed', 'cancelled'].includes(run.status);
    if (unfinished && ['done', 'failed', 'cancelled'].includes(row.status))
      fill.status = row.status;
    return Object.keys(fill).length === 0 ? next : { ...next, ...fill };
  };

  /** What the rebuilt row with this id adds to a cached one: the same row
   * when nothing. */
  const healTool = (tool: ToolCall, rows: Map<string, ToolCall | null>): ToolCall => {
    const row = rows.get(tool.id);
    let next = tool;
    if (row !== undefined && row !== null) {
      const complete = !tool.done && row.done;
      const payload = tool.payload === undefined && row.payload !== undefined;
      const result = tool.result === undefined && row.result !== undefined;
      const started = tool.startedAt === undefined && row.startedAt !== undefined;
      const ended = tool.endedAt === undefined && row.endedAt !== undefined;
      if (complete || payload || result || started || ended) {
        next = {
          ...tool,
          ...(complete
            ? { done: true, failed: row.failed, output: tool.output ?? row.output }
            : {}),
          ...(payload ? { payload: row.payload } : {}),
          ...(result ? { result: row.result } : {}),
          ...(started ? { startedAt: row.startedAt } : {}),
          ...(ended ? { endedAt: row.endedAt } : {}),
        };
      }
    }
    if (next.subagent === undefined) {
      return row?.subagent === undefined ? next : { ...next, subagent: row.subagent };
    }
    const run = healRun(next.subagent, row?.subagent, rows);
    return run === next.subagent ? next : { ...next, subagent: run };
  };

  /** The rebuilt reply a cached one is: by id, by anchor, or by a call. */
  const twinOf = (message: ChatMessage): ChatMessage | null | undefined => {
    const byItsId = byId.get(message.id);
    if (byItsId !== undefined) return byItsId;
    if (message.anchor !== undefined) {
      const anchored = byAnchor.get(anchorKey(message.anchor));
      if (anchored !== undefined) return anchored;
    }
    let candidate: ChatMessage | undefined;
    for (const tool of message.tools) {
      const holder = byCall.get(tool.id);
      if (
        holder === null ||
        (holder !== undefined && candidate !== undefined && holder !== candidate)
      )
        return null;
      if (holder !== undefined) candidate = holder;
    }
    return candidate;
  };

  let changed = false;
  const healed = cached.map((message) => {
    if (message.role !== 'assistant') return message;
    let next = message;
    const twin = twinOf(message);
    const rows = rowsOf(twin?.tools ?? []);
    const held = rowsOf(message.tools);
    const conflict =
      twin === null ||
      [...rows.values(), ...held.values()].some((row) => row === null) ||
      [...held.values()].some((tool) => {
        if (tool === null) return false;
        const row = rows.get(tool.id);
        if (row === undefined || row === null) return false;
        return (
          tool.name !== row.name ||
          tool.parent !== row.parent ||
          (tool.subagent?.agentId !== undefined &&
            row.subagent?.agentId !== undefined &&
            tool.subagent.agentId !== row.subagent.agentId)
        );
      });
    if (conflict && next.childTraceUnavailable !== true) {
      next = { ...next, childTraceUnavailable: true };
    }
    if (twin !== undefined && twin !== null) {
      if (twin.childTraceUnavailable === true && next.childTraceUnavailable !== true) {
        next = { ...next, childTraceUnavailable: true };
      }
    }
    if (!conflict && twin !== undefined && twin !== null) {
      const tools = healTools(message.tools, rows);
      if (tools !== message.tools) next = { ...next, tools };
      if (next.anchor === undefined && twin.anchor !== undefined) {
        next = { ...next, anchor: twin.anchor };
      }
      if (twin.parts !== undefined) {
        if (next.parts === undefined) {
          if (twin.text === next.text) next = { ...next, parts: twin.parts };
        } else {
          const parts = withReasoning(next.parts, twin.parts);
          if (parts !== null) next = { ...next, parts };
        }
      }
    }
    if (next !== message) changed = true;
    return next;
  });
  return changed ? healed : cached;
}

const ENDED_RUN: ReadonlySet<StepStatus> = new Set(['done', 'failed', 'cancelled']);

/** `tools` from the file with what the panel saw of each call and the file
 * cannot hold kept, by id at any depth: a person's cancel, a pause (M57.1)
 * and Claude Code's own denial, which only the live stream says (M91.3a). */
function keepLiveCalls(tools: ToolCall[], cached: ToolCall[]): ToolCall[] {
  const seen = new Map<string, ToolCall>();
  const collect = (list: ToolCall[]) => {
    for (const call of list) {
      seen.set(call.id, call);
      if (call.subagent !== undefined) collect(call.subagent.tools);
    }
  };
  collect(cached);
  const carry = (list: ToolCall[]): ToolCall[] =>
    list.map((call) => {
      const was = seen.get(call.id);
      if (was === undefined && call.subagent === undefined) return call;
      const run = call.subagent;
      return {
        ...call,
        ...(was?.cancelled === true ? { cancelled: true } : {}),
        ...(was?.paused === true ? { paused: true } : {}),
        ...(was?.denied !== undefined && call.denied === undefined ? { denied: was.denied } : {}),
        ...(run === undefined
          ? {}
          : {
              subagent: {
                ...run,
                tools: carry(run.tools),
                ...(was?.subagent?.status === 'cancelled' && !ENDED_RUN.has(run.status)
                  ? { status: 'cancelled' as const }
                  : {}),
              },
            }),
      };
    });
  return seen.size === 0 ? tools : carry(tools);
}

/**
 * Put a turn's reply back as its session file says it ended (M57.6): a
 * re-attach that found a gap in the journal, or no journal at all, reads the
 * file and replaces the reply `assistantId` names with the file's last
 * reply, its text, parts, tools, error and notice, and its anchor when the
 * file names one (M91.4); so does a re-attach from a stored copy, at its
 * Done. What the panel knows and the file does not stays: a person's cancel,
 * a call's cancel, pause or denial, how long its runs worked (M92.2), and
 * what they reached (M92.8). The reply stops streaming and loses its gap
 * line. With no replayed reply, or no such message, the same array comes
 * back.
 */
export function replaceLastTurn(
  messages: ChatMessage[],
  assistantId: string,
  replayed: ChatMessage[],
): ChatMessage[] {
  const last = [...replayed].reverse().find((m) => m.role === 'assistant');
  if (last === undefined || !messages.some((m) => m.id === assistantId)) return messages;
  return messages.map((m) => {
    if (m.id !== assistantId) return m;
    const {
      streaming: _streaming,
      gap: _gap,
      live: _live,
      error: _error,
      notice: _notice,
      interrupted: _interrupted,
      parts: _parts,
      ...kept
    } = m;
    return {
      ...kept,
      ...(last.childTraceUnavailable === true ? { childTraceUnavailable: true } : {}),
      text: last.text,
      tools: keepLiveCalls(last.tools, m.tools),
      ...(last.parts === undefined ? {} : { parts: last.parts }),
      ...(last.anchor === undefined ? {} : { anchor: last.anchor }),
      ...(last.error === undefined ? {} : { error: last.error }),
      ...(last.notice === undefined ? {} : { notice: last.notice }),
      ...(last.interrupted === true ? { interrupted: true } : {}),
      ...(last.model === undefined ? {} : { model: last.model }),
    };
  });
}
