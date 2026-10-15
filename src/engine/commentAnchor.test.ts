import { describe, expect, it } from 'vitest';
import {
  ANCHOR_LIMITS,
  anchorAt,
  resolveAnchor,
  validMatches,
  type CommentAnchor,
  type TextSpans,
} from './commentAnchor';

/**
 * Comment anchors on reader text (M70.1): a quote, its occurrence and its
 * context, resolved again against the page as it is now.
 */

/** Reader text for `blocks`, each block's text joined by `\n`; `[[…]]` in a
 * block is a chip (an atom), as readerText spells one. */
function spansOf(...blocks: string[]): TextSpans {
  let text = '';
  const ranges: [number, number][] = [];
  const atoms: [number, number][] = [];
  blocks.forEach((block, i) => {
    if (i > 0) text += '\n';
    const start = text.length;
    for (const m of block.matchAll(/\[\[[^\]]*\]\]/g)) {
      atoms.push([start + (m.index ?? 0), start + (m.index ?? 0) + m[0].length]);
    }
    text += block;
    ranges.push([start, text.length]);
  });
  return { text, blocks: ranges, atoms };
}

/** The anchor on the `n`th copy (from 1) of `quote` in `spans`. */
function anchorOn(spans: TextSpans, quote: string, n = 1): CommentAnchor {
  let at = -1;
  for (let k = 0; k < n; k++) at = spans.text.indexOf(quote, at + 1);
  const result = anchorAt(spans, at, at + quote.length);
  if (!result.ok) throw new Error(`no anchor: ${result.reason}`);
  return result.anchor;
}

describe('anchorAt', () => {
  it('trims edge whitespace', () => {
    const spans = spansOf('We ship on Thursdays, after the freeze.');
    const at = spans.text.indexOf(' after');
    const result = anchorAt(spans, at, at + ' after the freeze '.length - 1);
    expect(result).toMatchObject({ ok: true, anchor: { quote: 'after the freeze' } });
    if (result.ok) expect(spans.text.slice(result.start, result.end)).toBe('after the freeze');
  });

  it('refuses an empty range and one that is only whitespace', () => {
    const spans = spansOf('One two.', '', 'Three.');
    expect(anchorAt(spans, 3, 3)).toEqual({ ok: false, reason: 'empty' });
    expect(anchorAt(spans, 3, 4)).toEqual({ ok: false, reason: 'empty' });
    expect(anchorAt(spans, 8, 10)).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses a range across blocks', () => {
    const spans = spansOf('First block.', 'Second block.');
    expect(anchorAt(spans, 6, 19)).toEqual({ ok: false, reason: 'spans_blocks' });
  });

  it('cuts the quote at 1000 code points, an emoji counted once', () => {
    const long = '😀'.repeat(1200);
    const spans = spansOf(long);
    const result = anchorAt(spans, 0, long.length);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.anchor.quote)).toHaveLength(ANCHOR_LIMITS.quote);
    expect(result.anchor.quote).toBe('😀'.repeat(1000));
    expect(result.end).toBe(2000);
    expect(Array.from(result.anchor.after)).toHaveLength(ANCHOR_LIMITS.context);
  });

  it('never cuts inside a chip', () => {
    const block = `${'a'.repeat(995)} [[kickoff]] end`;
    const spans = spansOf(block);
    const result = anchorAt(spans, 0, block.length);
    expect(result).toMatchObject({ ok: true, anchor: { quote: 'a'.repeat(995) } });
  });

  it('takes a chip whole when the range splits it', () => {
    const spans = spansOf('See [[kickoff]] notes.');
    expect(anchorAt(spans, 6, 21)).toMatchObject({
      ok: true,
      anchor: { quote: '[[kickoff]] notes' },
    });
  });

  it('numbers the occurrence and takes 40 code points of context', () => {
    const spans = spansOf('Owner: TBD.', 'Deadline: TBD.');
    const anchor = anchorOn(spans, 'TBD', 2);
    expect(anchor).toEqual({
      quote: 'TBD',
      occurrence: 2,
      before: 'Owner: TBD.\nDeadline: ',
      after: '.',
    });
    const far = spansOf(`${'x'.repeat(60)} TBD ${'y'.repeat(60)}`);
    const wide = anchorOn(far, 'TBD');
    expect(wide.before).toBe(`${'x'.repeat(39)} `);
    expect(wide.after).toBe(` ${'y'.repeat(39)}`);
  });
});

