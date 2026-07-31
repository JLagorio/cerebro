import { describe, expect, it } from 'vitest';
import { jobQueue } from './jobs';
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
    expect(parseSchedule('weekly fri 17:00')).toEqual({ kind: 'weekly', day: 5, hour: 17, minute: 0 });
    expect(parseSchedule('weekly monday 09:15')).toEqual({ kind: 'weekly', day: 1, hour: 9, minute: 15 });
  });

  it('rejects everything malformed rather than guessing', () => {
    for (const bad of [undefined, null, 42, '', 'sometimes', 'daily', 'daily 25:00', 'daily 9:60', 'weekly 09:00', 'weekly noday 09:00', 'monthly 1 09:00']) {
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
    expect(lastFireKey({ kind: 'daily', hour: 17, minute: 0 }, friday1030)).toBe('2026-07-30 17:00');
  });

  it('weekdays skips back over the weekend', () => {
    const monday0800 = new Date(2026, 7, 3, 8, 0); // Mon Aug 3, before 09:00
    expect(lastFireKey({ kind: 'weekdays', hour: 9, minute: 0 }, monday0800)).toBe('2026-07-31 09:00');
  });

  it('weekly walks back to the scheduled day', () => {
    expect(lastFireKey({ kind: 'weekly', day: 5, hour: 17, minute: 0 }, friday1030)).toBe('2026-07-24 17:00');
    expect(lastFireKey({ kind: 'weekly', day: 1, hour: 9, minute: 0 }, friday1030)).toBe('2026-07-27 09:00');
  });

  it('weekly on the scheduled day AFTER the time fires today, not last week', () => {
    const friday1800 = new Date(2026, 6, 31, 18, 0);
    expect(lastFireKey({ kind: 'weekly', day: 5, hour: 17, minute: 0 }, friday1800)).toBe('2026-07-31 17:00');
  });

  it('weekdays observed FROM a weekend walks back to Friday', () => {
    const saturday1000 = new Date(2026, 7, 1, 10, 0); // Sat Aug 1
    expect(lastFireKey({ kind: 'weekdays', hour: 9, minute: 0 }, saturday1000)).toBe('2026-07-31 09:00');
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
        expect(lastFireKey({ kind: 'weekly', day: 0, hour: 2, minute: 30 }, now)).toMatch(/ 02:30$/);
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
      makeEntry({ path: 'inbox/capture.md', title: 'Capture', snippet: 'notes', modifiedAt: '2026-07-31T08:00:00Z' }),
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
      makeEntry({ path: 'inbox/new.md', title: 'New', snippet: 'x', modifiedAt: '2026-07-31T08:00:00Z' }),
      skill('Digest', 'daily 09:00'),
      makeEntry({ path: 'docs/edited.md', title: 'Edited', snippet: 'x', modifiedAt: '2026-07-31T09:00:00Z' }),
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
