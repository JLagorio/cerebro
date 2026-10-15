import { describe, expect, it } from 'vitest';
import {
  announcements,
  carriedRenames,
  collectReminders,
  legacyImports,
  planReminders,
  propertyReminders,
  reminderClaimFor,
  reminderId,
  reminderChip,
  toLocalWindow,
} from './reminders';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';

const BODY = [
  '# Plan',
  '- [ ] Ship the beta 📅 2026-07-30 ((remind:1d)) @[[maya-chen]]',
  'Kickoff is 📅 2026-08-01 09:30 ((remind:0d)) with the team.',
  '- [ ] No reminder here 📅 2026-07-28',
  '```',
  'fenced 📅 2026-07-29 ((remind:0d))',
  '```',
].join('\n');

describe('collectReminders', () => {
  it('skips checked tasks while preserving later duplicate identities', () => {
    const token = '📅 2026-07-28 ((remind:0d))';
    const before = collectReminders('a.md', `- [ ] First ${token}\n- [ ] Second ${token}`);
    const after = collectReminders('a.md', `- [x] First ${token}\n- [ ] Second ${token}`);
    expect(after).toHaveLength(1);
    expect(reminderId(after[0])).toBe(reminderId(before[1]));
    expect(collectReminders('a.md', `* [X] ${token}\n1. [x] ${token}`)).toEqual([]);
  });
  it('finds reminder-bearing tokens and strips chrome from context', () => {
    const reminders = collectReminders('inbox/plan.md', BODY);
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toMatchObject({
      sourcePath: 'inbox/plan.md',
      line: 1,
      at: '2026-07-29T09:00',
      context: 'Ship the beta maya-chen',
    });
    expect(reminders[1]).toMatchObject({
      line: 2,
      at: '2026-08-01T09:30',
      context: 'Kickoff is with the team.',
    });
  });

  it('skips tokens without a remind flag and fenced code', () => {
    const paths = collectReminders('x.md', BODY).map((r) => r.line);
    expect(paths).not.toContain(3);
    expect(paths).not.toContain(5);
  });
});

describe('propertyReminders', () => {
  const type = makeEntry({
    path: 'types/visit.md',
    title: 'Visit',
    type: 'Type',
    properties: {
      deadline: 'window',
      fields: {
        due: { kind: 'date', remind: '1d' },
        window: { kind: 'daterange', remind: '1w' },
        status: { kind: 'status' },
      },
      statuses: [
        { id: 'active', group: 'active' },
        { id: 'done', group: 'done' },
        { id: 'cancelled', group: 'closed' },
      ],
    },
  });
  it('uses field identities and the start time of each declared value', () => {
    const entry = makeEntry({
      path: 'visits/checkup.md',
      title: 'Checkup',
      type: 'Visit',
      properties: {
        due: '2026-07-29',
        window: { start: '2026-08-04 16:00', end: '2026-08-06 17:00' },
      },
    });
    const entries = [type, entry];
    expect(propertyReminders(entries, buildSchema(entries))).toEqual([
      {
        sourcePath: entry.path,
        chip: reminderChip('field:due'),
        ordinal: 0,
        line: -1,
        context: 'Checkup · Due',
        at: '2026-07-28T09:00',
      },
      {
        sourcePath: entry.path,
        chip: reminderChip('field:window'),
        ordinal: 0,
        line: -1,
        context: 'Checkup · Window',
        at: '2026-07-28T16:00',
      },
    ]);
  });
  it('skips finished, template, unreadable and invalid records, while unknown status still reminds', () => {
    const visit = makeEntry({ type: 'Visit', properties: { due: '2026-07-29' } });
    const entries = [
      type,
      { ...visit, path: 'done.md', properties: { ...visit.properties, status: 'done' } },
      { ...visit, path: 'cancelled.md', properties: { ...visit.properties, status: 'cancelled' } },
      { ...visit, path: 'templates/visit.md', folder: 'templates' },
      { ...visit, path: 'invalid.md', properties: { due: '2026-02-30' } },
      { ...visit, path: 'broken.md', parseError: 'bad YAML' },
      { ...visit, path: 'ghost.md', properties: { ...visit.properties, status: 'old' } },
    ];
    expect(propertyReminders(entries, buildSchema(entries)).map((r) => r.sourcePath)).toEqual([
      'ghost.md',
    ]);
  });
  it('re-arms when a stored date changes while leaving the old fire identity distinct', () => {
    const first = makeEntry({
      path: 'visit.md',
      type: 'Visit',
      properties: { due: '2026-07-29 10:00' },
    });
    const second = { ...first, properties: { due: '2026-07-29 11:00' } };
    const a = propertyReminders([first], buildSchema([type, first]))[0];
    const b = propertyReminders([second], buildSchema([type, second]))[0];
    expect(a.chip).toBe(b.chip);
    expect(reminderId(a)).not.toBe(reminderId(b));
    expect(
      planReminders({
        reminders: [b],
        now: '2026-07-28T12:00',
        claimed: new Set([reminderId(a)]),
        window: null,
      }).due,
    ).toEqual([b]);
  });
});

