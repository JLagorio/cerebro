import { describe, expect, it } from 'vitest';
import { pairNodes, planMerge, planReplace, type MergeNode } from './blockMerge';

/**
 * The block plans an outside write is applied by (M55.6). Refs are labels: a
 * prefix names the side (`b:` base, `m:` mine or live, `t:` theirs or next)
 * and the rest names the content, so `m:b` and `t:b` are the same paragraph
 * on two sides.
 */

interface Opts {
  type?: string;
  children?: MergeNode<string>[];
  /** A signature that differs from the content's own, as a prop a file does
   *  not carry would make it. */
  extra?: string;
}

function node(ref: string, opts: Opts = {}): MergeNode<string> {
  const content = ref.slice(2);
  const type = opts.type ?? 'paragraph';
  const children = opts.children ?? [];
  const own = JSON.stringify([type, content, opts.extra ?? '']);
  return {
    ref,
    type,
    own,
    sig: JSON.stringify([own, children.map((c) => c.sig)]),
    blank: false,
    text: () => [`${type}:${content}`, ...children.map((c) => c.text())].join('\n'),
    children,
  };
}

const blank = (ref: string): MergeNode<string> => ({
  ref,
  type: 'paragraph',
  own: '[]',
  sig: '[]',
  blank: true,
  text: () => '',
  children: [],
});

const side = (prefix: string, names: string[]) => names.map((name) => node(`${prefix}:${name}`));

