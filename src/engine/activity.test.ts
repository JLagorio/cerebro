import { afterEach, describe, expect, it } from 'vitest';
import VAULT_WRITES_RS from '../../src-tauri/src/runtime/vault_writes.rs?raw';
import WRITE_LOG_RS from '../../src-tauri/src/runtime/write_log.rs?raw';
import {
  activityWindow,
  addDays,
  cellWords,
  CONTENT_KINDS,
  dayKeyOf,
  dayStates,
  feedOf,
  heatmapOf,
  listWords,
  revealed,
  runText,
  SESSION_GAP_MS,
  sessionsOf,
  sessionText,
  weekdayOf,
  foldTimeline,
  OUTSIDE_WORDS,
  pageDays,
  pageTimeline,
  type ActivityRunCore,
  type ActivityWrite,
  type AppSessionSpan,
  type ConceptEvent,
  type FeedGroup,
  type PageActivity,
  type VaultActivity,
} from './activity';
import type { FileCommit, PulseCommit } from './git';
import { makeEntry } from './testHelpers';

/**
 * History's fold (M64.2). Every case that reads a local day sets
 * `process.env.TZ` and restores it, so a day key is never the machine's.
 */

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});
function inZone(tz: string): void {
  process.env.TZ = tz;
}

const schedule = makeEntry({ path: 'delivery/how-we-schedule.md', title: 'How we schedule' });
const delivery = makeEntry({ path: 'delivery/delivery.md', title: 'Delivery' });
const plan = makeEntry({ path: 'notes/plan.md', title: 'Plan' });
const scout = makeEntry({
  path: 'records/agents/release-scout.md',
  title: 'Release scout',
  type: 'Agent',
  properties: { description: 'Watches releases.', tools: 'safe' },
});
const entries = [schedule, delivery, plan, scout];

function row(fields: Partial<ActivityWrite> & { first_at: string }): ActivityWrite {
  const kind = fields.kind ?? 'vault.write';
  return {
    kind,
    content: CONTENT_KINDS.includes(kind),
    path: 'delivery/how-we-schedule.md',
    to: null,
    actor: 'human:me',
    run_id: null,
    approved_by: null,
    at: fields.first_at,
    ...fields,
  };
}

/** `minute` minutes after 09:00Z on 2026-07-28. */
const t = (minute: number, second = 0) =>
  new Date(Date.UTC(2026, 6, 28, 9, minute, second)).toISOString();

type Run = ActivityRunCore & { cause: { why: string } | null };

function run(fields: Partial<Run> & { run_id: string }): Run {
  return {
    actor: 'process:release-scout',
    mode: 'ambient',
    started_at: t(15),
    ended_at: t(19),
    cli_session_id: null,
    writes_booked: 1,
    cause: { why: 'its schedule came due' },
    ...fields,
  };
}

const span = (opened_at: string, until: string, precision = 'clean_exact'): AppSessionSpan => ({
  opened_at,
  until,
  precision,
});

function activity(fields: Partial<VaultActivity<Run>> = {}): VaultActivity<Run> {
  return {
    writes: { state: 'read', rows: [], more: false },
    runs: { state: 'read', rows: [], more: false },
    app_sessions: { state: 'read', rows: [], more: false },
    recording_since: { state: 'read', at: null },
    ...fields,
  };
}

const read = <T>(rows: T[], more = false) => ({ state: 'read' as const, rows, more });
const down = { state: 'unavailable' as const, reason: 'no such table: app_sessions' };

function commit(hash: string, date: number): PulseCommit {
  return {
    hash: hash.repeat(40).slice(0, 40),
    shortHash: hash.repeat(7).slice(0, 7),
    message: `Checkpoint ${hash}`,
    author: 'Cerebro',
    date,
    changes: { files: [], added: 0, modified: 1, deleted: 0 },
  };
}

const days = <R extends ActivityRunCore>(groups: FeedGroup<R>[]) =>
  groups.flatMap((g) => (g.kind === 'day' ? [g.day] : []));

