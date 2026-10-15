// @vitest-environment node
import { parse } from 'yaml';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import { makeDateValue, parseDateProperty } from './dates';
import { buildSchema } from './schema';
import { coerceValueToKind, kindMeta, validateValue } from './properties';
import {
  parseRepeat,
  serializeRepeat,
  describeRepeat,
  occurrencesIn,
  repeatFieldFor,
  repeatAnchor,
  repeatPresets,
  expandForCalendar,
  planDetach,
  type RepeatRule,
} from './recurrence';

const rule = (text: string): RepeatRule => {
  const parsed = parseRepeat(text);
  if (parsed?.kind !== 'rule') throw new Error(`Not understood: ${text}`);
  return parsed.rule;
};
const dates = (text: string, start: string, from: string, to: string) =>
  occurrencesIn(rule(text), makeDateValue(start), { start: from, end: to }).map((v) => v.start);

describe('repeat grammar', () => {
  it('distinguishes absence from unsupported or malformed text', () => {
    expect(parseRepeat(null)).toBeNull();
    expect(parseRepeat('')).toBeNull();
    expect(parseRepeat(3)).toMatchObject({
      kind: 'unknown',
      reason: 'A repeat rule must be text.',
    });
  });
  it.each([
    'FREQ=HOURLY',
    'FREQ=DAILY;BYSETPOS=1',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;INTERVAL=1000',
    'FREQ=DAILY;COUNT=0',
    'FREQ=DAILY;COUNT=1001',
    'FREQ=DAILY;COUNT=3;UNTIL=20261231',
    'FREQ=DAILY;UNTIL=20260230',
    'FREQ=DAILY;UNTIL=20260728T246000',
    'FREQ=WEEKLY;BYDAY=1MO',
    'FREQ=MONTHLY;BYDAY=-6FR',
    'FREQ=MONTHLY;BYMONTHDAY=0',
    'FREQ=MONTHLY;BYMONTHDAY=32',
    'FREQ=MONTHLY;BYMONTH=5',
    'FREQ=YEARLY;BYMONTH=13',
    'FREQ=DAILY;WKST=TU',
    'FREQ=DAILY;FREQ=WEEKLY',
    'FREQ=DAILY\nEXDATE:20260230',
    'FREQ=DAILY\nDTSTART:20260728',
    'FREQ=DAILY\nEXDATE;TZID=Europe/London:20260728T090000',
  ])('keeps a reason and raw bytes for %s', (text) => {
    expect(parseRepeat(text)).toMatchObject({
      kind: 'unknown',
      raw: text,
      reason: expect.any(String),
    });
  });
  it.each([
    'FREQ=DAILY',
    'FREQ=WEEKLY;INTERVAL=999;BYDAY=MO,TH;COUNT=1000;WKST=SU',
    'FREQ=MONTHLY;BYDAY=-1FR',
    'FREQ=MONTHLY;BYMONTHDAY=-31,1,31',
    'FREQ=YEARLY;BYDAY=1MO;BYMONTH=9;UNTIL=20271231',
    'FREQ=YEARLY;BYMONTHDAY=28;BYMONTH=7\nEXDATE:20270728,20280728',
  ])('round-trips the admitted subset: %s', (text) => {
    expect(serializeRepeat(rule(text))).toBe(text);
  });
  it('reads case-insensitively and writes fixed-order parts with sorted exceptions in anchor form', () => {
    const parsed = rule('rrule:byday=tu;freq=weekly;interval=2\nexdate:20260811,20260804,20260804');
    const anchor = { ...makeDateValue('2026-07-28'), startTime: '09:00' };
    expect(serializeRepeat(parsed, anchor)).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU\nEXDATE:20260804T090000,20260811T090000',
    );
  });
});

