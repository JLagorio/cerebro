import { describe, expect, it } from 'vitest';
import { makeEntry, fixtureVault } from '@/test/factories';
import { buildSchema } from './schema';
import {
  HOME_LANES,
  laneView,
  myWorkRows,
  proposalRows,
  captureRows,
  comingUpRows,
  ROW_CAP,
  editRows,
  editsData,
  runRows,
  reminderRows,
  changeRows,
} from './homeLanes';
import { markId, type DoneMark, type ReminderFire } from './reminderState';
import { sessionsOf, type ActivityWrite, type VaultActivity } from './activity';
import type { Entry } from './types';
const ctx = { today: '2026-07-28', weekStart: 0 as const };
const now = new Date(2026, 6, 28, 12);
const task = {
  version: null,
  sourcePath: 'docs/a.md',
  line: 2,
  text: 'Call vendor',
  due: null,
  done: false,
  assignees: [],
};
describe('Home lane builders', () => {
  it('declares one order and only three event lanes, hiding ready empty lanes', () => {
    expect(HOME_LANES.map((lane) => lane.id)).toEqual([
      'mywork',
      'proposals',
      'runs',
      'captures',
      'reminders',
      'changes',
      'edits',
      'comingup',
    ]);
    expect(HOME_LANES.filter((lane) => lane.kind === 'event').map((lane) => lane.id)).toEqual([
      'runs',
      'reminders',
      'changes',
    ]);
    const empty = { rows: [], line: '', notes: [] };
    expect(laneView('ready', empty)).toBeNull();
    expect(laneView('loading', empty)).toBeNull();
    expect(laneView('partial', { ...empty, notes: ['unreadable'] })).not.toBeNull();
    expect(laneView('unavailable', empty)?.state).toBe('unavailable');
    expect(ROW_CAP).toBe(10);
  });
  it('includes only near-term open record deadlines and every open document task', () => {
    const entries = fixtureVault();
    const doc = entries.find((e) => e.type === 'Type' && e.title === 'Work item')!;
    doc.properties.deadline = 'due';
    entries.push(
      ...['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-31', '2026-08-04'].map((due, i) =>
        makeEntry({ path: `work/${i}.md`, type: 'Work item', properties: { status: 'todo', due } }),
      ),
    );
    const result = myWorkRows(
      entries,
      buildSchema(entries),
      [task, { ...task, line: 3, done: true }],
      ctx,
    );
    expect(result.rows.map((row) => row.subject)).toEqual([
      'work/0.md',
      'work/1.md',
      'work/2.md',
      'work/3.md',
      'docs/a.md#2',
    ]);
    expect(result.line).toBe('1 overdue · 1 due today · 2 due this week · 1 open task');
  });
  it('stacks targets and page writes and chooses the newest valid timestamp', () => {
    const cards = [
      {
        proposal_id: 'a',
        targets: [{ path: 'knowledge/a.md' }],
        submitted_at: '2026-07-27T12:00:00Z',
      },
      {
        proposal_id: 'b',
        targets: [{ path: 'knowledge/a.md' }],
        submitted_at: '2026-07-28T11:58:00Z',
      },
    ];
    const data = proposalRows(
      cards,
      [],
      [makeEntry({ path: 'knowledge/a.md', title: 'Local truth' })],
    );
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({
      title: 'Local truth',
      detail: '2 proposals waiting',
      at: '2026-07-28T11:58:00Z',
    });
    expect(
      proposalRows(
        [...cards, { proposal_id: 'c', targets: [], submitted_at: 'junk' }],
        [{ pending_id: 'w', target: 'page.md', queued_at: '2026-07-28T10:00:00Z' }],
        [],
      ).rows,
    ).toHaveLength(3);
  });
  it('uses Inbox membership and period, including unknown capture times honestly', () => {
    const entries = [
      makeEntry({ path: 'a.md', createdAt: '2026-07-28T00:00:00Z' }),
      makeEntry({ path: 'old.md' }),
      makeEntry({ path: 'unknown.md', createdAt: '' }),
      makeEntry({ path: 'typed.md', type: 'Person' }),
    ];
    expect(captureRows(entries, 'week', now).rows.map((row) => row.path)).toEqual([
      'a.md',
      'unknown.md',
    ]);
    expect(captureRows(entries, 'all', now).rows).toHaveLength(3);
  });
  it('admits declared upcoming dates, excludes deadlines and finished records, and reports bad dates', () => {
    const type = makeEntry({
      path: 'types/event.md',
      type: 'Type',
      title: 'Event',
      properties: {
        deadline: 'due',
        statuses: [
          { id: 'open', group: 'active' },
          { id: 'done', group: 'done' },
        ],
        fields: {
          status: { kind: 'status' },
          due: { kind: 'date' },
          time: { kind: 'daterange' },
          other: { kind: 'date' },
        },
      } as unknown as Entry['properties'],
    });
    const base = (path: string, properties: Record<string, unknown>) =>
      makeEntry({ path, type: 'Event', properties: properties as Entry['properties'] });
    const entries = [
      type,
      base('a.md', { time: { start: '2026-07-27', end: '2026-07-29' }, other: '2026-07-30' }),
      base('b.md', { due: '2026-07-29' }),
      base('c.md', { status: 'done', other: '2026-07-29' }),
      base('d.md', { other: 'junk' }),
      base('e.md', { other: '2026-08-06' }),
      base('f.md', { other: '2026-07-28 11:59' }),
    ];
    const data = comingUpRows(entries, buildSchema(entries), now, ctx);
    expect(data.rows.map((row) => row.path)).toEqual(['a.md']);
    expect(data.rows[0].detail).toBe('Time');
    expect(data.notes[0]).toContain('d · Other');
    const many = [
      type,
      ...Array.from({ length: 201 }, (_, i) => base(`event/${i}.md`, { other: '2026-07-29' })),
    ];
    expect(comingUpRows(many, buildSchema(many), now, ctx)).toMatchObject({
      line: '201 coming up in the next 7 days',
      notes: ['Showing 200 of 201 upcoming records.'],
    });
    expect(comingUpRows(many, buildSchema(many), now, ctx).rows).toHaveLength(200);
  });
});