describe('sessions', () => {
  it('folds five rows a minute apart by one writer into one session', () => {
    inZone('UTC');
    const rows = [0, 1, 2, 3, 4].map((m) => row({ first_at: t(m) }));
    const sessions = sessionsOf(rows);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].first_at).toBe(t(0));
    expect(sessions[0].at).toBe(t(4));
    expect(sessions[0].pages).toEqual([
      { path: 'delivery/how-we-schedule.md', verb: 'edited', from: null },
    ]);
    expect(sessionText(sessions[0], entries)).toBe('You edited How we schedule');
  });

  it('joins a row 4:59 after the last and splits one 5:00 after it', () => {
    inZone('UTC');
    const joined = sessionsOf([row({ first_at: t(0), at: t(2) }), row({ first_at: t(6, 59) })]);
    expect(joined).toHaveLength(1);
    const split = sessionsOf([row({ first_at: t(0), at: t(2) }), row({ first_at: t(7) })]);
    expect(split).toHaveLength(2);
    expect(SESSION_GAP_MS).toBe(300_000);
  });

  it('makes another actor or another run another session', () => {
    inZone('UTC');
    const sessions = sessionsOf([
      row({ first_at: t(0) }),
      row({ first_at: t(1), actor: 'process:release-scout', run_id: 'r1' }),
      row({ first_at: t(2), actor: 'process:release-scout', run_id: 'r2' }),
      row({ first_at: t(3) }),
    ]);
    expect(sessions.map((s) => [s.actor, s.run_id])).toEqual([
      ['human:me', null],
      ['process:release-scout', 'r1'],
      ['process:release-scout', 'r2'],
    ]);
  });

  it('never lets a session cross local midnight', () => {
    // 23:58 and 00:01 in Los Angeles (PDT, UTC-7): three minutes, two days.
    inZone('America/Los_Angeles');
    const sessions = sessionsOf([
      row({ first_at: '2026-07-28T06:58:00.000Z' }),
      row({ first_at: '2026-07-28T07:01:00.000Z' }),
    ]);
    expect(sessions.map((s) => s.day)).toEqual(['2026-07-27', '2026-07-28']);
  });

  it('maps a comment row to its page, as commented, never edited', () => {
    inZone('UTC');
    const [session] = sessionsOf([
      row({
        kind: 'vault.comment',
        path: '.comments/notes/plan.md.json',
        actor: 'human:owner',
        first_at: t(0),
      }),
    ]);
    expect(session.pages).toEqual([{ path: 'notes/plan.md', verb: 'commented', from: null }]);
    expect(sessionText(session, entries)).toBe('You commented on Plan');
  });

  it('reads your writes and your comments as You, and a NULL writer as not recorded', () => {
    inZone('UTC');
    const [mine, unknown] = sessionsOf([
      row({ first_at: t(0) }),
      row({ first_at: t(1), actor: null }),
    ]);
    expect(sessionText(mine, entries)).toBe('You edited How we schedule');
    expect(sessionText(unknown, entries)).toBe('Edited How we schedule · who was not recorded');
  });

  it('names creates, deletes, renames and several pages in words', () => {
    inZone('UTC');
    const [s] = sessionsOf([
      row({ first_at: t(0), kind: 'vault.create', path: 'notes/plan.md' }),
      row({ first_at: t(1), path: 'delivery/delivery.md' }),
      row({ first_at: t(1), path: 'delivery/how-we-schedule.md' }),
      row({ first_at: t(1), path: 'notes/other.md' }),
      row({ first_at: t(2), kind: 'vault.rename', path: 'notes/a.md', to: 'notes/b.md' }),
      row({ first_at: t(2), kind: 'vault.delete', path: 'notes/gone.md' }),
      row({ first_at: t(3), approved_by: 'human:me' }),
    ]);
    expect(sessionText(s, entries)).toBe(
      'You created Plan, edited Delivery, How we schedule and 1 more, renamed a to b, deleted gone · you allowed it',
    );
    expect(listWords(['A'])).toBe('A');
    expect(listWords(['A', 'B'])).toBe('A and B');
    expect(listWords(['A', 'B', 'C'])).toBe('A, B and 1 more');
  });
});