describe('planReminders', () => {
  const reminders = collectReminders('inbox/plan.md', BODY);

  it('fires only reminders that are due and unfired', () => {
    const due = planReminders({
      reminders,
      now: '2026-07-29T09:05',
      claimed: new Set(),
      window: null,
    }).due;
    expect(due).toHaveLength(1);
    expect(due[0].at).toBe('2026-07-29T09:00');
  });

  it('never re-fires an already-fired reminder', () => {
    const fired = new Set([reminderId(reminders[0])]);
    expect(
      planReminders({ reminders, now: '2026-07-29T09:05', claimed: fired, window: null }).due,
    ).toHaveLength(0);
  });

  it('stays silent for reminders older than the grace window', () => {
    expect(
      planReminders({ reminders, now: '2026-08-15T12:00', claimed: new Set(), window: null }).due,
    ).toHaveLength(0);
  });

  it('future reminders wait', () => {
    expect(
      planReminders({ reminders, now: '2026-07-28T12:00', claimed: new Set(), window: null }).due,
    ).toHaveLength(0);
  });
});

describe('durable reminder identities and windows', () => {
  const token = '📅 2026-07-28 12:00 ((remind:0d))';
  const r = collectReminders('a.md', `Call vendor ${token}`)[0];
  it('keeps a chip through an inserted line or edited context, but changes it with its date', () => {
    expect(reminderId(collectReminders('a.md', `Heading\nNew words ${token}`)[0])).toBe(
      reminderId(r),
    );
    expect(reminderId(collectReminders('a.md', token.replace('12:00', '13:00'))[0])).not.toBe(
      reminderId(r),
    );
    expect(reminderChip(` ${token} `)).toBe(r.chip);
  });
  it('counts equal chips in the file while ignoring fences', () => {
    const rows = collectReminders('a.md', `${token}\n\`\`\`\n${token}\n\`\`\`\n${token}`);
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1]);
    expect(rows[0].chip).toBe(rows[1].chip);
  });
  it('uses closed-inclusive and reopened-exclusive bounds, with future and claimed guards', () => {
    const at = (at: string) => ({ ...r, at });
    const reminders = [
      '2026-07-26T11:00',
      '2026-07-27T12:00',
      '2026-07-28T11:59',
      '2026-07-28T12:00',
      '2026-07-28T12:01',
    ].map(at);
    const window = {
      closedAt: '2026-07-27T12:00',
      reopenedAt: '2026-07-28T12:00',
      cause: 'app' as const,
      precision: 'clean_exact' as const,
    };
    const result = planReminders({
      reminders,
      now: '2026-07-28T12:00',
      claimed: new Set(),
      window,
    });
    expect(result.missed.map((r) => r.at)).toEqual(['2026-07-27T12:00', '2026-07-28T11:59']);
    expect(result.due.map((r) => r.at)).toEqual(['2026-07-28T12:00']);
    expect(
      planReminders({
        reminders,
        now: '2026-07-28T12:00',
        claimed: new Set(reminders.map(reminderId)),
        window,
      }),
    ).toEqual({ missed: [], due: [] });
  });
  it('converts UTC windows to local schedule minutes and rounds partial minutes forward', () => {
    const closedAt = '2026-07-27T18:00:30.000Z',
      reopenedAt = '2026-07-28T11:58:00.000Z';
    const local = toLocalWindow({ closedAt, reopenedAt, cause: 'app', precision: 'clean_exact' })!;
    const d = new Date(closedAt);
    d.setMinutes(d.getMinutes() + 1, 0, 0);
    expect(local.closedAt).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    );
    expect(
      toLocalWindow({ closedAt: 'bad', reopenedAt, cause: 'app', precision: 'clean_exact' }),
    ).toBeNull();
  });
  it('imports exact old keys only when unambiguous and not future', () => {
    const key = `a.md#0@${r.at}`;
    expect(legacyImports([key], [r], '2026-07-28T12:00')).toEqual([reminderClaimFor(r, 'fired')]);
    expect(legacyImports([key], [r, { ...r, ordinal: 1 }], '2026-07-28T12:00')).toEqual([]);
    expect(legacyImports([key], [r], '2026-07-28T11:59')).toEqual([]);
  });
  it('carries only a vanished source to one newly appeared destination, never a copy', () => {
    const fire = { ...reminderClaimFor(r, 'fired'), claimedAt: '2026-07-28T12:00:00Z' };
    const renamed = { ...r, sourcePath: 'b.md' };
    expect(carriedRenames([fire], [renamed], new Set(['a.md']), new Set(['b.md']))).toEqual([
      reminderClaimFor(renamed, 'moved'),
    ]);
    expect(carriedRenames([fire], [renamed], new Set(['a.md']), new Set(['a.md', 'b.md']))).toEqual(
      [],
    );
    expect(
      carriedRenames(
        [fire],
        [renamed, { ...renamed, sourcePath: 'c.md' }],
        new Set(['a.md']),
        new Set(['b.md', 'c.md']),
      ),
    ).toEqual([]);
  });
  it('says lateness, groups notices and gives missed windows their actual cause', () => {
    expect(announcements([r], 'fired', r.at)).toEqual(['⏰ Reminder: Call vendor']);
    expect(announcements([r], 'fired', '2026-07-28T12:30')).toEqual([
      '⏰ Reminder (30m late): Call vendor',
    ]);
    expect(announcements([{ ...r, context: '' }], 'fired', r.at)).toEqual([
      '⏰ Reminder: Scheduled reminder',
    ]);
    const rows = ['A', 'B', 'C', 'D'].map((context) => ({ ...r, context }));
    expect(announcements(rows, 'fired', r.at)).toEqual(['⏰ 4 reminders: A · B · C · and 1 more']);
    expect(announcements(rows.slice(0, 2), 'missed', r.at)).toEqual([
      '⏰ 2 reminders passed while Cerebro was closed: A · B',
    ]);
    expect(announcements([r], 'missed', r.at, 'vault')).toEqual([
      '⏰ A reminder passed while this vault was closed: Call vendor',
    ]);
  });
});

describe('one native banner per tick', () => {
  it('keeps one announcement and merges missed plus due by reminder count', async () => {
    const { bannerFor } = await import('./reminders');
    expect(bannerFor([])).toBeNull();
    const one = { title: 'Reminder', body: 'Call vendor', count: 1 };
    expect(bannerFor([one])).toEqual({ title: 'Reminder', body: 'Call vendor' });
    expect(bannerFor([one, { title: '2 reminders', body: 'Deck · Room', count: 2 }])).toEqual({
      title: '3 reminders',
      body: 'Call vendor · Deck · Room',
    });
  });
  it('caps characters without splitting Unicode', async () => {
    const { bannerFor } = await import('./reminders');
    const banner = bannerFor([{ title: '🦀'.repeat(130), body: '中'.repeat(500), count: 1 }])!;
    expect([...banner.title]).toHaveLength(120);
    expect([...banner.body]).toHaveLength(400);
  });
});
