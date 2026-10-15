/**
 * One name ranker for ⌘K and every picker (M59.3).
 *
 * Six matchers used to disagree: some ranked by `quickOpenScore`, some only
 * filtered by it, the editor's menus listed in scan order, and one sorted
 * alphabetically. Every name picker now asks this module, so a page sits in
 * the same place wherever you look for it.
 *
 * The order, best first:
 * 1. the match tier over the whole query (`quickOpenTier`: prefix, word
 *    boundary, substring), and below those a TERMS tier for a query of two or
 *    more words that only matches word by word, in order ("a world" finds
 *    "A Better World"; "ab" still does not);
 * 2. within a tier, the person's own recent opens (`engine/openLog.ts`),
 *    weighted by age, so a tier never inverts however often a page was opened;
 * 3. then the most recently opened, then the shorter matched text, then the
 *    order the caller gave.
 *
 * A query with no letter or digit in it matches nothing. ⌘K changes that way:
 * a lone `-` used to list every hyphenated name, and now offers only the Ask
 * row.
 *
 * The TERMS tier uses uFuzzy (`@leeoniya/ufuzzy`, MIT, pinned; the notice is
 * in THIRD_PARTY_NOTICES.md) with its README's unicode options, so a
 * non-Latin query of two words matches too. `intraMode` 0 with no
 * insertions: each word matches as an in-order substring, never with typos.
 */
import uFuzzy from '@leeoniya/ufuzzy';
import { openWeight, type OpenLog } from '@/engine/openLog';
import { quickOpenTier } from '@/lib/quickOpenScore';

const uf = new uFuzzy({
  unicode: true,
  interSplit: "[^\\p{L}\\d']+",
  intraSplit: '\\p{Ll}\\p{Lu}',
  intraBound: '\\p{L}\\d|\\d\\p{L}|\\p{Ll}\\p{Lu}',
  intraChars: "[\\p{L}\\d']",
  intraContr: "'\\p{L}{1,2}\\b",
  intraMode: 0,
});

/** Below every whole-query tier (substring is 1), above no match. */
export const TERMS_TIER = 0.5;

const WORD = /[\p{L}\p{N}]/u;

/** What the open log knows about a path, as the ranker reads it. */
export interface Recency {
  /** The decayed weight of the path's opens; 0 when never opened. */
  weight(path: string): number;
  /** The path's index in the log, most recent 0; Infinity when absent. */
  order(path: string): number;
}

export const NO_RECENCY: Recency = { weight: () => 0, order: () => Infinity };

/** Read one vault's log at `now`. */
export function recencyOf(log: OpenLog | undefined, now: number): Recency {
  if (log === undefined || log.length === 0) return NO_RECENCY;
  const known = new Map<string, { weight: number; order: number }>();
  log.forEach((record, order) => {
    if (!known.has(record.path)) known.set(record.path, { weight: openWeight(record, now), order });
  });
  return {
    weight: (path) => known.get(path)?.weight ?? 0,
    order: (path) => known.get(path)?.order ?? Infinity,
  };
}

export interface RankInput<T> {
  query: string;
  items: readonly T[];
  /** The names an item answers to; empty and missing ones are skipped. */
  texts: (item: T) => readonly (string | null | undefined)[];
  /** The page path whose opens rank the item; none means never opened. */
  path?: (item: T) => string | null | undefined;
  recency?: Recency;
  /** How many to return; every match when omitted. */
  limit?: number;
}

export interface Ranked<T> {
  /** Best first, at most `limit`. */
  items: T[];
  /** Every item that matched, shown or not. */
  total: number;
}

interface Hit {
  index: number;
  tier: number;
  weight: number;
  order: number;
  len: number;
}

function compareHits(a: Hit, b: Hit): number {
  if (a.tier !== b.tier) return b.tier - a.tier;
  if (a.weight !== b.weight) return b.weight - a.weight;
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  if (a.len !== b.len) return a.len - b.len;
  return a.index - b.index;
}

