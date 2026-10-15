import { beforeEach, describe, expect, it } from 'vitest';
import {
  MOCK_JOURNAL_EVENTS,
  attachRun,
  mockJournal,
  onAgentEvent,
  runAgent,
  type RunHandle,
} from './agentIpc';
import { releaseHeldMockRuns } from './mockAgent';
import type { AgentEvent } from './types';
import { resetMockGit } from '@/lib/mockGit';
import * as mock from '@/lib/mockIpc';

/**
 * Re-attach in the browser (M57.6): the mock journal numbers and holds every
 * mock event as Rust's reader does, and `attachRun` reads it from a cursor,
 * then follows the run live, each event once and in order.
 */

beforeEach(() => {
  mock.resetMockFs();
});

const VAULT = '/demo-vault';

async function start(message: string): Promise<RunHandle> {
  const handle = await runAgent(VAULT, {
    message,
    shell: 'off',
    connectors: false,
    attended: true,
  });
  if ('deferred' in handle) throw new Error('an attended run is never deferred');
  return handle;
}

/** Resolve once `run` says Done. */
function doneOf(run: number): Promise<void> {
  return new Promise((resolve) => {
    const stop = onAgentEvent((event) => {
      if (event.kind === 'Done') {
        stop();
        resolve();
      }
    }, run);
  });
}

/** Resolve once `run` says an event of `kind`. */
function first(run: number, kind: AgentEvent['kind']): Promise<void> {
  return new Promise((resolve) => {
    const stop = onAgentEvent((event) => {
      if (event.kind === kind) {
        stop();
        resolve();
      }
    }, run);
  });
}

describe('attachRun (M57.6)', () => {
  it('backfills events emitted before it subscribed, each once and in seq order', async () => {
    const handle = await start('wait for me');
    expect(handle.attach).toMatch(/^mock-[a-z0-9]+-\d+$/);
    // The run is mid-tool before anyone attaches.
    await first(handle.run, 'ToolStart');
    const seen: AgentEvent[] = [];
    const done = doneOf(handle.run);
    const attached = await attachRun(handle, 0, (event) => seen.push(event));
    expect(attached).toMatchObject({ state: 'held', done: false });
    expect(seen.length).toBeGreaterThan(0);
    // The script reaches its hold a step after its ToolStart.
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseHeldMockRuns();
    await done;
    const seqs = seen.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, at) => at + 1));
    expect(seen.filter((e) => e.kind === 'Done')).toHaveLength(1);
    expect(seen.filter((e) => e.kind === 'ToolStart')).toHaveLength(1);
    if (attached.state !== 'unknown') attached.detach();
  });

  it('drops events at or under the cursor', async () => {
    const handle = await start('hello');
    await doneOf(handle.run);
    const seen: AgentEvent[] = [];
    const attached = await attachRun(handle, 3, (event) => seen.push(event));
    expect(attached).toMatchObject({ state: 'held', done: true });
    expect(seen[0].seq).toBe(4);
    expect(seen.at(-1)?.kind).toBe('Done');
    if (attached.state !== 'unknown') attached.detach();
  });

  it('reads a stale attach key as unknown, and lets go', async () => {
    const handle = await start('hello');
    await doneOf(handle.run);
    const states: string[] = [];
    const seen: AgentEvent[] = [];
    const attached = await attachRun(
      { run: handle.run, attach: `mock-earlier-${handle.run}` },
      0,
      (event) => seen.push(event),
      (state) => states.push(state),
    );
    expect(attached).toEqual({ state: 'unknown' });
    expect(states).toEqual(['unknown']);
    expect(seen).toEqual([]);
    expect(mockJournal.since(handle.run, 'mock-earlier-1', 0)).toEqual({ state: 'unknown' });
  });

  it('reads a gap once the mock journal passed its cap, and says so first', async () => {
    const run = 900_001;
    mockJournal.open(run);
    for (let i = 0; i < MOCK_JOURNAL_EVENTS + 5; i += 1) {
      mockJournal.append(run, { kind: 'TextDelta', text: 'x' });
    }
    mockJournal.finish(run);
    const answer = mockJournal.since(run, `nope`, 0);
    expect(answer).toEqual({ state: 'unknown' });
    const attach = (await start('hello')).attach ?? '';
    const key = attach.replace(/-\d+$/, `-${run}`);
    const gap = mockJournal.since(run, key, 0);
    expect(gap).toMatchObject({ state: 'gap', first: 6, done: true });
    if (gap.state === 'gap') expect(gap.events[0].seq).toBe(6);
    const order: string[] = [];
    await attachRun(
      { run, attach: key },
      0,
      () => order.push('event'),
      (state) => order.push(state),
    );
    expect(order[0]).toBe('gap');
    expect(order).toHaveLength(MOCK_JOURNAL_EVENTS + 1);
  });

  it('numbers every mock event from 1', async () => {
    const seen: AgentEvent[] = [];
    const stop = onAgentEvent((event) => seen.push(event));
    const handle = await start('hello');
    await doneOf(handle.run);
    stop();
    const own = seen.filter((e) => e.run === handle.run);
    expect(own.length).toBeGreaterThan(1);
    expect(own.map((e) => e.seq)).toEqual(own.map((_, at) => at + 1));
  });
});