describe('repeat words and capability pairing', () => {
  it.each([
    ['FREQ=DAILY', 'Daily'],
    ['FREQ=DAILY;INTERVAL=3', 'Every 3 days'],
    ['FREQ=WEEKLY;BYDAY=TU', 'Weekly on Tuesday'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', 'Every 2 weeks on Monday and Thursday'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Every weekday'],
    ['FREQ=MONTHLY;BYMONTHDAY=15', 'Monthly on the 15th'],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', 'Monthly on the last day'],
    ['FREQ=MONTHLY;BYDAY=1FR', 'Monthly on the first Friday'],
    ['FREQ=YEARLY;BYMONTHDAY=28;BYMONTH=7', 'Annually on July 28'],
    ['FREQ=YEARLY;BYDAY=1MO;BYMONTH=9', 'Annually on the first Monday of September'],
    ['FREQ=DAILY;COUNT=10\nEXDATE:20260729', 'Daily · 10 times · 1 exception'],
    ['FREQ=DAILY;UNTIL=20261231', 'Daily · until Dec 31, 2026'],
  ])('describes %s', (text, words) => expect(describeRepeat(parseRepeat(text))).toBe(words));
  it('pairs the first range ahead of dates and offers Tuesday presets', () => {
    const entry = makeEntry({
      path: 'one.md',
      type: 'Standup',
      properties: {
        day: '2026-07-29',
        when: { start: '2026-07-28 09:00', end: '2026-07-28 09:15' },
        repeat: 'FREQ=WEEKLY;BYDAY=TU',
      },
    } as never);
    const schema = buildSchema([
      makeEntry({
        path: 'types/standup.md',
        type: 'Type',
        title: 'Standup',
        properties: {
          fields: {
            day: { kind: 'date' },
            repeat: { kind: 'repeat' },
            when: { kind: 'daterange' },
          },
        },
      } as never),
      entry,
    ]);
    expect(repeatFieldFor(entry, schema)).toMatchObject({
      repeat: { name: 'repeat' },
      date: { name: 'when' },
    });
    const anchor = repeatAnchor(entry, schema)!;
    expect(anchor).toMatchObject({ start: '2026-07-28', startTime: '09:00', endTime: '09:15' });
    expect(repeatPresets(anchor)[1]).toEqual({
      label: 'Weekly on Tuesday',
      value: 'FREQ=WEEKLY;BYDAY=TU',
    });
    expect(schema.resolveField(entry, 'repeat').display).toBe('Weekly on Tuesday');
    expect(
      schema.resolveField(
        { ...entry, properties: { ...entry.properties, repeat: 'FREQ=DAILY;BYSETPOS=1' } },
        'repeat',
      ).display,
    ).toBe('Repeat rule not understood');
  });
  it('registers Repeat as text shape but coerces only understood text', () => {
    expect(kindMeta('repeat')).toMatchObject({ label: 'Repeat', icon: 'repeat', computed: false });
    expect(validateValue({ name: 'repeat', kind: 'repeat' }, 'outside our subset')).toBeNull();
    expect(validateValue({ name: 'repeat', kind: 'repeat' }, 3)).toBe(
      'repeat must be a repeat rule',
    );
    expect(coerceValueToKind('FREQ=WEEKLY;BYDAY=TU', 'repeat')).toBe('FREQ=WEEKLY;BYDAY=TU');
    expect(coerceValueToKind('every Tuesday', 'repeat')).toBeNull();
  });
});

describe('floating recurrence expansion', () => {
  it('draws Tuesdays and Thursdays, preserving times and duration', () => {
    const anchor = parseDateProperty({ start: '2026-07-28 09:00', end: '2026-07-28 09:15' })!;
    const values = occurrencesIn(rule('FREQ=WEEKLY;BYDAY=TU,TH'), anchor, {
      start: '2026-07-28',
      end: '2026-08-06',
    });
    expect(values.map((v) => v.start)).toEqual([
      '2026-07-28',
      '2026-07-30',
      '2026-08-04',
      '2026-08-06',
    ]);
    expect(
      values.every((v) => v.startTime === '09:00' && v.endTime === '09:15' && v.end === v.start),
    ).toBe(true);
  });
  it('skips short months for the 31st and reads the last Friday', () => {
    expect(dates('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31', '2026-01-01', '2026-05-31')).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
    ]);
    expect(dates('FREQ=MONTHLY;BYDAY=-1FR', '2026-01-01', '2026-01-01', '2026-03-31')).toEqual([
      '2026-01-30',
      '2026-02-27',
      '2026-03-27',
    ]);
  });
  it('counts from the original start, includes UNTIL and removes exceptions', () => {
    expect(dates('FREQ=WEEKLY;BYDAY=TU;COUNT=3', '2026-07-28', '2026-08-04', '2026-08-31')).toEqual(
      ['2026-08-04', '2026-08-11'],
    );
    expect(dates('FREQ=DAILY;UNTIL=20260730', '2026-07-28', '2026-07-28', '2026-08-31')).toEqual([
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
    ]);
    expect(
      dates('FREQ=DAILY;COUNT=3\nEXDATE:20260729', '2026-07-28', '2026-07-28', '2026-08-31'),
    ).toEqual(['2026-07-28', '2026-07-30']);
    const anchor = parseDateProperty({ start: '2026-07-28 09:00', end: '2026-07-28 09:15' })!;
    expect(
      occurrencesIn(rule('FREQ=DAILY;UNTIL=20260730\nEXDATE:20260729T090000'), anchor, {
        start: '2026-07-28',
        end: '2026-07-31',
      }).map((v) => v.start),
    ).toEqual(['2026-07-28', '2026-07-30']);
  });
  it('fast-forwards a 2000 anchor without changing weekly phase or losing overlapping ranges', () => {
    expect(dates('FREQ=DAILY', '2000-01-01', '2026-07-28', '2026-07-30')).toEqual([
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
    ]);
    expect(dates('FREQ=WEEKLY;BYDAY=TU', '2000-01-01', '2026-07-28', '2026-08-04')).toEqual([
      '2026-07-28',
      '2026-08-04',
    ]);
    const values = occurrencesIn(
      rule('FREQ=WEEKLY'),
      { ...makeDateValue('2026-07-28'), end: '2026-07-30' },
      { start: '2026-07-30', end: '2026-07-30' },
    );
    expect(values).toHaveLength(1);
    expect(values[0].end).toBe('2026-07-30');
  });
  it('has a hard 5,000-occurrence stop', () => {
    expect(
      occurrencesIn(rule('FREQ=DAILY'), makeDateValue('2000-01-01'), {
        start: '2000-01-01',
        end: '2050-01-01',
      }),
    ).toHaveLength(5000);
  });
  it('returns identical wall times in Sydney and Los Angeles across both DST transitions', () => {
    const code = `import {occurrencesIn,parseRepeat} from './src/engine/recurrence.ts'; import {parseDateProperty} from './src/engine/dates.ts'; const r=parseRepeat('FREQ=DAILY'); console.log(JSON.stringify(occurrencesIn(r.rule,parseDateProperty({start:'2026-03-01 09:00',end:'2026-03-01 09:15'}),{start:'2026-03-01',end:'2026-11-08'})));`;
    const run = (zone: string) =>
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
        cwd: join(__dirname, '../..'),
        env: { ...process.env, TZ: zone },
        encoding: 'utf8',
      });
    expect(run('Australia/Sydney')).toBe(run('America/Los_Angeles'));
  }, 20_000);
});