describe('local days', () => {
  it('keys days across the Sydney DST start on 2026-10-04', () => {
    inZone('Australia/Sydney');
    // AEST (+10) until 02:00 on the 4th, AEDT (+11) after.
    expect(dayKeyOf(Date.parse('2026-10-03T13:00:00Z'))).toBe('2026-10-03');
    expect(dayKeyOf(Date.parse('2026-10-03T14:30:00Z'))).toBe('2026-10-04');
    expect(dayKeyOf(Date.parse('2026-10-04T12:30:00Z'))).toBe('2026-10-04');
    expect(dayKeyOf(Date.parse('2026-10-04T13:00:00Z'))).toBe('2026-10-05');
    expect(addDays('2026-10-03', 1)).toBe('2026-10-04');
    expect(addDays('2026-10-04', 1)).toBe('2026-10-05');
    expect(weekdayOf('2026-10-04')).toBe(0);
    const w = activityWindow(Date.parse('2026-10-04T12:30:00Z'));
    expect(w.today).toBe('2026-10-04');
    // Local midnight tomorrow, in AEDT.
    expect(w.until).toBe('2026-10-04T13:00:00.000Z');
    expect(dayKeyOf(Date.parse(w.since))).toBe(addDays('2026-10-04', -370));
  });

  it('keys days across the Los Angeles DST end on 2026-11-01', () => {
    inZone('America/Los_Angeles');
    expect(dayKeyOf(Date.parse('2026-11-01T07:30:00Z'))).toBe('2026-11-01');
    expect(dayKeyOf(Date.parse('2026-11-02T07:30:00Z'))).toBe('2026-11-01');
    expect(dayKeyOf(Date.parse('2026-11-02T08:30:00Z'))).toBe('2026-11-02');
    const w = activityWindow(Date.parse('2026-11-02T20:00:00Z'));
    expect(w.today).toBe('2026-11-02');
    expect(w.until).toBe('2026-11-03T08:00:00.000Z');
    expect(dayKeyOf(Date.parse(w.since))).toBe(w.first);
    expect(w.first).toBe(addDays('2026-11-02', -370));
  });
});

