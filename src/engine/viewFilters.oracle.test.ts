import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARITY,
  FAMILY_TARGETS,
  KIND_CASES,
  OP_RULES,
  inZone,
  oracleGroup,
  oracleIds,
  targetsFor,
  valuesInZone,
  type KindCase,
  type OracleGroup,
  type OracleTarget,
} from '@/test/filterOracle';
import { makeEntry } from './testHelpers';
import { buildSchema } from './schema';
import { parseDateProperty } from './dates';
import { resolveRelative } from './relativeDates';
import { evaluateFilters, filterOpsFor } from './viewFilters';
import {
  FIELD_KINDS,
  FILTER_FAMILIES,
  FILTER_OPS,
  type Entry,
  type FieldKind,
  type FilterGroup,
} from './types';

const clock = { today: '2026-07-28', weekStart: 0 as const };
const zones = ['UTC', 'America/Los_Angeles'];
function withZone<T>(zone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
function fixture(kind: FieldKind, variant: KindCase) {
  const field: Record<string, unknown> = { kind };
  if (kind === 'select') field.options = ['high', 'low', '5'];
  if (kind === 'rollup')
    Object.assign(field, { relation: 'children', property: 'input', calculate: variant.compute });
  if (kind === 'formula') field.formula = variant.compute;
  const type = makeEntry({
    path: 'types/oracle.md',
    type: 'Type',
    title: 'Oracle',
    properties: {
      fields: { f: field, n: 'number', d: 'date', children: { kind: 'relation', target: 'Child' } },
      statuses: [
        'todo',
        'doing',
        { id: 'done', group: 'done' },
        { id: 'cancelled', group: 'closed' },
      ],
    },
  });
  const childType = makeEntry({
    path: 'types/child.md',
    type: 'Type',
    title: 'Child',
    properties: {
      fields: {
        input:
          variant.compute === 'earliest' ? 'date' : variant.compute === 'show' ? 'text' : 'number',
      },
    },
  });
  const children: Entry[] = [];
  const pages = variant.values.map((value) => {
    const path = `oracle/${value.id}.md`;
    const page = makeEntry({
      path,
      filename: `${value.id}.md`,
      type: 'Oracle',
      title: value.id,
      properties: { f: value.raw },
    });
    if ((kind === 'person' || kind === 'relation') && Array.isArray(value.raw)) {
      delete page.properties.f;
      if (value.raw !== undefined) page.relationships.f = value.raw as string[];
    }
    if (kind === 'created_time' || kind === 'last_edited_time') {
      page.properties.f = '1999-01-01';
      if (kind === 'created_time') page.createdAt = value.raw as string;
      else page.modifiedAt = value.raw as string;
    }
    if (kind === 'formula') {
      page.properties = {
        f: 999,
        [variant.compute === 'd + 0' ? 'd' : 'n']: value.input,
      } as Entry['properties'];
    }
    if (kind === 'rollup') {
      page.properties.f = 999;
      const child = `child-${value.id}`;
      page.relationships.children = [child];
      children.push(
        makeEntry({
          path: `children/${child}.md`,
          filename: `${child}.md`,
          title: child,
          type: 'Child',
          properties: { input: value.input },
        }),
      );
    }
    return page;
  });
  return { pages, schema: buildSchema([type, childType, ...pages, ...children]) };
}
function exactIds(
  kind: FieldKind,
  variant: KindCase,
  op: keyof typeof OP_RULES,
  target: OracleTarget,
) {
  const { pages, schema } = fixture(kind, variant);
  return pages
    .filter((page) =>
      evaluateFilters(page, { all: [{ field: 'f', op, value: target.raw }] }, schema, clock),
    )
    .map((page) => page.title);
}

it('registers every operator, kind and family with no missing or stray keys', () => {
  const sameKeys = (label: string, known: readonly string[], actual: object) => {
    expect(
      {
        missing: known.filter((id) => !(id in actual)),
        stray: Object.keys(actual).filter((id) => !known.includes(id)),
      },
      label,
    ).toEqual({ missing: [], stray: [] });
  };
  sameKeys('operators', FILTER_OPS, OP_RULES);
  sameKeys('arities', FILTER_OPS, ARITY);
  sameKeys('kinds', FIELD_KINDS, KIND_CASES);
  sameKeys('families', FILTER_FAMILIES, FAMILY_TARGETS);
});
it('the oracle imports no evaluator code', () => {
  // Keep this audit out of Vite's transform cache: a ?raw import can replace
  // the real oracle's source map when coverage normalizes module URLs.
  const source = readFileSync(join(__dirname, '../test/filterOracle.ts'), 'utf8');
  const imports = source.match(/^import[^;]+;/gm) ?? [];
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatch(/^import type .* from '@\/engine\/types';$/s);
  expect(source).not.toMatch(
    /\b(?:require\(|import\(|evaluateFilters|parseDateProperty|resolveRelative|numericText|buildSchema)\b/,
  );
});

for (const zone of zones) {
  it(`the hand-stated date readings agree with the grammar in ${zone}`, () =>
    withZone(zone, () => {
      for (const kind of FIELD_KINDS)
        for (const variant of KIND_CASES[kind] as KindCase[]) {
          for (const value of variant.values)
            for (const stated of value.items) {
              const item = inZone(stated, zone);
              const actual = parseDateProperty(item.raw);
              expect(actual?.start, `${kind}/${value.id}`).toBe(item.day);
              if (item.day !== undefined)
                expect(`${actual?.start} ${actual?.startTime ?? '00:00'}`).toBe(
                  item.minute ?? `${item.day} 00:00`,
                );
            }
        }
    }));
  it(`the hand-stated relative token ranges agree in ${zone}`, () =>
    withZone(zone, () => {
      for (const family of FILTER_FAMILIES)
        for (const op of FILTER_OPS) {
          for (const target of targetsFor(family, op, zone))
            for (const item of target.items) {
              if (item.range !== undefined)
                expect(resolveRelative(item.raw, clock)).toEqual(item.range);
            }
        }
    }));
  it(`the hand-stated computed readings agree with the schema in ${zone}`, () =>
    withZone(zone, () => {
      for (const kind of ['rollup', 'formula', 'created_time', 'last_edited_time'] as const) {
        for (const variant of KIND_CASES[kind] as KindCase[]) {
          const { pages, schema } = fixture(kind, variant);
          pages.forEach((page, i) =>
            expect(schema.fieldValue(page, 'f'), `${kind}/${variant.name}/${page.title}`).toEqual(
              variant.values[i].raw,
            ),
          );
        }
      }
    }));
}

for (const kind of FIELD_KINDS) {
  for (const variant of KIND_CASES[kind] as KindCase[]) {
    const inZones = variant.family === 'date' || variant.family === 'any' ? zones : ['UTC'];
    for (const zone of inZones)
      describe(`${kind}/${variant.name} in ${zone}`, () => {
        for (const op of filterOpsFor(kind)) {
          const targets = targetsFor(variant.family, op, zone);
          it(`${kind} × ${op} keeps exactly the oracle's pages for every fitting target`, () =>
            withZone(zone, () => {
              expect(targets.length, `missing ${variant.family}/${op} targets`).toBeGreaterThan(0);
              const values = valuesInZone(variant.values, zone);
              for (const target of targets)
                expect(exactIds(kind, variant, op, target), JSON.stringify(target.raw)).toEqual(
                  oracleIds(values, op, target),
                );
            }));
        }
      });
  }
}

it('groups compose: all, any, nested, unfinished and empty', () => {
  const variant: KindCase = KIND_CASES.text[0];
  const { pages, schema } = fixture('text', variant);
  const alpha = { op: 'contains' as const, target: FAMILY_TARGETS.text.one[0] };
  const five = { op: 'equals' as const, target: FAMILY_TARGETS.number.one[0] };
  const unfinished = { op: 'equals' as const, target: FAMILY_TARGETS.text.one.at(-1)! };
  const incompleteRange = {
    op: 'is_between' as const,
    target: {
      raw: [5, ''] as const,
      items: [
        { raw: 5, number: 5 },
        { raw: '', text: '' },
      ],
    },
  };
  const groups: OracleGroup[] = [
    { all: [alpha, five] },
    { any: [alpha, five] },
    {
      all: [{ any: [alpha, five] }, { op: 'is_not_empty', target: { raw: undefined, items: [] } }],
    },
    { all: [alpha, unfinished] },
    { any: [alpha, unfinished] },
    {
      any: [
        unfinished,
        { ...incompleteRange, target: { ...incompleteRange.target, raw: [5, ''] } },
      ],
    },
    { all: [] },
    { any: [] },
  ];
  const actualGroup = (group: OracleGroup): FilterGroup => {
    const nodes = ('all' in group ? group.all : group.any).map((node) =>
      'op' in node ? { field: 'f', op: node.op, value: node.target.raw } : actualGroup(node),
    );
    return 'all' in group ? { all: nodes } : { any: nodes };
  };
  for (const group of groups) {
    const expected = variant.values
      .filter((value) => oracleGroup(value, group))
      .map((value) => value.id);
    expect(
      pages
        .filter((page) => evaluateFilters(page, actualGroup(group), schema, clock))
        .map((page) => page.title),
    ).toEqual(expected);
  }
});
it('virtual fields read entry facts first', () =>
  withZone('UTC', () => {
    const page = makeEntry({
      title: 'Alpha',
      type: 'Oracle',
      createdAt: '2026-07-28T12:00:00Z',
      properties: { title: 'Beta', type: 'Other', createdAt: '1999-01-01' },
    });
    const schema = buildSchema([page]);
    for (const [field, value] of [
      ['title', 'Alpha'],
      ['type', 'Oracle'],
      ['createdAt', '2026-07-28'],
    ]) {
      expect(evaluateFilters(page, { all: [{ field, op: 'equals', value }] }, schema, clock)).toBe(
        true,
      );
    }
  }));
