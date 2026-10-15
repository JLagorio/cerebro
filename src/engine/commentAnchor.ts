import { occurrencesOf } from './quote';

/**
 * Comment anchors (M70.1): where on a page a thread points, held as text and
 * never as a position, so the page's bytes carry nothing of it.
 *
 * An anchor is a quote, which copy of it is meant (counting from 1), and the
 * context on each side. Everything here is counted in the page's READER text:
 * what the page reads, every textblock in document order joined by `\n`, code
 * left out, a chip spelled as its markdown (`editor/readerText.ts` builds it).
 * Offsets are UTF-16 units; the limits and the context are code points, so no
 * cut lands inside a surrogate pair.
 *
 * Matching is M55.5's finder (`occurrencesOf`); `validMatches` only filters
 * what it finds.
 */

export interface CommentAnchor {
  /** The quoted text, edges trimmed, at most `ANCHOR_LIMITS.quote` code points. */
  quote: string;
  /** Which valid match of `quote` is meant, counting from 1. */
  occurrence: number;
  /** Up to `ANCHOR_LIMITS.context` code points of reader text before the quote. */
  before: string;
  /** Up to `ANCHOR_LIMITS.context` code points of reader text after it. */
  after: string;
}

/** Limits, in code points. */
export const ANCHOR_LIMITS = { quote: 1000, context: 40 } as const;

/** A page's reader text and its structure, as offsets into `text`. */
export interface TextSpans {
  text: string;
  /** Each textblock's `[start, end)`, in document order (so sorted and
   * disjoint, which the lookups here rely on). */
  blocks: readonly (readonly [number, number])[];
  /** Each chip's `[start, end)`, in order: an atom a quote may hold whole,
   * never split. */
  atoms: readonly (readonly [number, number])[];
}

export type AnchorResult =
  | { ok: true; anchor: CommentAnchor; start: number; end: number }
  | { ok: false; reason: 'empty' | 'spans_blocks' };

export type AnchorResolution =
  | {
      kind: 'attached';
      start: number;
      end: number;
      /** True when the match is not the stored occurrence: text before it
       * gained or lost a copy, and context picked this one. */
      moved: boolean;
    }
  | { kind: 'detached'; reason: 'gone' | 'ambiguous'; count: number };