describe('days', () => {
  it('marks each day a span across midnight or a multi-day open span touches', () => {
    inZone('UTC');
    const states = dayStates(
      activity({
        recording_since: { state: 'read', at: '2026-07-01T09:00:00.000Z' },
        app_sessions: read([
          span('2026-07-20T22:00:00.000Z', '2026-07-21T01:00:00.000Z'),
          span('2026-07-24T08:00:00.000Z', '2026-07-27T09:00:00.000Z', 'open'),
        ]),
      }),
      '2026-07-19',
      '2026-07-28',
    );
    const recorded = [...states].filter(([, s]) => s.state === 'recorded').map(([d]) => d);
    expect(recorded).toEqual([
      '2026-07-20',
      '2026-07-21',
      '2026-07-24',
      '2026-07-25',
      '2026-07-26',
      '2026-07-27',
    ]);
  });

  it('reads days before recording began as not recorded, even with a span', () => {
    inZone('UTC');
    const states = dayStates(
      activity({
        recording_since: { state: 'read', at: '2026-07-21T10:00:00.000Z' },
        app_sessions: read([
          span('2026-07-20T08:00:00.000Z', '2026-07-20T18:00:00.000Z'),
          span('2026-07-22T08:00:00.000Z', '2026-07-22T18:00:00.000Z'),
        ]),
      }),
      '2026-07-19',
      '2026-07-28',
    );
    expect(states.get('2026-07-20')).toEqual({
      state: 'not-recorded',
      sessions: null,
      beforeRecording: true,
    });
    expect(states.get('2026-07-22')).toEqual({
      state: 'recorded',
      sessions: 0,
      beforeRecording: false,
    });
    expect(states.get('2026-07-25')).toEqual({
      state: 'not-recorded',
      sessions: null,
      beforeRecording: false,
    });
  });

  it('says no edits for a recorded empty day, and never 0 for an unrecorded one', () => {
    inZone('UTC');
    const map = heatmapOf(
      activity({
        recording_since: { state: 'read', at: '2026-07-21T10:00:00.000Z' },
        writes: read([row({ first_at: '2026-07-21T10:00:00.000Z', actor: null })]),
        app_sessions: read([span('2026-07-22T08:00:00.000Z', '2026-07-22T18:00:00.000Z')]),
      }),
      '2026-07-28',
    )!;
    const cells = map.weeks.flat().filter((c) => c !== null);
    const cell = (day: string) => cells.find((c) => c.day === day)!;
    expect(cellWords(cell('2026-07-21'))).toBe('Tue, Jul 21, 2026 — 1 editing session');
    expect(cell('2026-07-22').sessions).toBe(0);
    expect(cellWords(cell('2026-07-22'))).toBe('Wed, Jul 22, 2026 — no edits');
    expect(cell('2026-07-25').sessions).toBeNull();
    expect(cellWords(cell('2026-07-25'))).toBe(
      "Sat, Jul 25, 2026 — not recorded: Cerebro wasn't open",
    );
    expect(cellWords(cell('2026-07-20'))).toBe(
      'Mon, Jul 20, 2026 — not recorded: before Cerebro began recording edits',
    );
    expect(map.recordingSince).toBe('2026-07-21T10:00:00.000Z');
  });

  it('lays the year out in Sunday-first weeks with null padding and month labels', () => {
    inZone('UTC');
    const map = heatmapOf(activity(), '2026-07-28')!;
    const flat = map.weeks.flat();
    // 2025-07-23 is a Wednesday: three empty Sunday-to-Tuesday cells first.
    expect(flat.slice(0, 3)).toEqual([null, null, null]);
    expect(flat[3]?.day).toBe('2025-07-23');
    expect(flat.filter((c) => c !== null)).toHaveLength(371);
    // 2026-07-28 is a Tuesday: Wednesday to Saturday pad the last week.
    expect(map.weeks.at(-1)!.map((c) => c?.day ?? null)).toEqual([
      '2026-07-26',
      '2026-07-27',
      '2026-07-28',
      null,
      null,
      null,
      null,
    ]);
    expect(map.weeks.every((w) => w.length === 7)).toBe(true);
    expect(map.months.map((m) => m.label)).toEqual([
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
    ]);
    // Nothing recorded: every day reads not recorded, none reads 0.
    expect(flat.every((c) => c === null || (c.state === 'not-recorded' && c.level === 0))).toBe(
      true,
    );
  });

  it('shades by sessions against the busiest day', () => {
    inZone('UTC');
    const rows = [
      row({ first_at: '2026-07-27T09:00:00.000Z' }),
      ...[0, 10, 20, 30].map((m) => row({ first_at: t(m) })),
    ];
    const map = heatmapOf(
      activity({ recording_since: { state: 'read', at: rows[0].first_at }, writes: read(rows) }),
      '2026-07-28',
    )!;
    const cells = map.weeks.flat().filter((c) => c !== null);
    expect(cells.find((c) => c.day === '2026-07-28')).toMatchObject({ sessions: 4, level: 4 });
    expect(cells.find((c) => c.day === '2026-07-27')).toMatchObject({ sessions: 1, level: 1 });
  });

  it('marks days older than a capped lane could reach as not read', () => {
    inZone('UTC');
    const states = dayStates(
      activity({
        recording_since: { state: 'read', at: '2026-07-01T00:00:00.000Z' },
        writes: read([row({ first_at: '2026-07-25T09:00:00.000Z' })], true),
        app_sessions: read([span('2026-07-20T08:00:00.000Z', '2026-07-28T10:00:00.000Z')]),
      }),
      '2026-07-19',
      '2026-07-28',
    );
    expect(states.get('2026-07-24')?.state).toBe('not-read');
    expect(states.get('2026-07-25')?.state).toBe('recorded');
  });

  it('draws no grid when a lane it needs failed', () => {
    inZone('UTC');
    expect(heatmapOf(activity({ app_sessions: down }), '2026-07-28')).toBeNull();
    expect(heatmapOf(activity({ writes: down }), '2026-07-28')).toBeNull();
    expect(heatmapOf(activity({ recording_since: down }), '2026-07-28')).toBeNull();
    expect(heatmapOf(activity({ runs: down }), '2026-07-28')).not.toBeNull();
  });
});