/** The best `k` hits, best first, without sorting every hit. */
function topK(hits: readonly Hit[], k: number): Hit[] {
  if (k >= hits.length) return [...hits].sort(compareHits);
  if (k <= 0) return [];
  const buffer: Hit[] = [];
  for (const hit of hits) {
    if (buffer.length === k && compareHits(hit, buffer[k - 1]) >= 0) continue;
    let lo = 0;
    let hi = buffer.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareHits(buffer[mid], hit) <= 0) lo = mid + 1;
      else hi = mid;
    }
    buffer.splice(lo, 0, hit);
    if (buffer.length > k) buffer.pop();
  }
  return buffer;
}

const cleanTexts = (texts: readonly (string | null | undefined)[]): string[] =>
  texts.filter((t): t is string => typeof t === 'string' && t.trim() !== '');

/** True when the query splits into two or more words. */
const manyTerms = (q: string): boolean => uf.split(q).length >= 2;

/** Indices of `haystack` that hold every word of `q`, in order. */
function termMatches(haystack: string[], q: string): number[] {
  if (haystack.length === 0) return [];
  return uf.filter(haystack, q) ?? [];
}

export function rankNames<T>(input: RankInput<T>): Ranked<T> {
  const { items, texts } = input;
  const limit = input.limit ?? Infinity;
  const recency = input.recency ?? NO_RECENCY;
  const pathOf = input.path;
  const weigh = (index: number) => {
    const path = pathOf?.(items[index]);
    if (path === undefined || path === null || path === '') return { weight: 0, order: Infinity };
    return { weight: recency.weight(path), order: recency.order(path) };
  };
  const q = input.query.trim();

  if (q === '') {
    // Opened items first, by weight then recency; the rest keep their order.
    const opened: Hit[] = [];
    const rest: T[] = [];
    items.forEach((item, index) => {
      const { weight, order } = weigh(index);
      if (order === Infinity) rest.push(item);
      else opened.push({ index, tier: 0, weight, order, len: 0 });
    });
    const head = opened.sort(compareHits).map((h) => items[h.index]);
    return { items: [...head, ...rest].slice(0, limit), total: items.length };
  }
  if (!WORD.test(q)) return { items: [], total: 0 };

  const hits: Hit[] = [];
  const unmatched: number[] = [];
  items.forEach((item, index) => {
    let tier = 0;
    let len = Infinity;
    for (const text of cleanTexts(texts(item))) {
      const t = quickOpenTier(q, text);
      if (t > tier || (t === tier && t > 0 && text.length < len)) {
        tier = t;
        len = text.length;
      }
    }
    if (tier > 0) hits.push({ index, tier, len, ...weigh(index) });
    else unmatched.push(index);
  });

  if (unmatched.length > 0 && manyTerms(q)) {
    const haystack: string[] = [];
    const owner: number[] = [];
    for (const index of unmatched) {
      for (const text of cleanTexts(texts(items[index]))) {
        haystack.push(text);
        owner.push(index);
      }
    }
    const shortest = new Map<number, number>();
    for (const at of termMatches(haystack, q)) {
      const index = owner[at];
      const len = haystack[at].length;
      if (len < (shortest.get(index) ?? Infinity)) shortest.set(index, len);
    }
    for (const [index, len] of shortest) {
      hits.push({ index, tier: TERMS_TIER, len, ...weigh(index) });
    }
  }

  return { items: topK(hits, limit).map((h) => items[h.index]), total: hits.length };
}

/**
 * `rankNames` per group: groups stay contiguous, in the order they first
 * appear in `items`, and each keeps at most `perGroup` of its own best.
 */
export function rankGroups<T>(
  input: RankInput<T> & { group: (item: T) => string; perGroup: number },
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of input.items) {
    const key = input.group(item);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [item]);
    else list.push(item);
  }
  const out: T[] = [];
  for (const members of groups.values()) {
    out.push(...rankNames({ ...input, items: members, limit: input.perGroup }).items);
  }
  return out;
}

/**
 * Whether `query` names this item at any tier — a filter for option lists
 * that keep their designed order. An empty query keeps everything.
 */
export function nameMatches(query: string, texts: readonly (string | null | undefined)[]): boolean {
  const q = query.trim();
  if (q === '') return true;
  if (!WORD.test(q)) return false;
  const clean = cleanTexts(texts);
  if (clean.some((t) => quickOpenTier(q, t) > 0)) return true;
  return manyTerms(q) && termMatches(clean, q).length > 0;
}
