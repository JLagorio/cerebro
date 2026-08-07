import { describe, expect, it } from 'vitest';
import {
  chainTypes,
  columnOwner,
  columnUniverse,
  hiddenColumns,
  insertColumn,
  moveColumn,
  resolveColumns,
  setColumnWidth,
  setColumnWrap,
  toggleColumn,
} from '@/engine/columns';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { ColumnSpec } from '@/engine/types';

// Type docs carry nested YAML under `fields:`; Entry.properties is typed for
// scalars, so the cast mirrors how schema.ts reads them back.
const typeDoc = (name: string, fields: Record<string, unknown>) =>
  makeEntry({
    path: `types/${name}.md`,
    title: name,
    type: 'Type',
    properties: { fields } as unknown as Record<string, never>,
  });

describe('columnUniverse', () => {
  it('returns the declared fields for a typed source', () => {
    const schema = buildSchema([
      typeDoc('Work item', { status: { kind: 'status' }, due: { kind: 'date' } }),
    ]);
    expect(
      columnUniverse({ type: 'Work item', project: null }, [], schema).map((f) => f.name),
    ).toEqual(['status', 'due']);
  });

  // M9.2: a typeless view used to resolve to [], so an "Everything" view had
  // no columns at all.
  it('unions declared fields across the types present in a typeless view', () => {
    const schema = buildSchema([
      typeDoc('Work item', { status: { kind: 'status' } }),
      typeDoc('Risk', { severity: { kind: 'select' } }),
    ]);
    const entries = [
      makeEntry({ path: 'a.md', type: 'Work item' }),
      makeEntry({ path: 'b.md', type: 'Risk' }),
    ];
    expect(
      columnUniverse({ type: null, project: null }, entries, schema).map((f) => f.name),
    ).toEqual(['status', 'severity']);
  });

  it('includes undeclared frontmatter keys the records actually carry', () => {
    const schema = buildSchema([typeDoc('Work item', { status: { kind: 'status' } })]);
    const entries = [
      makeEntry({ path: 'a.md', type: 'Work item', properties: { vendor: 'acme' } }),
    ];
    expect(
      columnUniverse({ type: null, project: null }, entries, schema).map((f) => f.name),
    ).toContain('vendor');
  });

  it('flags a property two types declare with different kinds', () => {
    const schema = buildSchema([
      typeDoc('Work item', { size: { kind: 'number' } }),
      typeDoc('Risk', { size: { kind: 'select' } }),
    ]);
    const entries = [
      makeEntry({ path: 'a.md', type: 'Work item' }),
      makeEntry({ path: 'b.md', type: 'Risk' }),
    ];
    const size = columnUniverse({ type: null, project: null }, entries, schema).find(
      (f) => f.name === 'size',
    );
    expect(size?.heterogeneous).toBe(true);
  });

  it('excludes app-managed `_`-prefixed keys', () => {
    const schema = buildSchema([]);
    const entries = [makeEntry({ path: 'a.md', properties: { _organized: true } })];
    expect(
      columnUniverse({ type: null, project: null }, entries, schema).map((f) => f.name),
    ).not.toContain('_organized');
  });
});

