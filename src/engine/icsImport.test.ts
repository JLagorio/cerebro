import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeEntry } from '@/test/factories';
import type { Entry } from './types';
import { buildSchema } from './schema';
import { parseIcs } from './ics';
import { defaultIcsMapping, icsTargets, planIcsImport, type IcsMapping } from './icsImport';
import { splitFrontmatter } from './frontmatter';
import { planImports } from './importPlan';
import { MAX_BATCH_OPS } from './batch';

const type = (name: string, fields: Record<string, unknown>) =>
  makeEntry({
    path: `types/${name}.md`,
    title: name,
    type: 'Type',
    properties: { fields } as unknown as Entry['properties'],
  });
const entries = [
  type('Gathering', {
    when: { kind: 'daterange' },
    cadence: { kind: 'repeat' },
    guests: { kind: 'person' },
    venue: { kind: 'text' },
  }),
  type('Contact', { mailbox: { kind: 'email' } }),
  makeEntry({
    path: 'contacts/ana.md',
    type: 'Contact',
    title: 'Ana',
    properties: { mailbox: 'ana@example.test' },
  }),
];
const schema = buildSchema(entries);
const mapping = defaultIcsMapping(schema.types.get('Gathering')!);
const event = (body: string) => `BEGIN:VEVENT\n${body}\nEND:VEVENT`;
const calendar = (...events: string[]) =>
  parseIcs(`BEGIN:VCALENDAR\n${events.map(event).join('\n')}\nEND:VCALENDAR`);
const plan = (body: string, overrides: Partial<IcsMapping> = {}) =>
  planIcsImport(calendar(body), { ...mapping, ...overrides }, entries, schema);
const fields = (content: string) =>
  parse(splitFrontmatter(content).yaml!) as Record<string, unknown>;

