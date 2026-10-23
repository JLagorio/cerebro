import type { RailSectionState } from '@/components/ai/Rail';
import type { StepState } from '@/components/ai/StepLine';
import { handoffTitle } from '@/components/ai/Subagent';
import { runDuration, runStatus } from '@/agent/elements/runs';
import { handoffRunId, inputField, outputOf } from '@/agent/elements/turnTitles';
import type { ChatMessage, ToolCall } from '@/agent/types';
import { toolIconName, toolRenderer } from '@/engine/tools';
import type { FleetRun, FleetRunDetail } from '@/lib/ipc';

/**
 * The runs the conversation handed work to (M92.11, §0 Q13, §2), as the
 * rail's Handed off card lists them: the hand-offs its replies made on their
 * main thread, the calls the manifest draws with its `handoff` renderer
 * (CV-04), each with the run `hand_to` answered that it started
 * (`handoffRunId`). Phase 1 only: the follow-ups and wakes those runs set
 * going need run ids a reply does not keep (O6), so none of them is here.
 * Pure.
 *
 * Only a hand-off that went is listed. One that `hand_to` or Claude Code
 * refused started nothing, and one still under way has not answered; their
 * lines in the transcript say so. One that went and whose answer names no
 * run reads its run as not recorded, never as none (CV-05).
 *
 * The card reads the newest HANDOFF_READS of those runs from runtime.db
 * (`fleetRunDetail`), and the rest of this file folds the answers into what
 * it says: a run that answered says its record's outcome and time; one whose
 * read failed is unavailable, that row alone.
 *
 * Every TextDelta makes a new message and a new list of them and leaves the
 * reply's `tools` array as it was (transcript.ts): rows are kept per reply by
 * that array, so a streamed word reads the same answer back, the same object.
 * Beside a new hand-off, only a turn's start and end are news, and those only
 * to a conversation that handed something off.
 */

/** The card's words. */
export const RAIL_HANDOFFS_WORDS = {
  title: 'Handed off',
  /** Whom a hand-off went to when its call named no one. */
  someone: 'an agent',
  /** After a line's words: where its press goes. */
  show: ' (show it in the conversation)',
  /** A line's second action, which floats the conversation first. */
  open: (agent: string) => `Open ${agent}'s run (leaves full screen)`,
  notRecorded: 'Run not recorded',
  rowUnavailable: "Couldn't read this run",
  partial: "Some of these runs couldn't be read",
  unavailable: "Couldn't read the runs this conversation handed off",
  earlier: (shown: number, total: number) => `The ${shown} newest of ${total} hand-offs`,
} as const;

/** How many hand-offs the card lists and reads: the newest (§2). */
export const HANDOFF_READS = 8;

/** How often the card reads its runs again while one of them goes on and
 *  the rail can be seen (§2). */
export const HANDOFF_POLL_MS = 15_000;

export interface RailHandoffRow {
  /** The hand_to call's id: the transcript draws its line with the same
   *  `data-tool-id`, and the row's jump goes there. */
  toolId: string;
  /** Whom it went to, as the call named them: '' when it named no one. */
  agent: string;
  /** The run it started, as `hand_to` answered, or null where the answer
   *  names none: not recorded. */
  runId: string | null;
  /** The hand-off's icon, the manifest's for its tool. */
  icon: string;
}

export interface RailHandoffs {
  /** The newest HANDOFF_READS hand-offs, newest first. */
  rows: readonly RailHandoffRow[];
  /** The hand-offs before those, which the card leaves out. */
  earlier: number;
  /** A reply still streams: its turn's end reads the runs again. */
  streaming: boolean;
}

const NO_ROWS: readonly RailHandoffRow[] = Object.freeze([]);

/** A conversation that handed nothing off: nothing to read, so a turn's
 *  start and end are no news to it. */
const NONE: RailHandoffs = Object.freeze({ rows: NO_ROWS, earlier: 0, streaming: false });

/** A hand-off that went: its call answered, and neither `hand_to` nor Claude
 *  Code refused it. */
function went(tool: ToolCall): boolean {
  return (
    toolRenderer(tool.name) === 'handoff' && tool.done && !tool.failed && tool.denied === undefined
  );
}

function rowOf(tool: ToolCall): RailHandoffRow {
  return {
    toolId: tool.id,
    agent: inputField(tool, 'agent') ?? '',
    runId: handoffRunId(outputOf(tool)),
    icon: toolIconName(tool.name),
  };
}

/** One reply's hand-offs, in the order it made them, kept by its `tools`
 *  array. */
const byTools = new WeakMap<readonly ToolCall[], readonly RailHandoffRow[]>();

