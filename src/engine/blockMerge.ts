import { lcsPairs } from './hunks';

/**
 * Planning an outside write against an open page, block by block (M55.6).
 *
 * The editor used to remount on every outside write, losing the caret, the
 * scroll, the undo history and every node view, and a page with unsaved
 * typing could only take the write whole or refuse it. These plans say which
 * blocks stay, which change in place and which come and go, so the editor can
 * apply a write as edits and keep everything it did not touch.
 *
 * Pure and generic: a node carries an opaque `ref` (a live or parsed block in
 * the editor, a label in the tests) and the few facts a plan needs. Blocks
 * pair by content, through the LCS `hunks.ts` exports, never by id: a parsed
 * write has no ids to match.
 */

/** One block, as a plan sees it. */
export interface MergeNode<T> {
  /** The block with its children: equal signatures are the same block. */
  sig: string;
  /** The block without its children: its type, props and inline content. */
  own: string;
  type: string;
  /** An empty paragraph with no children. A plan never drops one. */
  blank: boolean;
  /** The block as markdown, children included: what is on disk. */
  text(): string;
  children: MergeNode<T>[];
  ref: T;
}

/**
 * What happens to one block. Every step but `insert` names a block of the
 * side being changed (the live page); `insert` and `own` name blocks of the
 * side being taken in. Steps list a level in document order, so each insert
 * goes after the kept or updated block before it.
 */
export type Step<T> =
  | { kind: 'keep'; ref: T }
  | { kind: 'drop'; ref: T }
  | { kind: 'insert'; ref: T }
  | {
      kind: 'update';
      ref: T;
      /** Take this block's own content (type, props, inline). Absent: keep. */
      own?: T;
      /** The block's children, planned a level down. Absent: keep them. */
      children?: Step<T>[];
    };

/** A place both sides changed differently. Mine stays until someone picks. */
export interface Choice<T> {
  id: string;
  /** Mine's blocks in the contested span; empty when mine deleted it. */
  mine: T[];
  /** Theirs's blocks for the same span; empty when theirs deleted it. */
  theirs: T[];
  /** The block whose children the span sits in; null at the top level. */
  parent: T | null;
  /** Mine's block just before the span, for theirs to follow when mine is
   *  empty; null at the start of its level. */
  after: T | null;
}

export interface MergePlan<T> {
  steps: Step<T>[];
  /** Every choice, at any depth, in document order. */
  choices: Choice<T>[];
}

const nonBlank = <T>(nodes: readonly MergeNode<T>[]): number[] =>
  nodes.flatMap((node, i) => (node.blank ? [] : [i]));

/**
 * Which blocks of `a` and `b` are the same block: an LCS on signature, then,
 * inside each run the first pass left unpaired, an LCS on text, so a block
 * whose markdown did not change pairs even if something the file does not
 * carry did. Blanks pair with nothing. Index pairs, ascending.
 */
export function pairNodes<T>(
  a: readonly MergeNode<T>[],
  b: readonly MergeNode<T>[],
): [number, number][] {
  const ai = nonBlank(a);
  const bi = nonBlank(b);
  const bySig = lcsPairs(ai, bi, (x, y) => a[x].sig === b[y].sig);
  const pairs: [number, number][] = [];
  let pa = 0;
  let pb = 0;
  for (const [x, y] of [...bySig, [ai.length, bi.length] as [number, number]]) {
    if (x > pa && y > pb) {
      const ga = ai.slice(pa, x);
      const gb = bi.slice(pb, y);
      for (const [u, v] of lcsPairs(ga, gb, (p, q) => a[p].text() === b[q].text())) {
        pairs.push([ga[u], gb[v]]);
      }
    }
    if (x < ai.length) pairs.push([ai[x], bi[y]]);
    pa = x + 1;
    pb = y + 1;
  }
  return pairs;
}

const childSigs = <T>(node: MergeNode<T>): string =>
  JSON.stringify(node.children.map((c) => c.sig));

/** `live` takes `next`'s content in place: own content only where it
 *  differs, children only where theirs differ. */
function updateStep<T>(live: MergeNode<T>, next: MergeNode<T>): Step<T> {
  const step: Step<T> = { kind: 'update', ref: live.ref };
  if (live.own !== next.own) step.own = next.ref;
  if (childSigs(live) !== childSigs(next))
    step.children = planReplace(live.children, next.children);
  return step;
}

/** Two-way, with no blanks on either side: what `planReplace` does to each level. */
function replaceCore<T>(live: readonly MergeNode<T>[], next: readonly MergeNode<T>[]): Step<T>[] {
  const steps: Step<T>[] = [];
  let li = 0;
  let nj = 0;
  const pairs = pairNodes(live, next);
  for (const [x, y] of [...pairs, [live.length, next.length] as [number, number]]) {
    // A gap: blocks of one type line up and change in place, so a paragraph
    // the write reworded keeps its id; the rest go and come.
    const gapLive = live.slice(li, x);
    const gapNext = next.slice(nj, y);
    let i = 0;
    let j = 0;
    const aligned = lcsPairs(gapLive, gapNext, (p, q) => p.type === q.type);
    for (const [u, v] of [...aligned, [gapLive.length, gapNext.length] as [number, number]]) {
      for (; i < u; i++) steps.push({ kind: 'drop', ref: gapLive[i].ref });
      for (; j < v; j++) steps.push({ kind: 'insert', ref: gapNext[j].ref });
      if (u < gapLive.length) steps.push(updateStep(gapLive[u], gapNext[v]));
      i = u + 1;
      j = v + 1;
    }
    if (x < live.length) steps.push({ kind: 'keep', ref: live[x].ref });
    li = x + 1;
    nj = y + 1;
  }
  return steps;
}

