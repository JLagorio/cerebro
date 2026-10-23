import { describe, expect, it } from 'vitest';
import {
  HOP_DEPTH,
  hopCount,
  liveRunWords,
  runDuration,
  runForest,
  runLogStatus,
  runStatus,
  runTree,
  type LinkedRun,
  type RunNode,
} from './runs';

/**
 * A run as a trace line (M91.14): its outcome in its state's ink and words,
 * how long it took only as recorded (CV-05), and the hops it caused nested
 * under it by `parent_run_id`, a chain no deeper than its second hop.
 */

describe('runStatus', () => {
  it("draws each of the schema's outcomes in its state, saying it in the record's own word", () => {
    expect(
      [
        'running',
        'succeeded',
        'failed',
        'quota_failed',
        'elapsed_aborted',
        'cancelled',
        'abandoned_usage_unknown',
      ].map((outcome) => {
        const { state, trace, words, statusText } = runStatus(outcome);
        return [outcome, state, trace, words, statusText];
      }),
    ).toEqual([
      ['running', 'running', 'running', 'running', 'Running'],
      ['succeeded', 'done', undefined, 'succeeded', null],
      ['failed', 'failed', 'error', 'failed', 'Failed'],
      ['quota_failed', 'failed', 'error', 'quota failed', 'Quota failed'],
      ['elapsed_aborted', 'failed', 'error', 'elapsed aborted', 'Elapsed aborted'],
      ['cancelled', 'cancelled', 'pending', 'cancelled', 'Cancelled'],
      // It may have completed: drawn as interrupted, never as failed or done.
      [
        'abandoned_usage_unknown',
        'interrupted',
        undefined,
        'abandoned usage unknown',
        'Abandoned usage unknown',
      ],
    ]);
  });

  it('draws a cancelled run with a stop, and leaves every other state its own icon', () => {
    expect(runStatus('cancelled').icon).toBe('circle-stop');
    expect(runStatus('succeeded').icon).toBeUndefined();
    expect(runStatus('failed').icon).toBeUndefined();
  });

  it('never draws a word it does not know as a success', () => {
    expect(runStatus('vanished_midway')).toMatchObject({
      state: 'failed',
      trace: 'error',
      words: 'vanished midway',
      statusText: 'Vanished midway',
    });
  });
});

describe('runDuration', () => {
  const run = (started_at: string, ended_at: string | null, outcome = 'succeeded') => ({
    outcome,
    started_at,
    ended_at,
  });

  it('says how long a run took from its two recorded ends', () => {
    expect(runDuration(run('2026-07-28T09:15:00Z', '2026-07-28T09:19:00Z'))).toBe('4m');
    expect(runDuration(run('2026-07-28T09:15:00Z', '2026-07-28T09:15:01.400Z'))).toBe('1.4s');
    // Measured at zero is a measurement.
    expect(runDuration(run('2026-07-28T09:15:00Z', '2026-07-28T09:15:00Z'))).toBe('0ms');
  });

  it('says nothing for a run still going, an end that went back, or a stamp it cannot read', () => {
    expect(runDuration(run('2026-07-28T09:15:00Z', null))).toBeUndefined();
    expect(runDuration(run('2026-07-28T09:15:00Z', '2026-07-28T09:14:00Z'))).toBeUndefined();
    expect(runDuration(run('not a time', '2026-07-28T09:14:00Z'))).toBeUndefined();
  });

  it('says nothing for an abandoned run, whose end is when the sweep closed it, not when it stopped', () => {
    expect(
      runDuration(run('2026-07-28T09:15:00Z', '2026-07-31T08:00:00Z', 'abandoned_usage_unknown')),
    ).toBeUndefined();
    // A run that failed or was cancelled ended when its record says.
    expect(runDuration(run('2026-07-28T09:15:00Z', '2026-07-28T09:16:00Z', 'failed'))).toBe('1m');
    expect(runDuration(run('2026-07-28T09:15:00Z', '2026-07-28T09:16:00Z', 'cancelled'))).toBe(
      '1m',
    );
  });
});

const link = (run_id: string, parent_run_id: string | null = null): LinkedRun => ({
  run_id,
  parent_run_id,
});

/** Each node as `id@depth`, depth first, as a list draws them. */
function flat(nodes: readonly RunNode<LinkedRun>[]): string[] {
  return nodes.flatMap((node) => [`${node.run.run_id}@${node.depth}`, ...flat(node.hops)]);
}

/** PageRunsTab's rows before M91.14, kept as the order and depth the nested
 * chains must still draw in. */