function rowsOf(message: ChatMessage): readonly RailHandoffRow[] {
  if (message.role !== 'assistant') return NO_ROWS;
  const kept = byTools.get(message.tools);
  if (kept !== undefined) return kept;
  const made = message.tools.filter(went).map(rowOf);
  const rows = made.length === 0 ? NO_ROWS : made;
  byTools.set(message.tools, rows);
  return rows;
}

/** The last answer, with the replies' rows it was made of. */
let last: {
  replies: readonly (readonly RailHandoffRow[])[];
  streaming: boolean;
  view: RailHandoffs;
} | null = null;

const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((item, at) => item === b[at]);

const sameRow = (a: RailHandoffRow, b: RailHandoffRow): boolean =>
  a === b ||
  (a.toolId === b.toolId && a.agent === b.agent && a.runId === b.runId && a.icon === b.icon);

/** The conversation's hand-offs: the same object while none is new and no
 *  turn starts or ends. */
export function railHandoffs(messages: readonly ChatMessage[]): RailHandoffs {
  const replies = messages.map(rowsOf);
  const streaming = messages.some(
    (message) => message.role === 'assistant' && message.streaming === true,
  );
  if (last !== null && last.streaming === streaming && same(last.replies, replies)) {
    return last.view;
  }
  const all = replies.flat();
  const rows = all.slice(-HANDOFF_READS).reverse();
  const earlier = all.length - rows.length;
  const before = last?.view;
  // The rows a turn's start or end leaves as they were stay the same array.
  const kept =
    before !== undefined &&
    before.rows.length === rows.length &&
    rows.every((row, at) => sameRow(row, before.rows[at]));
  const view: RailHandoffs =
    rows.length === 0
      ? NONE
      : kept && before.streaming === streaming && before.earlier === earlier
        ? before
        : { rows: kept ? before.rows : rows, earlier, streaming };
  last = { replies, streaming, view };
  return view;
}

/** The runs a read asks for: the listed rows' that are recorded, in order. */
export function handoffRunIds(handoffs: RailHandoffs): string[] {
  return handoffs.rows.flatMap((row) => (row.runId === null ? [] : [row.runId]));
}

/** What the card keeps of a run's record: what its line says. */
export type HandoffRun = Pick<FleetRun, 'outcome' | 'started_at' | 'ended_at'>;

/** What the latest read of one run answered. */
export type HandoffRunRead =
  | { state: 'read'; run: HandoffRun }
  /** The read failed. `last` is what an earlier read found, or null: it is
   *  never drawn, and keeps a run known to go on polled. */
  | { state: 'unavailable'; last: HandoffRun | null };

/** The latest read of each listed run, by its id. */
export type HandoffReads = ReadonlyMap<string, HandoffRunRead>;

export const NO_READS: HandoffReads = new Map();

const sameRun = (a: HandoffRun, b: HandoffRun): boolean =>
  a.outcome === b.outcome && a.started_at === b.started_at && a.ended_at === b.ended_at;

/** The record a detail holds, or null for one that holds none it can read:
 *  a failed read, never a run with no outcome. */
function runOf(detail: FleetRunDetail): HandoffRun | null {
  const run = (detail as Partial<FleetRunDetail> | null)?.run;
  if (run === undefined || run === null || typeof run.outcome !== 'string') return null;
  return { outcome: run.outcome, started_at: run.started_at, ended_at: run.ended_at ?? null };
}

/**
 * One read's answers folded over what the card held: run `ids[at]` answered
 * `answers[at]`. It keeps the runs the card lists now and nothing of one it
 * no longer lists. A run whose read failed is unavailable, keeping what it
 * last answered for the polling rule. The same map comes back when no run
 * says anything new, so a poll that finds nothing changed draws nothing.
 */
export function foldHandoffReads(
  before: HandoffReads,
  ids: readonly string[],
  answers: readonly PromiseSettledResult<FleetRunDetail>[],
): HandoffReads {
  const next = new Map<string, HandoffRunRead>();
  ids.forEach((id, at) => {
    const answer = answers.at(at);
    const was = before.get(id);
    const run = answer?.status === 'fulfilled' ? runOf(answer.value) : null;
    if (run !== null) {
      next.set(id, was?.state === 'read' && sameRun(was.run, run) ? was : { state: 'read', run });
      return;
    }
    const kept = was === undefined ? null : was.state === 'read' ? was.run : was.last;
    next.set(
      id,
      was?.state === 'unavailable' && was.last === kept
        ? was
        : { state: 'unavailable', last: kept },
    );
  });
  const unchanged =
    next.size === before.size && [...next].every(([id, read]) => before.get(id) === read);
  return unchanged ? before : next;
}

