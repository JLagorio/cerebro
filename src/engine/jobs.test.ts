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
    // With connectors OFF there is no refresh to derive, and catching up on
    // the edit is the content diff's job now — so there is nothing here.
    const off = jobQueue(entries, listConcepts(entries, TODAY), { ...EMPTY, now });
    expect(off.map((j) => j.kind)).toEqual([]);
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
    // ordinary trigger vocabulary — so an outside change is noticed when the
    // copy lands, at app pace, under the app's own budget gate.
    const watcher = makeEntry({
      path: 'records/agents/source-watcher.md',
      title: 'Source watcher',
      type: 'Agent',
      properties: { when: [{ event: 'changed', in: 'sources' }] },
    });
    const copy = makeEntry({
      path: 'sources/issues/phx-421.md',
      title: 'PHX-421',
      modifiedAt: '2026-07-31T10:00:00Z',
    });
    const entries = [watcher, copy];
    const jobs = jobQueue(entries, listConcepts(entries, TODAY), {
      ...EMPTY,
      now,
      events: [{ kind: 'changed', path: copy.path, entry: copy, before: copy, fields: [] }],
    });
    expect(jobs.map((j) => [j.kind, j.path])).toEqual([
      ['agent', 'records/agents/source-watcher.md'],
    ]);
    // The fire key names the event, so THIS refresh wakes the agent once and
    // the next refresh — a new modifiedAt — is a genuinely new fire.
    expect(jobs[0].runKey).toBe('event:changed:sources/issues/phx-421.md@2026-07-31T10:00:00Z');
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
