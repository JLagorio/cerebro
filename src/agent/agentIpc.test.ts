import { beforeEach, describe, expect, it } from 'vitest';
import {
  MOCK_JOURNAL_EVENTS,
  attachRun,
  mockJournal,
  onAgentEvent,
  runAgent,
  stopAgent,
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
  if ('deferred' in handle || 'settled' in handle) {
    throw new Error('an attended run is never deferred or settled');
  }
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

describe('a mock woken run claims its wake (M63.1)', () => {
  const offer = (key: string, subject: string) => ({
    agent: 'process:scout',
    wakeKey: key.repeat(64),
    trigger: '1'.repeat(16),
    cause: { kind: 'event', subject },
    path: subject,
    hash: 'a'.repeat(64),
    event: 'changed' as const,
  });
  async function admitOne(key: string, subject = `records/risks/${key}.md`): Promise<string> {
    await mock.admitWakes(VAULT, [offer(key, subject)]);
    const pending = await mock.wakesPending(VAULT);
    return pending.find((w) => w.wakeKey === key.repeat(64))!.wakeId;
  }
  const woken = (message: string, claim: string, attended = false) =>
    runAgent(VAULT, {
      message,
      shell: 'off',
      connectors: false,
      attended,
      actor: 'process:scout',
      lane: 'agent',
      wake: { claim, coalesce: [] },
    });
  const row = (id: string) =>
    (window as unknown as { __cerebroMockWakes: () => mock.MockWake[] })
      .__cerebroMockWakes()
      .find((w) => w.wakeId === id);

  it('finishes its wake succeeded on Done', async () => {
    const id = await admitOne('a');
    const start = await woken('hello', id);
    if (!('run' in start)) throw new Error('a pending wake starts');
    expect(row(id)).toMatchObject({ state: 'started', runId: start.attach });
    await doneOf(start.run);
    expect(row(id)).toMatchObject({ state: 'finished', outcome: 'succeeded' });
  });

  it('finishes it failed after an Error', async () => {
    const id = await admitOne('a');
    const start = await woken('fail: unknown', id);
    if (!('run' in start)) throw new Error('a pending wake starts');
    await doneOf(start.run);
    expect(row(id)).toMatchObject({ state: 'finished', outcome: 'failed' });
  });

  it('finishes it interrupted when stopped, and a busy agent defers its next wake', async () => {
    const id = await admitOne('a');
    const next = await admitOne('b');
    const start = await woken('wait for me', id);
    if (!('run' in start)) throw new Error('a pending wake starts');
    expect(await woken('hello', next)).toEqual({
      deferred: ['agent_running'],
      words: ['this agent is already running'],
    });
    expect(row(next)).toMatchObject({ state: 'pending', deferred: 'agent_running' });
    const done = doneOf(start.run);
    await stopAgent(start.run);
    await done;
    releaseHeldMockRuns();
    expect(row(id)).toMatchObject({ state: 'finished', outcome: 'interrupted' });
  });

  it('a wake that is gone answers settled, and starts nothing', async () => {
    const id = await admitOne('a');
    await mock.setAgentPaused(VAULT, 'process:scout', true);
    await mock.setAgentPaused(VAULT, 'process:scout', false);
    expect(row(id)).toMatchObject({ outcome: 'cancelled', reason: 'superseded', detail: 'paused' });
    expect(await woken('hello', id)).toEqual({ settled: 'gone' });
  });

  it('refuses a woken request Rust would refuse, in its words', async () => {
    const id = await admitOne('a');
    await expect(woken('hello', id, true)).rejects.toThrow(/a woken run is unattended/);
    expect(row(id)).toMatchObject({ state: 'pending' });
  });
});

it('a manual start refuses another live run of that actor only in this vault', async () => {
  const options = {
    message: 'wait for me',
    shell: 'off' as const,
    connectors: false,
    attended: true,
    actor: 'process:release-scout',
  };
  const first = (await runAgent(VAULT, options)) as RunHandle;
  await expect(
    runAgent(VAULT, { ...options, attended: false, lane: 'agent', cause: { kind: 'manual' } }),
  ).rejects.toThrow('process:release-scout is already running, so Run now did not start another.');
  const elsewhere = (await runAgent('/other-vault', {
    ...options,
    attended: false,
    lane: 'agent',
    cause: { kind: 'manual' },
  })) as RunHandle;
  await stopAgent(first.run);
  await stopAgent(elsewhere.run);
  const next = (await runAgent(VAULT, {
    ...options,
    attended: false,
    lane: 'agent',
    cause: { kind: 'manual' },
  })) as RunHandle;
  await stopAgent(next.run);
});

describe('follow-up run binding', () => {
  const actor = 'process:release-scout';
  const options = {
    message: 'hello',
    shell: 'off' as const,
    connectors: false,
    attended: false,
    lane: 'agent',
    actor,
    followup: 'later',
  };
  const seed = () =>
    mock.__seedFollowups([
      {
        vault: VAULT,
        actor,
        followupId: 'later',
        note: 'the stored note',
        dueAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
  it('a claimed row overrides the wire cause and fires only one child', async () => {
    seed();
    await mock.claimFollowup(VAULT, 'later');
    const started = await runAgent(VAULT, {
      ...options,
      cause: { kind: 'event', subject: 'forged' },
    });
    expect('run' in started).toBe(true);
    expect(await runAgent(VAULT, options)).toEqual({ settled: 'gone' });
    if (!('run' in started)) throw Error('not started');
    await doneOf(started.run);
    const booked = await mock.fleetRunDetail(started.durableId!);
    expect(booked?.run.cause).toMatchObject({ kind: 'followup', subject: 'the stored note' });
    expect(await mock.listFollowups(VAULT)).toEqual([]);
  });
  it('a binding cannot become an attended, foreign, wake or differently billed run', async () => {
    seed();
    await mock.claimFollowup(VAULT, 'later');
    for (const patch of [{ attended: true }, { lane: 'skill' }, { actor: 'human:me' }])
      await expect(runAgent(VAULT, { ...options, ...patch })).rejects.toThrow(
        'A follow-up starts only its own agent, unattended on lane agent, without a wake.',
      );
    expect(await runAgent(VAULT, { ...options, actor: 'process:other' })).toEqual({
      settled: 'gone',
    });
    await expect(
      runAgent(VAULT, { ...options, followup: null, cause: { kind: 'followup' } }),
    ).rejects.toThrow('never named by the renderer');
    expect((await mock.listFollowups(VAULT))[0].state).toBe('claimed');
  });
});
