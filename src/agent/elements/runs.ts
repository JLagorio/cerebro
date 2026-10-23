import { formatDuration, stepTraceStatus, type StepState } from '@/components/ai/StepLine';
import type { TraceStatus } from '@/components/ai/Trace';
import { durationBetween } from '@/agent/transcript';
import type { RunLogEntry } from '@/engine/runLog';

/**
 * A run as a trace line (M91.14): the fleet's rows, an agent's Runs tab, a
 * page's Runs tab, Home's Agents lane, History's run rows and the status
 * bar's run list each draw one, in its state's ink and icon and with its
 * state in words, and nest the hops a run caused under it. Pure: a row in,
 * a view out.
 *
 * The words are the records' own: a run's outcome is Rust's word
 * (`runs.outcome`, runtime/schema.rs), underscores as spaces, as every run
 * row has always printed it; only how a line is drawn comes from here. A
 * time nobody recorded is no time at all, never 0 (CV-05).
 */

/** How a run's line draws, and what it says. */
export interface RunStatusView {
  /** The trace state it draws in: its icon (StepLine's `StepIcon`). */
  state: StepState;
  /** Its TraceLine status: its ink, and the working light while it runs. */
  trace: TraceStatus | undefined;
  /** The outcome as a row prints it: "succeeded", "quota failed". */
  words: string;
  /** What a screen reader hears before the line: the outcome, capitalized,
   *  or null for a run that succeeded, whose line needs no word. */
  statusText: string | null;
  /** An icon in place of the state's own, where the state's says less. */
  icon?: string;
}

/** The outcomes that draw as something other than failed. A word this build
 *  does not know draws failed, as every outcome but success always has: a
 *  run is never drawn as having succeeded unless its record says so. */
const OUTCOME_STATES: Readonly<Record<string, StepState>> = {
  running: 'running',
  succeeded: 'done',
  // A person or a limit stopped it.
  cancelled: 'cancelled',
  // Its end was never recorded: it may have completed (§3.3's interrupted).
  abandoned_usage_unknown: 'interrupted',
};

const capitalized = (words: string): string =>
  words === '' ? words : words[0].toUpperCase() + words.slice(1);

/** A run's outcome as its line draws it. */
export function runStatus(outcome: string): RunStatusView {
  const state = OUTCOME_STATES[outcome] ?? 'failed';
  const words = outcome.replace(/_/g, ' ');
  return {
    state,
    trace: stepTraceStatus(state),
    words,
    statusText: state === 'done' ? null : capitalized(words),
    ...(state === 'cancelled' ? { icon: 'circle-stop' } : {}),
  };
}

/** How long a run took, from its recorded start to its recorded end, or
 *  undefined for a run still going, an end nobody recorded, or a clock that
 *  stepped back (`durationBetween`, CV-05). An abandoned run's `ended_at` is
 *  when Cerebro's sweep closed it, at the next start or lease expiry, not
 *  when it stopped, so it says no duration either. */
export function runDuration(run: {
  outcome: string;
  started_at: string;
  ended_at: string | null;
}): string | undefined {
  if (OUTCOME_STATES[run.outcome] === 'interrupted') return undefined;
  const ms = durationBetween(run.started_at, run.ended_at ?? undefined);
  return ms === undefined ? undefined : formatDuration(ms);
}

/** What a run line needs of a run to place it in a chain. */
export interface LinkedRun {
  run_id: string;
  /** The run that handed off or whose write caused this one; null is a root. */
  parent_run_id: string | null;
}

/** A run and the hops it caused, each in list order. */
export interface RunNode<R extends LinkedRun> {
  run: R;
  /** 0 for the run a list starts from, 1 for its hop, 2 for a hop's hop. */
  depth: number;
  hops: RunNode<R>[];
}

/** A chain stops at its second hop (CV-48): no hop nests deeper than this. */
export const HOP_DEPTH = 2;

/**
 * `run` into `into`, then the hops it caused among `runs` under it. A hop
 * past HOP_DEPTH, which only a malformed history holds, stays at that depth
 * after its parent; a run is drawn once, so a cycle ends where it closes.
 */
function grow<R extends LinkedRun>(
  run: R,
  depth: number,
  runs: readonly R[],
  seen: Set<string>,
  into: RunNode<R>[],
): void {
  seen.add(run.run_id);
  const node: RunNode<R> = { run, depth, hops: [] };
  into.push(node);
  for (const child of runs) {
    if (child.parent_run_id !== run.run_id || seen.has(child.run_id)) continue;
    if (depth < HOP_DEPTH) grow(child, depth + 1, runs, seen, node.hops);
    else grow(child, depth, runs, seen, into);
  }
}

/** `root` and the hops it caused among `runs`, nested by `parent_run_id`:
 *  an agent's Runs tab draws each of its runs so, hops by any agent. */
export function runTree<R extends LinkedRun>(root: R, runs: readonly R[]): RunNode<R> {
  const into: RunNode<R>[] = [];
  grow(root, 0, runs, new Set(), into);
  return into[0];
}

/**
 * A list of runs as chains: each run whose parent the list does not hold is
 * a root, in list order, with its hops under it, so a hop stands below the
 * run that caused it rather than where its own time would put it. A run in
 * a cycle, whose every ancestor is listed, roots where it first comes.
 */
export function runForest<R extends LinkedRun>(runs: readonly R[]): RunNode<R>[] {
  const listed = new Set(runs.map((run) => run.run_id));
  const seen = new Set<string>();
  const roots: RunNode<R>[] = [];
  for (const run of runs) {
    const root = run.parent_run_id === null || !listed.has(run.parent_run_id);
    if (root && !seen.has(run.run_id)) grow(run, 0, runs, seen, roots);
  }
  for (const run of runs) if (!seen.has(run.run_id)) grow(run, 0, runs, seen, roots);
  return roots;
}

/** Every hop under a run, at any depth: what bills to the chain it roots. */
export function hopCount<R extends LinkedRun>(node: RunNode<R>): number {
  return node.hops.reduce((sum, hop) => sum + 1 + hopCount(hop), 0);
}

/**
 * A run in the status bar's list (M17.7), which is under way: "Starting"
 * until its child exists, then "Running", its title in the working light.
 */
export function liveRunWords(started: boolean): string {
  return started ? 'Running' : 'Starting';
}

/**
 * A logged run's line (M17.15) by its status: done, failed, stopped by a
 * person, or deferred by the budget gate, which never started it. The line
 * under it says what it did in words (`describeRun`), so these are what a
 * screen reader hears before its title. The log is read back from storage
 * unchecked, so a status this build does not know reads as `describeRun`
 * reads it: done.
 */
export function runLogStatus(status: RunLogEntry['status']): RunStatusView {
  switch (status) {
    case 'failed':
      return { state: 'failed', trace: 'error', words: 'failed', statusText: 'Failed' };
    case 'stopped':
      return {
        state: 'cancelled',
        trace: stepTraceStatus('cancelled'),
        words: 'stopped',
        statusText: 'Stopped',
        icon: 'circle-stop',
      };
    case 'deferred':
      return {
        state: 'not_run',
        trace: stepTraceStatus('not_run'),
        words: 'deferred',
        statusText: 'Deferred',
        icon: 'clock',
      };
    default:
      return { state: 'done', trace: undefined, words: 'done', statusText: null };
  }
}
