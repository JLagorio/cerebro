import { describe, expect, it } from 'vitest';
import { bandLevels, nestLevels } from '@/engine/types';
import { parseViewYaml, serializeView } from '@/engine/views';
import type { GroupSpec } from '@/engine/types';

/**
 * M9.7: group and hierarchy were one concept wearing two hats. These pin the
 * unified chain and the migration off the two shapes it replaces.
 */
const parse = (yaml: string) => parseViewYaml('v', yaml).definition.presentation;

describe('band vs nest levels', () => {
  const chain: GroupSpec[] = [
    { field: 'status' },
    { field: 'objective', descend: { direction: 'reverse', type: 'Key result', field: 'objective' } },
    { field: 'owner' },
  ];

  it('splits a mixed chain by what each level does', () => {
    expect(bandLevels(chain).map((g) => g.field)).toEqual(['status', 'owner']);
    expect(nestLevels(chain)).toEqual([
      { direction: 'reverse', type: 'Key result', field: 'objective' },
    ]);
  });

  it('is empty on the other axis when a chain is all one kind', () => {
    expect(nestLevels([{ field: 'status' }])).toEqual([]);
    expect(bandLevels([chain[1]])).toEqual([]);
  });
});

describe('grouping chain parse', () => {
  it('reads a relation level from `relation:`', () => {
    const p = parse('presentation:\n  group:\n    - relation: { type: Key result, field: objective }\n');
    expect(p.group).toEqual([
      { field: 'objective', descend: { direction: 'reverse', type: 'Key result', field: 'objective' } },
    ]);
  });

  it('reads a relation level from `descend:` too', () => {
    const p = parse('presentation:\n  group:\n    - descend: { direction: forward, field: deliverables }\n');
    expect(nestLevels(p.group)).toEqual([{ direction: 'forward', field: 'deliverables' }]);
  });

  it('mixes bands and nesting in one chain, in the author’s order', () => {
    const p = parse(
      [
        'presentation:',
        '  group:',
        '    - field: status',
        '    - relation: { type: Key result, field: objective }',
      ].join('\n'),
    );
    expect(p.group.map((g) => g.descend === undefined)).toEqual([true, false]);
  });

  // The whole point of the migration: a view written against the old split
  // model opens as one chain.
  it('migrates M9.1 `hierarchy:` into relation levels', () => {
    const p = parse(
      [
        'presentation:',
        '  groupBy: status',
        '  hierarchy:',
        '    - { type: Key result, field: objective }',
        '    - { direction: forward, field: deliverables }',
      ].join('\n'),
    );
    expect(bandLevels(p.group).map((g) => g.field)).toEqual(['status']);
    expect(nestLevels(p.group)).toEqual([
      { direction: 'reverse', type: 'Key result', field: 'objective' },
      { direction: 'forward', field: 'deliverables' },
    ]);
  });

  it('migrates the v1 `childrenVia:` shorthand', () => {
    const p = parse('presentation:\n  childrenVia: key_results\n');
    expect(nestLevels(p.group)).toEqual([{ direction: 'forward', field: 'key_results' }]);
  });

  // A file that only declared a hierarchy never asked for status bands; the
  // default must not smuggle one in during migration.
  it('does not add default bands to a hierarchy-only file', () => {
    const p = parse('presentation:\n  childrenVia: key_results\n');
    expect(bandLevels(p.group)).toEqual([]);
  });

  it('still applies default bands when nothing at all is stated', () => {
    expect(bandLevels(parse('presentation:\n  type: list\n').group).map((g) => g.field)).toEqual([
      'status',
    ]);
  });

  it('does not duplicate a level already present in both shapes', () => {
    const p = parse(
      [
        'presentation:',
        '  group:',
        '    - relation: { type: Key result, field: objective }',
        '  hierarchy:',
        '    - { type: Key result, field: objective }',
      ].join('\n'),
    );
    expect(nestLevels(p.group)).toHaveLength(1);
  });
});

describe('grouping chain round trip', () => {
  it('survives serialize → parse with both kinds of level', () => {
    const original = parse(
      [
        'presentation:',
        '  group:',
        '    - field: status',
        '    - relation: { type: Key result, field: objective }',
      ].join('\n'),
    );
    const yaml = serializeView({
      name: 'n', icon: null, color: null, order: null,
      source: { type: 'Objective', project: null },
      filters: null,
      presentation: original,
    });
    expect(parseViewYaml('v', yaml).definition.presentation.group).toEqual(original.group);
  });
});
