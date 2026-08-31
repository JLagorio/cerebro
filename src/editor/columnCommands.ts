/**
 * Making a column layout, and knowing when not to offer one (M48.3).
 *
 * Pure block-tree work, kept out of the editor component so the shapes it
 * builds and the rule it enforces can be tested without mounting anything.
 */

import type { PartialBlock } from '@blocknote/core';
import { DEFAULT_COLUMN_WIDTH } from '@/engine/pageColumns';

/** How many columns the `/` menu offers, matching what Notion offers. */
export const COLUMN_COUNTS = [2, 3, 4, 5] as const;

/**
 * A fresh column list.
 *
 * `first` is the block that becomes the first column's contents — the "turn
 * into" case, where an existing paragraph moves into the layout rather than
 * being left above it. Every other column starts with one empty paragraph:
 * a column with no blocks in it has nowhere to put the cursor, so it would be
 * a column you can see and cannot type in.
 *
 * Every column starts at the default ratio. Nothing is written to disk for
 * that (see `openColumnMarker`), and a layout that arrived with widths already
 * decided would be a layout that decided them for the user.
 */
export function newColumnList(count: number, first?: PartialBlock): PartialBlock {
  const emptyParagraph = (): PartialBlock => ({ type: 'paragraph' }) as unknown as PartialBlock;
  const column = (child: PartialBlock): PartialBlock =>
    ({
      type: 'column',
      props: { width: DEFAULT_COLUMN_WIDTH },
      children: [child],
    }) as unknown as PartialBlock;
  const columns = Array.from({ length: Math.max(2, count) }, (_, i) =>
    column(i === 0 && first !== undefined ? first : emptyParagraph()),
  );
  return { type: 'columnList', children: columns } as unknown as PartialBlock;
}

/**
 * The chain of block types enclosing `id`, outermost first — `[]` when the id
 * is at the top level, and `[]` too when it is not in the document at all. The
 * caller asking "am I inside a column" gets the same answer either way, and it
 * is the safe one.
 */
export function ancestorTypesOf(blocks: PartialBlock[], id: string): string[] {
  return pathTo(blocks, id) ?? [];
}

function pathTo(blocks: PartialBlock[], id: string): string[] | null {
  for (const block of blocks) {
    const b = block as { id?: string; type?: string; children?: PartialBlock[] };
    if (b.id === id) return [];
    const inner = pathTo(b.children ?? [], id);
    if (inner !== null) return [b.type ?? '', ...inner];
  }
  return null;
}

/**
 * May a column layout be inserted at this block?
 *
 * No, if it is already inside one. Notion allows nesting; this does not (spec
 * D6). Nested layout editors are where the affordances multiply past the point
 * anyone can aim at them — every gutter and every gap doubles — and the ceiling
 * is far enough away that almost nobody reaches it. Enforced by not OFFERING
 * the command rather than by refusing it afterwards: a menu entry that does
 * nothing is worse than one that is not there.
 */
export function canInsertColumnsAt(blocks: PartialBlock[], id: string): boolean {
  return !ancestorTypesOf(blocks, id).includes('column');
}
