import { describe, expect, it } from 'vitest';
import { jobQueue, unlearnableFiled } from './jobs';
import { lastFireKey, parseSchedule } from './skills';
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

const EMPTY = { filed: [], attempts: {}, skillRuns: {} };

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
      'monthly 1 09:00',
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

  it('ranks a filed capture first, then scheduled, then maintenance', () => {
    const entries = [
      skill('Digest', 'daily 09:00'),
      makeEntry({
        path: 'inbox/capture.md',
        title: 'Capture',
        snippet: 'notes',
        modifiedAt: '2026-07-31T08:00:00Z',
      }),
    ];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), {
      ...EMPTY,
      filed: ['inbox/capture.md'],
      now,
    });
    expect(jobs.map((j) => j.kind)).toEqual(['filed', 'scheduled']);
  });

  it('orders all four kinds: filed, scheduled, behind, stale', () => {
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
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), {
      ...EMPTY,
      filed: ['inbox/new.md'],
      now,
    });
    expect(jobs.map((j) => j.kind)).toEqual(['filed', 'scheduled', 'behind', 'stale']);
  });

  it('a scheduled Agent record derives an agent job, ledgered like a skill, and never distils', () => {
    const scout = makeEntry({
      path: 'records/agents/scout.md',
      title: 'Scout',
      type: 'Agent',
      snippet: 'instructions',
      properties: { schedule: 'daily 09:00', tools: 'safe' },
    });
    const due = jobQueue([scout], [], { ...EMPTY, filed: ['records/agents/scout.md'], now });
    // One job, and it is the RUN — the filed entry is inert because an
    // agent's body is schema for behavior, exactly like a skill's.
    expect(due.map((j) => [j.kind, j.runKey])).toEqual([['agent', '2026-07-31 09:00']]);
    // The job names the ledger that gates it, and for an agent that is the
    // fire-key ledger. Recording it anywhere else re-runs the agent forever
    // — the review's worst finding, pinned here.
    expect(due[0].ledger).toBe('skillRuns');
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
    expect(jobs.map((j) => j.kind)).toEqual(['scheduled', 'agent', 'behind']);
  });

  it('derives a refresh for a stale cached source only while connectors are on', () => {
    const source = makeEntry({
      path: 'sources/issues/ops-121.md',
      title: 'OPS-121',
      type: 'Source',
      snippet: 'cached ticket',
      properties: { stale_after: '2026-07-01' },
      modifiedAt: '2026-06-01T00:00:00Z',
    });
    const fresh = makeEntry({
      path: 'sources/issues/ops-200.md',
      title: 'OPS-200',
      type: 'Source',
      snippet: 'cached ticket',
      properties: { stale_after: '2026-12-01' },
    });
    const on = jobQueue([source, fresh], [], { ...EMPTY, now, connectors: true });
    expect(on.map((j) => [j.kind, j.path])).toEqual([['refresh', 'sources/issues/ops-121.md']]);
    expect(on[0].ledger).toBe('attempts');
    // Without a connector there is nothing to re-fetch with — no job.
    expect(jobQueue([source], [], { ...EMPTY, now })).toEqual([]);
    // The shared attempts ledger stops the spin after one try.
    expect(
      jobQueue([source], [], {
        ...EMPTY,
        attempts: { 'sources/issues/ops-121.md': '2026-06-01T00:00:00Z' },
        now,
        connectors: true,
      }),
    ).toEqual([]);
  });

  it('a refresh-due source is ONE job even when it is also behind — the re-fetch is never starved', () => {
    // The source is cited by a concept with an older stamp, so without the
    // exclusion it would ALSO derive a behind job (rank 3) sharing the same
    // attempts key — running first and suppressing the re-fetch forever.
    const source = makeEntry({
      path: 'sources/issues/ops-121.md',
      title: 'OPS-121',
      type: 'Source',
      snippet: 'cached ticket',
      properties: { stale_after: '2026-07-01' },
      modifiedAt: '2026-07-20T00:00:00Z',
    });
    const entries = [
      source,
      makeEntry({
        path: 'knowledge/systems/cites-source.md',
        title: 'Cites source',
        properties: {
          sources: [{ id: 's', resource: 'sources/issues/ops-121.md' }],
          generated: { by: 'claude-code', at: '2026-07-10T00:00:00Z' },
        },
      }),
    ];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), {
      ...EMPTY,
      now,
      connectors: true,
    });
    expect(jobs.map((j) => j.kind)).toEqual(['refresh']);
    // With connectors OFF there is no refresh to protect — behind proceeds.
    const off = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now });
    expect(off.map((j) => j.kind)).toEqual(['behind']);
  });

  it('refresh outranks a stale concept recheck — the copy is replaced before it is re-read', () => {
    const entries = [
      makeEntry({
        path: 'sources/issues/ops-121.md',
        title: 'OPS-121',
        type: 'Source',
        snippet: 'x',
        properties: { stale_after: '2026-07-01' },
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
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), {
      ...EMPTY,
      now,
      connectors: true,
    });
    expect(jobs.map((j) => j.kind)).toEqual(['refresh', 'stale']);
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
    expect(jobs.map((j) => [j.kind, j.path, j.runKey])).toEqual([
      ['schema', 'knowledge/systems/phoenix-shape.md', '2026-07-30T12:00:00Z'],
    ]);
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
    expect(due[0].runKey).toBe('2026-07-30T12:00:00Z');
    // Recording the composite key suppresses BOTH triggers.
    const after = jobQueue(entries, listConcepts(entries, TODAY), {
      ...EMPTY,
      attempts: { 'knowledge/systems/phoenix-shape.md': '2026-07-30T12:00:00Z' },
      now,
    });
    expect(after).toEqual([]);
  });

  it('never distils a skill: filed or edited, its body is schema for behavior', () => {
    const playbook = skill('Playbook');
    const entries = [
      playbook,
      // A concept already cites the skill with an older stamp, so without the
      // filter this would derive BOTH a filed and a behind job.
      makeEntry({
        path: 'knowledge/systems/about-playbook.md',
        title: 'About playbook',
        properties: {
          sources: [{ id: 's', resource: playbook.path }],
          generated: { by: 'claude-code', at: '2026-07-01T00:00:00Z' },
        },
      }),
    ];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), {
      ...EMPTY,
      filed: [playbook.path],
      now,
    });
    expect(jobs).toEqual([]);
  });
});

describe('unlearnableFiled (PR #5 review: filed skills never dequeue)', () => {
  it('surfaces filed paths that point at Skill or Agent records, and only those', () => {
    const entries = [
      skill('Weekly Review'),
      makeEntry({
        path: 'records/agents/scout.md',
        title: 'Scout',
        type: 'Agent',
        snippet: 'instructions',
      }),
      makeEntry({ path: 'notes/idea.md', title: 'Idea', snippet: 'a real capture' }),
    ];
    // A learnable note stays filed; a path with no entry (deleted note) is
    // learn.ts's business, not this filter's.
    const filed = [
      'records/skills/weekly-review.md',
      'records/agents/scout.md',
      'notes/idea.md',
      'notes/deleted.md',
    ];
    expect(unlearnableFiled(entries, filed)).toEqual([
      'records/skills/weekly-review.md',
      'records/agents/scout.md',
    ]);
    expect(unlearnableFiled(entries, ['notes/idea.md'])).toEqual([]);
  });
});
