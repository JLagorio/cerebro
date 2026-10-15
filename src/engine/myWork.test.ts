import { describe, expect, it } from 'vitest';
import { openWork, workState, workSections } from './myWork';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';

/** A Type doc whose records are task-like: it declares a status field. */
const taskType = makeEntry({
  type: 'Type',
  title: 'Task',
  path: 'types/task.md',
  properties: {
    fields: { status: { kind: 'status' } },
    statuses: [
      { id: 'todo', label: 'To do', group: 'active' },
      { id: 'doing', label: 'Doing', group: 'active' },
      { id: 'done', label: 'Done', group: 'done' },
    ],
  },
});

/** A Type doc with NO status field: its records are never work. */
const noteType = makeEntry({
  type: 'Type',
  title: 'Note',
  path: 'types/note.md',
  properties: { fields: { topic: { kind: 'text' } } },
});

describe('openWork', () => {
  it('includes only records whose status resolves to an active group', () => {
    const open = makeEntry({
      type: 'Task',
      title: 'Fix login',
      path: 'records/tasks/fix-login.md',
      properties: { status: 'todo' },
    });
    const done = makeEntry({
      type: 'Task',
      title: 'Ship exports',
      path: 'records/tasks/ship-exports.md',
      properties: { status: 'done' },
    });
    const entries = [taskType, open, done];
    const rows = openWork(entries, buildSchema(entries));
    expect(rows.map((r) => r.entry.title)).toEqual(['Fix login']);
    expect(rows[0].status).toMatchObject({ id: 'todo', group: 'active' });
  });

  it('excludes records of a type with no status field — capability, not type name', () => {
    const note = makeEntry({
      type: 'Note',
      title: 'Meeting notes',
      path: 'notes/meeting.md',
      // A status VALUE without a status FIELD does not make a note a task.
      properties: { status: 'todo' },
    });
    const entries = [noteType, note];
    expect(openWork(entries, buildSchema(entries))).toEqual([]);
  });

  it('excludes an unresolvable status rather than guessing — the count counts what the page shows', () => {
    const typo = makeEntry({
      type: 'Task',
      title: 'Mystery',
      path: 'records/tasks/mystery.md',
      properties: { status: 'in-porgress' },
    });
    const unset = makeEntry({
      type: 'Task',
      title: 'No status yet',
      path: 'records/tasks/no-status.md',
      properties: {},
    });
    const entries = [taskType, typo, unset];
    expect(openWork(entries, buildSchema(entries))).toEqual([]);
  });

  it('excludes untyped entries and templates', () => {
    const untyped = makeEntry({ type: null, title: 'Capture', path: 'inbox/capture.md' });
    const template = makeEntry({
      type: 'Task',
      title: 'Task template',
      path: 'templates/task.md',
      folder: 'templates',
      properties: { status: 'todo' },
    });
    const entries = [taskType, untyped, template];
    expect(openWork(entries, buildSchema(entries))).toEqual([]);
  });
});

describe('deadline sections (M61.3b)', () => {
  const dated = makeEntry({
    ...taskType,
    properties: {
      ...taskType.properties,
      deadline: 'due',
      fields: { status: { kind: 'status' }, due: { kind: 'daterange' } },
    },
  });
  const row = (title: string, due: unknown, status = 'todo') =>
    makeEntry({ path: `${title}.md`, title, type: 'Task', properties: { status, due } });
  it('reads open, finished and unknown states from the record status set', () => {
    const schema = buildSchema([dated]);
    expect(workState(row('a', null), schema)).toBe('open');
    expect(workState(row('a', null, 'done'), schema)).toBe('finished');
    expect(workState(row('a', null, 'oops'), schema)).toBe('unknown');
    expect(workState(makeEntry(), schema)).toBe('unknown');
  });
  it('orders date sections and times, preserves invalid values, then groups undated work', () => {
    const entries = [
      dated,
      row('Later', '2026-09-01'),
      row('Afternoon', '2026-07-28 14:30'),
      row('Morning', '2026-07-28 09:00'),
      row('Overdue', '2026-07-24'),
      row('Tomorrow', { start: '2026-07-20', end: '2026-07-29' }),
      row('Week', '2026-07-31'),
      row('Next', '2026-08-03'),
      row('Invalid', 'sometime'),
      row('Undated doing', null, 'doing'),
      row('Undated todo', null),
      row('Finished', '2026-07-20', 'done'),
    ];
    const sections = workSections(entries, buildSchema(entries), {
      today: '2026-07-28',
      weekStart: 0,
    });
    expect(sections.map((section) => section.bucket)).toEqual([
      'overdue',
      'today',
      'tomorrow',
      'this_week',
      'next_week',
      'later',
      'unreadable',
      'Task',
    ]);
    expect(sections[1].rows.map((row) => row.entry.title)).toEqual(['Morning', 'Afternoon']);
    expect(sections[2].rows[0].deadline?.date).toBe('2026-07-29');
    expect(sections[6].rows[0].unreadable).toBe(true);
    expect(sections[7].rows.map((row) => row.entry.title)).toEqual([
      'Undated todo',
      'Undated doing',
    ]);
    expect(workSections([dated], buildSchema([dated]))).toEqual([]);
  });
});