it('picks targets by capabilities and excludes reserved databases', () => {
  const shape = buildSchema([
    ...entries,
    type('Simple', { day: { kind: 'date' } }),
    type('Agent', { day: { kind: 'date' } }),
  ]);
  expect(icsTargets(shape).map((row) => row.name)).toEqual(['Gathering', 'Simple']);
  expect(mapping).toEqual({ type: 'Gathering', date: 'when', person: 'guests', location: null });
  expect(plan('UID:one\nDTSTART:20260703', { date: 'venue' }).problem).toContain('Choose');
});
it('stores zoned time, a point and an inclusive all-day range without invented ends', () => {
  const result = planIcsImport(
    calendar(
      'UID:paris\nSUMMARY:Standup\nDTSTART;TZID=Europe/Paris:20260703T090000\nDTEND;TZID=Europe/Paris:20260703T100000',
      'UID:point\nSUMMARY:Reminder\nDTSTART:20260703T120000Z',
      'UID:days\nSUMMARY:Leave\nDTSTART;VALUE=DATE:20260703\nDTEND;VALUE=DATE:20260706',
    ),
    mapping,
    entries,
    schema,
  );
  expect(result.problem).toBeNull();
  expect(fields(result.ops[0].content).when).toEqual({
    start: '2026-07-03T09:00:00+02:00',
    end: '2026-07-03T10:00:00+02:00',
  });
  expect(result.ops[0].content).toContain('* Time zone: Europe/Paris');
  expect(fields(result.ops[1].content).when).toEqual({ start: '2026-07-03T12:00:00Z' });
  expect(fields(result.ops[2].content).when).toEqual({ start: '2026-07-03', end: '2026-07-05' });
  expect(result.counts).toMatchObject({ allDay: 1, point: 1 });
  expect(result.ops[0].path).toBe('records/gatherings/2026-07-03-standup.md');
});
it('keeps equal ends and one-day all-day events as points', () => {
  for (const ending of ['DTEND:20260703', 'DTEND:20260704', 'DURATION:P1D']) {
    const result = plan(`UID:point\nDTSTART:20260703\n${ending}`);
    expect(fields(result.ops[0].content).when).toEqual({ start: '2026-07-03' });
    expect(result.counts.point).toBe(1);
  }
});
it('redacts invite addresses from title, description and location, and links only one declared email match', () => {
  const result = plan(
    'UID:invite\nDTSTART:20260703\nSUMMARY:Call ANA@example.test\nDESCRIPTION:Organizer host@example.test invited ana@example.test and unknown@example.test.\nLOCATION:room@example.test\nORGANIZER;CN=Host:mailto:host@example.test\nATTENDEE;CN=Ana:mailto:ana@example.test\nATTENDEE;CN=unknown@example.test:mailto:unknown@example.test\nATTENDEE:mailto:room@example.test',
    { location: 'venue' },
  );
  expect(result.problem).toBeNull();
  const content = result.ops[0].content;
  expect(content).not.toMatch(/(?:host|ana|unknown|room)@example\.test/i);
  expect(content).toContain('# Call Ana');
  expect(content).toContain('Organizer Host invited Ana and (address removed).');
  expect(fields(content)).toMatchObject({ guests: ['[[ana]]'], venue: '(address removed)' });
  expect(result.counts).toMatchObject({ peopleLinked: 1, peopleUnlinked: 3, addressesRemoved: 5 });
  expect(content).toContain('* People not linked: 3');
  const duplicate = [
    ...entries,
    makeEntry({
      path: 'contacts/another.md',
      type: 'Contact',
      properties: { mailbox: 'ana@example.test' },
    }),
  ];
  const ambiguous = planIcsImport(
    calendar('UID:one\nDTSTART:20260703\nATTENDEE:mailto:ana@example.test'),
    mapping,
    duplicate,
    buildSchema(duplicate),
  );
  expect(fields(ambiguous.ops[0].content).guests).toBeUndefined();
  expect(ambiguous.counts.peopleUnlinked).toBe(1);
});
it('puts overrides on their own page and excludes them from the series', () => {
  const result = planIcsImport(
    calendar(
      'UID:series\nDTSTART:20260703T090000Z\nRRULE:FREQ=WEEKLY;COUNT=3\nRDATE:20260705T090000Z',
      'UID:series\nRECURRENCE-ID:20260710T090000Z\nDTSTART:20260710T100000Z',
    ),
    mapping,
    entries,
    schema,
  );
  expect(result.ops).toHaveLength(2);
  expect(fields(result.ops[0].content).cadence).toBe(
    'FREQ=WEEKLY;COUNT=3\nEXDATE:20260710T090000Z',
  );
  expect(result.ops[0].content).toContain('* Also on: 20260705T090000Z');
  expect(result.ops[1].recordId).toBe('series 20260710T090000Z');
  expect(result.counts).toMatchObject({ repeating: 1, overrides: 1 });
});
it('retains unsupported repeat text and limits Join links to https', () => {
  expect(
    fields(plan('UID:repeat\nDTSTART:20260703\nRRULE:FREQ=HOURLY').ops[0].content).cadence,
  ).toBe('FREQ=HOURLY');
  expect(plan('UID:url\nDTSTART:20260703\nURL:https://example.test/join').ops[0].content).toContain(
    '* Join: https://example.test/join',
  );
  expect(
    plan('UID:url\nDTSTART:20260703\nURL:http://example.test/join').ops[0].content,
  ).not.toContain('* Join:');
});
it('counts each skip and keeps unknown zones as written', () => {
  const result = planIcsImport(
    calendar(
      'DTSTART:20260703',
      'UID:bad\nDTSTART:20260230',
      'UID:cancel\nDTSTART:20260703\nSTATUS:CANCELLED',
      'UID:one\nDTSTART:20260703T090013\nSUMMARY:First',
      'UID:one\nDTSTART:20260703T100000',
    ),
    mapping,
    entries,
    schema,
  );
  expect(result.counts).toMatchObject({
    missingUid: 1,
    unreadableStart: 1,
    cancelled: 1,
    duplicate: 1,
    secondsDropped: 1,
  });
  const unknown = plan('UID:unknown\nDTSTART;TZID=Imaginary/Zone:20260703T090000');
  expect(unknown.ops[0].content).toContain('Imaginary/Zone (times kept as written)');
  expect(unknown.counts.unknownZone).toBe(1);
  const cancelled = parseIcs(
    'BEGIN:VCALENDAR\nMETHOD:CANCEL\nBEGIN:VEVENT\nUID:one\nDTSTART:20260703\nEND:VEVENT\nEND:VCALENDAR',
  );
  expect(planIcsImport(cancelled, mapping, entries, schema).counts.cancelled).toBe(1);
});
it('re-imports through the shared identity and stamp writer without creating another file', () => {
  const result = plan('UID:same\nSUMMARY:One\nDTSTART:20260703');
  const requests = result.ops.map((op, index) => ({ op, index }));
  const stamp = { now: '2026-10-15T00:00:00Z', actor: 'human:me' };
  const first = planImports(requests, [], [], [], stamp);
  const files = first.writes.map(({ op }) => ({ path: op.path, content: op.content }));
  const again = planImports(
    requests,
    files,
    files.map((file) => file.path),
    [],
    stamp,
  );
  expect(again.writes).toEqual([]);
  expect(again.imports[0].outcome).toBe('unchanged');
});
it('refuses a calendar bigger than one batch with no partial import', () => {
  const result = planIcsImport(
    calendar(...Array.from({ length: MAX_BATCH_OPS + 1 }, (_, i) => `UID:${i}\nDTSTART:20260703`)),
    mapping,
    entries,
    schema,
  );
  expect(result.ops).toEqual([]);
  expect(result.problem).toContain('Split this calendar');
});
it('redacts address-valued display names and encoded addresses and drops addressed Join URLs', () => {
  const result = plan(
    'UID:privacy\nDTSTART:20260703\nATTENDEE;CN="alias@example.test":mailto:owner%40example.test\nDESCRIPTION:alias@example.test owner@example.test owner%40example.test\nURL:https://example.test/join?to=owner%2540example.test',
  );
  expect(result.problem).toBeNull();
  expect(result.ops[0].content).not.toMatch(/(?:alias|owner)(?:@|%40|%2540)example\.test/i);
  expect(result.ops[0].url).toBeUndefined();
  expect(result.counts.addressesRemoved).toBe(3);
});
it('a malformed override keeps the original occurrence; an explicit cancellation excludes it', () => {
  const master = 'UID:series\nDTSTART:20260703T090000Z\nRRULE:FREQ=WEEKLY;COUNT=3';
  const override = 'UID:series\nRECURRENCE-ID:20260710T090000Z';
  const broken = planIcsImport(
    calendar(master, `${override}\nDTSTART:unreadable`),
    mapping,
    entries,
    schema,
  );
  expect(fields(broken.ops[0].content).cadence).toBe('FREQ=WEEKLY;COUNT=3');
  expect(broken.counts.unreadableStart).toBe(1);
  const cancelled = planIcsImport(
    calendar(master, `${override}\nSTATUS:CANCELLED`),
    mapping,
    entries,
    schema,
  );
  expect(fields(cancelled.ops[0].content).cadence).toBe(
    'FREQ=WEEKLY;COUNT=3\nEXDATE:20260710T090000Z',
  );
  expect(cancelled.counts.cancelled).toBe(1);
});

