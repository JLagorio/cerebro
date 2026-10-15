import type { BlockNoteEditor } from '@blocknote/core';

/**
 * Find in a page (M59.6): every place a query appears in the page's own text,
 * as document positions the find bar can draw, step through and replace.
 *
 * This is neither the section-link finder (sectionLinks.ts, M55.5's heading
 * lookup) nor the comment reader text (readerText.ts, M70.1). Find is
 * case-insensitive and literal, never overlaps two hits, reads code blocks
 * as text, and spells a chip by the label the page SHOWS (`Sync error rate`),
 * not by the bytes the file holds (`[[sync-error-rate]]`): a reader searches
 * what they can see.
 *
 * Link and person chips both count. That is wider than Macro, which counts a
 * mention's document title but not a person, and it is on purpose (Q12): a
 * name on screen that find walks past reads as a miss. A chip's hit is one
 * hit over the whole chip, flagged `inLink`, and Replace never rewrites it,
 * because a link's name is its target's title, not text on this page.
 *
 * Each textblock (a paragraph, heading, list item, code block or table cell's
 * paragraph) is scanned alone, so no hit spans two blocks. Inside one, a chip
 * reads as its label between two `FIND_SEPARATOR`s, which no query holds, so
 * no hit crosses a chip's edge either. A hard break and a chip with no label
 * (a date, a citation) read as a lone separator. Positions are ProseMirror's,
 * which count UTF-16 units inside a text node, as a JavaScript string does.
 *
 * No React and no DOM: the doc type comes through a type-only import, as in
 * citationInput.ts.
 */

/** A ProseMirror node, named through the state type BlockNote hands us. */
type PMNode = BlockNoteEditor<any, any, any>['prosemirrorState']['doc'];

/** What a chip reads as. Written as an escape (CV-13): U+FFFC, the object
 * replacement character, which nobody types into a find field. */
export const FIND_SEPARATOR = '￼';

export interface FindHit {
  /** 1-based, in document order. */
  index: number;
  /** Doc positions; a link hit covers its whole chip. */
  from: number;
  to: number;
  /** The block holding the hit: its nearest block container's id. */
  blockId: string | null;
  /** The hit lies in a link or person chip's label. */
  inLink: boolean;
  /** The text matched, as the page has it (case and all). */
  text: string;
}

/** A chip's visible label, or null for a chip find does not read. */
export type LabelOf = (type: string, attrs: Record<string, unknown>) => string | null;

/** One run of a block's scanned text, in string offsets and doc positions. */
interface Piece {
  off: number;
  len: number;
  pos: number;
  /** Set for a chip whose label was read: its node size. */
  atom: number | null;
}

/**
 * `text` with exactly the characters that mean something in a pattern
 * escaped: `^ $ \ . * + ? ( ) [ ] { } |` and `/`. Under the `u` flag an
 * escape of anything else (`-`, `#`, a comma, a space) is a syntax error, so
 * nothing else is touched.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[\^$\\.*+?()[\]{}|/]/g, '\\$&');
}

/** Every hit of `query` in `doc`, in document order. An empty query finds nothing. */
export function findHits(doc: PMNode, query: string, labelOf: LabelOf): FindHit[] {
  if (query === '') return [];
  const pattern = new RegExp(escapeRegExp(query), 'giu');
  const hits: FindHit[] = [];

  const scanBlock = (block: PMNode, start: number, blockId: string | null) => {
    let text = '';
    const pieces: Piece[] = [];
    block.forEach((child, offset) => {
      const pos = start + 1 + offset;
      const off = text.length;
      if (child.isText) {
        text += child.text ?? '';
        pieces.push({ off, len: text.length - off, pos, atom: null });
        return;
      }
      const label = child.type.name === 'hardBreak' ? null : labelOf(child.type.name, child.attrs);
      if (label === null || label === '') {
        text += FIND_SEPARATOR;
        return;
      }
      text += FIND_SEPARATOR;
      pieces.push({ off: text.length, len: label.length, pos, atom: child.nodeSize });
      text += label + FIND_SEPARATOR;
    });
    if (text === '') return;

    const pieceAt = (offset: number, edge: 'start' | 'end'): Piece | undefined =>
      pieces.find((p) =>
        edge === 'start'
          ? offset >= p.off && offset < p.off + p.len
          : offset > p.off && offset <= p.off + p.len,
      );

    let lastAtom: number | null = null;
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      const begin = m.index;
      const end = begin + m[0].length;
      const first = pieceAt(begin, 'start');
      const last = pieceAt(end, 'end');
      if (first === undefined || last === undefined) continue;
      if (first.atom !== null || last.atom !== null) {
        const chip = first.atom !== null ? first : last;
        // Two hits in one label are one hit on the chip.
        if (lastAtom === chip.pos) continue;
        lastAtom = chip.pos;
        hits.push({
          index: hits.length + 1,
          from: chip.pos,
          to: chip.pos + (chip.atom ?? 1),
          blockId,
          inLink: true,
          text: m[0],
        });
        continue;
      }
      hits.push({
        index: hits.length + 1,
        from: first.pos + (begin - first.off),
        to: last.pos + (end - last.off),
        blockId,
        inLink: false,
        text: m[0],
      });
    }
  };

  const visit = (parent: PMNode, base: number, blockId: string | null) => {
    parent.forEach((child, offset) => {
      const pos = base + offset;
      if (child.isTextblock) {
        scanBlock(child, pos, blockId);
        return;
      }
      if (child.isLeaf) return;
      const id =
        child.type.name === 'blockContainer' && typeof child.attrs.id === 'string'
          ? child.attrs.id
          : blockId;
      visit(child, pos + 1, id);
    });
  };
  visit(doc, 0, null);
  return hits;
}

/** The 1-based index `step` away from `current`, wrapping; 0 with no hits. */
export function nextIndex(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return 0;
  if (current < 1 || current > count) return step === 1 ? 1 : count;
  return ((current - 1 + step + count) % count) + 1;
}

/** The first hit starting at or after `pos`, wrapping to the first; 0 with none. */
export function firstAtOrAfter(hits: readonly FindHit[], pos: number): number {
  if (hits.length === 0) return 0;
  return (hits.find((h) => h.from >= pos) ?? hits[0]).index;
}

export interface ReplacementPlan {
  /** The text hits to replace, last first, so each leaves the rest in place. */
  ranges: { from: number; to: number }[];
  /** The hits in a link's name, which Replace leaves as they are. */
  skippedLinks: number;
}

/** What Replace all does to `hits`: every text hit not already `text`. */
export function replacementPlan(hits: readonly FindHit[], text: string): ReplacementPlan {
  const ranges: { from: number; to: number }[] = [];
  let skippedLinks = 0;
  for (const hit of hits) {
    if (hit.inLink) skippedLinks += 1;
    else if (hit.text !== text) ranges.push({ from: hit.from, to: hit.to });
  }
  return { ranges: ranges.reverse(), skippedLinks };
}
