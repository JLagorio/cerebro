import { describe, expect, it } from 'vitest';
import type { PartialBlock } from '@blocknote/core';
import { DEFAULT_COLUMN_WIDTH } from '@/engine/pageColumns';
import {
  ancestorTypesOf,
  canInsertColumnsAt,
  COLUMN_COUNTS,
  newColumnList,
} from './columnCommands';

type Loose = { id?: string; type?: string; props?: Record<string, unknown>; children?: Loose[] };
const loose = (block: PartialBlock): Loose => block as unknown as Loose;

describe('building a column list', () => {
  it.each(COLUMN_COUNTS)('makes %i columns', (count) => {
    const list = loose(newColumnList(count));
    expect(list.type).toBe('columnList');
    expect(list.children?.length).toBe(count);
    expect(list.children?.every((c) => c.type === 'column')).toBe(true);
  });

  /* A column with no blocks in it has nowhere to put the cursor: you can see
     it and you cannot type in it. */
  it('gives every column somewhere to type', () => {
    const list = loose(newColumnList(3));
    expect(list.children?.map((c) => c.children?.[0]?.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
  });

  it('starts every column at the default ratio, so nothing is written to disk for it', () => {
    const list = loose(newColumnList(2));
    expect(list.children?.map((c) => c.props?.width)).toEqual([
      DEFAULT_COLUMN_WIDTH,
      DEFAULT_COLUMN_WIDTH,
    ]);
  });

  /* Turn-into: the block you were standing in MOVES into the layout. Left
     above it, the command would be "make an empty layout under my paragraph",
     which is the two-step thing it exists to replace. */
  it('puts the block being turned into a layout in the first column', () => {
    const paragraph = { id: 'p1', type: 'paragraph' } as unknown as PartialBlock;
    const list = loose(newColumnList(3, paragraph));
    expect(list.children?.[0]?.children?.[0]?.id).toBe('p1');
    expect(list.children?.[1]?.children?.[0]?.id).toBeUndefined();
  });

  /* One column is a paragraph with extra steps. */
  it('never makes fewer than two', () => {
    expect(loose(newColumnList(1)).children?.length).toBe(2);
    expect(loose(newColumnList(0)).children?.length).toBe(2);
  });
});

const NEST = [
  { id: 'top', type: 'paragraph' },
  {
    id: 'list',
    type: 'columnList',
    children: [
      { id: 'col', type: 'column', children: [{ id: 'inner', type: 'paragraph' }] },
      { id: 'col2', type: 'column', children: [{ id: 'inner2', type: 'heading' }] },
    ],
  },
] as unknown as PartialBlock[];

describe('knowing where you are', () => {
  it('reports the enclosing types outermost first', () => {
    expect(ancestorTypesOf(NEST, 'inner')).toEqual(['columnList', 'column']);
    expect(ancestorTypesOf(NEST, 'col')).toEqual(['columnList']);
    expect(ancestorTypesOf(NEST, 'top')).toEqual([]);
  });

  it('answers empty for a block that is not there at all', () => {
    expect(ancestorTypesOf(NEST, 'ghost')).toEqual([]);
  });

  /* Spec D6. Enforced by not OFFERING the command: a menu entry that does
     nothing is worse than one that is not there. */
  it('refuses to offer a layout inside a column, and offers one everywhere else', () => {
    expect(canInsertColumnsAt(NEST, 'inner')).toBe(false);
    expect(canInsertColumnsAt(NEST, 'inner2')).toBe(false);
    expect(canInsertColumnsAt(NEST, 'top')).toBe(true);
  });
});