/**
 * Put `live`'s blanks back into `steps`, which plan only its other blocks.
 * Each blank is kept just before the next non-blank block it preceded, and
 * after any insert that comes first: an insert at a blank's gap lands before
 * it, so the trailing paragraph stays last.
 */
function withBlanks<T>(live: readonly MergeNode<T>[], steps: Step<T>[]): Step<T>[] {
  const order = new Map<T, number>();
  live.forEach((node, i) => order.set(node.ref, i));
  const out: Step<T>[] = [];
  let next = 0;
  const flushTo = (end: number) => {
    for (; next < end; next++)
      if (live[next].blank) out.push({ kind: 'keep', ref: live[next].ref });
  };
  for (const step of steps) {
    const at = step.kind === 'insert' ? undefined : order.get(step.ref);
    if (at !== undefined && at >= next) {
      flushTo(at);
      next = at + 1;
    }
    out.push(step);
  }
  flushTo(live.length);
  return out;
}

/**
 * The two-way plan: make `live` read as `next`. Paired blocks stay. In each
 * unpaired run, blocks of one type line up by an LCS on type and update in
 * place; the rest of `live` drops and the rest of `next` inserts. Blanks in
 * `live` stay, after the inserts of their run.
 */
export function planReplace<T>(
  live: readonly MergeNode<T>[],
  next: readonly MergeNode<T>[],
): Step<T>[] {
  const solid = live.filter((node) => !node.blank);
  return withBlanks(
    live,
    replaceCore(
      solid,
      next.filter((node) => !node.blank),
    ),
  );
}

/** One side's change to base: base range [s, e) became side range [f, t). */
interface Hunk {
  side: 'mine' | 'theirs';
  s: number;
  e: number;
  f: number;
  t: number;
}

/** The runs between `pairs` (base index, side index), as hunks. */
function hunksOf(
  side: Hunk['side'],
  pairs: [number, number][],
  baseLength: number,
  sideLength: number,
): Hunk[] {
  const hunks: Hunk[] = [];
  let pb = 0;
  let ps = 0;
  for (const [b, x] of [...pairs, [baseLength, sideLength] as [number, number]]) {
    if (b > pb || x > ps) hunks.push({ side, s: pb, e: b, f: ps, t: x });
    pb = b + 1;
    ps = x + 1;
  }
  return hunks;
}

/**
 * Whether two hunks, one from each side, touch the same part of base. Ranges
 * overlap when they intersect, and an insertion overlaps a range it falls
 * strictly inside. Two insertions at one gap do not (mine goes first), and
 * neither does an insertion at a range's edge.
 */
function overlaps(a: Hunk, b: Hunk): boolean {
  const aInserts = a.s === a.e;
  const bInserts = b.s === b.e;
  if (aInserts && bInserts) return false;
  if (aInserts) return b.s < a.s && a.s < b.e;
  if (bInserts) return a.s < b.s && b.s < a.e;
  return a.s < b.e && b.s < a.e;
}

