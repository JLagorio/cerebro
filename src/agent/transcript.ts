import { upsertChangeset } from '@/engine/changeset';
import type { AgentStreamEvent, ChatMessage, PrLink, ToolCall, ToolPayload } from './types';

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
 * A tool call's input and output arrive as previews; where a preview cut
 * one, a ToolPayload follows with the whole (M56.8), and it lands on the tool
 * by id in either mode. Payloads stay in memory: conversations.ts saves the
 * previews only.
 *
 * A run's Changeset (M58.3, live only) lands on the reply, one per run by its
 * run id: a resume after a held call is a second run, so a second entry.
 */

export type ReduceMode = 'live' | 'replay';

type Live = NonNullable<ChatMessage['live']>;

const EMPTY_LIVE: Live = { messageId: null, finalText: '', allText: '', ended: false };

const join = (a: string, b: string): string => (a === '' ? b : `${a}\n\n${b}`);

/** A ToolStart, under the M15 and PR #7 rules: a tool id is unique within a
 * turn, so a repeat is a redelivery of the same call and never a second row,
 * and a redelivery never un-finishes a row ToolDone already finished. */
function startTool(tools: ToolCall[], event: Extract<AgentStreamEvent, { kind: 'ToolStart' }>) {
  const at = tools.findIndex((t) => t.id === event.tool_id);
  if (at === -1) {
    const started: ToolCall = {
      id: event.tool_id,
      name: event.tool_name,
      input: event.input ?? null,
      output: null,
      done: false,
      failed: false,
    };
    return [...tools, started];
  }
  // Only what the start event knows is refreshed; the completion stays.
  const next = tools.slice();
  next[at] = { ...next[at], name: event.tool_name, input: event.input ?? next[at].input };
  return next;
}

/** `payload` with one part whole, as a ToolPayload carried it. */
function withPart(
  payload: ToolPayload | undefined,
  event: Extract<AgentStreamEvent, { kind: 'ToolPayload' }>,
): ToolPayload {
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

/** `tools` with the call `id` changed by `patch`; a call the turn never
 * started (a deferral read without its start) is added under `name`. */
function patchTool(
  tools: ToolCall[],
  id: string,
  name: string,
  patch: Partial<ToolCall>,
): ToolCall[] {
  if (!tools.some((t) => t.id === id)) {
    return [
      ...tools,
      { id, name, input: null, output: null, done: false, failed: false, ...patch },
    ];
  }
  return tools.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

/** Apply one event to the assistant message of its turn. Unknown kinds, and
 * kinds that are not about the message (Init, UserPrompt, PrLink,
 * Interaction, Done), change nothing. */
export function applyEvent(
  message: ChatMessage,
  event: AgentStreamEvent,
  mode: ReduceMode,
): ChatMessage {
  const live = message.live ?? EMPTY_LIVE;
  switch (event.kind) {
    case 'TextDelta':
      // Deltas exist only live. Once the turn has ended, its text is settled.
      if (live.ended) return message;
      return { ...message, text: message.text + event.text };
    case 'Text': {
      const same = live.messageId === event.message_id;
      const next: Live = {
        ...live,
        messageId: event.message_id,
        finalText: same ? join(live.finalText, event.text) : event.text,
        allText: join(live.allText, event.text),
      };
      // Live text keeps its deltas until the turn's end; replayed text shows
      // all of it until then.
      return mode === 'replay'
        ? { ...message, live: next, text: next.allText }
        : { ...message, live: next };
    }
    case 'ToolStart':
      return { ...message, tools: startTool(message.tools, event) };
    case 'ToolDone':
      return {
        ...message,
        tools: message.tools.map((t) =>
          t.id === event.tool_id
            ? { ...t, done: true, output: event.output ?? null, failed: event.is_error === true }
            : t,
        ),
      };
    case 'ToolDeferred':
      return {
        ...message,
        tools: patchTool(message.tools, event.tool_id, event.tool_name, { deferred: true }),
      };
    case 'ToolCancelled':
      return {
        ...message,
        tools: message.tools.map((t) =>
          t.id === event.tool_id && !t.done ? { ...t, cancelled: true } : t,
        ),
      };
    case 'ToolPayload':
      return {
        ...message,
        tools: message.tools.map((t) =>
          t.id === event.tool_id ? { ...t, payload: withPart(t.payload, event) } : t,
        ),
      };
    case 'ModelChanged':
      return { ...message, model: event.model };
    case 'Result':
      // The final message's text is the reply; with none (a reply no Text
      // event carried), the result's text; with neither, what streamed.
      if (live.finalText !== '') return { ...message, text: live.finalText };
      if (event.text.trim() !== '') return { ...message, text: event.text };
      return message;
    case 'TurnEnded':
      return {
        ...message,
        live: { ...live, ended: true },
        text: live.finalText !== '' ? live.finalText : message.text,
      };
    case 'TurnInterrupted':
      return { ...message, live: { ...live, ended: true }, interrupted: true };
    case 'Cancelled':
      // M57.5: the partial text stays; the bubble says a person stopped it.
      return { ...message, cancelled: true };
    case 'Changeset':
      return { ...message, changesets: upsertChangeset(message.changesets, event.changeset) };
    case 'Error':
      // The notice rides beside the raw words (M56.4): the card shows both.
      return event.notice != null
        ? { ...message, error: event.message, notice: event.notice }
        : { ...message, error: event.message };
    default:
      return message;
  }
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
  return {
    ...message,
    streaming: false,
    ...(ended || message.interrupted === true ? {} : { interrupted: true }),
  };
}

export interface Replayed {
  messages: ChatMessage[];
  /** The last model Claude Code reported, if any. */
  model: string | null;
  prLinks: PrLink[];
}

/** Drop the reducer's in-memory state from a finished message. */
function settled(message: ChatMessage): ChatMessage {
  const { live: _live, streaming: _streaming, ...rest } = message;
  return rest;
}

/** Rebuild a thread from its folded session file: a user bubble and an
 * assistant bubble per prompt, ids derived from the session so a rebuild is
 * stable. */
export function replayTranscript(events: AgentStreamEvent[], sessionId: string): Replayed {
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
        open.assistant = applyEvent(assistant, event, 'replay');
      }
    }
  }
  close();
  return { messages, model, prLinks };
}

