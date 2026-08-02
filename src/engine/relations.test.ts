import { describe, expect, it } from 'vitest';
import { buildRelationIndex, childrenAt, childrenOf, rollupSpec } from '@/engine/relations';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { ChildrenSpec, Entry } from '@/engine/types';

/** Objective ← Key result (the child holds the link), plus one forward link. */
function fixture(): Entry[] {
  return [
    makeEntry({
      path: 'types/objective.md',
      title: 'Objective',
      type: 'Type',
      properties: {
        fields: {
          key_results: { kind: 'relation', target: 'Key result' },
          kr_count: {
            kind: 'rollup',
            from: { type: 'Key result', field: 'objective' },
            calculate: 'count',
          },
          avg_attainment: {
            kind: 'rollup',
            from: { type: 'Key result', field: 'objective' },
            property: 'attainment',
            calculate: 'avg',
          },
        },
      } as never,
    }),
    makeEntry({
      path: 'types/key-result.md',
      title: 'Key result',
      type: 'Type',
      properties: {
        fields: {
          objective: { kind: 'relation', target: 'Objective' },
          attainment: { kind: 'number' },
        },
      } as never,
    }),
    makeEntry({ path: 'objs/alpha.md', filename: 'alpha.md', title: 'Alpha', type: 'Objective' }),
    makeEntry({ path: 'objs/beta.md', filename: 'beta.md', title: 'Beta', type: 'Objective' }),
    makeEntry({
      path: 'krs/kr1.md',
      filename: 'kr1.md',
      title: 'KR One',
      type: 'Key result',
      properties: { attainment: 80 },
      relationships: { objective: ['alpha'] },
    }),
    makeEntry({
      path: 'krs/kr2.md',
      filename: 'kr2.md',
      title: 'KR Two',
      type: 'Key result',
      properties: { attainment: 40 },
      relationships: { objective: ['alpha'] },
    }),
    makeEntry({
      path: 'krs/kr3.md',
      filename: 'kr3.md',
      title: 'KR Three',
      type: 'Key result',
      properties: { attainment: 10 },
      relationships: { objective: ['beta'] },
    }),
  ];
}

const byPath = (entries: Entry[], path: string) => entries.find((e) => e.path === path)!;

describe('bidirectional relations (M3.5)', () => {
  it('resolves children through a link the CHILD holds', () => {
    const entries = fixture();
    const index = buildRelationIndex(entries);
    const kids = childrenOf(
      byPath(entries, 'objs/alpha.md'),
      { direction: 'reverse', type: 'Key result', field: 'objective' },
      entries,
      index,
    );
    expect(kids.map((k) => k.title)).toEqual(['KR One', 'KR Two']);
  });

  it('gives the same answer with and without the index', () => {
    const entries = fixture();
    const spec = { direction: 'reverse', type: 'Key result', field: 'objective' } as const;
    const alpha = byPath(entries, 'objs/alpha.md');
    const withIndex = childrenOf(alpha, spec, entries, buildRelationIndex(entries));
    const withoutIndex = childrenOf(alpha, spec, entries);
    expect(withoutIndex).toEqual(withIndex);
  });

  it('resolves children through a link the PARENT holds', () => {
    const entries = [
      ...fixture(),
      makeEntry({
        path: 'objs/gamma.md',
        filename: 'gamma.md',
        title: 'Gamma',
        type: 'Objective',
        relationships: { key_results: ['kr1', 'kr3'] },
      }),
    ];
    const kids = childrenOf(
      byPath(entries, 'objs/gamma.md'),
      { direction: 'forward', field: 'key_results' },
      entries,
      buildRelationIndex(entries),
    );
    expect(kids.map((k) => k.title)).toEqual(['KR One', 'KR Three']);
  });

  it('keeps reverse children of one parent out of another', () => {
    const entries = fixture();
    const index = buildRelationIndex(entries);
    const kids = childrenOf(
      byPath(entries, 'objs/beta.md'),
      { direction: 'reverse', type: 'Key result', field: 'objective' },
      entries,
      index,
    );
    expect(kids.map((k) => k.title)).toEqual(['KR Three']);
  });

  it('reads the rollup source from either `relation` or `from`', () => {
    expect(rollupSpec({ name: 'r', kind: 'rollup', relation: 'key_results' })).toEqual({
      direction: 'forward',
      field: 'key_results',
    });
    expect(
      rollupSpec({ name: 'r', kind: 'rollup', from: { type: 'Key result', field: 'objective' } }),
    ).toEqual({ direction: 'reverse', type: 'Key result', field: 'objective' });
    expect(rollupSpec({ name: 'r', kind: 'rollup' })).toBeNull();
  });
});

describe('reverse rollups', () => {
  it('aggregates children that point back at the parent — no duplicate link', () => {
    const entries = fixture();
    const schema = buildSchema(entries);
    const alpha = byPath(entries, 'objs/alpha.md');
    // The Objective declares NO key_results values; the KRs point at it.
    expect(alpha.relationships.key_results).toBeUndefined();
    expect(schema.resolveField(alpha, 'kr_count').display).toBe('2');
    expect(schema.resolveField(alpha, 'avg_attainment').display).toBe('60');
  });

  it('rolls up a different parent independently', () => {
    const entries = fixture();
    const schema = buildSchema(entries);
    const beta = byPath(entries, 'objs/beta.md');
    expect(schema.resolveField(beta, 'kr_count').display).toBe('1');
    expect(schema.resolveField(beta, 'avg_attainment').display).toBe('10');
  });
});

// M9.1: the defect this fixes — one spec applied at every depth meant a
// hierarchy could only ever be one relation deep.
describe('childrenAt', () => {
  const objective = makeEntry({ path: 'o.md', type: 'Objective', title: 'Ship it' });
  const kr = makeEntry({
    path: 'kr.md',
    type: 'Key result',
    title: 'KR one',
    relationships: { objective: ['o'], deliverables: ['w'] },
  });
  const work = makeEntry({ path: 'w.md', type: 'Work item', title: 'W' });
  const all = [objective, kr, work];
  const index = buildRelationIndex(all);

  const chain: ChildrenSpec[] = [
    { direction: 'reverse', type: 'Key result', field: 'objective' },
    { direction: 'forward', field: 'deliverables' },
  ];

  it('follows each depth with its OWN spec', () => {
    expect(childrenAt(objective, chain, 0, all, index).map((e) => e.path)).toEqual(['kr.md']);
    // The level that never rendered before: depth 1 uses the forward
    // relation, not a re-run of depth 0's reverse one.
    expect(childrenAt(kr, chain, 1, all, index).map((e) => e.path)).toEqual(['w.md']);
  });

  it('terminates past the end of the chain', () => {
    expect(childrenAt(work, chain, 2, all, index)).toEqual([]);
  });
});
