import { describe, expect, it } from 'vitest';
import { buildRows, entryRows, hasNesting, MAX_ROW_DEPTH, type RenderRow } from './rows';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { GroupSpec } from './types';

/**
 * M10: bands and nesting are ONE chain, and every record view renders from the
 * flattened result. These pin the composition — bands outside, nesting inside
 * each band leaf — plus the two guards a relation walk needs (cycles, depth).
 */

const objectiveType = makeEntry({
  path: 'types/objective.md', filename: 'objective.md', title: 'Objective', type: 'Type',
  properties: {
    statuses: [
      { id: 'on-track', group: 'active', color: '#34B764' },
      { id: 'at-risk', group: 'active', color: '#DE3B4E' },
    ],
    fields: { status: { kind: 'status' } },
  },
});

const keyResultType = makeEntry({
  path: 'types/key-result.md', filename: 'key-result.md', title: 'Key result', type: 'Type',
  properties: { fields: { objective: { kind: 'relation', target: 'Objective' } } },
});

const workItemType = makeEntry({
  path: 'types/work-item.md', filename: 'work-item.md', title: 'Work item', type: 'Type',
  properties: { fields: { key_result: { kind: 'relation', target: 'Key result' } } },
});

// Two objectives, each with key results, each with work items. The links point
// UP (child holds the relation), which is the direction the OKR data uses.
const o1 = makeEntry({
  path: 'records/objectives/o1.md', filename: 'o1.md', title: 'Ship the platform',
  type: 'Objective', properties: { status: 'on-track' },
});
const o2 = makeEntry({
  path: 'records/objectives/o2.md', filename: 'o2.md', title: 'Delight operators',
  type: 'Objective', properties: { status: 'at-risk' },
});

const kr1 = makeEntry({
  path: 'records/key-results/kr1.md', filename: 'kr1.md', title: 'p99 under 200ms',
  type: 'Key result', relationships: { objective: ['o1'] },
});
const kr2 = makeEntry({
  path: 'records/key-results/kr2.md', filename: 'kr2.md', title: 'NPS above 40',
  type: 'Key result', relationships: { objective: ['o2'] },
});

const w1 = makeEntry({
  path: 'items/w1.md', filename: 'w1.md', title: 'Add the cache',
  type: 'Work item', relationships: { key_result: ['kr1'] },
});

const ALL = [objectiveType, keyResultType, workItemType, o1, o2, kr1, kr2, w1];
const schema = buildSchema(ALL);
const objectives = [o1, o2];

const DESCEND_KR: GroupSpec = {
  field: 'objective',
  descend: { direction: 'reverse', type: 'Key result', field: 'objective' },
};
const DESCEND_WORK: GroupSpec = {
  field: 'key_result',
  descend: { direction: 'reverse', type: 'Work item', field: 'key_result' },
};

/** Compact render-order shorthand: `#band`, `depth:title`, `+add`. */
const shape = (rows: RenderRow[]) =>
  rows.map((r) => {
    if (r.kind === 'band') return `#${r.node.label}`;
    if (r.kind === 'add') return `+${r.band?.key ?? ''}`;
    return `${r.depth}:${r.entry.title}`;
  });

describe('buildRows — a chain with no levels', () => {
  it('emits one flat run of rows at depth 0', () => {
    const rows = buildRows({ entries: objectives, group: [], schema, allEntries: ALL });
    expect(shape(rows)).toEqual(['0:Ship the platform', '0:Delight operators']);
    expect(rows.every((r) => r.kind === 'row' && r.childCount === 0)).toBe(true);
  });
});