describe('column specs', () => {
  const columns: ColumnSpec[] = [{ field: 'a' }, { field: 'b' }, { field: 'c' }];

  it('hides rather than removes, so re-showing keeps the position', () => {
    const hidden = toggleColumn(columns, 'b');
    expect(hidden).toEqual([{ field: 'a' }, { field: 'b', hidden: true }, { field: 'c' }]);
    expect(toggleColumn(hidden, 'b')).toEqual([
      { field: 'a' },
      { field: 'b', hidden: false },
      { field: 'c' },
    ]);
  });

  it('adds a column that was never in the list', () => {
    expect(toggleColumn(columns, 'd')).toEqual([...columns, { field: 'd' }]);
  });

  it('moves a column and clamps at the ends', () => {
    expect(moveColumn(columns, 'a', 1).map((c) => c.field)).toEqual(['b', 'a', 'c']);
    expect(moveColumn(columns, 'a', -1)).toEqual(columns);
    expect(moveColumn(columns, 'c', 1)).toEqual(columns);
  });

  it('clamps width to the minimum and clears back to auto', () => {
    expect(setColumnWidth(columns, 'a', 10)).toEqual([
      { field: 'a', width: 60 },
      { field: 'b' },
      { field: 'c' },
    ]);
    const sized = setColumnWidth(columns, 'a', 220);
    expect(setColumnWidth(sized, 'a', undefined)).toEqual(columns);
  });

  // `undeclared` is what tells a cell this column belongs to no TYPE, so no
  // row is trespassing on another type's property by editing it (M20.1).
  it('resolves an undeclared column as text rather than dropping it', () => {
    const resolved = resolveColumns([{ field: 'mystery' }], []);
    expect(resolved).toEqual([
      {
        spec: { field: 'mystery' },
        def: { name: 'mystery', kind: 'text', undeclared: true },
        width: 150,
      },
    ]);
  });

  it('never resolves a `title` column — the name cell already shows it', () => {
    expect(resolveColumns([{ field: 'title' }, { field: 'a' }], [])).toHaveLength(1);
  });

  it('lists the fields not currently shown', () => {
    const fields = [
      { name: 'a', kind: 'text' as const },
      { name: 'z', kind: 'text' as const },
    ];
    expect(hiddenColumns(columns, fields).map((f) => f.name)).toEqual(['z']);
  });
});

// M12.4b: the header menu's column operations.
describe('setColumnWrap', () => {
  it('toggles the wrap flag, creating the spec when absent', () => {
    const columns: ColumnSpec[] = [{ field: 'status' }];
    const on = setColumnWrap(columns, 'status');
    expect(on).toEqual([{ field: 'status', wrap: true }]);
    expect(setColumnWrap(on, 'status')).toEqual([{ field: 'status', wrap: false }]);
    expect(setColumnWrap(columns, 'notes')).toEqual([
      { field: 'status' },
      { field: 'notes', wrap: true },
    ]);
  });
});

describe('insertColumn', () => {
  const columns: ColumnSpec[] = [{ field: 'a' }, { field: 'b' }, { field: 'c' }];

  it('inserts a fresh spec beside the anchor', () => {
    expect(insertColumn(columns, 'x', 'b', 'left').map((c) => c.field)).toEqual([
      'a',
      'x',
      'b',
      'c',
    ]);
    expect(insertColumn(columns, 'x', 'b', 'right').map((c) => c.field)).toEqual([
      'a',
      'b',
      'x',
      'c',
    ]);
  });

  it('moves an existing spec (unhiding it) rather than duplicating', () => {
    const withHidden: ColumnSpec[] = [...columns, { field: 'x', hidden: true, width: 90 }];
    const next = insertColumn(withHidden, 'x', 'a', 'right');
    expect(next.map((c) => c.field)).toEqual(['a', 'x', 'b', 'c']);
    const moved = next.find((c) => c.field === 'x')!;
    expect(moved.hidden).toBeUndefined();
    expect(moved.width).toBe(90); // configuration survives the move
  });

  it('appends when the anchor is unknown', () => {
    expect(insertColumn(columns, 'x', 'gone', 'left').map((c) => c.field)).toEqual([
      'a',
      'b',
      'c',
      'x',
    ]);
  });
});

/**
 * A grid's columns come from its CHAIN, not just its source (M20.2).
 *
 * A grouping level that descends a relation nests foreign types under the
 * source, so a Work item sat under Objective's columns carrying Status,
 * Priority, Due and Estimate — none of which the grid could show, while
 * offering it six columns it does not have.
 */
