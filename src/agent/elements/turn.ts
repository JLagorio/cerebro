import { summarizeSteps, type StepSummary } from '@/engine/ai/steps';
import type { StepInput } from '@/engine/ai/types';
import { toolRenderer } from '@/engine/tools';
import {
  transcriptRows,
  type FactsOf,
  type ToolGroupRow,
  type ToolRow,
} from '@/agent/transcriptRows';
import type { ChatMessage, MessagePart, SubagentRun, ToolCall } from '@/agent/types';
import { toolFacts } from '@/lib/policy/tools';

/**
 * A turn as the conversation draws it (M91.13): its pieces in the order they
 * came, a reasoning line, a folded run of reads, a call or a message's words,
 * and the one chain of thought that folds the turn's working. Pure: what the
 * reducer made of the turn (transcript.ts, M91.4) in, the lines out.
 *
 * Only what the transcript already folds goes inside the chain (§3.3): its
 * runs of reads, and its reasoning. Every other call, a change, a concept, a
 * hand-off, a commit, a view, and every call that failed, was interrupted,
 * waits, was cancelled, never ran or is paused, is a line of its own, so the
 * turn never hides what it changed or what went wrong. The chain sits where
 * its first step came and counts every step the turn took, inside it or
 * not. A turn that did no thinking has no chain: its folded reads are folds
 * already, and stay lines of their own.
 *
 * Reads fold across the reasoning between them, never across a message's
 * words: the words are on screen between them. A subagent's steps are drawn
 * the same way, inside its own line, with no chain of their own.
 */

type ReasoningPart = Extract<MessagePart, { kind: 'reasoning' }>;

export type TurnItem =
  | { kind: 'reasoning'; key: string; part: ReasoningPart }
  | { kind: 'group'; key: string; group: ToolGroupRow }
  | { kind: 'row'; key: string; row: ToolRow }
  /** A message's words: the last of the turn's is its answer. */
  | { kind: 'text'; key: string; id: string; text: string; answer: boolean };

/** What the chain of thought holds. */
export type ChainStep = Extract<TurnItem, { kind: 'reasoning' | 'group' }>;

/** One line of a turn: an item, or the chain that folds its steps, which
 * holds every reasoning line. */
export type TurnLine =
  | Exclude<TurnItem, { kind: 'reasoning' }>
  | { kind: 'chain'; key: 'chain'; steps: ChainStep[]; summary: StepSummary };

export interface ThreadOptions {
  /** The message still streams: an unfinished call runs, else it was
   * interrupted (transcriptRows.ts). */
  streaming: boolean;
  /** The call a card waits on (M57.1). */
  waitingToolId?: string | null;
  factsOf?: FactsOf;
}

const isChainStep = (item: TurnItem): item is ChainStep =>
  item.kind === 'reasoning' || item.kind === 'group';

/** Thinking with no words that is not still arriving says nothing, and a
 * line saying only "Thought" tells the reader nothing either (§3.3). */
function draws(part: ReasoningPart): boolean {
  return part.text.trim() !== '' || part.redacted === true || part.streaming === true;
}

/**
 * One thread's pieces as items: the main thread's or a subagent's. Calls are
 * folded by `transcriptRows` within each stretch between two messages'
 * words; a group stands where its first read came. A call no part names is
 * drawn after the rest, so none is ever hidden.
 */
function threadItems(
  parts: readonly MessagePart[],
  tools: readonly ToolCall[],
  { streaming, waitingToolId = null, factsOf = toolFacts }: ThreadOptions,
): TurnItem[] {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const named = new Set<string>();
  const placed: { at: number; item: TurnItem }[] = [];
  let stretch: { at: number; tool: ToolCall }[] = [];
  const flush = () => {
    if (stretch.length === 0) return;
    const at = new Map(stretch.map((entry) => [entry.tool.id, entry.at]));
    const rows = transcriptRows(
      stretch.map((entry) => entry.tool),
      streaming,
      factsOf,
      waitingToolId,
    );
    for (const row of rows) {
      if (row.kind === 'group') {
        placed.push({
          at: at.get(row.members[0].tool.id) ?? 0,
          item: { kind: 'group', key: row.key, group: row },
        });
      } else {
        placed.push({ at: at.get(row.tool.id) ?? 0, item: { kind: 'row', key: row.key, row } });
      }
    }
    stretch = [];
  };
  parts.forEach((part, at) => {
    if (part.kind === 'tool') {
      const tool = byId.get(part.toolId);
      if (tool === undefined || named.has(tool.id)) return;
      named.add(tool.id);
      stretch.push({ at, tool });
    } else if (part.kind === 'reasoning') {
      if (draws(part)) {
        placed.push({ at, item: { kind: 'reasoning', key: `reasoning:${part.id}`, part } });
      }
    } else {
      flush();
      if (part.text !== '') {
        placed.push({
          at,
          item: {
            kind: 'text',
            key: `text:${part.id}`,
            id: part.id,
            text: part.text,
            answer: false,
          },
        });
      }
    }
  });
  tools.forEach((tool, n) => {
    if (!named.has(tool.id)) stretch.push({ at: parts.length + n, tool });
  });
  flush();
  // Stable, so pieces keep their order where two share a place.
  return placed.sort((a, b) => a.at - b.at).map((entry) => entry.item);
}

