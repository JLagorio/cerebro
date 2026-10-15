import { describe, expect, it } from 'vitest';
import { icsProperty, icsText, parseIcs } from './ics';
const calendar = (event: string) =>
  `BEGIN:VCALENDAR\nBEGIN:VEVENT\n${event}\nEND:VEVENT\nEND:VCALENDAR`;
describe('calendar parser', () => {
  for (const newline of ['\r\n', '\n', '\r'])
    it(`unfolds a BOM file with ${JSON.stringify(newline)} lines`, () => {
      const parsed = parseIcs(
        `\uFEFF${calendar('UID:one\nSUMMARY:A long\n  line\n\tcontinued')}`.replaceAll(
          '\n',
          newline,
        ),
      );
      expect(parsed.events).toHaveLength(1);
      expect(icsProperty(parsed.events[0].properties, 'summary')?.value).toBe(
        'A long linecontinued',
      );
      expect(parsed.skipped.malformed).toBe(0);
    });
  it('keeps commas and colons inside quoted parameters and decodes parameter escapes', () => {
    const parsed = parseIcs(
      calendar('ATTENDEE;MEMBER=v1,"v,2";CN="Room: ^\'A^\'":mailto:room@example.test'),
    );
    expect(parsed.events[0].properties[0]).toEqual({
      name: 'ATTENDEE',
      params: { MEMBER: ['v1', 'v,2'], CN: ['Room: "A"'] },
      value: 'mailto:room@example.test',
    });
  });
  it('unescapes only the TEXT grammar, once', () => {
    expect(icsText('a\\nB\\N\\,\\;\\\\n\\x')).toBe('a\nB\n,;\\n\\x');
  });
  it('ignores alarm fields, counts other kinds, and retains the calendar method after events', () => {
    const parsed = parseIcs(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:one\nBEGIN:VALARM\nSUMMARY:Alarm\nEND:VALARM\nEND:VEVENT\nBEGIN:VTODO\nEND:VTODO\nBEGIN:VJOURNAL\nEND:VJOURNAL\nBEGIN:VFREEBUSY\nEND:VFREEBUSY\nMETHOD:CANCEL\nEND:VCALENDAR',
    );
    expect(parsed.events).toEqual([
      { properties: [{ name: 'UID', params: {}, value: 'one' }], method: 'CANCEL' },
    ]);
    expect(parsed.skipped).toEqual({ todo: 1, journal: 1, freebusy: 1, other: 0, malformed: 0 });
  });
  it('counts malformed lines and stray ends without throwing away a completed event', () => {
    const parsed = parseIcs(
      `END:VEVENT\n${calendar('UID:one\nbroken\nBAD;A="unclosed:value\nSUMMARY:Good')}`,
    );
    expect(parsed.skipped.malformed).toBe(3);
    expect(icsProperty(parsed.events[0].properties, 'SUMMARY')?.value).toBe('Good');
    expect(parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:one').events).toEqual([]);
    expect(parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:one').skipped.malformed).toBe(2);
  });
  it('refuses the byte cap before retaining component text', () => {
    const parsed = parseIcs('é'.repeat(8 * 1024 * 1024 + 1));
    expect(parsed.problem).toContain('16 MB');
    expect(parsed.events).toEqual([]);
  });
  it('ignores valid timezone definitions and rejects trailing text after quoted parameters', () => {
    const parsed = parseIcs(
      'BEGIN:VCALENDAR\nBEGIN:VTIMEZONE\nTZID:Europe/Paris\nBEGIN:STANDARD\nDTSTART:20261025T030000\nEND:STANDARD\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:one\nATTENDEE;CN="Name"junk:mailto:one@example.test\nEND:VEVENT\nEND:VCALENDAR',
    );
    expect(parsed.events).toHaveLength(1);
    expect(parsed.skipped).toEqual({ todo: 0, journal: 0, freebusy: 0, other: 0, malformed: 1 });
  });
});
