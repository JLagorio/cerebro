import type { EditorState } from 'prosemirror-state';
import type { TextSpans } from '@/engine/commentAnchor';
import { chipText } from './markdown';

/**
 * A page's reader text (M70.1): the text comment anchors quote and count in.
 *
 * Every textblock in document order, code blocks left out, joined by `\n`.
 * A text node is its text and a hard break is `\n`. A chip is an atom spelled
 * as the file spells it (`chipText`), so a quote holding one reads
 * `[[kickoff]]`. A block with no inline content (an image, a divider) adds
 * nothing. Offsets are UTF-16 units into `spans.text`.
 */

/** A ProseMirror node, named through the state type BlockNote hands us. */
type PMNode = EditorState['doc'];

/** One run of a block's inline content, in reader offsets and doc positions. */
interface Piece {
  /** Reader offset where it starts, and how many units it spells. */
  off: number;
  len: number;
  /** Doc position where it starts. */
  pos: number;
  /** A chip: one doc position wide, however long it reads. */
  atom: boolean;
}

interface Block {
  start: number;
  end: number;
  /** The block's content, from just inside its open to just before its close. */
  from: number;
  to: number;
  pieces: Piece[];
}

export type OffsetsResult =
  { ok: true; start: number; end: number } | { ok: false; reason: 'outside_text' };

export interface ReaderText {
  spans: TextSpans;
  /** The doc position at reader `offset`. Inside a chip, `start` lands before
   * it and `end` after it, so a range holds the chip whole. */
  posAt: (offset: number, edge: 'start' | 'end') => number;
  /** The reader offsets of the doc range `from..to`, refused when an end
   * lies outside every counted textblock (in code, or between blocks). */
  offsetsOf: (from: number, to: number) => OffsetsResult;
}

export function readerText(doc: PMNode): ReaderText {
  let text = '';
  const blocks: Block[] = [];
  const atoms: [number, number][] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code === true) return false;
    if (blocks.length > 0) text += '\n';
    const block: Block = {
      start: text.length,
      end: text.length,
      from: pos + 1,
      to: pos + 1 + node.content.size,
      pieces: [],
    };
    node.forEach((child, offset) => {
      const at = pos + 1 + offset;
      const off = text.length;
      if (child.isText) {
        text += child.text ?? '';
        block.pieces.push({ off, len: text.length - off, pos: at, atom: false });
      } else if (child.type.name === 'hardBreak') {
        text += '\n';
        block.pieces.push({ off, len: 1, pos: at, atom: false });
      } else {
        const spelled = chipText({ type: child.type.name, props: child.attrs }) ?? '';
        text += spelled;
        block.pieces.push({ off, len: spelled.length, pos: at, atom: true });
        if (spelled !== '') atoms.push([off, text.length]);
      }
    });
    block.end = text.length;
    blocks.push(block);
    return false;
  });

  const posAt = (offset: number, edge: 'start' | 'end'): number => {
    const block = blocks.find((b) => b.start <= offset && offset <= b.end) ?? blocks.at(-1);
    if (block === undefined) return 0;
    for (const p of block.pieces) {
      if (offset < p.off || offset > p.off + p.len) continue;
      if (!p.atom) return p.pos + (offset - p.off);
      if (offset === p.off) return p.pos;
      if (offset === p.off + p.len) return p.pos + 1;
      return edge === 'start' ? p.pos : p.pos + 1;
    }
    return offset <= block.start ? block.from : block.to;
  };

  const offsetAt = (pos: number): number | null => {
    const block = blocks.find((b) => b.from <= pos && pos <= b.to);
    if (block === undefined) return null;
    for (const p of block.pieces) {
      if (p.atom) {
        if (pos === p.pos) return p.off;
        if (pos === p.pos + 1) return p.off + p.len;
      } else if (p.pos <= pos && pos <= p.pos + p.len) {
        return p.off + (pos - p.pos);
      }
    }
    return pos <= block.from ? block.start : block.end;
  };

  const offsetsOf = (from: number, to: number): OffsetsResult => {
    const start = offsetAt(Math.min(from, to));
    const end = offsetAt(Math.max(from, to));
    if (start === null || end === null) return { ok: false, reason: 'outside_text' };
    return { ok: true, start, end };
  };

  return {
    spans: { text, blocks: blocks.map((b) => [b.start, b.end] as const), atoms },
    posAt,
    offsetsOf,
  };
}
