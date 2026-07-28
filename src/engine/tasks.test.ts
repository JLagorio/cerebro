import { describe, expect, it } from 'vitest';
import { dueBucket, formatDue, parseTasks, toggleTaskLine } from './tasks';

const BODY = [
  '# Doc',
  '',
  '- [ ] plain task',
  '- [x] finished task',
  '* [ ] starred task 📅 2026-08-01',
  '- [ ] assigned @[[maya-chen]] 📅 2026-07-20',
  '  - [ ] nested with link [[kickoff|the kickoff]]',
  '- not a task',
  '```',
  '- [ ] inside a fence',
  '```',
].join('\n');

describe('parseTasks', () => {
  it('finds checklist items with done state, due dates, and assignees', () => {
    const tasks = parseTasks('inbox/doc.md', BODY);
    expect(tasks).toHaveLength(5);
    expect(tasks.map((t) => t.done)).toEqual([false, true, false, false, false]);
    expect(tasks[2].due).toBe('2026-08-01');
    expect(tasks[3].assignees).toEqual(['maya-chen']);
    expect(tasks[3].due).toBe('2026-07-20');
    expect(tasks[3].text).toBe('assigned');
    expect(tasks.every((t) => t.sourcePath === 'inbox/doc.md')).toBe(true);
  });

  it('unwraps wikilinks in the display text', () => {
    const tasks = parseTasks('d.md', BODY);
    expect(tasks[4].text).toBe('nested with link the kickoff');
  });

  it('skips fenced code and non-checklist lines', () => {
    const tasks = parseTasks('d.md', BODY);
    expect(tasks.some((t) => t.text.includes('inside a fence'))).toBe(false);
    expect(tasks.some((t) => t.text.includes('not a task'))).toBe(false);
  });
});

describe('toggleTaskLine', () => {
  it('checks and unchecks the addressed line only', () => {
    const tasks = parseTasks('d.md', BODY);
    const on = toggleTaskLine(BODY, tasks[0].line, true)!;
    expect(on.split('\n')[tasks[0].line]).toBe('- [x] plain task');
    const off = toggleTaskLine(on, tasks[1].line, false)!;
    expect(off.split('\n')[tasks[1].line]).toBe('- [ ] finished task');
  });

  it('returns null for a line that is not a task (stale index)', () => {
    expect(toggleTaskLine(BODY, 0, true)).toBeNull();
    expect(toggleTaskLine(BODY, 999, true)).toBeNull();
  });
});

describe('dueBucket / formatDue', () => {
  it('buckets against today', () => {
    expect(dueBucket(null, '2026-07-25')).toBe('none');
    expect(dueBucket('2026-07-24', '2026-07-25')).toBe('overdue');
    expect(dueBucket('2026-07-25', '2026-07-25')).toBe('today');
    expect(dueBucket('2026-07-26', '2026-07-25')).toBe('upcoming');
  });

  it('formats without timezone drift', () => {
    expect(formatDue('2026-08-01')).toBe('Aug 1');
    expect(formatDue('2026-12-31')).toBe('Dec 31');
  });
});
