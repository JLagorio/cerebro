import { describe, expect, it } from 'vitest';
import {
  closeMarker,
  DEFAULT_COLUMN_WIDTH,
  MIN_COLUMN_SHARE,
  resizeColumnPair,
  loosenColumnMarkers,
  openColumnMarker,
  openListMarker,
  parseColumnMarker,
  tightenColumnMarkers,
} from './pageColumns';

describe('reading a marker line', () => {
  it('reads the three shapes and their depth', () => {
    expect(parseColumnMarker(':::columns')).toEqual({ kind: 'open-list', depth: 3 });
    expect(parseColumnMarker('::::column')).toEqual({
      kind: 'open-column',
      depth: 4,
      width: DEFAULT_COLUMN_WIDTH,
    });
    expect(parseColumnMarker('::::')).toEqual({ kind: 'close', depth: 4 });
  });

  it('reads a declared width, whole or fractional', () => {
    expect(parseColumnMarker('::::column width=2')).toMatchObject({ width: 2 });
    expect(parseColumnMarker('::::column width=1.5')).toMatchObject({ width: 1.5 });
  });

  /* Depth is what makes nesting unambiguous: a `::::` closes the four-colon
     container, never the three-colon one that encloses it. */
  it('keeps the depth so an inner close cannot be read as the outer one', () => {
    expect(parseColumnMarker(':::')).toMatchObject({ depth: 3 });
    expect(parseColumnMarker('::::::')).toMatchObject({ depth: 6 });
  });

  /* Vault tolerance. The app does not get to decide a file is wrong: a line it
     cannot read as layout is a line it renders as the text it is. */
  it.each([
    ['::columns', 'two colons is not a container'],
    [':::columns 3', 'trailing junk'],
    [':::column width=', 'a width with no number'],
    [':::columnist', 'a word that merely starts the same way'],
    ['  :::columns', 'indented — that is a code block or a list item'],
    ['text', 'ordinary prose'],
    ['', 'a blank line'],
  ])('does not read %j as a marker (%s)', (line) => {
    expect(parseColumnMarker(line)).toBeNull();
  });

  /* A zero-ratio flex child renders at zero height and width — the writing
     inside it would be gone from the page with no way to get it back. */
  it('refuses a width of zero rather than hiding the column', () => {
    expect(parseColumnMarker('::::column width=0')).toMatchObject({
      width: DEFAULT_COLUMN_WIDTH,
    });
  });
});

describe('writing a marker line', () => {
  it('round-trips through the reader', () => {
    expect(parseColumnMarker(openListMarker(3))).toEqual({ kind: 'open-list', depth: 3 });
    expect(parseColumnMarker(openColumnMarker(4, 2))).toEqual({
      kind: 'open-column',
      depth: 4,
      width: 2,
    });
    expect(parseColumnMarker(closeMarker(5))).toEqual({ kind: 'close', depth: 5 });
  });

  /* Deviations only — the rule every serializer in this codebase follows. A
     file full of `width=1` is a file full of noise. */
  it('writes width= only when it deviates from the default', () => {
    expect(openColumnMarker(4, DEFAULT_COLUMN_WIDTH)).toBe('::::column');
    expect(openColumnMarker(4, 3)).toBe('::::column width=3');
  });
});

const TIGHT = [
  'Before the columns.',
  '',
  ':::columns',
  '::::column',
  '## Left',
  '::::',
  '::::column width=2',
  '## Right',
  '::::',
  ':::',
  '',
  'After the columns.',
].join('\n');