/** The parts a reply saved before M91.4 is drawn with: its calls above its
 * words, as it was drawn then. Its text part's id is the one the reducer
 * gives it, so a part added later never moves it. */
function legacyParts(message: ChatMessage): MessagePart[] {
  const calls: MessagePart[] = message.tools.map((tool) => ({ kind: 'tool', toolId: tool.id }));
  return message.text === ''
    ? calls
    : [...calls, { kind: 'text', id: 'text-1', text: message.text }];
}

/**
 * A reply's items, in order. The last message's words are its answer; a
 * reply whose words no part holds draws its text as the answer, last.
 */
export function turnItems(message: ChatMessage, options: ThreadOptions): TurnItem[] {
  const items = threadItems(message.parts ?? legacyParts(message), message.tools, options);
  let last = -1;
  items.forEach((item, at) => {
    if (item.kind === 'text') last = at;
  });
  if (last === -1) {
    if (message.text !== '') {
      items.push({
        kind: 'text',
        key: 'text:answer',
        id: 'answer',
        text: message.text,
        answer: true,
      });
    }
    return items;
  }
  items[last] = { ...(items[last] as Extract<TurnItem, { kind: 'text' }>), answer: true };
  return items;
}

/** A step as summarizeSteps counts it, or none for a message's words. */
function stepOf(item: TurnItem): StepInput[] {
  switch (item.kind) {
    case 'reasoning':
      return [{ kind: 'reasoning', status: item.part.streaming ? 'running' : 'done', folds: true }];
    case 'group':
      return [{ kind: 'group', status: item.group.running ? 'running' : 'done', folds: true }];
    case 'row': {
      const subagent = toolRenderer(item.row.tool.name) === 'subagent';
      return [{ kind: subagent ? 'subagent' : 'tool', status: item.row.status, folds: false }];
    }
    default:
      return [];
  }
}

/**
 * A reply's lines: its items, with the reasoning and folded reads gathered
 * into one chain where the first of them came, counting every step the turn
 * took. A turn that did no thinking has no chain.
 */
export function turnLines(items: readonly TurnItem[]): TurnLine[] {
  if (!items.some((item) => item.kind === 'reasoning')) return items as TurnLine[];
  const steps = items.filter(isChainStep);
  const summary = summarizeSteps(items.flatMap(stepOf));
  const lines: TurnLine[] = [];
  for (const item of items) {
    if (!isChainStep(item)) lines.push(item);
    else if (item === steps[0]) lines.push({ kind: 'chain', key: 'chain', steps, summary });
  }
  return lines;
}

/**
 * Whether a chain starts open: the latest turn's is, and so is one at work
 * or holding a failure (§3.3); the reader's own choice wins over all three.
 */
export function chainOpens(summary: StepSummary, latest: boolean): boolean {
  return latest || summary.running || summary.failed > 0;
}

/** The thread's latest call drawn by the todo renderer: the plan a live run
 * is working through. Null when it made none. */
export function latestTodo(tools: readonly ToolCall[]): string | null {
  for (let at = tools.length - 1; at >= 0; at -= 1) {
    if (toolRenderer(tools[at].name) === 'todo') return tools[at].id;
  }
  return null;
}

/**
 * A subagent's steps, in order (M91.4's SubagentRun): its reasoning, its
 * calls, folded as the turn's are, and its words. Its report is what its
 * summary says, so its last words, when it ended on them, are not drawn
 * twice. Its calls run only while it does.
 */
export function subagentItems(run: SubagentRun, options: ThreadOptions): TurnItem[] {
  const working = run.status === 'running' || run.status === 'waiting';
  const items = threadItems(run.parts, run.tools, {
    ...options,
    streaming: options.streaming && working,
  });
  const reported = run.summary !== undefined && run.summary.trim() !== '';
  if (reported && items.at(-1)?.kind === 'text') items.pop();
  return items;
}