/**
 * Heal a cached thread from its rebuild (Q6): the cached copy stays on
 * screen, wording and all, and a tool row it holds unfinished (a reload
 * mid-turn) takes its completion from the rebuilt row with the same tool id.
 * A row the cache holds without its payload (the cache keeps previews only,
 * M56.8) takes the rebuilt row's. The same array comes back when nothing
 * changed.
 */
export function healFromTranscript(cached: ChatMessage[], rebuilt: ChatMessage[]): ChatMessage[] {
  const rows = new Map<string, ToolCall>();
  for (const message of rebuilt) {
    for (const tool of message.tools) rows.set(tool.id, tool);
  }
  /** What the rebuilt row with this id adds to a cached one, or null. */
  const healTool = (tool: ToolCall): ToolCall | null => {
    const row = rows.get(tool.id);
    if (row === undefined) return null;
    const complete = !tool.done && row.done;
    const payload = tool.payload === undefined && row.payload !== undefined;
    if (!complete && !payload) return null;
    return {
      ...tool,
      ...(complete ? { done: true, failed: row.failed, output: tool.output ?? row.output } : {}),
      ...(payload ? { payload: row.payload } : {}),
    };
  };
  let changed = false;
  const healed = cached.map((message) => {
    if (message.role !== 'assistant') return message;
    let touched = false;
    const tools = message.tools.map((tool) => {
      const next = healTool(tool);
      if (next === null) return tool;
      touched = true;
      return next;
    });
    if (!touched) return message;
    changed = true;
    return { ...message, tools };
  });
  return changed ? healed : cached;
}

/**
 * Put a turn's reply back as its session file says it ended (M57.6): a
 * re-attach that found a gap in the journal, or no journal at all, reads the
 * file and replaces the reply `assistantId` names with the file's last
 * reply, its text, tools, error and notice. What the panel knows and the
 * file does not stays: a person's cancel. The reply stops streaming and
 * loses its gap line. With no replayed reply, or no such message, the same
 * array comes back.
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
      ...kept
    } = m;
    return {
      ...kept,
      text: last.text,
      tools: last.tools,
      ...(last.error === undefined ? {} : { error: last.error }),
      ...(last.notice === undefined ? {} : { notice: last.notice }),
      ...(last.interrupted === true ? { interrupted: true } : {}),
      ...(last.model === undefined ? {} : { model: last.model }),
    };
  });
}