describe('loosening and tightening', () => {
  it('gives every marker its own paragraph on the way in', () => {
    const loose = loosenColumnMarkers(TIGHT).split('\n');
    const at = loose.indexOf(':::columns');
    expect(loose[at - 1]).toBe('');
    expect(loose[at + 1]).toBe('');
  });

  /* The property the whole round trip rests on. If these two are not exact
     inverses, an unedited page grows a blank line on every save — forever. */
  it('tighten undoes loosen exactly', () => {
    expect(tightenColumnMarkers(loosenColumnMarkers(TIGHT))).toBe(TIGHT);
  });

  it('is idempotent in both directions', () => {
    const loose = loosenColumnMarkers(TIGHT);
    expect(loosenColumnMarkers(loose)).toBe(loose);
    expect(tightenColumnMarkers(TIGHT)).toBe(TIGHT);
  });

  /* The failure the inside/outside rule exists to prevent: a paragraph break
     an author typed is not a blank line we added, and eating it reflows their
     writing every time they save. */
  it("keeps the author's own paragraph breaks, inside a column and around it", () => {
    const prose = [
      'A sentence.',
      '',
      ':::columns',
      '::::column',
      'First paragraph.',
      '',
      'Second paragraph.',
      '::::',
      '::::column',
      'Alone.',
      '::::',
      ':::',
      '',
      'Another sentence.',
    ].join('\n');
    expect(tightenColumnMarkers(prose)).toBe(prose);
    expect(tightenColumnMarkers(loosenColumnMarkers(prose))).toBe(prose);
  });

  it('leaves a file with no columns in it completely alone', () => {
    const plain = 'One.\n\nTwo.\n\n```ts\nconst a = 1;\n```\n\nThree.\n';
    expect(loosenColumnMarkers(plain)).toBe(plain);
    expect(tightenColumnMarkers(plain)).toBe(plain);
  });

  /* `:::` inside a fence is somebody's example of this very syntax. Rewriting
     it would corrupt a code sample by trying to lay it out. */
  it('does not touch marker-shaped lines inside a code fence', () => {
    const fenced = [
      'Look:',
      '',
      '```markdown',
      ':::columns',
      '::::column',
      '::::',
      ':::',
      '```',
    ].join('\n');
    expect(loosenColumnMarkers(fenced)).toBe(fenced);
    expect(tightenColumnMarkers(fenced)).toBe(fenced);
  });

  it('survives a nested container at a deeper marker depth', () => {
    const nested = [
      ':::columns',
      '::::column',
      ':::::columns',
      '::::::column',
      'Deep.',
      '::::::',
      ':::::',
      '::::',
      ':::',
    ].join('\n');
    expect(tightenColumnMarkers(loosenColumnMarkers(nested))).toBe(nested);
  });
});

describe('dragging the gutter between two columns', () => {
  /* 600px of pair, split 1:1, so each column is 300px wide. */
  const pair = (delta: number, left = 1, right = 1) => resizeColumnPair(left, right, delta, 600);

  it('does nothing when the gutter does not move', () => {
    expect(pair(0)).toEqual([1, 1]);
  });

  it('moves the split by the distance dragged', () => {
    // 300 + 150 = 450 of 600 = three quarters of a combined ratio of 2.
    expect(pair(150)).toEqual([1.5, 0.5]);
    expect(pair(-150)).toEqual([0.5, 1.5]);
  });

  /* Only the PAIR changes. Conserving their combined ratio is what stops one
     gutter from reflowing the whole row. */
  it('conserves the pair’s combined ratio', () => {
    for (const delta of [-200, -40, 0, 40, 200]) {
      const [l, r] = pair(delta, 2, 3);
      expect(l + r).toBeCloseTo(5, 5);
    }
  });

  /* A ratio that can reach zero is a column you can make disappear, with its
     contents still in the file and nowhere on the page. */
  it('refuses to let either column vanish, however far it is dragged', () => {
    const [farLeft, farRight] = pair(-10_000);
    expect(farLeft / (farLeft + farRight)).toBeCloseTo(MIN_COLUMN_SHARE, 5);
    const [l, r] = pair(10_000);
    expect(r / (l + r)).toBeCloseTo(MIN_COLUMN_SHARE, 5);
  });

  /* The ratio is written into somebody's markdown file. */
  it('rounds to two decimals, so nothing floating-point reaches the file', () => {
    const [l, r] = resizeColumnPair(1, 1, 37, 511);
    expect(String(l)).toMatch(/^\d+(\.\d{1,2})?$/);
    expect(String(r)).toMatch(/^\d+(\.\d{1,2})?$/);
  });

  it('answers unchanged rather than dividing by zero on a pair with no width', () => {
    expect(resizeColumnPair(1, 2, 50, 0)).toEqual([1, 2]);
    expect(resizeColumnPair(0, 0, 50, 600)).toEqual([0, 0]);
  });
});