describe('pairNodes', () => {
  it('pairs by signature, then by text inside the runs left over', () => {
    const live = [node('m:a'), node('m:b', { extra: 'colour' }), node('m:c')];
    const next = [node('t:a'), node('t:b'), node('t:c')];
    expect(pairNodes(live, next)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('never pairs a blank', () => {
    expect(pairNodes([blank('m:_')], [blank('t:_')])).toEqual([]);
  });
});

describe('planReplace (two-way)', () => {
  it('keeps everything when nothing changed', () => {
    expect(planReplace(side('m', ['a', 'b']), side('t', ['a', 'b']))).toEqual([
      { kind: 'keep', ref: 'm:a' },
      { kind: 'keep', ref: 'm:b' },
    ]);
  });

  it('updates the one changed block in place, with its own content', () => {
    expect(planReplace(side('m', ['a', 'b', 'c']), side('t', ['a', 'B', 'c']))).toEqual([
      { kind: 'keep', ref: 'm:a' },
      { kind: 'update', ref: 'm:b', own: 't:B' },
      { kind: 'keep', ref: 'm:c' },
    ]);
  });

  it('lines blocks of one type up as updates, and a changed type drops and inserts', () => {
    expect(planReplace(side('m', ['a', 'b']), side('t', ['A', 'B']))).toEqual([
      { kind: 'update', ref: 'm:a', own: 't:A' },
      { kind: 'update', ref: 'm:b', own: 't:B' },
    ]);
    expect(planReplace([node('m:a')], [node('t:a', { type: 'heading' })])).toEqual([
      { kind: 'drop', ref: 'm:a' },
      { kind: 'insert', ref: 't:a' },
    ]);
  });

  it('inserts at the start, in the middle and at the end, and deletes', () => {
    expect(planReplace(side('m', ['a', 'b']), side('t', ['x', 'a', 'y', 'b', 'z']))).toEqual([
      { kind: 'insert', ref: 't:x' },
      { kind: 'keep', ref: 'm:a' },
      { kind: 'insert', ref: 't:y' },
      { kind: 'keep', ref: 'm:b' },
      { kind: 'insert', ref: 't:z' },
    ]);
    expect(planReplace(side('m', ['a', 'b', 'c']), side('t', ['a', 'c']))).toEqual([
      { kind: 'keep', ref: 'm:a' },
      { kind: 'drop', ref: 'm:b' },
      { kind: 'keep', ref: 'm:c' },
    ]);
  });

  it('never drops a blank, and an insert at its gap lands before it', () => {
    expect(planReplace([node('m:a'), blank('m:_')], side('t', ['a', 'x']))).toEqual([
      { kind: 'keep', ref: 'm:a' },
      { kind: 'insert', ref: 't:x' },
      { kind: 'keep', ref: 'm:_' },
    ]);
    expect(planReplace([blank('m:_'), node('m:a')], side('t', ['x', 'a']))).toEqual([
      { kind: 'insert', ref: 't:x' },
      { kind: 'keep', ref: 'm:_' },
      { kind: 'keep', ref: 'm:a' },
    ]);
    expect(planReplace([node('m:a'), blank('m:_')], [])).toEqual([
      { kind: 'drop', ref: 'm:a' },
      { kind: 'keep', ref: 'm:_' },
    ]);
  });

  it('recurses, and updates only the child that changed', () => {
    const live = [node('m:p', { type: 'columnList', children: side('m', ['c1', 'c2']) })];
    const next = [node('t:p', { type: 'columnList', children: side('t', ['c1', 'C2']) })];
    expect(planReplace(live, next)).toEqual([
      {
        kind: 'update',
        ref: 'm:p',
        children: [
          { kind: 'keep', ref: 'm:c1' },
          { kind: 'update', ref: 'm:c2', own: 't:C2' },
        ],
      },
    ]);
  });
});

describe('planMerge (three-way)', () => {
  const merge = (base: string[], mine: string[], theirs: string[]) =>
    planMerge(side('b', base), side('m', mine), side('t', theirs));

  it('keeps a change only mine made', () => {
    expect(merge(['a', 'b'], ['a', 'B'], ['a', 'b'])).toEqual({
      steps: [
        { kind: 'keep', ref: 'm:a' },
        { kind: 'keep', ref: 'm:B' },
      ],
      choices: [],
    });
  });

  it('applies a change only theirs made to mine’s block', () => {
    expect(merge(['a', 'b'], ['a', 'b'], ['a', 'B'])).toEqual({
      steps: [
        { kind: 'keep', ref: 'm:a' },
        { kind: 'update', ref: 'm:b', own: 't:B' },
      ],
      choices: [],
    });
  });

  it('makes no choice when both made the same change', () => {
    expect(merge(['a', 'b'], ['a', 'B'], ['a', 'B']).choices).toEqual([]);
  });

  it('lands both when each side changed the block next to the other’s', () => {
    expect(merge(['a', 'b', 'c'], ['A', 'b', 'c'], ['a', 'B', 'c'])).toEqual({
      steps: [
        { kind: 'keep', ref: 'm:A' },
        { kind: 'update', ref: 'm:b', own: 't:B' },
        { kind: 'keep', ref: 'm:c' },
      ],
      choices: [],
    });
  });

  it('makes one choice when both changed one block differently, and keeps mine', () => {
    expect(merge(['a', 'b'], ['a', 'mine'], ['a', 'theirs'])).toEqual({
      steps: [
        { kind: 'keep', ref: 'm:a' },
        { kind: 'keep', ref: 'm:mine' },
      ],
      choices: [{ id: '0', mine: ['m:mine'], theirs: ['t:theirs'], parent: null, after: 'm:a' }],
    });
  });

  it('keeps both inserts at one gap, mine first', () => {
    expect(merge(['a'], ['a', 'x'], ['a', 'y'])).toEqual({
      steps: [
        { kind: 'keep', ref: 'm:a' },
        { kind: 'keep', ref: 'm:x' },
        { kind: 'insert', ref: 't:y' },
      ],
      choices: [],
    });
  });

  it('makes no choice for an insert at the edge of the other side’s change', () => {
    expect(merge(['a', 'b', 'c'], ['a', 'B', 'c'], ['a', 'y', 'b', 'c'])).toEqual({
      steps: [
        { kind: 'keep', ref: 'm:a' },
        { kind: 'insert', ref: 't:y' },
        { kind: 'keep', ref: 'm:B' },
        { kind: 'keep', ref: 'm:c' },
      ],
      choices: [],
    });
    expect(merge(['a', 'b', 'c'], ['a', 'B', 'c'], ['a', 'b', 'y', 'c']).steps).toEqual([
      { kind: 'keep', ref: 'm:a' },
      { kind: 'keep', ref: 'm:B' },
      { kind: 'insert', ref: 't:y' },
      { kind: 'keep', ref: 'm:c' },
    ]);
  });

  it('makes a delete against a change a choice, either way round', () => {
    expect(merge(['a', 'b'], ['a', 'B'], ['a']).choices).toEqual([
      { id: '0', mine: ['m:B'], theirs: [], parent: null, after: 'm:a' },
    ]);
    expect(merge(['a', 'b'], ['a'], ['a', 'B']).choices).toEqual([
      { id: '0', mine: [], theirs: ['t:B'], parent: null, after: 'm:a' },
    ]);
  });

  it('merges a parent whose own content one side changed and whose child the other did', () => {
    const base = [node('b:p', { type: 'toggle', children: side('b', ['c']) })];
    const mine = [node('m:P', { type: 'toggle', children: side('m', ['c']) })];
    const theirs = [node('t:p', { type: 'toggle', children: side('t', ['C']) })];
    expect(planMerge(base, mine, theirs)).toEqual({
      steps: [
        {
          kind: 'update',
          ref: 'm:P',
          children: [{ kind: 'update', ref: 'm:c', own: 't:C' }],
        },
      ],
      choices: [],
    });
  });

  it('makes a choice when both changed a parent’s own content differently', () => {
    const base = [node('b:p', { type: 'toggle', children: side('b', ['c']) })];
    const mine = [node('m:P', { type: 'toggle', children: side('m', ['c']) })];
    const theirs = [node('t:Q', { type: 'toggle', children: side('t', ['c']) })];
    expect(planMerge(base, mine, theirs).choices).toEqual([
      { id: '0', mine: ['m:P'], theirs: ['t:Q'], parent: null, after: null },
    ]);
  });

  it('gives equal plans for equal inputs, and keeps everything when nothing changed', () => {
    const run = () => merge(['a', 'b', 'c'], ['a', 'mine', 'c', 'x'], ['a', 'theirs', 'C']);
    expect(run()).toEqual(run());
    expect(merge(['a', 'b'], ['a', 'b'], ['a', 'b'])).toEqual({
      steps: [
        { kind: 'keep', ref: 'm:a' },
        { kind: 'keep', ref: 'm:b' },
      ],
      choices: [],
    });
  });

  it('leaves mine’s blanks where they are, after theirs’s insert at their gap', () => {
    expect(
      planMerge(side('b', ['a']), [node('m:a'), blank('m:_')], side('t', ['a', 'y'])).steps,
    ).toEqual([
      { kind: 'keep', ref: 'm:a' },
      { kind: 'insert', ref: 't:y' },
      { kind: 'keep', ref: 'm:_' },
    ]);
  });
});
