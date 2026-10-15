import type { Entry } from '@/engine/types';
import { makeEntry } from './factories';

/**
 * A vault whose interesting values are all COMPUTED (M60.1): created and
 * edited time, count/sum/show rollups and a derived relation, beside the
 * stored relation they derive from.
 *
 * Epic "Big" has ten tasks and Epic "Small" nine, so a count rollup that sorts
 * as text puts 10 before 9. Every instant sits at T12:00:00Z and every filter
 * bound a test uses is at least a day away, so the fixtures read the same
 * whether a date is taken in UTC or in the machine's zone.
 */

const props = (p: Record<string, unknown>) => p as unknown as Entry['properties'];

const reverse = { type: 'Task', field: 'epic' };

export const epicType = makeEntry({
  path: 'types/epic.md',
  title: 'Epic',
  type: 'Type',
  properties: props({
    fields: {
      tasks: { kind: 'relation', from: reverse },
      task_count: { kind: 'rollup', from: reverse, calculate: 'count' },
      points: { kind: 'rollup', from: reverse, property: 'estimate', calculate: 'sum' },
      prose_sum: { kind: 'rollup', from: reverse, property: 'note', calculate: 'sum' },
      notes: { kind: 'rollup', from: reverse, property: 'note', calculate: 'show' },
      created: { kind: 'created_time' },
      edited: { kind: 'last_edited_time' },
    },
  }),
});

export const taskType = makeEntry({
  path: 'types/task.md',
  title: 'Task',
  type: 'Type',
  properties: props({
    fields: {
      epic: { kind: 'relation', target: 'Epic', limit: 1 },
      estimate: { kind: 'number' },
      note: { kind: 'text' },
    },
  }),
});

/** Ten tasks, created 2026-08-01, edited 2026-07-25. A frontmatter `title:`
 * that disagrees with the page title, as an Obsidian import carries. */
export const bigEpic = makeEntry({
  path: 'epics/big.md',
  title: 'Big',
  type: 'Epic',
  properties: props({ title: 'Zeta', colour: 'red' }),
  createdAt: '2026-08-01T12:00:00Z',
  modifiedAt: '2026-07-25T12:00:00Z',
});

/** Nine tasks, created 2026-06-01, edited 2026-07-10. */
export const smallEpic = makeEntry({
  path: 'epics/small.md',
  title: 'Small',
  type: 'Epic',
  createdAt: '2026-06-01T12:00:00Z',
  modifiedAt: '2026-07-10T12:00:00Z',
});

/** No tasks: a count of 0 (measured), a sum of nothing (absent). */
export const emptyEpic = makeEntry({
  path: 'epics/empty.md',
  title: 'Empty',
  type: 'Epic',
  createdAt: '2026-05-01T12:00:00Z',
  modifiedAt: '2026-05-01T12:00:00Z',
});

const task = (epic: string, n: number, estimate: number, note: string): Entry =>
  makeEntry({
    path: `tasks/${epic}-${n}.md`,
    title: `${epic} ${n}`,
    type: 'Task',
    properties: props({ estimate, note }),
    // Bracket-stripped, as the scanner hands relationships over (CV-09).
    relationships: { epic: [epic] },
  });

export const bigTasks = Array.from({ length: 10 }, (_, i) => task('big', i + 1, 1, 'alpha'));
export const smallTasks = Array.from({ length: 9 }, (_, i) => task('small', i + 1, 2, 'beta'));

export function computedVault(): Entry[] {
  return [epicType, taskType, bigEpic, smallEpic, emptyEpic, ...bigTasks, ...smallTasks];
}

export const epics = (): Entry[] => [bigEpic, smallEpic, emptyEpic];