describe('your recent edits', () => {
  const write = (path: string, at: string, extra: Partial<ActivityWrite> = {}): ActivityWrite => ({
    kind: 'vault.write',
    content: true,
    path,
    to: null,
    actor: 'human:me',
    run_id: null,
    approved_by: null,
    first_at: at,
    at,
    ...extra,
  });
  const entries = ['new.md', 'other.md'].map((path) => makeEntry({ path }));
  it('folds five saves into one page and counts only recorded human content writes', () => {
    const rows = Array.from({ length: 5 }, (_, i) => write('new.md', `2026-07-28T11:5${i}:00Z`));
    rows.push(
      write('new.md', '2026-07-28T11:55:00Z', { actor: 'agent:scout' }),
      write('new.md', '2026-07-28T11:56:00Z', { actor: null }),
      write('new.md', '2026-07-28T11:57:00Z', { kind: 'vault.comment', content: false }),
    );
    const data = editRows(sessionsOf(rows), entries);
    expect(data.rows).toEqual([
      expect.objectContaining({
        path: 'new.md',
        detail: 'edited 5 times',
        at: '2026-07-28T11:57:00Z',
      }),
    ]);
    expect(data.line).toBe('1 page you edited in the last 7 days');
    expect(data.notes).toEqual(["Edits made outside Cerebro aren't listed."]);
  });
  it('follows later renames by any actor and orders the newest human session first', () => {
    const data = editRows(
      sessionsOf([
        write('old.md', '2026-07-28T10:00:00Z'),
        write('old.md', '2026-07-28T10:10:00Z', {
          kind: 'vault.rename',
          to: 'middle.md',
          actor: 'agent:scout',
        }),
        write('middle.md', '2026-07-28T10:20:00Z', { kind: 'vault.rename', to: 'new.md' }),
        write('other.md', '2026-07-28T11:00:00Z'),
        write('gone.md', '2026-07-28T11:10:00Z'),
      ]),
      entries,
    );
    expect(data.rows.map((row) => [row.path, row.detail])).toEqual([
      ['other.md', 'edited 1 time'],
      ['new.md', 'edited 2 times'],
    ]);
    expect(data.notes).toContain('1 edited page is no longer in the vault.');
  });
  it('moves history through a rename cycle without merging distinct current paths', () => {
    const data = editRows(
      sessionsOf([
        write('new.md', '2026-07-28T10:00:00Z'),
        write('new.md', '2026-07-28T10:10:00Z', { kind: 'vault.rename', to: 'other.md' }),
        write('new.md', '2026-07-28T10:20:00Z', { kind: 'vault.create' }),
      ]),
      entries,
    );
    expect(data.rows.map((row) => [row.path, row.detail])).toEqual([
      ['new.md', 'edited 1 time'],
      ['other.md', 'edited 2 times'],
    ]);
  });
  const activity = (): VaultActivity => ({
    writes: { state: 'read', rows: [write('new.md', '2026-07-28T11:58:00Z')], more: false },
    runs: { state: 'unavailable', reason: 'not needed here' },
    app_sessions: { state: 'unavailable', reason: 'not needed here' },
    recording_since: { state: 'read', at: '2026-07-01T12:00:00Z' },
  });
  it('states the recording boundary and truncation without hiding readable rows', () => {
    const input = activity();
    input.recording_since = { state: 'read', at: '2026-07-27T12:00:00Z' };
    if (input.writes.state === 'read') input.writes.more = true;
    const result = editsData(input, entries, '2026-07-21T12:00:00Z');
    expect(result.state).toBe('partial');
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.notes).toEqual([
      "Edits made outside Cerebro aren't listed.",
      'More edits were recorded than could be read.',
      "Edits before Mon, Jul 27, 2026 weren't recorded.",
    ]);
  });
  it('distinguishes an empty window, absent recording and an unavailable read', () => {
    const input = activity();
    input.writes = { state: 'read', rows: [], more: false };
    expect(editsData(input, entries, '2026-07-21T12:00:00Z').state).toBe('ready');
    input.recording_since = { state: 'read', at: null };
    expect(editsData(input, entries, '2026-07-21T12:00:00Z')).toMatchObject({
      state: 'partial',
      data: { line: 'Editing history not recorded' },
    });
    input.recording_since = { state: 'unavailable', reason: 'database unavailable' };
    expect(editsData(input, entries, '2026-07-21T12:00:00Z').data.notes).toContain(
      'When edit recording began could not be read.',
    );
    input.writes = { state: 'unavailable', reason: 'database unavailable' };
    expect(editsData(input, entries, '2026-07-21T12:00:00Z').state).toBe('unavailable');
  });
});