it('only recurrence.ts loads the upstream expander', () => {
  const root = join(__dirname, '..');
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        /\.tsx?$/.test(path) &&
        !/\.test\.tsx?$/.test(path) &&
        /(?:from\s*|import\s*\(|import\s*)['"]rrule(?:\/|['"])/.test(readFileSync(path, 'utf8'))
      )
        paths.push(path.slice(root.length + 1));
    }
  };
  walk(root);
  expect(paths).toEqual(['engine/recurrence.ts']);
});

function seriesFixture() {
  const source = {
    content: `---
type: Standup
when: {start: '2026-07-28 09:00', end: '2026-07-28 09:15'}
repeat: FREQ=WEEKLY;BYDAY=TU,TH
owner: '[[maya]]'
key: TEAM-3
icon: 'star'
cover: blue
formula: 900
reverse: ['[[other]]']
undeclared: private
---

# Daily standup

The series body stays here.
`,
    hash: 'a'.repeat(64),
  };
  const type = makeEntry({
    path: 'types/standup.md',
    type: 'Type',
    title: 'Standup',
    properties: {
      folder: 'meetings/new',
      fields: {
        when: { kind: 'daterange' },
        repeat: { kind: 'repeat' },
        owner: { kind: 'person' },
        formula: { kind: 'formula', formula: '1 + 2' },
        reverse: { kind: 'relation', from: { type: 'Standup', field: 'owner' } },
      },
    },
  } as never);
  const series = makeEntry({
    path: 'records/standups/daily-standup.md',
    type: 'Standup',
    title: 'Daily standup',
    properties: {
      when: { start: '2026-07-28 09:00', end: '2026-07-28 09:15' },
      repeat: 'FREQ=WEEKLY;BYDAY=TU,TH',
      key: 'TEAM-3',
    },
  } as never);
  const entries = [type, series];
  const schema = buildSchema(entries);
  const occurrence = parseDateProperty({ start: '2026-08-04 09:00', end: '2026-08-04 09:15' })!;
  return { source, type, series, entries, schema, occurrence };
}