describe('buildRows — nesting only', () => {
  it('descends each level with its OWN relation, so levels can differ in type', () => {
    const rows = buildRows({
      entries: objectives,
      group: [DESCEND_KR, DESCEND_WORK],
      schema,
      allEntries: ALL,
    });
    expect(shape(rows)).toEqual([
      '0:Ship the platform',
      '1:p99 under 200ms',
      '2:Add the cache',
      '0:Delight operators',
      '1:NPS above 40',
    ]);
  });

  it('reports childCount so a collapsed parent still says how much is inside', () => {
    const rows = entryRows(
      buildRows({ entries: objectives, group: [DESCEND_KR], schema, allEntries: ALL }),
    );
    expect(rows.map((r) => [r.entry.title, r.childCount])).toEqual([
      ['Ship the platform', 1],
      ['p99 under 200ms', 0],
      ['Delight operators', 1],
      ['NPS above 40', 0],
    ]);
  });

  it('stops at a collapsed row but still emits the row itself', () => {
    const collapsedKey = `row:/${o1.path}`;
    const rows = buildRows({
      entries: objectives,
      group: [DESCEND_KR],
      schema,
      allEntries: ALL,
      isCollapsed: (key) => key === collapsedKey,
    });
    expect(shape(rows)).toEqual([
      '0:Ship the platform',
      '0:Delight operators',
      '1:NPS above 40',
    ]);
  });

  it('keys the same record differently under two parents', () => {
    // A key result linked to BOTH objectives appears twice; identical keys
    // would collide as React keys and toggle both copies together.
    const shared = makeEntry({
      path: 'records/key-results/shared.md', filename: 'shared.md', title: 'Shared KR',
      type: 'Key result', relationships: { objective: ['o1', 'o2'] },
    });
    const all = [...ALL, shared];
    const rows = entryRows(
      buildRows({
        entries: objectives,
        group: [DESCEND_KR],
        schema: buildSchema(all),
        allEntries: all,
      }),
    ).filter((r) => r.entry.path === shared.path);
    expect(rows).toHaveLength(2);
    expect(rows[0].key).not.toBe(rows[1].key);
  });
});

describe('buildRows — bands only', () => {
  it('emits a band header followed by its rows', () => {
    const rows = buildRows({
      entries: objectives,
      group: [{ field: 'status' }],
      schema,
      allEntries: ALL,
    });
    expect(shape(rows)).toEqual([
      '#On track',
      '0:Ship the platform',
      '#At risk',
      '0:Delight operators',
    ]);
  });

  it('emits a collapsed band header with none of its rows', () => {
    const rows = buildRows({
      entries: objectives,
      group: [{ field: 'status' }],
      schema,
      allEntries: ALL,
      isCollapsed: (key) => key === 'band:on-track',
    });
    expect(shape(rows)).toEqual(['#On track', '#At risk', '0:Delight operators']);
  });
});

describe('buildRows — bands and nesting in one chain', () => {
  // The composition the whole model exists for: a TABLE that bands by a
  // property and nests by a relation, which is what the retired Hierarchy
  // view was the only way to half-express.
  it('bands on the outside, nests inside each band leaf', () => {
    const rows = buildRows({
      entries: objectives,
      group: [{ field: 'status' }, DESCEND_KR, DESCEND_WORK],
      schema,
      allEntries: ALL,
    });
    expect(shape(rows)).toEqual([
      '#On track',
      '0:Ship the platform',
      '1:p99 under 200ms',
      '2:Add the cache',
      '#At risk',
      '0:Delight operators',
      '1:NPS above 40',
    ]);
  });

  it('namespaces band and row keys so one collapse map holds both', () => {
    const rows = buildRows({
      entries: objectives,
      group: [{ field: 'status' }, DESCEND_KR],
      schema,
      allEntries: ALL,
    });
    expect(rows.filter((r) => r.kind === 'band').every((r) => r.key.startsWith('band:'))).toBe(true);
    expect(rows.filter((r) => r.kind === 'row').every((r) => r.key.startsWith('row:'))).toBe(true);
  });
});