describe('the feed', () => {
  it("groups a run's rows under it, with its why and the pages it wrote", () => {
    inZone('UTC');
    const groups = feedOf(
      activity({
        writes: read([
          row({
            first_at: t(16),
            at: t(18),
            actor: 'process:release-scout',
            run_id: 'run-scout-1',
            path: 'delivery/delivery.md',
          }),
        ]),
        runs: read([run({ run_id: 'run-scout-1' })]),
      }),
      null,
      '2026-07-28',
      entries,
    );
    const today = groups.find((g) => g.kind === 'day' && g.day === '2026-07-28');
    expect(today?.kind).toBe('day');
    if (today?.kind !== 'day') return;
    expect(today.items.map((i) => i.kind)).toEqual(['run']);
    const item = today.items[0];
    if (item.kind !== 'run') return;
    expect(item.sessions).toHaveLength(1);
    expect(runText(item, 'its schedule came due')).toBe(
      'Release scout ran · its schedule came due · wrote Delivery',
    );
  });

  it('says what a run wrote as its booking lets it be said', () => {
    inZone('UTC');
    const words = (writes_booked: number) => {
      const groups = feedOf(
        activity({ runs: read([run({ run_id: 'r', writes_booked })]) }),
        null,
        '2026-07-28',
        entries,
      );
      const day = groups.find((g) => g.kind === 'day');
      const item = day?.kind === 'day' ? day.items[0] : undefined;
      return item?.kind === 'run' ? item.wrote : null;
    };
    expect(words(1)).toBe('wrote no pages');
    expect(words(2)).toBe('wrote no pages · shell changes not recorded');
    expect(words(0)).toBe('pages written: not recorded');
    const unread = feedOf(
      activity({ writes: down, runs: read([run({ run_id: 'r' })]) }),
      null,
      '2026-07-28',
      entries,
    ).find((g) => g.kind === 'day');
    const item = unread?.kind === 'day' ? unread.items[0] : undefined;
    expect(item?.kind === 'run' && item.wrote).toBe('pages written: could not be read');
  });

  it("folds an attended conversation's turns into one row a day", () => {
    inZone('UTC');
    const turn = (run_id: string, minute: number) =>
      run({
        run_id,
        actor: 'process:knowledge',
        mode: 'attended',
        cli_session_id: 'session-1',
        started_at: t(minute),
        ended_at: t(minute + 1),
      });
    const groups = feedOf(
      activity({
        runs: read([
          turn('a', 0),
          turn('b', 10),
          turn('c', 20),
          run({ run_id: 'other', started_at: t(30), ended_at: t(31) }),
        ]),
      }),
      null,
      '2026-07-28',
      entries,
    );
    const day = groups.find((g) => g.kind === 'day');
    expect(day?.kind).toBe('day');
    if (day?.kind !== 'day') return;
    const rows = day.items.filter((i) => i.kind === 'run');
    expect(rows).toHaveLength(2);
    const folded = rows.find((r) => r.kind === 'run' && r.runs.length === 3);
    expect(folded?.kind === 'run' && folded.run.run_id).toBe('a');
  });

  it('says gap lines only when every lane read', () => {
    inZone('UTC');
    const full = activity({
      recording_since: { state: 'read', at: '2026-07-21T10:00:00.000Z' },
      writes: read([row({ first_at: '2026-07-21T10:00:00.000Z' })]),
      app_sessions: read([
        span('2026-07-20T08:00:00.000Z', '2026-07-24T18:00:00.000Z'),
        span('2026-07-27T08:00:00.000Z', '2026-07-28T10:00:00.000Z'),
      ]),
    });
    const groups = feedOf(full, null, '2026-07-28', entries);
    const gaps = groups.flatMap((g) => (g.kind === 'gap' ? [[g.state, g.text]] : []));
    expect(gaps.slice(0, 4)).toEqual([
      ['empty', 'No edits or runs · Jul 27 – Jul 28'],
      ['not-recorded', "Not recorded · Jul 25 – Jul 26 — Cerebro wasn't open"],
      ['empty', 'No edits or runs · Jul 22 – Jul 24'],
      [
        'not-recorded',
        'Not recorded · Jul 23, 2025 – Jul 20 — before Cerebro began recording edits',
      ],
    ]);
    for (const lane of ['writes', 'runs', 'app_sessions', 'recording_since'] as const) {
      const partial = feedOf({ ...full, [lane]: down }, null, '2026-07-28', entries);
      expect(partial.some((g) => g.kind === 'gap')).toBe(false);
    }
  });

  it('lands commits on their local day, and still groups them when activity failed', () => {
    inZone('America/Los_Angeles');
    // 2026-07-28T05:00Z is 22:00 on the 27th in Los Angeles.
    const late = commit('a', Date.parse('2026-07-28T05:00:00Z') / 1000);
    const noon = commit('b', Date.parse('2026-07-28T19:00:00Z') / 1000);
    const groups = feedOf(null, [noon, late], '2026-07-28', entries);
    expect(days(groups)).toEqual(['2026-07-28', '2026-07-27']);
    expect(groups.some((g) => g.kind === 'gap')).toBe(false);
    const withActivity = feedOf(
      activity({ writes: read([row({ first_at: '2026-07-28T18:00:00.000Z' })]) }),
      [noon],
      '2026-07-28',
      entries,
    );
    const day = withActivity.find((g) => g.kind === 'day');
    // Its own row, never blended into the session.
    expect(day?.kind === 'day' && day.items.map((i) => i.kind)).toEqual(['commit', 'session']);
  });

  it('reveals days that hold something, a batch at a time', () => {
    inZone('UTC');
    const commits = [1, 2, 3, 4, 5].map((n) =>
      commit(String(n), Date.parse(`2026-07-2${n}T09:00:00Z`) / 1000),
    );
    const groups = feedOf(null, commits, '2026-07-28', entries);
    const first = revealed(groups, 2);
    expect(days(first.groups)).toEqual(['2026-07-25', '2026-07-24']);
    expect(first.more).toBe(true);
    expect(revealed(groups, 5).more).toBe(false);
  });
});

