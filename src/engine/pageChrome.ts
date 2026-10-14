/**
 * Page chrome: a page's own icon and cover (M55.11).
 *
 * One resolver for every row, crumb and card, after Macro's EntityIcon: a
 * page's own `icon:` beats its type's glyph, and the fallback a surface draws
 * when nothing is set is drawn only, never written back.
 *
 * `icon:` holds three shapes, because the key already meant something before
 * pages had icons. Type docs and Collection pages store a lucide name there,
 * with `color:` beside it; the page picker writes an emoji or an attachment.
 * So: one emoji is an emoji, a path or a URL is a file, and anything else is
 * a lucide name (a dead one draws Icon's dashed square, M15.7).
 *
 * `cover:` is a file or a colour. The colour stays raw here and is checked
 * only where it reaches CSS, by `resolveOptionColor`, the one colour gate.
 *
 * Pure: no DOM, no store, no writer. The pickers write through
 * `patchFrontmatter` like every other frontmatter edit.
 */

import type { Entry } from './types';

/** The frontmatter keys that are page chrome rather than page data. */
export const PAGE_CHROME_KEYS = ['icon', 'cover'] as const;

export type PageChromeKey = (typeof PAGE_CHROME_KEYS)[number];

export function isPageChromeKey(name: string): name is PageChromeKey {
  return (PAGE_CHROME_KEYS as readonly string[]).includes(name);
}

export type PageIcon =
  | { kind: 'emoji'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'lucide'; name: string; color: string | null };

export type PageCover = { kind: 'file'; path: string } | { kind: 'color'; raw: string };

/** Longest value read as an emoji, in UTF-16 units: a family ZWJ sequence
 *  with skin tones fits, a sentence does not. */
const EMOJI_MAX_UNITS = 32;

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/u;
const KEYCAP = '\u{20E3}';

/** A code point that joins the grapheme before it, for the fallback count:
 *  ZWJ and what follows it, a variation selector, a skin tone, the keycap
 *  mark, an emoji tag. */
function joinsPrevious(cp: string): boolean {
  const c = cp.codePointAt(0) ?? 0;
  return (
    c === 0x200d ||
    c === 0xfe0e ||
    c === 0xfe0f ||
    c === 0x20e3 ||
    (c >= 0x1f3fb && c <= 0x1f3ff) ||
    (c >= 0xe0020 && c <= 0xe007f)
  );
}

/**
 * How many user-perceived characters `text` holds. `Intl.Segmenter` decides
 * when the runtime has one (WebKit from Safari 14.1); without it, a code-point
 * count that folds the emoji joiners and pairs regional indicators stands in,
 * so a missing Segmenter never refuses every emoji.
 */
export function graphemeCount(text: string, segment = true): number {
  const Segmenter = segment ? Intl.Segmenter : undefined;
  if (Segmenter !== undefined) {
    return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length;
  }
  let n = 0;
  let joinNext = false;
  let openFlag = false;
  for (const cp of text) {
    if (joinNext) {
      joinNext = false;
      continue;
    }
    if (cp === '\u{200D}') {
      joinNext = true;
      continue;
    }
    if (joinsPrevious(cp)) continue;
    if (REGIONAL_INDICATOR.test(cp)) {
      if (openFlag) {
        openFlag = false;
        continue;
      }
      openFlag = true;
      n += 1;
      continue;
    }
    openFlag = false;
    n += 1;
  }
  return n;
}

/** One emoji: a single grapheme holding a pictographic code point, a
 *  regional indicator (a flag) or the keycap mark. */
export function isEmojiIcon(value: string): boolean {
  const text = value.trim();
  if (text === '' || text.length > EMOJI_MAX_UNITS) return false;
  if (graphemeCount(text) !== 1) return false;
  return PICTOGRAPHIC.test(text) || REGIONAL_INDICATOR.test(text) || text.includes(KEYCAP);
}

/** A value that names a file: a path, an http(s) URL, or a name with an
 *  extension. A lucide name has none of the three. */
export function isFileValue(value: string): boolean {
  const text = value.trim();
  if (text.includes('/') || text.includes('\\')) return true;
  if (/^https?:\/\//i.test(text)) return true;
  return /\.[A-Za-z0-9]{2,5}$/.test(text);
}

/** What the icon and cover doors accept as an image. */
export const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'avif',
  'bmp',
  'ico',
  'heic',
] as const;

/** Whether a path (or URL) ends in an image extension, query and fragment
 *  dropped, case folded. */
export function isImagePath(path: string): boolean {
  const bare = path.trim().split('#')[0].split('?')[0];
  const last = bare.slice(bare.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return false;
  return (IMAGE_EXTENSIONS as readonly string[]).includes(last.slice(dot + 1).toLowerCase());
}

/** The string a chrome key holds, or null when it is absent, blank or not a
 *  string. */
function chromeValue(entry: Entry, key: PageChromeKey): string | null {
  const raw = entry.properties[key];
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text === '' ? null : text;
}

/** The page's own icon, or null when it has none. */
export function pageIconOf(entry: Entry): PageIcon | null {
  const value = chromeValue(entry, 'icon');
  if (value === null) return null;
  if (isEmojiIcon(value)) return { kind: 'emoji', text: value };
  if (isFileValue(value)) return { kind: 'file', path: value };
  const color = entry.properties.color;
  return { kind: 'lucide', name: value, color: typeof color === 'string' ? color : null };
}

/** The page's own cover, or null when it has none. */
export function pageCoverOf(entry: Entry): PageCover | null {
  const value = chromeValue(entry, 'cover');
  if (value === null) return null;
  if (isFileValue(value)) return { kind: 'file', path: value };
  return { kind: 'color', raw: value };
}