describe('buildRows — walk guards', () => {
  it('does not loop on a relation cycle', () => {
    // Two records that each claim the other as a child.
    const cycleType = makeEntry({
      path: 'types/node.md', filename: 'node.md', title: 'Node', type: 'Type',
      properties: { fields: { next: { kind: 'relation', target: 'Node' } } },
    });
    const a = makeEntry({
      path: 'items/a.md', filename: 'a.md', title: 'A', type: 'Node',
      relationships: { next: ['b'] },
    });
    const b = makeEntry({
      path: 'items/b.md', filename: 'b.md', title: 'B', type: 'Node',
      relationships: { next: ['a'] },
    });
    const all = [cycleType, a, b];
    const rows = buildRows({
      entries: [a],
      group: [{ field: 'next', descend: { direction: 'forward', field: 'next' } }],
      schema: buildSchema(all),
      allEntries: all,
    });
    // A → B, then B's child is A again, which is already an ancestor: stop.
    expect(shape(rows)).toEqual(['0:A', '1:B']);
  });

  it('bounds an unbounded self-referential chain at MAX_ROW_DEPTH', () => {
    // A chain long enough to out-run the cycle guard: every level descends the
    // same forward relation on a fresh record, so `seen` never trips.
    const selfType = makeEntry({
      path: 'types/link.md', filename: 'link.md', title: 'Link', type: 'Type',
      properties: { fields: { next: { kind: 'relation', target: 'Link' } } },
    });
    const chainLength = MAX_ROW_DEPTH + 4;
    const links = Array.from({ length: chainLength }, (_, i) =>
      makeEntry({
        path: `items/n${i}.md`, filename: `n${i}.md`, title: `N${i}`, type: 'Link',
        ...(i + 1 < chainLength ? { relationships: { next: [`n${i + 1}`] } } : {}),
      }),
    );
    const all = [selfType, ...links];
    const group: GroupSpec[] = Array.from({ length: chainLength }, () => ({
      field: 'next',
      descend: { direction: 'forward' as const, field: 'next' },
    }));
    const rows = entryRows(
      buildRows({ entries: [links[0]], group, schema: buildSchema(all), allEntries: all }),
    );
    expect(Math.max(...rows.map((r) => r.depth))).toBe(MAX_ROW_DEPTH);
  });
});

describe('buildRows — the create-record row', () => {
  it('is absent unless asked for', () => {
    const rows = buildRows({
      entries: objectives,
      group: [{ field: 'status' }],
      schema,
      allEntries: ALL,
    });
    expect(rows.some((r) => r.kind === 'add')).toBe(false);
  });

  it('lands at the end of each band, carrying that band’s value to inherit', () => {
    const rows = buildRows({
      entries: objectives,
      group: [{ field: 'status' }],
      schema,
      allEntries: ALL,
      addRows: true,
    });
    expect(shape(rows)).toEqual([
      '#On track',
      '0:Ship the platform',
      '+on-track',
      '#At risk',
      '0:Delight operators',
      '+at-risk',
    ]);
  });

  it('is a single bandless row when the chain is flat', () => {
    const rows = buildRows({ entries: objectives, group: [], schema, allEntries: ALL, addRows: true });
    expect(shape(rows)).toEqual(['0:Ship the platform', '0:Delight operators', '+']);
  });

  it('goes on the LEAF band only, not on the interior ones', () => {
    // An interior band's rows live in its children; a create row there would
    // have no run to append to and no single value to inherit.
    const rows = buildRows({
      entries: objectives,
      group: [{ field: 'status' }, { field: 'title' }],
      schema,
      allEntries: ALL,
      addRows: true,
    });
    const addDepths = rows.filter((r) => r.kind === 'add').map((r) => r.depth);
    expect(addDepths.every((d) => d === 2)).toBe(true);
  });

  it('is suppressed inside a collapsed band', () => {
    const rows = buildRows({
      entries: objectives,
      group: [{ field: 'status' }],
      schema,
      allEntries: ALL,
      addRows: true,
      isCollapsed: (key) => key === 'band:on-track',
    });
    expect(shape(rows)).toEqual(['#On track', '#At risk', '0:Delight operators', '+at-risk']);
  });
});

describe('hasNesting', () => {
  it('is true only when a level descends a relation', () => {
    expect(hasNesting([])).toBe(false);
    expect(hasNesting([{ field: 'status' }])).toBe(false);
    expect(hasNesting([{ field: 'status' }, DESCEND_KR])).toBe(true);
  });
});