// M64.2b: one page's History merges its rows, runs, Knowledge events and
// versions into one timeline.
describe("a page's timeline", () => {
  const PAGE = 'delivery/how-we-schedule.md';
  const CONCEPT = 'knowledge/playbooks/warehouse-cutover.md';

  function page(fields: Partial<PageActivity<Run>> = {}): PageActivity<Run> {
    return {
      chain: [PAGE],
      writes: read([]),
      runs: read([]),
      recording_since: { state: 'read', at: null },
      knowledge: null,
      ...fields,
    };
  }

  function version(hash: string, iso: string): FileCommit {
    return {
      hash: hash.repeat(40).slice(0, 40),
      shortHash: hash.repeat(7).slice(0, 7),
      message: `Version ${hash}`,
      author: 'Ana Rios',
      date: Date.parse(iso) / 1000,
      parent: null,
      previousAt: null,
      pathAt: PAGE,
      previousPath: null,
      change: 'modified',
    };
  }

  function event(fields: Partial<ConceptEvent> & { event_id: string }): ConceptEvent {
    return {
      kind: 'created',
      revision: null,
      state: null,
      actor: 'process:release-scout',
      run_id: null,
      at: null,
      ...fields,
    };
  }

  const recorded = (at: string) => ({
    state: 'recorded' as const,
    kind: 'vault.write',
    actor: 'human:me',
    run_id: null,
    approved_by: null,
    at,
  });

  const timeline = (
    activity: PageActivity<Run> | null,
    commits: FileCommit[] | null = [],
    extra: {
      isKnowledge?: boolean;
      attribution?: Parameters<typeof pageTimeline>[0]['attribution'];
    } = {},
  ) =>
    pageTimeline({
      activity,
      commits,
      attribution: extra.attribution ?? null,
      isKnowledge: extra.isKnowledge ?? false,
      entries,
    });

  it('orders sessions and commits by time, a run speaking for its sessions', () => {
    inZone('UTC');
    const got = timeline(
      page({
        writes: read([
          row({ first_at: t(40), at: t(45) }),
          row({ first_at: t(10), actor: 'process:release-scout', run_id: 'run-1' }),
          row({
            kind: 'vault.comment',
            path: `.comments/${PAGE}.json`,
            actor: 'human:owner',
            first_at: t(50),
          }),
        ]),
        runs: read([run({ run_id: 'run-1' })]),
      }),
      [version('a', t(30)), version('b', t(5))],
    );
    expect(
      got.entries.map((e) => [e.kind, e.kind === 'commit' ? null : 'text' in e ? e.text : null]),
    ).toEqual([
      ['session', 'You commented'],
      ['session', 'You edited it'],
      ['commit', null],
      ['run', 'Release scout wrote it'],
      ['commit', null],
    ]);
    expect(got.outside).toBeNull();
  });

  it('names a rename from the old name, and a writer nobody recorded', () => {
    inZone('UTC');
    const got = timeline(
      page({
        chain: [PAGE, 'delivery/old.md'],
        writes: read([
          row({ kind: 'vault.rename', path: 'delivery/old.md', to: PAGE, first_at: t(20) }),
          row({ actor: null, first_at: t(0) }),
        ]),
      }),
    );
    expect(got.entries.map((e) => ('text' in e ? e.text : ''))).toEqual([
      'You renamed it from old.md',
      'Edited it · who was not recorded',
    ]);
  });

  it('puts the seam where recording began, only after the oldest commit', () => {
    inZone('UTC');
    const since = { state: 'read' as const, at: '2026-07-21T10:00:00.000Z' };
    const got = timeline(page({ recording_since: since }), [
      version('a', '2026-07-25T09:00:00Z'),
      version('b', '2026-07-19T09:00:00Z'),
    ]);
    expect(got.entries.map((e) => e.kind)).toEqual(['commit', 'seam', 'commit']);
    const seam = got.entries[1];
    expect(seam.kind === 'seam' && seam.text).toBe(
      'Cerebro began recording edits on Tue, Jul 21, 2026; before this, only versions were kept.',
    );
    // Recording that began before every version draws no seam, and neither
    // does a vault that never recorded one.
    expect(
      timeline(page({ recording_since: since }), [
        version('a', '2026-07-25T09:00:00Z'),
      ]).entries.map((e) => e.kind),
    ).toEqual(['commit']);
    expect(
      timeline(page(), [version('b', '2026-07-19T09:00:00Z')]).entries.map((e) => e.kind),
    ).toEqual(['commit']);
  });

  it('says the outside row only when attribution reads Unattributed', () => {
    const at = '2026-07-28T09:00:00.000Z';
    expect(
      timeline(page(), [], { attribution: { ...recorded(at), state: 'unattributed' } }).outside,
    ).toBe(OUTSIDE_WORDS);
    for (const attribution of [
      recorded(at),
      { state: 'not_recorded' as const },
      { state: 'knowledge' as const },
      null,
    ]) {
      expect(timeline(page(), [], { attribution }).outside).toBeNull();
    }
  });

  it("lets the ledger's events replace the concept file's writes, keeping comments", () => {
    inZone('UTC');
    const writes = read([
      row({ path: CONCEPT, actor: 'process:knowledge', run_id: 'run-ingest-2', first_at: t(5) }),
      row({
        kind: 'vault.comment',
        path: `.comments/${CONCEPT}.json`,
        actor: 'human:owner',
        first_at: t(30),
      }),
    ]);
    const knowledge = {
      state: 'read' as const,
      events: [
        event({ event_id: 'c', at: t(5) }),
        event({ event_id: 'v', kind: 'verified', actor: 'human:me', at: t(20) }),
        event({ event_id: 'p', kind: 'proposal', state: 'queued', at: t(25) }),
      ],
    };
    const got = timeline(page({ chain: [CONCEPT], writes, knowledge }), [], { isKnowledge: true });
    expect(got.entries.map((e) => ('text' in e ? e.text : e.kind))).toEqual([
      'You commented',
      'Release scout proposed a change · waiting on you',
      'Verified by You',
      'Created by Release scout',
    ]);
    // With no ledger to say what they meant, the writes stay.
    const bare = timeline(
      page({ chain: [CONCEPT], writes, knowledge: { state: 'not_recorded' } }),
      [],
      {
        isKnowledge: true,
      },
    );
    expect(bare.entries.map((e) => e.kind)).toEqual(['session', 'session']);
  });

  it('sorts events with no time last, under Time not recorded', () => {
    inZone('America/Los_Angeles');
    const knowledge = {
      state: 'read' as const,
      events: [
        event({ event_id: 'c' }),
        event({ event_id: 'r', kind: 'revised', revision: 2, actor: null }),
      ],
    };
    const got = timeline(
      page({
        chain: [CONCEPT],
        knowledge,
        writes: read([
          row({ path: CONCEPT, kind: 'vault.comment', first_at: '2026-07-28T06:30:00.000Z' }),
        ]),
      }),
      [version('a', '2026-07-27T20:00:00Z')],
      { isKnowledge: true },
    );
    expect(got.entries.map((e) => e.kind)).toEqual(['session', 'commit', 'concept', 'concept']);
    expect(got.entries[3].kind === 'concept' && got.entries[3].text).toBe(
      'Revised · revision 2 · who was not recorded',
    );
    // 06:30Z is 23:30 the day before in Los Angeles, the same day as 20:00Z.
    const groups = pageDays(got.entries, '2026-07-28');
    expect(groups.map((g) => [g.label, g.entries.length])).toEqual([
      ['Jul 27', 2],
      ['Time not recorded', 2],
    ]);
  });

  it('folds to the newest 8, pins the oldest and counts the rest', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    expect(foldTimeline(items, 8)).toEqual({
      shown: [0, 1, 2, 3, 4, 5, 6, 7],
      hidden: 3,
      pinned: 11,
    });
    expect(foldTimeline(items.slice(0, 9), 8)).toEqual({
      shown: items.slice(0, 9),
      hidden: 0,
      pinned: null,
    });
    expect(foldTimeline([], 8)).toEqual({ shown: [], hidden: 0, pinned: null });
  });

  it('adds nothing for a lane that failed', () => {
    const got = timeline(null, null);
    expect(got.entries).toEqual([]);
    const writesDown = timeline(page({ writes: down }), [version('a', t(0))]);
    expect(writesDown.entries.map((e) => e.kind)).toEqual(['commit']);
  });
});

describe('tripwires', () => {
  it("SESSION_GAP_MS is vault_writes.rs's COALESCE_WINDOW", () => {
    const m =
      /COALESCE_WINDOW: chrono::Duration = chrono::Duration::(minutes|seconds)\((\d+)\)/.exec(
        VAULT_WRITES_RS,
      );
    expect(m).not.toBeNull();
    const [, unit, n] = m!;
    expect(SESSION_GAP_MS).toBe(Number(n) * (unit === 'minutes' ? 60_000 : 1_000));
  });

  it("CONTENT_KINDS is write_log.rs's", () => {
    const m = /pub const CONTENT_KINDS: \[&str; \d+\] = \[([^\]]*)\]/.exec(WRITE_LOG_RS);
    expect(m).not.toBeNull();
    const kinds = [...m![1].matchAll(/"([^"]+)"/g)].map((k) => k[1]);
    expect([...CONTENT_KINDS]).toEqual(kinds);
  });
});
