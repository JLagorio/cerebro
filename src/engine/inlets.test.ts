import { expect, it } from 'vitest';
import { inletFor } from './inlets';
it('requires the import kind and a calendar component in the bounded head', () => {
  expect(inletFor('Team.ICS', '\uFEFFBEGIN:VCALENDAR\r\n')).toBe('calendar');
  expect(inletFor('team.ics', 'BEGIN:VCALENDAR-OTHER\n')).toBeNull();
  expect(inletFor('team.txt', 'BEGIN:VCALENDAR\n')).toBeNull();
  expect(inletFor('team.ics', `${'a'.repeat(65_536)}\nBEGIN:VCALENDAR\n`)).toBeNull();
  expect(inletFor('linear.csv', 'ID,Title\n')).toBeNull();
});