describe('Home event rows', () => {
  const now = new Date('2026-07-28T12:00:00Z');
  const run = (run_id: string, actor: string | null, ended_at: string, outcome = 'succeeded') => ({
    run_id,
    actor,
    ended_at,
    outcome,
  });
  const rows = [
    run('new', 'process:scout', '2026-07-28T11:30:00Z'),
    run('earlier', 'process:scout', '2026-07-28T09:19:00Z', 'quota_failed'),
    run('other', 'process:review', '2026-07-27T20:00:00Z'),
    run('old', 'process:scout', '2026-07-20T12:00:00Z'),
  ];
  const mark = (subject: string, revision: string, lane: DoneMark['lane'] = 'run'): DoneMark => ({
    lane,
    subject,
    revision,
    until: 'revision',
    markedAt: '2026-07-28T12:00:00Z',
  });
  const marks = (...rows: DoneMark[]) => Object.fromEntries(rows.map((row) => [markId(row), row]));
  it('a first look counts only the last seven days and stacks by actor with the newest outcome', () => {
    const result = runRows(rows, {}, [], now);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      detail: 'succeeded · +1 earlier',
      runId: 'new',
      danger: false,
    });
    expect(result.line).toBe("3 runs ended · 1 didn't succeed");
    expect(result.notes).toEqual(["Agents you haven't marked done show their last 7 days."]);
  });
  it('only complete actor marks earn since-you-looked words and a mark hides only its seen revision', () => {
    const scout = mark('process:scout', '2026-07-26T12:00:00Z');
    const review = mark('process:review', '2026-07-26T12:00:00Z');
    expect(runRows(rows, marks(scout), [], now).line).not.toContain('since you looked');
    expect(runRows(rows, marks(scout, review), [], now).line).toBe(
      "3 runs ended since you looked · 1 didn't succeed",
    );
    const rendered = runRows(rows, marks(scout), [], now).rows[0];
    const seen = mark('process:scout', rendered.done!.revision!);
    expect(runRows(rows, marks(seen), [], now).rows.map((row) => row.subject)).toEqual([
      'process:review',
    ]);
    expect(
      runRows(
        [...rows, run('later', 'process:scout', '2026-07-28T11:45:00Z')],
        marks(seen),
        [],
        now,
      ).rows.find((row) => row.subject === 'process:scout')?.runId,
    ).toBe('later');
  });
  it('unreadable marks fall back explicitly; unknown attribution and raw outcome words remain honest', () => {
    const result = runRows(
      [run('u', null, '2026-07-28T11:30:00Z', 'abandoned_usage_unknown')],
      null,
      [],
      now,
      true,
    );
    expect(result.rows[0]).toMatchObject({
      title: 'unattributed',
      detail: 'abandoned usage unknown',
      danger: true,
    });
    expect(result.line).not.toContain('since you looked');
    expect(result.notes).toContain('Only the newest 200 finished runs are counted.');
    expect(result.notes.some((note) => note.includes('Done history could not be read'))).toBe(true);
  });
  const fire: ReminderFire = {
    path: 'page.md',
    chip: '0123456789abcdef',
    ordinal: 0,
    fireAt: '2026-07-27T18:00',
    claimedAt: '2026-07-28T11:58:00Z',
    outcome: 'missed',
  };
  it('shows missed and removed reminders, excludes transferred claims, and marks their stable identity', () => {
    const entries = [makeEntry({ path: 'page.md', title: 'Plan' })];
    const data = reminderRows(
      [fire, { ...fire, ordinal: 1, outcome: 'moved' }],
      [],
      {},
      entries,
      now,
    );
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({
      title: 'A reminder in Plan (since removed)',
      detail: 'Passed while Cerebro was closed',
    });
    expect(data.line).toBe('1 reminder · 1 passed while Cerebro was closed');
    const seen = { ...data.rows[0].done!, markedAt: now.toISOString() };
    expect(reminderRows([fire], [], marks(seen), entries, now).rows).toEqual([]);
    const current = {
      sourcePath: fire.path,
      chip: fire.chip,
      ordinal: 0,
      at: fire.fireAt,
      line: 0,
      context: 'Call supplier',
    };
    expect(reminderRows([fire], [current], {}, entries, now).rows[0].title).toBe('Call supplier');
    expect(
      reminderRows([{ ...fire, path: 'a'.repeat(1024) }], [], {}, [], now).rows[0].subject.length,
    ).toBe(64);
    expect(
      reminderRows([{ ...fire, claimedAt: '2026-07-20T12:00:00Z' }], [], {}, [], now).rows,
    ).toEqual([]);
  });
  it('changes use the ledger revision and distinguish a first look from a marked window', () => {
    const view = {
      window: { from_seq: 1, to_seq: 12 },
      quiet: false,
      sections: [{ lines: ['a', 'b'] }],
      changed_at: '2026-07-28T11:58:00Z',
    };
    expect(changeRows(view, {}).line).toBe(
      'Knowledge changed since the last convergence run · 2 changes',
    );
    expect(changeRows(view, marks(mark('knowledge', '10', 'change'))).line).toBe(
      'Knowledge changed since you looked · 2 changes',
    );
    expect(changeRows(view, marks(mark('knowledge', '12', 'change'))).rows).toEqual([]);
    expect(
      changeRows(
        { ...view, window: { from_seq: 12, to_seq: 13 } },
        marks(mark('knowledge', '12', 'change')),
      ).rows,
    ).toHaveLength(1);
    expect(changeRows(null, null)).toMatchObject({ rows: [], notes: [] });
    expect(changeRows({ ...view, quiet: true }, null)).toMatchObject({ rows: [], notes: [] });
  });
});
