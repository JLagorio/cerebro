import { describe, expect, it } from 'vitest';
import {
  isLetter,
  keyOf,
  keycapParts,
  matchesSpec,
  parseKeys,
  specId,
  type KeyLike,
} from './combo';

const ev = (key: string, init: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe('parseKeys', () => {
  it('parses modifiers, named keys and punctuation', () => {
    expect(parseKeys('mod+shift+k')).toEqual([
      { mod: true, ctrl: false, alt: false, shift: true, key: 'k' },
    ]);
    expect(parseKeys('mod+\\')[0].key).toBe('\\');
    expect(parseKeys('enter')[0]).toMatchObject({ mod: false, key: 'enter' });
    expect(parseKeys('shift+g')[0]).toMatchObject({ shift: true, key: 'g' });
  });

  it('parses a two-step chord into two steps', () => {
    const steps = parseKeys('g h');
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.key)).toEqual(['g', 'h']);
  });

  it('refuses Escape in every form', () => {
    for (const spec of ['escape', 'esc', 'mod+escape', 'Escape', 'g esc']) {
      expect(() => parseKeys(spec)).toThrow(/Escape/);
    }
  });

  it('refuses an empty spec, an empty part and an unknown modifier', () => {
    expect(() => parseKeys('')).toThrow(/empty/);
    expect(() => parseKeys('mod+')).toThrow(/empty part/);
    expect(() => parseKeys('hyper+k')).toThrow(/unknown modifier/);
    expect(() => parseKeys('mod+notakey')).toThrow(/unknown key/);
    expect(() => parseKeys('a b c')).toThrow(/two steps/);
  });

  it('gives one canonical id whatever the modifier order', () => {
    expect(specId('shift+mod+k')).toBe(specId('mod+shift+k'));
  });

  it('calls a spec with no mod, ctrl or alt a letter', () => {
    expect(isLetter('j')).toBe(true);
    expect(isLetter('shift+g')).toBe(true);
    expect(isLetter('enter')).toBe(true);
    expect(isLetter('g h')).toBe(true);
    expect(isLetter('mod+k')).toBe(false);
    expect(isLetter('alt+k')).toBe(false);
  });
});

describe('matching', () => {
  it('on macOS mod is ⌘ alone', () => {
    expect(matchesSpec('mod+k', ev('k', { metaKey: true }), true)).toBe(true);
    expect(matchesSpec('mod+k', ev('k', { ctrlKey: true }), true)).toBe(false);
  });

  it('on macOS ⌃K is its own ctrl+k, never mod+k', () => {
    expect(matchesSpec('ctrl+k', ev('k', { ctrlKey: true }), true)).toBe(true);
    expect(matchesSpec('mod+k', ev('k', { ctrlKey: true, metaKey: true }), true)).toBe(false);
  });

  it('elsewhere mod is Ctrl or ⌘', () => {
    expect(matchesSpec('mod+k', ev('k', { ctrlKey: true }), false)).toBe(true);
    expect(matchesSpec('mod+k', ev('k', { metaKey: true }), false)).toBe(true);
    expect(matchesSpec('mod+k', ev('k'), false)).toBe(false);
  });

  it('matches modifiers exactly', () => {
    expect(matchesSpec('mod+k', ev('K', { metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(matchesSpec('mod+shift+k', ev('K', { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matchesSpec('k', ev('k', { altKey: true }), true)).toBe(false);
  });

  it('reads ⌥⌘F by its code', () => {
    const e = ev('ƒ', { code: 'KeyF', metaKey: true, altKey: true });
    expect(keyOf(e)).toBe('f');
    expect(matchesSpec('mod+alt+f', e, true)).toBe(true);
  });

  it('reads ⇧⌘[ arriving as `{`', () => {
    const real = ev('{', { code: 'BracketLeft', metaKey: true, shiftKey: true });
    expect(matchesSpec('mod+shift+[', real, true)).toBe(true);
    // A synthetic event carries no code.
    expect(matchesSpec('mod+shift+[', ev('{', { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matchesSpec('mod+shift+[', ev('[', { metaKey: true, shiftKey: true }), true)).toBe(true);
  });

  it('falls back to the code on a non-Latin layout', () => {
    expect(keyOf(ev('л', { code: 'KeyK' }))).toBe('k');
    expect(matchesSpec('mod+k', ev('л', { code: 'KeyK', metaKey: true }), true)).toBe(true);
  });

  it('keeps the key when the code is empty', () => {
    expect(keyOf(ev('л'))).toBe('л');
    expect(keyOf(ev('Enter'))).toBe('enter');
    expect(keyOf(ev(' '))).toBe('space');
  });

  it('never matches a chord in one keystroke', () => {
    expect(matchesSpec('g h', ev('g'), true)).toBe(false);
  });
});

describe('keycapParts', () => {
  it('draws glyphs on macOS, in Apple order', () => {
    expect(keycapParts('mod+shift+k', true)).toEqual([['⇧', '⌘', 'K']]);
    expect(keycapParts('mod+alt+f', true)).toEqual([['⌥', '⌘', 'F']]);
    expect(keycapParts('enter', true)).toEqual([['↵']]);
  });

  it('draws words elsewhere', () => {
    expect(keycapParts('mod+shift+k', false)).toEqual([['Ctrl', 'Shift', 'K']]);
    expect(keycapParts('enter', false)).toEqual([['Enter']]);
  });

  it('draws a chord as two groups', () => {
    expect(keycapParts('g h', true)).toEqual([['G'], ['H']]);
  });
});
