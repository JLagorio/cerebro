import { describe, expect, it } from 'vitest';
import { openWork } from './myWork';
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
