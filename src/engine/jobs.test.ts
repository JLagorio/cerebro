import { describe, expect, it } from 'vitest';
import SCHEMA_RS from '../../src-tauri/src/runtime/schema.rs?raw';
import { agentRef } from './agents';
import {
  causeOfJob,
  dueFireKey,
  runNowJob,
  jobQueue,
  TRIGGER_COOLDOWN_MS,
  type AgentJob,
} from './jobs';
import type { Trigger } from './triggers';
import { triggerDigest, type PendingWake } from './wakes';
import { fireKeyDate, lastFireKey, parseSchedule } from './skills';
import { listConcepts } from './okf';
import { makeEntry } from './testHelpers';

const TODAY = '2026-07-31';

const skill = (title: string, schedule?: string) =>
  makeEntry({
    path: `records/skills/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    title,
    type: 'Skill',
    properties: schedule === undefined ? {} : { schedule },
    snippet: 'instructions',
  });

const EMPTY = { attempts: {}, skillRuns: {} };

describe('parseSchedule', () => {
  it('parses the four forms, case-insensitively', () => {
    expect(parseSchedule('hourly')).toEqual({ kind: 'hourly' });
    expect(parseSchedule('daily 09:00')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    expect(parseSchedule('Weekdays 8:30')).toEqual({ kind: 'weekdays', hour: 8, minute: 30 });
    expect(parseSchedule('weekly fri 17:00')).toEqual({
      kind: 'weekly',
      day: 5,
      hour: 17,
      minute: 0,
    });
    expect(parseSchedule('weekly monday 09:15')).toEqual({
      kind: 'weekly',
      day: 1,
      hour: 9,
      minute: 15,
    });
  });

  it('resolves full day names to their own day — saturday is not sunday (PR #5 review)', () => {
    expect(parseSchedule('weekly saturday 10:00')).toEqual({
      kind: 'weekly',
      day: 6,
      hour: 10,
      minute: 0,
    });
    expect(parseSchedule('weekly sunday 08:00')).toEqual({
      kind: 'weekly',
      day: 0,
      hour: 8,
      minute: 0,
    });
  });

  it('rejects everything malformed rather than guessing', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'sometimes',
      'daily',
      'daily 25:00',
      'daily 9:60',
      'weekly 09:00',
      'weekly noday 09:00',
      'monthly 29 09:00',
      'once 2026-02-29 09:00',
      'weekly fri,fri 09:00',
    ]) {
      expect(parseSchedule(bad)).toBeNull();
    }
  });
});

describe('lastFireKey', () => {
  // 2026-07-31 is a Friday.
  const friday1030 = new Date(2026, 6, 31, 10, 30);

  it('hourly truncates to the hour in UTC — fall-back repeats a local hour, never a UTC one', () => {
    const expected = `${friday1030.toISOString().slice(0, 13)}:00Z`;
    expect(lastFireKey({ kind: 'hourly' }, friday1030)).toBe(expected);
  });

  it('daily fires today once the time has passed, else yesterday', () => {
    expect(lastFireKey({ kind: 'daily', hour: 9, minute: 0 }, friday1030)).toBe('2026-07-31 09:00');
    expect(lastFireKey({ kind: 'daily', hour: 17, minute: 0 }, friday1030)).toBe(
      '2026-07-30 17:00',
    );
  });

  it('weekdays skips back over the weekend', () => {
    const monday0800 = new Date(2026, 7, 3, 8, 0); // Mon Aug 3, before 09:00
    expect(lastFireKey({ kind: 'weekdays', hour: 9, minute: 0 }, monday0800)).toBe(
      '2026-07-31 09:00',
    );
  });

  it('weekly walks back to the scheduled day', () => {
    expect(lastFireKey({ kind: 'weekly', day: 5, hour: 17, minute: 0 }, friday1030)).toBe(
      '2026-07-24 17:00',
    );
    expect(lastFireKey({ kind: 'weekly', day: 1, hour: 9, minute: 0 }, friday1030)).toBe(
      '2026-07-27 09:00',
    );
  });

  it('weekly on the scheduled day AFTER the time fires today, not last week', () => {
    const friday1800 = new Date(2026, 6, 31, 18, 0);
    expect(lastFireKey({ kind: 'weekly', day: 5, hour: 17, minute: 0 }, friday1800)).toBe(
      '2026-07-31 17:00',
    );
  });

  it('weekdays observed FROM a weekend walks back to Friday', () => {
    const saturday1000 = new Date(2026, 7, 1, 10, 0); // Sat Aug 1
    expect(lastFireKey({ kind: 'weekdays', hour: 9, minute: 0 }, saturday1000)).toBe(
      '2026-07-31 09:00',
    );
  });

  it("a dated key's HH:MM always equals the schedule's — DST normalization must never leak in", () => {
    // Spring-forward (2026-03-08 in US zones) turns a skipped 02:30 into a
    // normalized 03:30 on the Date object; stamping that onto a walked-back
    // day minted a phantom key and a duplicate unattended run. The invariant
    // holds in every timezone, DST or not.
    for (let day = 7; day <= 9; day++) {
      for (const hour of [0, 1, 3, 12, 23]) {
        const now = new Date(2026, 2, day, hour, 45);
        expect(lastFireKey({ kind: 'daily', hour: 2, minute: 30 }, now)).toMatch(/ 02:30$/);
        expect(lastFireKey({ kind: 'weekdays', hour: 2, minute: 30 }, now)).toMatch(/ 02:30$/);
        expect(lastFireKey({ kind: 'weekly', day: 0, hour: 2, minute: 30 }, now)).toMatch(
          / 02:30$/,
        );
      }
    }
  });
});

describe('jobQueue', () => {
  const now = new Date(2026, 6, 31, 10, 30);

  it('derives a due scheduled run and suppresses it once recorded', () => {
    const entries = [skill('Digest', 'daily 09:00')];
    const due = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now });
    expect(due.map((j) => [j.kind, j.path, j.runKey])).toEqual([
      ['scheduled', 'records/skills/digest.md', '2026-07-31 09:00'],
    ]);
    // A skill has no trigger, so it has no cooldown to start.
    expect(due[0].cooldownKey).toBeNull();
    const recorded = jobQueue(entries, listConcepts(entries, TODAY), {
      ...EMPTY,
      skillRuns: { 'records/skills/digest.md': '2026-07-31 09:00' },
      now,
    });
    expect(recorded).toEqual([]);
  });

  it('a recorded key from an OLDER fire re-queues at the next one — one catch-up, not a backlog', () => {
    const entries = [skill('Digest', 'daily 09:00')];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), {
      ...EMPTY,
      skillRuns: { 'records/skills/digest.md': '2026-07-28 09:00' },
      now,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].runKey).toBe('2026-07-31 09:00');
  });

  it('unscheduled and malformed-schedule skills produce no jobs', () => {
    const entries = [skill('Plain'), skill('Broken', 'whenever feels right')];
    expect(jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now })).toEqual([]);
  });

  it("a capture produces no job at all — reading it is the ingest pass's (M26.4j)", () => {
    // The distillation lanes are gone. Organizing a capture WRITES the note,
    // and changed bytes are what the Rust ingest tick watches; a renderer
    // queue that only knew about work the UI had recorded could never see a
    // note edited in an external editor.
    const entries = [
      skill('Digest', 'daily 09:00'),
      makeEntry({
        path: 'inbox/capture.md',
        title: 'Capture',
        snippet: 'notes',
        modifiedAt: '2026-07-31T08:00:00Z',
      }),
    ];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now });
    expect(jobs.map((j) => j.kind)).toEqual(['scheduled']);
  });

  it('orders what is left: scheduled, then the recheck lanes', () => {
    // The full RANK, pinned: mutating any tier's number fails here. The
    // runner takes jobQueue(...)[0], so a wrong order is a wrong next run.
    const entries = [
      makeEntry({
        path: 'inbox/new.md',
        title: 'New',
        snippet: 'x',
        modifiedAt: '2026-07-31T08:00:00Z',
      }),
      skill('Digest', 'daily 09:00'),
      makeEntry({
        path: 'docs/edited.md',
        title: 'Edited',
        snippet: 'x',
        modifiedAt: '2026-07-31T09:00:00Z',
      }),
      makeEntry({
        path: 'knowledge/systems/cites-edited.md',
        title: 'Cites edited',
        properties: {
          sources: [{ id: 's', resource: 'docs/edited.md' }],
          generated: { by: 'claude-code', at: '2026-07-30T00:00:00Z' },
        },
      }),
      makeEntry({
        path: 'knowledge/systems/old.md',
        title: 'Old',
        properties: {
          generated: { by: 'claude-code', at: '2026-06-01T00:00:00Z' },
          stale_after: '2026-07-01',
        },
      }),
    ];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now });
    // The full RANK, pinned. `filed` and `behind` are gone with the
    // distillation lanes (M26.4j) — reading a note is `src-tauri/src/ingest/`
    // now — and what is left is a standing appointment plus maintenance.
    expect(jobs.map((j) => j.kind)).toEqual(['scheduled', 'stale']);
  });

  it('a scheduled Agent record derives an agent job, ledgered like a skill, and never distils', () => {
    const scout = makeEntry({
      path: 'records/agents/scout.md',
      title: 'Scout',
      type: 'Agent',
      snippet: 'instructions',
      properties: { schedule: 'daily 09:00', tools: 'safe' },
    });
    const due = jobQueue([scout], [], { ...EMPTY, now });
    // One job, and it is the RUN.
    expect(due.map((j) => [j.kind, j.runKey])).toEqual([['agent', '2026-07-31 09:00']]);
    // The job names the ledger that gates it, and for an agent that is the
    // fire-key ledger. Recording it anywhere else re-runs the agent forever
    // — the review's worst finding, pinned here.
    expect(due[0].ledger).toBe('skillRuns');
    // And it starts no event cooldown: only an event-fired run does
    // (TRIGGER_COOLDOWN_MS).
    expect(due[0].cooldownKey).toBeNull();
    expect(
      jobQueue([scout], [], {
        ...EMPTY,
        skillRuns: { 'records/agents/scout.md': '2026-07-31 09:00' },
        now,
      }),
    ).toEqual([]);
  });

  it('an agent run ranks after a scheduled skill and before maintenance', () => {
    const entries = [
      makeEntry({
        path: 'records/agents/scout.md',
        title: 'Scout',
        type: 'Agent',
        snippet: 'x',
        properties: { schedule: 'daily 09:00' },
      }),
      skill('Digest', 'daily 09:00'),
      makeEntry({
        path: 'docs/edited.md',
        title: 'Edited',
        snippet: 'x',
        modifiedAt: '2026-07-31T09:00:00Z',
      }),
      makeEntry({
        path: 'knowledge/systems/cites-edited.md',
        title: 'Cites edited',
        properties: {
          sources: [{ id: 's', resource: 'docs/edited.md' }],
          generated: { by: 'claude-code', at: '2026-07-30T00:00:00Z' },
        },
      }),
    ];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now });
    expect(jobs.map((j) => j.kind)).toEqual(['scheduled', 'agent']);
  });

  it('derives no refresh for a stale cached source — a refresh run holds no connector (M54.9)', () => {
    // A refresh runs unattended with no record to name `connectors:`, and an
    // unattended run reaches only the connectors its record names. A job
    // here would spend a budgeted run that can only say it has no connector,
    // once per stale source, so the stale copy waits and the concept that
    // cites it is still rechecked.
    const entries = [
      makeEntry({
        path: 'sources/issues/ops-121.md',
        title: 'OPS-121',
        type: 'Source',
        snippet: 'cached ticket',
        properties: { stale_after: '2026-07-01' },
        modifiedAt: '2026-06-01T00:00:00Z',
      }),
      makeEntry({
        path: 'knowledge/systems/old.md',
        title: 'Old',
        properties: {
          sources: [{ id: 's', resource: 'sources/issues/ops-121.md' }],
          generated: { by: 'claude-code', at: '2026-06-01T00:00:00Z' },
          stale_after: '2026-07-01',
        },
      }),
    ];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now });
    expect(jobs.map((j) => [j.kind, j.path])).toEqual([['stale', 'knowledge/systems/old.md']]);
  });

  it('a type-doc edit after a concept was written queues a schema recheck — lazily, never in bulk', () => {
    const record = makeEntry({ path: 'records/epics/phoenix.md', title: 'Phoenix', type: 'Epic' });
    const typeDoc = makeEntry({
      path: 'types/epic.md',
      title: 'Epic',
      type: 'Type',
      modifiedAt: '2026-07-30T12:00:00Z',
    });
    const concept = makeEntry({
      path: 'knowledge/systems/phoenix-shape.md',
      title: 'Phoenix shape',
      modifiedAt: '2026-07-01T00:00:00Z',
      properties: { generated: { by: 'claude-code', at: '2026-07-01T00:00:00Z' } },
      relationships: { about: ['Phoenix'] },
    });
    const entries = [record, typeDoc, concept];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now });
    expect(jobs.map((j) => [j.kind, j.path])).toEqual([
      ['schema', 'knowledge/systems/phoenix-shape.md'],
    ]);
    // M49.7 (K18): keyed on the SCHEMA it was checked against, never an
    // mtime — the same schema is the same key whenever the doc was touched.
    expect(jobs[0].runKey).toMatch(/^schema:[0-9a-f]{16}$/);
    const touched = [record, { ...typeDoc, modifiedAt: '2026-07-31T09:00:00Z' }, concept];
    expect(jobQueue(touched, listConcepts(touched, TODAY), { ...EMPTY, now })[0].runKey).toBe(
      jobs[0].runKey,
    );
    // A type edited BEFORE the concept was generated is not a change to it.
    const older = [record, { ...typeDoc, modifiedAt: '2026-06-01T00:00:00Z' }, concept];
    expect(jobQueue(older, listConcepts(older, TODAY), { ...EMPTY, now })).toEqual([]);
  });

  it('stale + schema on one concept is ONE job under ONE ledger key — a no-op recheck cannot ping-pong', () => {
    const record = makeEntry({ path: 'records/epics/phoenix.md', title: 'Phoenix', type: 'Epic' });
    const typeDoc = makeEntry({
      path: 'types/epic.md',
      title: 'Epic',
      type: 'Type',
      modifiedAt: '2026-07-30T12:00:00Z',
    });
    const concept = makeEntry({
      path: 'knowledge/systems/phoenix-shape.md',
      title: 'Phoenix shape',
      modifiedAt: '2026-07-05T00:00:00Z',
      properties: {
        generated: { by: 'claude-code', at: '2026-07-01T00:00:00Z' },
        stale_after: '2026-07-15',
      },
      relationships: { about: ['Phoenix'] },
    });
    const entries = [record, typeDoc, concept];
    const due = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now });
    expect(due).toHaveLength(1);
    expect(due[0].kind).toBe('schema');
    // Recording the key suppresses BOTH triggers.
    const after = jobQueue(entries, listConcepts(entries, TODAY), {
      ...EMPTY,
      attempts: { 'knowledge/systems/phoenix-shape.md': due[0].runKey },
      now,
    });
    expect(after).toEqual([]);
  });

  it('a new Type queues nothing for concepts anchored to themselves or other concepts (M49.7, K18)', () => {
    // The live vault, 2026-08-17: creating `types/decision.md` re-queued gcs-5
    // through its SELF-anchor and the tx-6 pair through a Decision CONCEPT.
    const decisionType = makeEntry({
      path: 'types/decision.md',
      title: 'Decision',
      type: 'Type',
      modifiedAt: '2026-08-17T11:50:01Z',
    });
    const gcs5 = makeEntry({
      path: 'knowledge/decisions/gcs-5-supervision-ratio.md',
      title: 'GCS-5 supervision ratio',
      type: 'Decision',
      properties: { generated: { by: 'claude-code', at: '2026-08-16T10:00:00Z' } },
      relationships: { about: ['GCS-5 supervision ratio'] },
    });
    const frb = makeEntry({
      path: 'knowledge/decisions/frb-118-session-1-disposition.md',
      title: 'FRB-118 session 1 disposition',
      type: 'Decision',
      properties: { generated: { by: 'claude-code', at: '2026-08-16T10:00:00Z' } },
    });
    const tx6 = makeEntry({
      path: 'knowledge/systems/tx-6.md',
      title: 'TX-6',
      properties: { generated: { by: 'claude-code', at: '2026-08-16T10:00:00Z' } },
      relationships: { about: ['FRB-118 session 1 disposition'] },
    });
    const entries = [decisionType, gcs5, frb, tx6];
    expect(jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now })).toEqual([]);
  });

  it('an attempt recorded under the old mtime key still counts after an upgrade (M49.7)', () => {
    const concept = makeEntry({
      path: 'knowledge/systems/old.md',
      title: 'Old',
      modifiedAt: '2026-07-10T00:00:00Z',
      properties: {
        generated: { by: 'claude-code', at: '2026-06-01T00:00:00Z' },
        stale_after: '2026-07-01',
      },
    });
    const legacy = { [concept.path]: '2026-07-10T00:00:00Z' };
    expect(
      jobQueue([concept], listConcepts([concept], TODAY), { ...EMPTY, attempts: legacy, now }),
    ).toEqual([]);
    // …but not once the concept has moved past it.
    const moved = { ...concept, modifiedAt: '2026-07-20T00:00:00Z' };
    expect(
      jobQueue([moved], listConcepts([moved], TODAY), { ...EMPTY, attempts: legacy, now }),
    ).toHaveLength(1);
  });

  it('a stale recheck that did not move the date does not run again (M49.7, K19)', () => {
    const concept = makeEntry({
      path: 'knowledge/systems/old.md',
      title: 'Old',
      modifiedAt: '2026-07-10T00:00:00Z',
      properties: {
        generated: { by: 'claude-code', at: '2026-06-01T00:00:00Z' },
        stale_after: '2026-07-01',
      },
    });
    const [job] = jobQueue([concept], listConcepts([concept], TODAY), { ...EMPTY, now });
    expect(job.runKey).toBe('stale:2026-07-01');
    // The run restamped the file (a new mtime) without moving the date.
    const restamped = { ...concept, modifiedAt: '2026-07-28T09:00:00Z' };
    expect(
      jobQueue([restamped], listConcepts([restamped], TODAY), {
        ...EMPTY,
        attempts: { [concept.path]: job.runKey },
        now,
      }),
    ).toEqual([]);
  });

  it('a refreshed source wakes the agent watching sources/ — noticed, not pushed (M34.5.4)', () => {
    // The whole connection-trigger story in one deterministic test: nothing
    // in the app listens for webhooks (the Source Monitor never fetches, and
    // there is no HTTP server to push to). A refresh WRITES the cached copy,
    // the write is an ordinary VaultEvent, and `when: changed in sources` is
    // ordinary trigger vocabulary — so an outside change is admitted as a
    // wake when the copy lands, and runs at app pace, under the app's own
    // budget gate (M63.1).
    const watcher = makeEntry({
      path: 'records/agents/source-watcher.md',
      title: 'Source watcher',
      type: 'Agent',
      properties: { when: [{ event: 'changed', in: 'sources' }] },
    });
    const copy = makeEntry({ path: 'sources/issues/phx-421.md', title: 'PHX-421' });
    const entries = [watcher, copy];
    const wake: PendingWake = {
      wakeId: 'w1',
      agent: 'process:source-watcher',
      wakeKey: 'a'.repeat(64),
      trigger: triggerDigest({ event: 'changed', in: 'sources' }),
      cause: { kind: 'event', subject: copy.path, detail: 'a record changes in sources' },
      admittedAt: '2026-07-31T10:00:00.000Z',
      notBefore: null,
      deferred: null,
    };
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now, wakes: [wake] });
    expect(jobs.map((j) => [j.kind, j.path])).toEqual([
      ['agent', 'records/agents/source-watcher.md'],
    ]);
    // The run claims the wake, so THIS refresh wakes the agent once.
    expect(jobs[0].runKey).toBe('wake:w1');
    // Remembered in the wake lane's own slot, and — the one kind of run that
    // starts the cooldown — stamped under the agent's bare identity.
    expect(jobs[0].key).toBe('records/agents/source-watcher.md#wake');
    expect(jobs[0].ledger).toBe('wakes');
    expect(jobs[0].cooldownKey).toBe('records/agents/source-watcher.md');
  });

  it('a skill is never read for material, however a concept cites it', () => {
    const playbook = skill('Playbook');
    const entries = [
      playbook,
      makeEntry({
        path: 'knowledge/systems/about-playbook.md',
        title: 'About playbook',
        properties: {
          sources: [{ id: 's', resource: playbook.path }],
          generated: { by: 'claude-code', at: '2026-07-01T00:00:00Z' },
        },
      }),
    ];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now });
    expect(jobs).toEqual([]);
  });
});

/**
 * The wake lane (M63.1): an agent's due wakes, drained one run at a time.
 *
 * One agent with a schedule AND a trigger keeps two slots (AUTOMATION-2): the
 * schedule's under the bare identity, and the wake lane's `#wake`. Shared,
 * an event run overwrote the fire its schedule had answered, and the two
 * ping-ponged every fifteen minutes until the day's budget stopped them.
 */
describe('jobQueue — the wake lane (M63.1)', () => {
  const IDENTITY = 'records/agents/watcher.md';
  const INBOX: Trigger = { event: 'changed', in: 'inbox' };
  const OTHER: Trigger = { event: 'created', in: 'inbox' };
  const agent = (over: Record<string, unknown> = {}, path = IDENTITY) =>
    makeEntry({
      path,
      title: 'Watcher',
      type: 'Agent',
      snippet: 'instructions',
      properties: { schedule: 'daily 06:00', when: [INBOX], ...over },
    });
  const watcher = agent();
  const actor = agentRef(watcher).actor;
  let seq = 0;
  const wake = (over: Partial<PendingWake> = {}, trigger: Trigger = INBOX): PendingWake => {
    seq += 1;
    return {
      wakeId: `w${seq}`,
      agent: actor,
      wakeKey: String(seq % 10).repeat(64),
      trigger: triggerDigest(trigger),
      cause: { kind: 'event', subject: `inbox/${seq}.md`, detail: 'a record changes in inbox' },
      admittedAt: `2026-07-31T09:${String(seq % 60).padStart(2, '0')}:00.000Z`,
      notBefore: null,
      deferred: null,
      ...over,
    };
  };
  /** 2026-07-31 on the local wall clock — the one schedules run on. */
  const at = (hour: number, minute = 0) => new Date(2026, 6, 31, hour, minute);
  const answered = { [IDENTITY]: '2026-07-31 06:00' };
  const derive = (
    wakes: readonly PendingWake[],
    now: Date,
    triggerRuns: Record<string, string> = {},
    entries = [watcher],
  ) => jobQueue(entries, [], { attempts: {}, skillRuns: answered, triggerRuns, wakes, now });

  it('drains the oldest due wake and takes the due wakes of its trigger with it', () => {
    const first = wake({ admittedAt: '2026-07-31T09:00:00.000Z' });
    const other = wake({ admittedAt: '2026-07-31T09:01:00.000Z' }, OTHER);
    const second = wake({ admittedAt: '2026-07-31T09:02:00.000Z' });
    const watching = agent({ when: [INBOX, OTHER] });
    const [job, ...rest] = derive([first, other, second], at(10), {}, [watching]);
    expect(rest).toEqual([]);
    expect(job).toEqual({
      kind: 'agent',
      path: IDENTITY,
      key: `${IDENTITY}#wake`,
      title: 'Watcher',
      runKey: `wake:${first.wakeId}`,
      ledger: 'wakes',
      cooldownKey: IDENTITY,
      wake: {
        claim: first.wakeId,
        coalesce: [second.wakeId],
        trigger: INBOX,
        admittedAt: first.admittedAt,
        deferredBefore: null,
      },
    });
  });

  it('coalesces only wakes that share the same recorded parent', () => {
    const head = wake({ parentRunId: 'a' });
    const same = wake({ parentRunId: 'a' });
    const other = wake({ parentRunId: 'b' });
    const root = wake();
    const [job] = derive([head, same, other, root], at(10));
    expect(job.wake?.coalesce).toEqual([same.wakeId]);
  });

  it('coalesces at most nineteen, oldest first', () => {
    const wakes = Array.from({ length: 25 }, (_, n) =>
      wake({ admittedAt: `2026-07-31T09:${String(n).padStart(2, '0')}:00.000Z` }),
    );
    const [job] = derive(wakes, at(10));
    expect(job.wake?.claim).toBe(wakes[0].wakeId);
    expect(job.wake?.coalesce).toEqual(wakes.slice(1, 20).map((w) => w.wakeId));
  });

  it('waits out notBefore and the cooldown, and drops nothing', () => {
    const deferred = wake({ notBefore: at(10, 10).toISOString(), deferred: 'daily_runs' });
    expect(derive([deferred], at(10))).toEqual([]);
    const [due] = derive([deferred], at(10, 10));
    expect(due.wake).toMatchObject({ claim: deferred.wakeId, deferredBefore: 'daily_runs' });
    // A woken run stamped the clock at 10:00: the next wake waits, then runs.
    const stamped = at(10, 0).getTime();
    const clock = { [IDENTITY]: at(10, 0).toISOString() };
    const next = wake();
    expect(derive([next], new Date(stamped + TRIGGER_COOLDOWN_MS - 1), clock)).toEqual([]);
    expect(
      derive([next], new Date(stamped + TRIGGER_COOLDOWN_MS), clock).map((j) => j.runKey),
    ).toEqual([`wake:${next.wakeId}`]);
  });

  it('skips a wake whose trigger is gone, and another agent never runs it', () => {
    const edited = wake({}, { event: 'moved' });
    expect(derive([edited], at(10))).toEqual([]);
    const theirs = wake({ agent: 'process:someone-else' });
    expect(derive([theirs], at(10))).toEqual([]);
    const live = wake({ admittedAt: '2026-07-31T09:59:00.000Z' });
    expect(derive([edited, live], at(10)).map((j) => j.runKey)).toEqual([`wake:${live.wakeId}`]);
  });

  it('a paused agent, or one with no trigger, derives no woken run', () => {
    const w = wake();
    expect(derive([w], at(10), {}, [agent({ paused: true })])).toEqual([]);
    expect(derive([w], at(10), {}, [agent({ when: undefined })])).toEqual([]);
  });

  it('orders woken runs by admission, before every fire', () => {
    const scout = agent({ slug: 'scout', schedule: undefined }, 'records/agents/scout.md');
    const late = wake({ admittedAt: '2026-07-31T09:30:00.000Z' });
    const early = wake({ agent: 'process:scout', admittedAt: '2026-07-31T09:10:00.000Z' });
    const jobs = jobQueue([watcher, scout], [], {
      attempts: {},
      skillRuns: {},
      wakes: [late, early],
      now: at(10),
    });
    expect(jobs.map((j) => j.runKey)).toEqual([
      `wake:${early.wakeId}`,
      `wake:${late.wakeId}`,
      '2026-07-31 06:00',
    ]);
  });

  it('absent wakes, as after a failed read, derive no woken run', () => {
    expect(jobQueue([watcher], [], { attempts: {}, skillRuns: answered, now: at(10) })).toEqual([]);
  });

  it('a schedule and a wake keep their own slots, so neither re-fires the other', () => {
    const w = wake();
    // The 06:00 is answered; a woken run does not touch its slot.
    const jobs = derive([w], at(10));
    expect(jobs.map((j) => [j.key, j.runKey, j.cooldownKey])).toEqual([
      [`${IDENTITY}#wake`, `wake:${w.wakeId}`, IDENTITY],
    ]);
    // Once the wake ran (it is no longer pending), the day is quiet, and
    // tomorrow's 06:00 is the schedule's alone.
    const clock = { [IDENTITY]: at(10).toISOString() };
    for (const now of [at(10, 1), at(10, 16), at(23, 59)]) {
      expect(derive([], now, clock)).toEqual([]);
    }
    expect(derive([], new Date(2026, 7, 1, 6, 30), clock).map((j) => [j.key, j.runKey])).toEqual([
      [IDENTITY, '2026-08-01 06:00'],
    ]);
  });

  it('a slugged agent keeps both slots by its slug, so a rename moves neither', () => {
    const slugged = agent({ slug: 'Risk watch' }, 'records/agents/renamed.md');
    const w = wake({ agent: 'process:risk-watch' });
    const jobs = jobQueue([slugged], [], {
      attempts: {},
      skillRuns: {},
      triggerRuns: {},
      wakes: [w],
      now: at(10, 30),
    });
    expect(jobs.map((j) => [j.key, j.runKey, j.cooldownKey])).toEqual([
      ['slug:risk-watch#wake', `wake:${w.wakeId}`, 'slug:risk-watch'],
      ['slug:risk-watch', '2026-07-31 06:00', null],
    ]);
  });
});

describe('causeOfJob (M56.7)', () => {
  const job = (over: Partial<AgentJob>): AgentJob => ({
    kind: 'agent',
    path: 'records/agents/scout.md',
    key: 'records/agents/scout.md',
    title: 'Scout',
    runKey: '2026-07-28 08:30',
    ledger: 'skillRuns',
    cooldownKey: null,
    ...over,
  });

  it("a schedule names the record's schedule and the fire's due moment", () => {
    expect(causeOfJob(job({}), 'weekdays 08:30')).toEqual({
      kind: 'schedule',
      detail: 'weekdays 08:30',
      due_at: fireKeyDate('2026-07-28 08:30')?.toISOString(),
    });
    expect(causeOfJob(job({ kind: 'scheduled' }), null)).toEqual({
      kind: 'schedule',
      due_at: fireKeyDate('2026-07-28 08:30')?.toISOString(),
    });
  });

  it("a woken run names none: its cause is its wake's (M63.1)", () => {
    const woken = job({
      runKey: 'wake:w1',
      key: 'records/agents/scout.md#wake',
      ledger: 'wakes',
      wake: {
        claim: 'w1',
        coalesce: [],
        trigger: { event: 'changed' },
        admittedAt: '2026-07-28T10:00:00.000Z',
        deferredBefore: null,
      },
    });
    expect(causeOfJob(woken, 'daily 09:00')).toBeNull();
  });

  it('the recheck lanes are maintenance, with the lane as the reason', () => {
    const lane = (kind: AgentJob['kind']) =>
      causeOfJob(
        job({ kind, path: 'knowledge/acme.md', runKey: 'stale:2026-07-01', ledger: 'attempts' }),
        null,
      );
    expect(lane('refresh')).toEqual({
      kind: 'maintenance',
      subject: 'knowledge/acme.md',
      detail: 'a cached source passed its refresh date',
    });
    expect(lane('stale')).toEqual({
      kind: 'maintenance',
      subject: 'knowledge/acme.md',
      detail: 'a concept passed its recheck date',
    });
    expect(lane('schema')).toEqual({
      kind: 'maintenance',
      subject: 'knowledge/acme.md',
      detail: 'the schema a concept describes changed',
    });
  });

  it('the runner names only kinds the runs CHECK holds', () => {
    const opens = "json_extract(cause, '$.kind') IN (";
    const at = SCHEMA_RS.indexOf(opens);
    expect(at).toBeGreaterThan(-1);
    const rest = SCHEMA_RS.slice(at + opens.length);
    const held = rest
      .slice(0, rest.indexOf(')'))
      .split(',')
      .map((name) => name.trim().replace(/'/g, ''));
    expect(held.length).toBe(10);
    const kinds: AgentJob['kind'][] = ['scheduled', 'agent', 'refresh', 'stale', 'schema'];
    const named = new Set(kinds.map((kind) => causeOfJob(job({ kind }), null)?.kind));
    // A woken run's kind is the wake's: engine/wakes.ts names `event`.
    named.add('event');
    for (const kind of named) expect(held).toContain(kind);
  });
});

it('Run now takes an unconsumed due fire and otherwise records no ledger', () => {
  const entry = makeEntry({
    path: 'agents/scout.md',
    type: 'Agent',
    title: 'Scout',
    properties: { slug: 'scout', schedule: 'daily 08:00' },
  });
  const now = new Date(2026, 6, 28, 12);
  const due = dueFireKey(entry, {}, now)!;
  expect(due).toBe(lastFireKey(parseSchedule('daily 08:00')!, now));
  const job = runNowJob(entry, { skillRuns: {}, now });
  expect(job).toMatchObject({ manual: true, ledger: 'skillRuns', runKey: due, cooldownKey: null });
  expect(causeOfJob(job, 'daily 08:00')).toEqual({
    kind: 'manual',
    subject: entry.path,
    detail: 'in place of its run due 2026-07-28 08:00',
  });
  expect(dueFireKey(entry, { [job.key]: due }, now)).toBeNull();
  const again = runNowJob(entry, { skillRuns: { [job.key]: due }, now });
  expect(again).toMatchObject({
    manual: true,
    ledger: null,
    runKey: `manual:${now.toISOString()}`,
  });
  expect(causeOfJob(again, 'daily 08:00')).toEqual({ kind: 'manual', subject: entry.path });
  expect(dueFireKey({ ...entry, properties: {} }, {}, now)).toBeNull();
});

it('a list owes its newest fire and records the whole list as its cause', () => {
  const entry = skill('Digest');
  entry.properties.schedule = ['monthly last 18:00', 'weekdays 08:30'];
  const now = new Date(2026, 6, 28, 12);
  const jobs = jobQueue([entry], [], { ...EMPTY, now });
  expect(jobs).toHaveLength(1);
  expect(jobs[0].runKey).toBe('2026-07-28 08:30');
  expect(causeOfJob(jobs[0], entry.properties.schedule)?.detail).toBe(
    'monthly last 18:00; weekdays 08:30',
  );
  expect(
    jobQueue([entry], [], { ...EMPTY, now, skillRuns: { [entry.path]: jobs[0].runKey } }),
  ).toEqual([]);
  entry.properties.schedule = 'once 2026-10-20 09:00';
  expect(jobQueue([entry], [], { ...EMPTY, now })).toEqual([]);
});

describe('booked follow-ups (M63.8)', () => {
  const now = new Date('2026-10-15T12:00:00.000Z');
  const owner = makeEntry({
    path: 'agents/scout.md',
    type: 'Agent',
    title: 'Scout',
    properties: { slug: 'scout', schedule: 'hourly' },
  });
  const row = (
    over: Partial<import('./followups').Followup> = {},
  ): import('./followups').Followup => ({
    followupId: '00000000000000000000000000000001',
    actor: 'process:scout',
    note: 'check the vendor reply',
    dueAt: '2026-10-15T11:59:00.000Z',
    requestedAt: '2026-10-15T10:00:00.000Z',
    requestedByRun: 'previous',
    state: 'pending',
    claimedAt: null,
    runId: null,
    endedAt: null,
    cancelReason: null,
    ...over,
  });
  const queue = (followups: import('./followups').Followup[], entries = [owner]) =>
    jobQueue(entries, [], { ...EMPTY, now, followups });
  it('derives one job per due row before any schedule and gives it its recorded cause', () => {
    const job = queue([row()])[0];
    expect(job).toMatchObject({
      kind: 'agent',
      path: owner.path,
      title: 'Scout',
      ledger: 'followup',
      key: 'followup:00000000000000000000000000000001',
      cooldownKey: null,
    });
    expect(causeOfJob(job, 'hourly')).toEqual({
      kind: 'followup',
      subject: 'check the vendor reply',
      due_at: '2026-10-15T11:59:00.000Z',
    });
    expect(queue([row()], [owner, skill('Digest', 'hourly')]).map((item) => item.ledger)).toEqual([
      'followup',
      'skillRuns',
      'skillRuns',
    ]);
  });
  it('a future row, a fresh claim and ended rows derive nothing', () => {
    for (const input of [
      row({ dueAt: '2026-10-15T12:00:00.001Z' }),
      row({ state: 'claimed', claimedAt: '2026-10-15T11:50:00.001Z' }),
      row({ state: 'fired' }),
      row({ state: 'cancelled' }),
    ])
      expect(queue([input]).filter((item) => item.followup !== undefined)).toEqual([]);
  });
  it('a claim at the ten-minute boundary can recover, with no schedule cooldown', () => {
    const expired = row({ state: 'claimed', claimedAt: '2026-10-15T11:50:00.000Z' });
    const jobs = jobQueue([owner], [], {
      ...EMPTY,
      now,
      followups: [expired],
      triggerRuns: { 'slug:scout': now.toISOString() },
    });
    expect(jobs[0].followup).toEqual(expired);
  });
  it('missing, duplicate and paused owners still derive a row for the runtime to cancel', () => {
    expect(queue([row()], [])[0]).toMatchObject({ path: '', title: 'process:scout' });
    expect(queue([row()], [owner, { ...owner, path: 'other.md' }])[0]).toMatchObject({ path: '' });
    expect(
      queue([row()], [{ ...owner, properties: { ...owner.properties, paused: true } }])[0],
    ).toMatchObject({ path: owner.path, ledger: 'followup' });
  });
  it('orders follow-ups by due time then id', () => {
    const later = row({ followupId: 'a', dueAt: '2026-10-15T12:00:00.000Z' });
    const earlier = row({ followupId: 'b' });
    expect(
      queue([later, earlier])
        .filter((job) => job.followup)
        .map((job) => job.followup!.followupId),
    ).toEqual(['b', 'a']);
  });
});