describe('validMatches', () => {
  it('keeps matches inside one block that split no chip', () => {
    const spans = spansOf('ab [[kickoff]] off', 'kick');
    expect(validMatches(spans, 'off')).toEqual([15]);
    expect(validMatches(spans, '[[kickoff]]')).toEqual([3]);
    expect(validMatches(spans, 'off\nkick')).toEqual([]);
  });
});

describe('resolveAnchor', () => {
  it('attaches an exact match where it was', () => {
    const spans = spansOf('We ship on Thursdays, after the freeze.');
    const anchor = anchorOn(spans, 'after the freeze');
    expect(resolveAnchor(spans, anchor)).toEqual({
      kind: 'attached',
      start: 22,
      end: 38,
      moved: false,
    });
  });

  it('attaches occurrence 2 of a repeated phrase', () => {
    const spans = spansOf('Owner: TBD.', 'Deadline: TBD.');
    const anchor = anchorOn(spans, 'TBD', 2);
    expect(resolveAnchor(spans, anchor)).toEqual({
      kind: 'attached',
      start: spans.text.lastIndexOf('TBD'),
      end: spans.text.lastIndexOf('TBD') + 3,
      moved: false,
    });
  });

  it('follows its context when a copy is inserted before it', () => {
    const anchor = anchorOn(spansOf('Owner: TBD.', 'Deadline: TBD.'), 'TBD', 1);
    const now = spansOf('Also TBD.', 'Owner: TBD.', 'Deadline: TBD.');
    const at = now.text.indexOf('Owner: TBD') + 'Owner: '.length;
    expect(resolveAnchor(now, anchor)).toEqual({
      kind: 'attached',
      start: at,
      end: at + 3,
      moved: true,
    });
  });

  it('scores context in code points, emoji included', () => {
    const anchor = anchorOn(spansOf('😀 ship 🚀 now', '🎉 ship 🎈 now'), 'ship', 2);
    const now = spansOf('ship', '😀 ship 🚀 now', '🎉 ship 🎈 now');
    expect(resolveAnchor(now, anchor)).toMatchObject({
      kind: 'attached',
      start: now.text.lastIndexOf('ship'),
      moved: true,
    });
  });

  it('is gone when its quote is deleted', () => {
    const anchor = anchorOn(spansOf('We ship on Thursdays, after the freeze.'), 'after the freeze');
    expect(resolveAnchor(spansOf('We ship on Thursdays.'), anchor)).toEqual({
      kind: 'detached',
      reason: 'gone',
      count: 0,
    });
  });

  it('is gone when the stored copy of three is deleted and the rest share too little', () => {
    const anchor = anchorOn(spansOf('a sign b', 'c sign d', 'e sign f'), 'sign', 3);
    expect(anchor.occurrence).toBe(3);
    expect(resolveAnchor(spansOf('a sign b', 'c sign d'), anchor)).toEqual({
      kind: 'detached',
      reason: 'gone',
      count: 0,
    });
    const middle = anchorOn(spansOf('a sign b', 'c sign d', 'e sign f'), 'sign', 2);
    expect(resolveAnchor(spansOf('a sign b', 'e sign f'), middle)).toMatchObject({
      kind: 'detached',
      reason: 'gone',
    });
  });

  it('is gone when its sentence is deleted and another copy of the quote is left', () => {
    const anchor = anchorOn(
      spansOf('Ana reviews the plan on Monday.', 'Nobody liked the plan at all.'),
      'the plan',
    );
    expect(resolveAnchor(spansOf('Nobody liked the plan at all.'), anchor)).toEqual({
      kind: 'detached',
      reason: 'gone',
      count: 0,
    });
  });

  it('is gone when its line is deleted and an earlier line holds the same word', () => {
    const anchor = anchorOn(spansOf('Owner: TBD.', 'Deadline: TBD.'), 'TBD', 2);
    expect(resolveAnchor(spansOf('Owner: TBD.'), anchor)).toEqual({
      kind: 'detached',
      reason: 'gone',
      count: 0,
    });
  });

  it('a limit: a copy that inherits the deleted quote context after attaches', () => {
    // The block after the deleted line now follows Owner's TBD, so that copy
    // shares the whole context after: 22 of 42 code points, over half.
    const anchor = anchorOn(
      spansOf('Owner: TBD.', 'Deadline: TBD.', 'Notes follow here.'),
      'TBD',
      2,
    );
    const now = spansOf('Owner: TBD.', 'Notes follow here.');
    expect(resolveAnchor(now, anchor)).toEqual({
      kind: 'attached',
      start: now.text.indexOf('TBD'),
      end: now.text.indexOf('TBD') + 3,
      moved: true,
    });
  });

  it('attaches a lone copy whose context changed on one side only', () => {
    const anchor = anchorOn(spansOf('We ship on Thursdays, after the freeze.'), 'after the freeze');
    const now = spansOf('We ship on Thursdays, after the freeze ends.');
    expect(resolveAnchor(now, anchor)).toMatchObject({ kind: 'attached', moved: false });
  });

  // Two copies agreeing equally, each on one side: 6 of 10 code points.
  const halves: CommentAnchor = { quote: 'sign', occurrence: 3, before: 'aaaa ', after: ' bbbb' };
  const split = spansOf('aaaa sign z', 'z sign bbbb');

  it('is ambiguous when two copies tie on enough context and neither is stored', () => {
    expect(resolveAnchor(split, halves)).toEqual({
      kind: 'detached',
      reason: 'ambiguous',
      count: 2,
    });
  });

  it('keeps the stored occurrence when it is among the tied best', () => {
    expect(resolveAnchor(split, { ...halves, occurrence: 2 })).toEqual({
      kind: 'attached',
      start: split.text.lastIndexOf('sign'),
      end: split.text.lastIndexOf('sign') + 4,
      moved: false,
    });
  });

  it('skips a match that ends inside a chip', () => {
    const anchor = anchorOn(spansOf('Meet at kick'), 'kick');
    const now = spansOf('See [[kickoff]].', 'Meet at kick');
    expect(validMatches(now, 'kick')).toEqual([now.text.lastIndexOf('kick')]);
    expect(resolveAnchor(now, anchor)).toMatchObject({
      kind: 'attached',
      start: now.text.lastIndexOf('kick'),
      moved: false,
    });
  });

  it('finds aa in aaa twice, and resolves occurrence 2', () => {
    const spans = spansOf('aaa');
    const result = anchorAt(spans, 1, 3);
    expect(result).toMatchObject({ ok: true, anchor: { quote: 'aa', occurrence: 2 } });
    if (!result.ok) return;
    expect(resolveAnchor(spans, result.anchor)).toEqual({
      kind: 'attached',
      start: 1,
      end: 3,
      moved: false,
    });
  });

  it('breaks ties the same way on every run', () => {
    const first = resolveAnchor(split, halves);
    for (let i = 0; i < 20; i++) expect(resolveAnchor(split, halves)).toEqual(first);
  });

  it('is gone for an empty quote', () => {
    expect(
      resolveAnchor(spansOf('text'), { quote: '', occurrence: 1, before: '', after: '' }),
    ).toEqual({ kind: 'detached', reason: 'gone', count: 0 });
  });
});