describe('chainTypes', () => {
  const schema = buildSchema([
    typeDoc('Objective', { owner: { kind: 'person' } }),
    typeDoc('Key result', {
      objective: { kind: 'relation', target: 'Objective' },
      deliverables: { kind: 'relation', target: 'Work item' },
    }),
    typeDoc('Work item', { estimate: { kind: 'select' } }),
  ]);
  const source = { type: 'Objective', project: null };

  it('is the source alone when the chain never descends', () => {
    expect(chainTypes(source, [], schema)).toEqual(['Objective']);
    expect(chainTypes(source, [{ field: 'status' }], schema)).toEqual(['Objective']);
  });

  // Each level's type comes from the level BEFORE it: a reverse descent names
  // its own type, a forward one takes the target of the field above.
  it('walks a chain of both descent directions', () => {
    expect(
      chainTypes(
        source,
        [
          {
            field: 'objective',
            descend: { direction: 'reverse', type: 'Key result', field: 'objective' },
          },
          { field: 'deliverables', descend: { direction: 'forward', field: 'deliverables' } },
        ],
        schema,
      ),
    ).toEqual(['Objective', 'Key result', 'Work item']);
  });

  // A relation with no declared target cannot say what it descends into, so
  // the walk stops rather than guessing.
  it('stops where a forward descent names no target', () => {
    expect(
      chainTypes(
        source,
        [{ field: 'mystery', descend: { direction: 'forward', field: 'mystery' } }],
        schema,
      ),
    ).toEqual(['Objective']);
  });

  it('is empty for a typeless source, which has no chain to walk', () => {
    expect(chainTypes({ type: null, project: null }, [], schema)).toEqual([]);
  });
});

describe('columnUniverse over a chain (M20.2)', () => {
  const schema = buildSchema([
    typeDoc('Objective', { owner: { kind: 'person' }, size: { kind: 'number' } }),
    typeDoc('Key result', {
      objective: { kind: 'relation', target: 'Objective' },
      size: { kind: 'select' },
      lead: { kind: 'person' },
    }),
  ]);
  const nest = [
    {
      field: 'objective',
      descend: { direction: 'reverse' as const, type: 'Key result', field: 'objective' },
    },
  ];
  const source = { type: 'Objective', project: null };

  it('adds the descended type’s own properties, after the source’s', () => {
    const names = columnUniverse(source, [], schema, nest).map((f) => f.name);
    expect(names).toEqual(['owner', 'size', 'objective', 'lead']);
  });

  it('leaves the source alone when no level descends', () => {
    expect(columnUniverse(source, [], schema).map((f) => f.name)).toEqual(['owner', 'size']);
  });

  // What makes a per-column schema op answerable: renaming `lead` has to write
  // to Key result, not to the view's source.
  it('records which type declares each column', () => {
    const byName = new Map(columnUniverse(source, [], schema, nest).map((f) => [f.name, f]));
    expect(byName.get('owner')?.owners).toEqual(['Objective']);
    expect(byName.get('lead')?.owners).toEqual(['Key result']);
    expect(byName.get('size')?.owners).toEqual(['Objective', 'Key result']);
  });

  it('flags a name the chain declares with two different kinds', () => {
    const size = columnUniverse(source, [], schema, nest).find((f) => f.name === 'size');
    expect(size?.heterogeneous).toBe(true);
    // The first declaration wins the header; the cells resolve their own.
    expect(size?.kind).toBe('number');
  });
});

describe('columnOwner', () => {
  it('answers the one type that declares a column', () => {
    expect(columnOwner({ name: 'a', kind: 'text', owners: ['Risk'] })).toBe('Risk');
  });

  // Two declarations, two possible writes, and no way to tell which was meant.
  it('answers null when several types declare it', () => {
    expect(columnOwner({ name: 'a', kind: 'text', owners: ['Risk', 'Bet'] })).toBeNull();
  });

  it('answers null for a column no type declares', () => {
    expect(columnOwner({ name: 'a', kind: 'text', undeclared: true })).toBeNull();
  });
});