function rowsBefore(runs: LinkedRun[]): string[] {
  const byId = new Set(runs.map((run) => run.run_id));
  const seen = new Set<string>();
  const rows: string[] = [];
  const add = (run: LinkedRun, depth: number) => {
    if (seen.has(run.run_id)) return;
    seen.add(run.run_id);
    rows.push(`${run.run_id}@${depth}`);
    for (const child of runs)
      if (child.parent_run_id === run.run_id) add(child, Math.min(depth + 1, 2));
  };
  for (const run of runs)
    if (run.parent_run_id === null || !byId.has(run.parent_run_id)) add(run, 0);
  for (const run of runs) add(run, 0);
  return rows;
}

describe('runForest', () => {
  it('stands a hop under the run that caused it, wherever its own time put it', () => {
    const forest = runForest([link('hop', 'root'), link('other'), link('root')]);
    expect(forest.map((node) => node.run.run_id)).toEqual(['other', 'root']);
    expect(flat(forest)).toEqual(['other@0', 'root@0', 'hop@1']);
  });

  it('roots a hop whose parent the list does not hold', () => {
    expect(flat(runForest([link('hop', 'filtered-out')]))).toEqual(['hop@0']);
  });

  it("nests a hop's hop, and keeps anything deeper at the chain's last depth", () => {
    const runs = [link('a'), link('b', 'a'), link('c', 'b'), link('d', 'c'), link('e', 'b')];
    const forest = runForest(runs);
    expect(flat(forest)).toEqual(['a@0', 'b@1', 'c@2', 'd@2', 'e@2']);
    expect(HOP_DEPTH).toBe(2);
    // d, which only a malformed history holds, stands after its parent c.
    const b = forest[0].hops[0];
    expect(b.hops.map((node) => node.run.run_id)).toEqual(['c', 'd', 'e']);
  });

  it('draws a run once, and roots a cycle where it first comes', () => {
    expect(flat(runForest([link('x', 'y'), link('y', 'x'), link('z')]))).toEqual([
      'z@0',
      'x@0',
      'y@1',
    ]);
  });

  it('draws the order and depth the flat rows had, over any history', () => {
    // MINSTD, seeded: the same histories every run.
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const size = 1 + next(8);
      const ids = Array.from({ length: size }, (_, at) => `r${at}`);
      const runs = ids.map((id) => {
        const roll = next(size + 3);
        // Mostly a listed parent, sometimes none, sometimes one not listed.
        return link(id, roll < size ? ids[roll] : roll === size ? 'gone' : null);
      });
      expect(flat(runForest(runs)), JSON.stringify(runs)).toEqual(rowsBefore(runs));
    }
  });
});

describe('runTree and hopCount', () => {
  it('grows one run with its hops by any actor, and counts what bills to its chain', () => {
    const runs = [link('root'), link('hop', 'root'), link('hop2', 'hop'), link('later', 'root')];
    const tree = runTree(runs[0], runs);
    expect(flat([tree])).toEqual(['root@0', 'hop@1', 'hop2@2', 'later@1']);
    expect(hopCount(tree)).toBe(3);
    expect(hopCount(runTree(runs[3], runs))).toBe(0);
  });

  it('grows a run that is itself a hop from that run, as an agent lists its own', () => {
    const runs = [link('root'), link('mine', 'root'), link('mine-hop', 'mine')];
    expect(flat([runTree(runs[1], runs)])).toEqual(['mine@0', 'mine-hop@1']);
  });
});

describe('the status bar', () => {
  it('says a run under way is starting until its child exists, then running', () => {
    expect(liveRunWords(false)).toBe('Starting');
    expect(liveRunWords(true)).toBe('Running');
  });

  it('draws a logged run by how it ended, and an unknown status as describeRun reads it', () => {
    expect(runLogStatus('ok')).toMatchObject({ state: 'done', trace: undefined, statusText: null });
    expect(runLogStatus('failed')).toMatchObject({
      state: 'failed',
      trace: 'error',
      statusText: 'Failed',
    });
    expect(runLogStatus('stopped')).toMatchObject({
      trace: 'pending',
      statusText: 'Stopped',
      icon: 'circle-stop',
    });
    expect(runLogStatus('deferred')).toMatchObject({
      trace: 'pending',
      statusText: 'Deferred',
      icon: 'clock',
    });
    expect(runLogStatus('lost' as 'ok')).toMatchObject({ state: 'done', statusText: null });
  });
});