describe('a mock run stamps its writes (M58.1)', () => {
  it('carries its attach id, and an IPC write in the same turn carries none', async () => {
    const host = window as unknown as {
      __cerebroMockFs: Map<string, string>;
      __cerebroMockWrites: mock.MockWrite[];
    };
    host.__cerebroMockFs.set('door-cases/a.md', '# A\n');
    const handle = await start('append "Agent line." to door-cases/a.md');
    await doneOf(handle.run);
    await mock.saveNote(VAULT, 'door-cases/a.md', '# A\n\nMine.\n');
    expect(host.__cerebroMockWrites.map((w) => [w.kind, w.path, w.actor, w.runId])).toEqual([
      ['vault.write', 'door-cases/a.md', 'claude-code', handle.attach],
      ['vault.write', 'door-cases/a.md', mock.HUMAN_ACTOR, null],
    ]);
  });
});

describe('a mock run commits what it wrote before its Done (M58.3)', () => {
  it('emits its Changeset just before Done, and commits only the run’s paths', async () => {
    const host = window as unknown as { __cerebroMockFs: Map<string, string> };
    host.__cerebroMockFs.set('runs/a.md', '# A\n');
    host.__cerebroMockFs.set('runs/b.md', '# B\n');
    const git = resetMockGit({
      modified: [{ path: 'runs/mine.md', status: 'modified', staged: false }],
    });
    const before = git.commits.length;
    const kinds: string[] = [];
    let changeset: Extract<AgentEvent, { kind: 'Changeset' }>['changeset'] | null = null;
    const handle = await start('append "One." to runs/a.md then append "Two." to runs/b.md');
    const stop = onAgentEvent((event) => {
      kinds.push(event.kind);
      if (event.kind === 'Changeset') changeset = event.changeset;
    }, handle.run);
    await doneOf(handle.run);
    stop();
    expect(kinds.slice(-2)).toEqual(['Changeset', 'Done']);
    const got = changeset as unknown as {
      state: string;
      commit: string;
      files: { path: string }[];
    };
    expect(got.state).toBe('committed');
    expect(got.files.map((f) => f.path)).toEqual(['runs/a.md', 'runs/b.md']);
    expect(got.commit).toMatch(/^[0-9a-f]{40}$/);
    const state = window.__cerebroMockGit;
    expect(state?.commits.length).toBe(before + 1);
    expect(state?.commits[0].hash).toBe(got.commit);
    expect(state?.commits[0].changes?.files.map((f) => f.path)).toEqual(['runs/a.md', 'runs/b.md']);
    expect(state?.commits[0].message).toContain(`Cerebro-Run: ${handle.attach}`);
    // The person's third file stays theirs, uncommitted.
    expect(state?.modified.map((f) => f.path)).toEqual(['runs/mine.md']);
    // The run is over, so nothing is owned any more.
    expect(mock.liveRunPaths(handle.attach ?? '')).toEqual([]);
  });

  it('a run that wrote nothing changes nothing', async () => {
    const git = resetMockGit();
    const before = git.commits.length;
    let changeset: unknown = null;
    const handle = await start('hello');
    const stop = onAgentEvent((event) => {
      if (event.kind === 'Changeset') changeset = event.changeset;
    }, handle.run);
    await doneOf(handle.run);
    stop();
    expect(changeset).toEqual({ state: 'nothing', run_id: handle.attach, shell_unrecorded: false });
    expect(window.__cerebroMockGit?.commits.length).toBe(before);
  });
});