/** The last range in `ranges` (sorted, disjoint) starting at or before `at`. */
function rangeBefore(
  ranges: readonly (readonly [number, number])[],
  at: number,
): readonly [number, number] | undefined {
  let lo = 0;
  let hi = ranges.length - 1;
  let found: readonly [number, number] | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][0] <= at) {
      found = ranges[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

const inOneBlock = (spans: TextSpans, start: number, end: number): boolean => {
  const block = rangeBefore(spans.blocks, start);
  return block !== undefined && end <= block[1];
};

/** The chip `at` falls strictly inside, if any. */
const atomAround = (spans: TextSpans, at: number): readonly [number, number] | undefined => {
  const atom = rangeBefore(spans.atoms, at);
  return atom !== undefined && atom[0] < at && at < atom[1] ? atom : undefined;
};

/** The finder's matches of `quote` that lie inside one block and neither
 * start nor end inside a chip. */
export function validMatches(spans: TextSpans, quote: string): number[] {
  return occurrencesOf(spans.text, quote).filter((start) => {
    const end = start + quote.length;
    return (
      inOneBlock(spans, start, end) &&
      atomAround(spans, start) === undefined &&
      atomAround(spans, end) === undefined
    );
  });
}

const points = (text: string): string[] => Array.from(text);

/** The last `n` code points of `text`. */
const lastPoints = (text: string, n: number): string => points(text).slice(-n).join('');

/** The first `n` code points of `text`. */
const firstPoints = (text: string, n: number): string => points(text).slice(0, n).join('');

/** The context around `start..end`. Each side reads at most twice the limit in
 * UTF-16 units, which always holds the limit in code points; a pair the window
 * cuts lands past the points taken. A page-long prefix is never copied, so a
 * phrase repeated on every paragraph stays linear. */
const contextAt = (text: string, start: number, end: number) => {
  const reach = ANCHOR_LIMITS.context * 2;
  return {
    before: lastPoints(text.slice(Math.max(0, start - reach), start), ANCHOR_LIMITS.context),
    after: firstPoints(text.slice(end, end + reach), ANCHOR_LIMITS.context),
  };
};

/**
 * The anchor for the reader-text range `start..end`: widened to hold any chip
 * it splits, edges trimmed, refused when nothing is left or it crosses a
 * block, the quote cut to its first
 * `ANCHOR_LIMITS.quote` code points (never inside a chip), its occurrence
 * numbered among the valid matches, and its context taken.
 */
export function anchorAt(spans: TextSpans, start: number, end: number): AnchorResult {
  const { text } = spans;
  let from = Math.max(0, Math.min(start, end));
  let to = Math.min(text.length, Math.max(start, end));
  // A range that splits a chip takes the whole chip.
  from = atomAround(spans, from)?.[0] ?? from;
  to = atomAround(spans, to)?.[1] ?? to;
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  if (from === to) return { ok: false, reason: 'empty' };
  if (!inOneBlock(spans, from, to)) return { ok: false, reason: 'spans_blocks' };
  const cut = from + firstPoints(text.slice(from, to), ANCHOR_LIMITS.quote).length;
  if (cut < to) {
    to = cut;
    to = atomAround(spans, to)?.[0] ?? to;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (from === to) return { ok: false, reason: 'empty' };
  }
  const quote = text.slice(from, to);
  const occurrence = validMatches(spans, quote).filter((m) => m < from).length + 1;
  return {
    ok: true,
    anchor: { quote, occurrence, ...contextAt(text, from, to) },
    start: from,
    end: to,
  };
}

/** Code points that `text` just before `at` shares with the end of `before`,
 * read in place: no copy of the page per candidate. */
function sharedBefore(text: string, at: number, before: string): number {
  let i = at;
  let j = before.length;
  let n = 0;
  while (i > 0 && j > 0) {
    const x = text.codePointAt(i - 2 >= 0 && isLow(text, i - 1) ? i - 2 : i - 1) ?? 0;
    const y = before.codePointAt(j - 2 >= 0 && isLow(before, j - 1) ? j - 2 : j - 1) ?? 0;
    if (x !== y) break;
    const size = x > 0xffff ? 2 : 1;
    i -= size;
    j -= size;
    n++;
  }
  return n;
}

/** Code points that `text` from `at` on shares with the start of `after`. */
function sharedAfter(text: string, at: number, after: string): number {
  let i = at;
  let j = 0;
  let n = 0;
  while (i < text.length && j < after.length) {
    const x = text.codePointAt(i) ?? 0;
    if (x !== after.codePointAt(j)) break;
    const size = x > 0xffff ? 2 : 1;
    i += size;
    j += size;
    n++;
  }
  return n;
}

/** Whether the unit at `i` is the low half of a surrogate pair. */
const isLow = (text: string, i: number): boolean => {
  const unit = text.charCodeAt(i);
  return unit >= 0xdc00 && unit <= 0xdfff;
};

/**
 * Where `anchor` sits in `spans` now. The rule, in order:
 * 1. no valid match: detached, gone;
 * 2. the stored occurrence, if its context is identical;
 * 3. if the best context score is under half the stored context, detached,
 *    gone (the score is the common suffix with `before` plus the common prefix
 *    with `after`, against the code points of `before` and `after`): a copy
 *    elsewhere on the page that shares a space or two is not the quote;
 * 4. the best score, if exactly one match holds it;
 * 5. the stored occurrence, if it is among the best;
 * 6. otherwise detached, ambiguous, with how many share the best score.
 * The same spans and anchor always give the same answer.
 *
 * A limit context cannot see past: when the quoted block is deleted and the
 * block just before it ends in another copy, that copy inherits the deleted
 * quote's context after, and it attaches (moved) if that side is at least
 * half the stored context.
 */
export function resolveAnchor(spans: TextSpans, anchor: CommentAnchor): AnchorResolution {
  const { text } = spans;
  const found = anchor.quote === '' ? [] : validMatches(spans, anchor.quote);
  if (found.length === 0) return { kind: 'detached', reason: 'gone', count: 0 };
  const len = anchor.quote.length;
  const stored = anchor.occurrence - 1;
  const attach = (i: number): AnchorResolution => ({
    kind: 'attached',
    start: found[i],
    end: found[i] + len,
    moved: i !== stored,
  });
  if (stored >= 0 && stored < found.length) {
    const own = contextAt(text, found[stored], found[stored] + len);
    if (own.before === anchor.before && own.after === anchor.after) return attach(stored);
  }
  // The score of a candidate: the common suffix of its context before with
  // `before`, plus the common prefix of its context after with `after`, in
  // code points. A stored side holds at most the limit, so reading the page
  // in place gives what comparing the cut contexts would.
  const scores = found.map(
    (start) =>
      sharedBefore(text, start, anchor.before) + sharedAfter(text, start + len, anchor.after),
  );
  const best = Math.max(...scores);
  const storedPoints = points(anchor.before).length + points(anchor.after).length;
  if (best * 2 < storedPoints) return { kind: 'detached', reason: 'gone', count: 0 };
  const tops = scores.flatMap((score, i) => (score === best ? [i] : []));
  if (tops.length === 1) return attach(tops[0]);
  if (tops.includes(stored)) return attach(stored);
  return { kind: 'detached', reason: 'ambiguous', count: tops.length };
}