it('a date-only destination keeps its end in the footer and counts zones over all events', () => {
  const only = [type('Dated', { date: { kind: 'date' } })];
  const shape = buildSchema(only);
  const result = planIcsImport(
    calendar(
      'UID:one\nDTSTART;TZID=Europe/Paris:20260703T090000\nDTEND;TZID=Europe/Paris:20260703T100000',
    ),
    defaultIcsMapping(shape.types.get('Dated')!),
    only,
    shape,
  );
  expect(fields(result.ops[0].content).date).toBe('2026-07-03T09:00:00+02:00');
  expect(result.ops[0].content).toContain('* Ends: 2026-07-03T10:00:00+02:00');
  expect(result.zones).toEqual({ 'Europe/Paris': 1 });
});
it('counts an unknown zone once per event and omits a malformed end', () => {
  const unknown = plan(
    'UID:one\nDTSTART;TZID=Unknown/Place:20260703T090000\nDTEND;TZID=Unknown/Place:20260703T100000',
  );
  expect(unknown.counts.unknownZone).toBe(1);
  expect(unknown.zones).toEqual({ 'Unknown/Place': 1 });
  const invalid = plan('UID:one\nDTSTART:20260703T090000Z\nDTEND:wrong');
  expect(invalid.counts.invalidEnd).toBe(1);
  expect(fields(invalid.ops[0].content).when).toEqual({ start: '2026-07-03T09:00:00Z' });
});
