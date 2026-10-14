import { afterEach, describe, expect, it } from 'vitest';
import {
  graphemeCount,
  isEmojiIcon,
  isFileValue,
  isImagePath,
  isPageChromeKey,
  pageCoverOf,
  pageIconOf,
} from './pageChrome';
import { makeEntry } from './testHelpers';

const ROCKET = '\u{1F680}';
const ASTRONAUT = '\u{1F9D1}\u{200D}\u{1F680}';
const FLAG = '\u{1F1EF}\u{1F1F5}';
const KEYCAP = '#\u{FE0F}\u{20E3}';
const HEART = '\u{2764}\u{FE0F}';
const FAMILY = '\u{1F468}\u{1F3FD}\u{200D}\u{1F469}\u{1F3FD}\u{200D}\u{1F467}\u{200D}\u{1F466}';

const withIcon = (icon: unknown, extra: Record<string, unknown> = {}) =>
  makeEntry({ properties: { icon, ...extra } as never });
const withCover = (cover: unknown) => makeEntry({ properties: { cover } as never });

describe('isEmojiIcon', () => {
  it.each([ROCKET, ASTRONAUT, FLAG, KEYCAP, HEART, FAMILY, ` ${ROCKET} `])('accepts %s', (v) => {
    expect(isEmojiIcon(v)).toBe(true);
  });

  it('refuses two emoji, plain text, digits and blanks', () => {
    expect(isEmojiIcon(ROCKET + ROCKET)).toBe(false);
    expect(isEmojiIcon('rocket')).toBe(false);
    expect(isEmojiIcon('a')).toBe(false);
    expect(isEmojiIcon('1')).toBe(false);
    expect(isEmojiIcon('')).toBe(false);
    expect(isEmojiIcon('   ')).toBe(false);
  });

  describe('without Intl.Segmenter', () => {
    const real = Intl.Segmenter;
    afterEach(() => {
      (Intl as { Segmenter: unknown }).Segmenter = real;
    });

    it('the fallback count still takes one emoji of every shape and refuses two', () => {
      (Intl as { Segmenter: unknown }).Segmenter = undefined;
      for (const v of [ROCKET, ASTRONAUT, FLAG, KEYCAP, HEART, FAMILY]) {
        expect(isEmojiIcon(v)).toBe(true);
      }
      expect(isEmojiIcon(ROCKET + ROCKET)).toBe(false);
      expect(isEmojiIcon(FLAG + FLAG)).toBe(false);
    });
  });

  it('the fallback count agrees with the segmenter', () => {
    for (const v of [ROCKET, ASTRONAUT, FLAG, KEYCAP, HEART, FAMILY, 'ab', ROCKET + HEART]) {
      expect(graphemeCount(v, false)).toBe(graphemeCount(v));
    }
  });
});

describe('isFileValue / isImagePath', () => {
  it('a path, a URL or an extension names a file; a lucide word does not', () => {
    expect(isFileValue('attachments/a.png')).toBe(true);
    expect(isFileValue('a\\b')).toBe(true);
    expect(isFileValue('https://example.com/x')).toBe(true);
    expect(isFileValue('cover.jpeg')).toBe(true);
    expect(isFileValue('rocket')).toBe(false);
    expect(isFileValue('file-text')).toBe(false);
  });

  it('reads the image extension, case folded, query dropped', () => {
    expect(isImagePath('attachments/a.PNG')).toBe(true);
    expect(isImagePath('https://x.test/a.webp?v=2')).toBe(true);
    expect(isImagePath('notes/a.md')).toBe(false);
    expect(isImagePath('.png')).toBe(false);
    expect(isImagePath('png')).toBe(false);
  });
});

describe('isPageChromeKey', () => {
  it('names exactly icon and cover', () => {
    expect(isPageChromeKey('icon')).toBe(true);
    expect(isPageChromeKey('cover')).toBe(true);
    expect(isPageChromeKey('iconic')).toBe(false);
    expect(isPageChromeKey('color')).toBe(false);
  });
});

describe('pageIconOf', () => {
  it('reads one emoji as an emoji', () => {
    expect(pageIconOf(withIcon(ROCKET))).toEqual({ kind: 'emoji', text: ROCKET });
    expect(pageIconOf(withIcon(ASTRONAUT))).toEqual({ kind: 'emoji', text: ASTRONAUT });
  });

  it('gives null for blank, number, array and absent values', () => {
    expect(pageIconOf(withIcon(''))).toBeNull();
    expect(pageIconOf(withIcon('  '))).toBeNull();
    expect(pageIconOf(withIcon(3))).toBeNull();
    expect(pageIconOf(withIcon([ROCKET]))).toBeNull();
    expect(pageIconOf(makeEntry())).toBeNull();
  });

  it('reads an attachment or a URL as a file', () => {
    expect(pageIconOf(withIcon('attachments/i.png'))).toEqual({
      kind: 'file',
      path: 'attachments/i.png',
    });
    expect(pageIconOf(withIcon('https://example.com/i.png'))).toEqual({
      kind: 'file',
      path: 'https://example.com/i.png',
    });
  });

  it('reads two emoji as neither, so a lucide name: a dead one draws the dashed square', () => {
    expect(pageIconOf(withIcon(ROCKET + ROCKET))?.kind).toBe('lucide');
  });

  it('reads a word as a lucide name carrying the color beside it', () => {
    expect(pageIconOf(withIcon('rocket', { color: 'blue' }))).toEqual({
      kind: 'lucide',
      name: 'rocket',
      color: 'blue',
    });
    expect(pageIconOf(withIcon('target', { color: 4 }))).toEqual({
      kind: 'lucide',
      name: 'target',
      color: null,
    });
  });
});

describe('pageCoverOf', () => {
  it('reads a colour raw and a file as a file', () => {
    expect(pageCoverOf(withCover('blue'))).toEqual({ kind: 'color', raw: 'blue' });
    expect(pageCoverOf(withCover('#3D8BE8'))).toEqual({ kind: 'color', raw: '#3D8BE8' });
    expect(pageCoverOf(withCover('attachments/c.png'))).toEqual({
      kind: 'file',
      path: 'attachments/c.png',
    });
  });

  it('gives null for blank and non-string values', () => {
    expect(pageCoverOf(withCover(''))).toBeNull();
    expect(pageCoverOf(withCover(false))).toBeNull();
    expect(pageCoverOf(makeEntry())).toBeNull();
  });
});