/** Hunks that overlap, transitively, as clusters in base order (mine first on a tie). */
function clusters(hunks: Hunk[]): Hunk[][] {
  const root = hunks.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  for (let i = 0; i < hunks.length; i++) {
    for (let j = i + 1; j < hunks.length; j++) {
      if (hunks[i].side !== hunks[j].side && overlaps(hunks[i], hunks[j])) {
        root[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, Hunk[]>();
  hunks.forEach((hunk, i) => {
    const key = find(i);
    groups.set(key, [...(groups.get(key) ?? []), hunk]);
  });
  const start = (group: Hunk[]) => Math.min(...group.map((h) => h.s));
  const end = (group: Hunk[]) => Math.max(...group.map((h) => h.e));
  const mineFirst = (group: Hunk[]) => (group.some((h) => h.side === 'mine') ? 0 : 1);
  return [...groups.values()].sort(
    (a, b) => start(a) - start(b) || end(a) - end(b) || mineFirst(a) - mineFirst(b),
  );
}

/** Steps for mine's blocks in [lo, hi), standing in for keeps there. */
interface Region<T> {
  lo: number;
  hi: number;
  steps: Step<T>[];
}

const texts = <T>(nodes: readonly MergeNode<T>[]): string =>
  JSON.stringify(nodes.map((node) => node.text()));

/** One level of `planMerge`; choices at any depth go to `choices`. */
function mergeLevel<T>(
  baseLevel: readonly MergeNode<T>[],
  mineLevel: readonly MergeNode<T>[],
  theirsLevel: readonly MergeNode<T>[],
  parent: T | null,
  choices: Choice<T>[],
): Step<T>[] {
  const base = baseLevel.filter((node) => !node.blank);
  const mine = mineLevel.filter((node) => !node.blank);
  const theirs = theirsLevel.filter((node) => !node.blank);
  const minePairs = pairNodes(base, mine);
  const theirPairs = pairNodes(base, theirs);
  const partner = (pairs: [number, number][]) => {
    const of = new Array<number>(base.length).fill(-1);
    for (const [b, x] of pairs) of[b] = x;
    return of;
  };
  const mineOf = partner(minePairs);
  const theirsOf = partner(theirPairs);
  const mineHunks = hunksOf('mine', minePairs, base.length, mine.length);
  const theirHunks = hunksOf('theirs', theirPairs, base.length, theirs.length);

  /** Where in mine the content for base[p..] starts: after every mine block
   *  for base before p, and after mine's own insert at p. */
  const mineAt = (p: number): number => {
    let at = 0;
    for (let b = 0; b < p; b++) if (mineOf[b] >= 0) at = Math.max(at, mineOf[b] + 1);
    for (const h of mineHunks) if (h.e <= p) at = Math.max(at, h.t);
    return at;
  };

  /** The span a side's blocks cover for the cluster's base span [s, e). */
  const span = (members: Hunk[], of: number[], s: number, e: number): [number, number] => {
    const ends: number[] = [];
    for (const h of members) ends.push(h.f, h.t);
    for (let b = s; b < e; b++) if (of[b] >= 0) ends.push(of[b], of[b] + 1);
    return [Math.min(...ends), Math.max(...ends)];
  };

  const regions: Region<T>[] = [];
  for (const group of clusters([...mineHunks, ...theirHunks])) {
    const theirsIn = group.filter((h) => h.side === 'theirs');
    const mineIn = group.filter((h) => h.side === 'mine');
    // Only mine changed it: what is on screen already is the merge.
    if (theirsIn.length === 0) continue;
    if (mineIn.length === 0) {
      // Only theirs changed it: mine's blocks there are base's, so take
      // theirs on them the way a clean page would.
      const [h] = theirsIn;
      const lo = mineAt(h.s);
      const hi = lo + (h.e - h.s);
      regions.push({
        lo,
        hi,
        steps: replaceCore(mine.slice(lo, hi), theirs.slice(h.f, h.t)),
      });
      continue;
    }
    const s = Math.min(...group.map((h) => h.s));
    const e = Math.max(...group.map((h) => h.e));
    const [lo, hi] = span(mineIn, mineOf, s, e);
    const [tlo, thi] = span(theirsIn, theirsOf, s, e);
    const ours = mine.slice(lo, hi);
    const theirsSpan = theirs.slice(tlo, thi);
    // Both made the same change.
    if (texts(ours) === texts(theirsSpan)) continue;
    // One block each, one type: merge its own content and its children.
    if (e - s === 1 && ours.length === 1 && theirsSpan.length === 1) {
      const [was, my, their] = [base[s], ours[0], theirsSpan[0]];
      const mineOwn = my.own !== was.own;
      const theirOwn = their.own !== was.own;
      if (
        was.type === my.type &&
        my.type === their.type &&
        (!mineOwn || !theirOwn || my.own === their.own)
      ) {
        const step: Step<T> = { kind: 'update', ref: my.ref };
        if (theirOwn && !mineOwn) step.own = their.ref;
        step.children = mergeLevel(was.children, my.children, their.children, my.ref, choices);
        regions.push({ lo, hi, steps: [step] });
        continue;
      }
    }
    // Anything else is the person's to decide; mine stays meanwhile.
    choices.push({
      id: String(choices.length),
      mine: ours.map((node) => node.ref),
      theirs: theirsSpan.map((node) => node.ref),
      parent,
      after: lo > 0 ? mine[lo - 1].ref : null,
    });
  }

  const steps: Step<T>[] = [];
  let at = 0;
  for (const region of regions) {
    for (; at < region.lo; at++) steps.push({ kind: 'keep', ref: mine[at].ref });
    steps.push(...region.steps);
    at = Math.max(at, region.hi);
  }
  for (; at < mine.length; at++) steps.push({ kind: 'keep', ref: mine[at].ref });
  return withBlanks(mineLevel, steps);
}

/**
 * The three-way plan: merge `theirs` (an outside write) into `mine` (the
 * page on screen), both changed from `base` (what the page last read or
 * saved). Each side's changes are hunks of base; hunks of the two sides that
 * overlap cluster. A cluster only one side changed takes that side. Where
 * both made the same change, mine stays. One block on each side, of one type
 * with base, merges its own content (when at most one side changed it, or
 * both alike) and its children a level down. Anything else is a choice, and
 * mine stays until it is made. Mine's blanks stay put.
 */
export function planMerge<T>(
  base: readonly MergeNode<T>[],
  mine: readonly MergeNode<T>[],
  theirs: readonly MergeNode<T>[],
): MergePlan<T> {
  const choices: Choice<T>[] = [];
  const steps = mergeLevel(base, mine, theirs, null, choices);
  return { steps, choices };
}
