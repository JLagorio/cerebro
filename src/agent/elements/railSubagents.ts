import type { StepState } from '@/components/ai/StepLine';
import { inputField } from '@/agent/elements/turnTitles';
import { toolStatus } from '@/agent/transcriptRows';
import type { ChatMessage, SubagentRun, ToolCall } from '@/agent/types';
import { toolDisplay, toolRenderer } from '@/engine/tools';

/**
 * The conversation's subagents (M92.4, §2): every Agent call its replies
 * made on their main thread, the calls the manifest draws with its
 * `subagent` renderer (CV-04), as the rail's Subagents card lists them.
 * Pure.
 *
 * A row says what Claude Code reported of its subagent: its type and what it
 * was asked, how it went, with a call Claude Code refused kept denied, never
 * failed (it never ran, M91.3a), and its tool uses and time only as recorded
 * (CV-05), never its tokens (Q8). What it is doing now is live only: the
 * reply still streams and the subagent still runs. One a reply holds still
 * running once nothing streams into it reads interrupted, never done.
 *
 * A row whose subagent ran and used tools but whose steps are not in hand
 * says its steps were not recorded, as its line in the transcript does: a
 * reply a branch copied keeps its subagents' summaries, and their steps stay
 * with the session they ran in.
 *
 * Every TextDelta makes a new message and a new list of them, and leaves the
 * reply's `tools` array as it was (transcript.ts): rows are kept per reply by
 * that array, and the conversation's by its replies' rows, so a streamed word
 * reads the same rows back, the same object, and the rail draws nothing again.
 * A subagent's own step or words make a new array; the answer stays the same
 * object while every row still says what it said.
 */

export interface RailSubagentRow {
  /** The Agent call's id: the transcript's line for it carries the same
   *  `data-tool-id`, and the row's jump reveals it. */
  toolId: string;
  /** Its `subagent_type`, '' when nothing named one. */
  type: string;
  /** What it was asked to do, '' when nothing said. */
  description: string;
  state: StepState;
  toolUses?: number;
  durationMs?: number;
  /** Live only: what it is doing now, in Claude Code's words, or the last
   *  tool it used. */
  now?: string;
  /** It ran and used tools, and none of its steps are in hand. */
  stepsNotRecorded?: true;
}

export interface RailSubagents {
  /** In the order the conversation made them. */
  rows: readonly RailSubagentRow[];
  /** The conversation holds turns: none of them may have started one, which
   *  is not the same as having nothing to read. */
  held: boolean;
}

const NONE: readonly RailSubagentRow[] = Object.freeze([]);

/** Live only: what a running subagent is doing, or the last tool it used. */
function nowOf(run: SubagentRun): string | undefined {
  const progress = run.progress?.trim() ?? '';
  if (progress !== '') return progress;
  return run.lastTool === undefined || run.lastTool === ''
    ? undefined
    : toolDisplay(run.lastTool).label;
}

/** Whether a subagent ran and used tools, and nothing it did is in hand: the
 *  same test its line in the transcript makes before saying so. Its own
 *  failure says why it has no steps, and claims nothing else. */
function stepsMissing(run: SubagentRun): boolean {
  const ran = run.status === 'done' || run.status === 'failed' || run.status === 'interrupted';
  const failure = run.error?.trim() ?? '';
  return (
    ran && failure === '' && run.toolUses !== 0 && run.parts.length === 0 && run.tools.length === 0
  );
}

function rowOf(tool: ToolCall, streaming: boolean): RailSubagentRow {
  const run = tool.subagent;
  const denied = tool.denied !== undefined;
  if (run === undefined) {
    // A stored call whose subagent did not survive the load: what its input
    // and its own row say.
    return {
      toolId: tool.id,
      type: inputField(tool, 'subagent_type') ?? '',
      description: inputField(tool, 'description') ?? '',
      state: denied ? 'denied' : toolStatus(tool, streaming),
    };
  }
  const live = streaming && (run.status === 'running' || run.status === 'waiting');
  const state: StepState = denied
    ? 'denied'
    : run.status === 'running' && !streaming
      ? 'interrupted'
      : run.status;
  const now = live ? nowOf(run) : undefined;
  return {
    toolId: tool.id,
    type: run.type,
    description: run.description,
    state,
    ...(run.toolUses === undefined ? {} : { toolUses: run.toolUses }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(now === undefined ? {} : { now }),
    ...(!denied && stepsMissing(run) ? { stepsNotRecorded: true as const } : {}),
  };
}

/** One reply's rows, kept by its `tools` array while it streams the same. */
const byTools = new WeakMap<
  readonly ToolCall[],
  { streaming: boolean; rows: readonly RailSubagentRow[] }
>();

function rowsOf(message: ChatMessage): readonly RailSubagentRow[] {
  if (message.role !== 'assistant') return NONE;
  const streaming = message.streaming === true;
  const kept = byTools.get(message.tools);
  if (kept !== undefined && kept.streaming === streaming) return kept.rows;
  const made = message.tools
    .filter((tool) => toolRenderer(tool.name) === 'subagent')
    .map((tool) => rowOf(tool, streaming));
  const rows = made.length === 0 ? NONE : made;
  byTools.set(message.tools, { streaming, rows });
  return rows;
}

/** A conversation that started no subagent, with turns and without. */
const QUIET: RailSubagents = Object.freeze({ rows: NONE, held: true });
const UNHELD: RailSubagents = Object.freeze({ rows: NONE, held: false });

/** The last answer, with the replies' rows it was made of. */
let last: { replies: readonly (readonly RailSubagentRow[])[]; view: RailSubagents } | null = null;

const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((item, at) => item === b[at]);

/** Whether two rows say the same: a subagent's own step or words change its
 *  reply's calls, and seldom anything its row says. */
function sameRow(a: RailSubagentRow, b: RailSubagentRow): boolean {
  return (
    a === b ||
    (a.toolId === b.toolId &&
      a.type === b.type &&
      a.description === b.description &&
      a.state === b.state &&
      a.toolUses === b.toolUses &&
      a.durationMs === b.durationMs &&
      a.now === b.now &&
      a.stepsNotRecorded === b.stepsNotRecorded)
  );
}

/** The conversation's subagents: the same object while no row says anything
 *  new. */
export function railSubagents(messages: readonly ChatMessage[]): RailSubagents {
  const replies = messages.map(rowsOf);
  if (last !== null && same(last.replies, replies)) return last.view;
  const rows = replies.flat();
  const held = messages.length > 0;
  const before = last?.view;
  const view =
    before !== undefined &&
    before.held === held &&
    before.rows.length === rows.length &&
    rows.every((row, at) => sameRow(row, before.rows[at]))
      ? before
      : rows.length > 0
        ? { rows, held: true }
        : held
          ? QUIET
          : UNHELD;
  last = { replies, view };
  return view;
}