/**
 * The card's state (CV-44), or null while no run it lists has answered: a
 * claim made then could be wrong a moment later, so the card makes none.
 * Empty with no hand-off. Where reads failed: unavailable when every run
 * that answered failed, partial when some did. Not recorded where a
 * hand-off's answer named no run. Else ready.
 */
export function handoffsState(
  handoffs: RailHandoffs,
  reads: HandoffReads,
): RailSectionState | null {
  if (handoffs.rows.length === 0) return 'empty';
  const ids = handoffRunIds(handoffs);
  const answered = ids.flatMap((id) => {
    const read = reads.get(id);
    return read === undefined ? [] : [read];
  });
  if (ids.length > 0 && answered.length === 0) return null;
  const failed = answered.filter((read) => read.state === 'unavailable').length;
  if (failed > 0) return failed === answered.length ? 'unavailable' : 'partial';
  return ids.length < handoffs.rows.length ? 'not-recorded' : 'ready';
}

/** Whether a run the card lists is known to go on: the latest of its reads
 *  that answered says it runs. The card polls only while one does. */
export function handoffsGoingOn(handoffs: RailHandoffs, reads: HandoffReads): boolean {
  return handoffRunIds(handoffs).some((id) => {
    const read = reads.get(id);
    const run = read === undefined ? null : read.state === 'read' ? read.run : read.last;
    return run !== null && runStatus(run.outcome).state === 'running';
  });
}

/** The heading's counts, in this order, each a state's word. */
const BUCKETS: readonly (readonly [StepState, string])[] = [
  ['running', 'running'],
  ['done', 'done'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['interrupted', 'interrupted'],
];

/** "1 running · 2 done": the runs that answered, each state counted, with
 *  no state no run is in. */
export function handoffsCount(handoffs: RailHandoffs, reads: HandoffReads): string | undefined {
  const states = handoffRunIds(handoffs).flatMap((id) => {
    const read = reads.get(id);
    return read?.state === 'read' ? [runStatus(read.run.outcome).state] : [];
  });
  const counted = BUCKETS.flatMap(([state, word]) => {
    const count = states.filter((at) => at === state).length;
    return count === 0 ? [] : [`${count} ${word}`];
  });
  return counted.length === 0 ? undefined : counted.join(' · ');
}

/** A line's state: its run's, once read; being read; not recorded, with no
 *  run named; unavailable, where its read failed. */
export type HandoffLineState = StepState | 'reading' | 'not-recorded' | 'unavailable';

/** One hand-off as the card draws its line. */
export interface HandoffLine {
  toolId: string;
  runId: string | null;
  /** Whom it went to, as the call named them. */
  agent: string;
  state: HandoffLineState;
  /** Its run's outcome, Rust's word, once read. */
  outcome: string | null;
  /** How the line draws: its run's state once read, and until then the
   *  hand-off's own, which went. */
  status: StepState;
  /** An icon in place of the state's: the hand-off's own until its run is
   *  read, then the run's where its state's says less (`runStatus`). */
  icon: string | undefined;
  /** "Handed to release-scout", as its line in the transcript says it. */
  title: string;
  /** The run's outcome and its time, each as recorded: "succeeded · 4m". */
  facts: string | undefined;
  /** Why the line says nothing of its run. */
  note: string | undefined;
}

/** The listed hand-offs as their lines say them, newest first. */
export function handoffLines(handoffs: RailHandoffs, reads: HandoffReads): HandoffLine[] {
  return handoffs.rows.map((row): HandoffLine => {
    const agent = row.agent === '' ? RAIL_HANDOFFS_WORDS.someone : row.agent;
    const own = {
      toolId: row.toolId,
      runId: row.runId,
      agent,
      title: handoffTitle(agent, 'done'),
      outcome: null,
      status: 'done' as const,
      icon: row.icon,
      facts: undefined,
    };
    if (row.runId === null) {
      return { ...own, state: 'not-recorded', note: RAIL_HANDOFFS_WORDS.notRecorded };
    }
    const read = reads.get(row.runId);
    if (read === undefined) return { ...own, state: 'reading', note: undefined };
    if (read.state === 'unavailable') {
      return { ...own, state: 'unavailable', note: RAIL_HANDOFFS_WORDS.rowUnavailable };
    }
    const view = runStatus(read.run.outcome);
    const took = runDuration(read.run);
    return {
      ...own,
      state: view.state,
      outcome: read.run.outcome,
      status: view.state,
      icon: view.icon,
      facts: took === undefined ? view.words : `${view.words} · ${took}`,
      note: undefined,
    };
  });
}