it('expands only the paired date field, memoizes by inputs, and shows unknown rules once', () => {
  const { series, entries, schema } = seriesFixture();
  const window = { start: '2026-07-28', end: '2026-08-06' };
  const all = expandForCalendar(entries, 'when', schema, window);
  const events = all.filter((item) => item.series === series);
  expect(events).toHaveLength(4);
  expect(new Set(events.map((item) => item.key)).size).toBe(4);
  expect(events.every((item) => item.repeat === 'occurrence')).toBe(true);
  expect(events[2].entry.properties.when).toEqual({
    start: '2026-08-04 09:00',
    end: '2026-08-04 09:15',
  });
  expect(expandForCalendar(entries, 'when', schema, { ...window })).toBe(all);
  expect(
    expandForCalendar(entries, 'other', schema, window).find((item) => item.series === series)
      ?.repeat,
  ).toBe('none');
  const odd = { ...series, properties: { ...series.properties, repeat: 'FREQ=DAILY;BYSETPOS=2' } };
  expect(expandForCalendar([odd], 'when', schema, window)).toMatchObject([
    { repeat: 'unknown', entry: odd },
  ]);
});
it('plans a hash-checked exclusion then a new page with only declared stored fields and a fresh key', () => {
  const { series, source, entries, schema, occurrence } = seriesFixture();
  const plan = planDetach(series, source, occurrence, entries, schema)!;
  expect(plan.path).toBe('meetings/new/daily-standup-2026-08-04.md');
  expect(plan.label).toBe('Made Tue, Aug 4 of “Daily standup” its own page');
  expect(plan.ops[0]).toEqual({
    op: 'patch',
    path: series.path,
    set: { repeat: 'FREQ=WEEKLY;BYDAY=TU,TH\nEXDATE:20260804T090000' },
    expectHash: source.hash,
  });
  const create = plan.ops[1];
  expect(create.op).toBe('create');
  if (create.op !== 'create') return;
  const yaml = /^---\n([\s\S]*?)\n---/.exec(create.content)![1];
  expect(parse(yaml)).toEqual({
    type: 'Standup',
    owner: '[[maya]]',
    icon: 'star',
    cover: 'blue',
    when: { start: '2026-08-04 09:00', end: '2026-08-04 09:15' },
    key: 'TEAM-4',
  });
  expect(create.content).toContain(
    'Split from [[daily-standup]]: the Tuesday, August 4, 2026 occurrence.',
  );
  expect(create.content).not.toContain('The series body');
});
it('numbers occupied paths case-insensitively and keeps all-day exception form', () => {
  const { series, source, entries, schema } = seriesFixture();
  const raw = source.content.replace(
    "{start: '2026-07-28 09:00', end: '2026-07-28 09:15'}",
    "{start: '2026-07-28', end: '2026-07-28'}",
  );
  const occurrence = { ...makeDateValue('2026-08-04'), end: '2026-08-04' };
  const plan = planDetach(
    series,
    { ...source, content: raw },
    occurrence,
    [...entries, makeEntry({ path: 'MEETINGS/NEW/DAILY-STANDUP-2026-08-04.MD' })],
    schema,
  )!;
  expect(plan.path).toBe('meetings/new/daily-standup-2026-08-04-2.md');
  expect(plan.ops[0]).toMatchObject({
    set: { repeat: 'FREQ=WEEKLY;BYDAY=TU,TH\nEXDATE:20260804' },
  });
});
it('refuses a stale, already excluded, malformed or governed series without a plan', () => {
  const { series, source, entries, schema, occurrence } = seriesFixture();
  for (const content of [
    source.content.replace('FREQ=WEEKLY;BYDAY=TU,TH', 'FREQ=WEEKLY;BYDAY=WE'),
    source.content.replace("end: '2026-07-28 09:15'", "end: '2026-07-28 09:30'"),
    source.content.replace(
      'repeat: FREQ=WEEKLY;BYDAY=TU,TH',
      'repeat: |\n  FREQ=WEEKLY;BYDAY=TU,TH\n  EXDATE:20260804T090000',
    ),
    source.content.replace('type: Standup', 'type: Other'),
    '---\n[broken\n---\n# Broken',
  ])
    expect(planDetach(series, { ...source, content }, occurrence, entries, schema)).toBeNull();
  expect(
    planDetach({ ...series, path: 'knowledge/series.md' }, source, occurrence, entries, schema),
  ).toBeNull();
  expect(planDetach({ ...series, type: 'Agent' }, source, occurrence, entries, schema)).toBeNull();
});

it('does not invent an anchor month for a yearly weekday or month-day rule', () => {
  const anchor = makeDateValue('2026-07-28');
  expect(describeRepeat(parseRepeat('FREQ=YEARLY;BYDAY=1MO'), anchor)).toBe(
    'Annually on the first Monday',
  );
  expect(describeRepeat(parseRepeat('FREQ=YEARLY;BYMONTHDAY=15'), anchor)).toBe(
    'Annually on the 15th of every month',
  );
  expect(describeRepeat(parseRepeat('FREQ=YEARLY;BYMONTHDAY=-1;BYMONTH=7'), anchor)).toBe(
    'Annually on the last day of July',
  );
});

it('keeps virtual file times on the calendar instead of classing them undated', () => {
  const entry = makeEntry({
    path: 'one.md',
    createdAt: '2026-10-15',
    properties: { createdAt: '1999-01-01' },
  });
  const items = expandForCalendar([entry], 'createdAt', buildSchema([entry]), {
    start: '2026-10-01',
    end: '2026-10-31',
  });
  expect(items).toHaveLength(1);
  expect(items[0].value?.start).toBe('2026-10-15');
  expect(items[0].repeat).toBe('none');
});
