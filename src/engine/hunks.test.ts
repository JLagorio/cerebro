import { describe, expect, it } from 'vitest';
import { applyHunks, describeHunk, isUnchanged, lcsPairs, lcsTable, rewriteHunks } from './hunks';

const accept = (before: string, after: string, ids: number[]) =>
  applyHunks(rewriteHunks(before, after), new Set(ids));

describe('rewriteHunks', () => {
  it('finds nothing to decide when the rewrite changed nothing', () => {
    const rewrite = rewriteHunks('the same text', 'the same text');
    expect(isUnchanged(rewrite)).toBe(true);
    expect(applyHunks(rewrite, new Set())).toBe('the same text');
  });

  it('collapses adjacent changed words into ONE decision', () => {
    // Two consecutive replaced words are one edit to a reader. Offering them
    // separately produces half-accepted sentences that read as neither version.
    const rewrite = rewriteHunks('ship the beta on friday', 'ship the release candidate on friday');
    expect(rewrite.hunks).toHaveLength(1);
    expect(rewrite.hunks[0].before.trim()).toBe('beta');
    expect(rewrite.hunks[0].after.trim()).toBe('release candidate');
  });

  it('keeps separate edits separate', () => {
    const rewrite = rewriteHunks('alpha beta gamma delta', 'alpha BETA gamma DELTA');
    expect(rewrite.hunks).toHaveLength(2);
  });
});

describe('applyHunks', () => {
  const before = 'The pricing is annual and the trial is short.';
  const after = 'The pricing is monthly and the trial is generous.';

  it('defaults to the original — a decision surface must not change anything by itself', () => {
    expect(accept(before, after, [])).toBe(before);
  });

  it('takes every hunk when every hunk is accepted', () => {
    const rewrite = rewriteHunks(before, after);
    expect(applyHunks(rewrite, new Set(rewrite.hunks.map((h) => h.id)))).toBe(after);
  });

  it('takes THREE of five and leaves the other two — the whole point', () => {
    // The pattern Cursor and Windsurf both regressed and had to restore: a
    // single Accept/Reject makes you take changes you did not want, or lose
    // the ones you did.
    expect(accept(before, after, [0])).toBe('The pricing is monthly and the trial is short.');
    expect(accept(before, after, [1])).toBe('The pricing is annual and the trial is generous.');
  });

  it('round-trips exactly, so accepting nothing is byte-identical', () => {
    const messy = '  leading space\n\nand a blank line   ';
    expect(accept(messy, 'totally different', [])).toBe(messy);
  });
});

describe('whitespace', () => {
  it('does not leave a double space where a word was deleted', () => {
    expect(accept('keep the extra word here', 'keep the word here', [0])).toBe(
      'keep the word here',
    );
  });

  it('takes the rewrite’s spacing on shared words, so accept matches what was shown', () => {
    // A rewrite may re-wrap the paragraph. Keeping the old whitespace would
    // make the accepted result differ from the text the user approved.
    const rewrite = rewriteHunks('one two three', 'one\ntwo three');
    expect(applyHunks(rewrite, new Set(rewrite.hunks.map((h) => h.id)))).toBe('one\ntwo three');
  });
});

describe('pure insertions and deletions', () => {
  it('reads an addition as an addition', () => {
    const rewrite = rewriteHunks('alpha gamma', 'alpha beta gamma');
    expect(rewrite.hunks).toHaveLength(1);
    expect(rewrite.hunks[0].before.trim()).toBe('');
    expect(describeHunk(rewrite.hunks[0])).toBe('Add "beta"');
  });

  it('reads a removal as a removal', () => {
    const rewrite = rewriteHunks('alpha beta gamma', 'alpha gamma');
    expect(describeHunk(rewrite.hunks[0])).toBe('Delete "beta"');
  });

  it('describes a replacement as one', () => {
    const rewrite = rewriteHunks('alpha beta', 'alpha gamma');
    expect(describeHunk(rewrite.hunks[0])).toBe('Replace "beta" with "gamma"');
  });
});

describe('degenerate input', () => {
  it('handles an empty original as one big insertion', () => {
    const rewrite = rewriteHunks('', 'brand new text');
    expect(rewrite.hunks).toHaveLength(1);
    expect(applyHunks(rewrite, new Set([0]))).toBe('brand new text');
    expect(applyHunks(rewrite, new Set())).toBe('');
  });

  it('handles an empty rewrite as one big deletion', () => {
    const rewrite = rewriteHunks('some text', '');
    expect(applyHunks(rewrite, new Set([0]))).toBe('');
    expect(applyHunks(rewrite, new Set())).toBe('some text');
  });

  it('survives a passage with no shared words at all', () => {
    const rewrite = rewriteHunks('aaa bbb', 'ccc ddd');
    expect(applyHunks(rewrite, new Set(rewrite.hunks.map((h) => h.id)))).toBe('ccc ddd');
    expect(applyHunks(rewrite, new Set())).toBe('aaa bbb');
  });
});

/* M55.6 — the LCS the open page's blocks pair through, exported. */
describe('lcsPairs', () => {
  const caseless = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

  it('returns the matched pairs in ascending order, under the equality it is given', () => {
    expect(lcsPairs(['A', 'b', 'c', 'D'], ['a', 'x', 'C', 'd', 'e'], caseless)).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
  });

  it('pairs nothing when nothing is equal, and nothing against an empty side', () => {
    expect(lcsPairs([1, 2], [3, 4], (x, y) => x === y)).toEqual([]);
    expect(lcsPairs([], [1], (x, y) => x === y)).toEqual([]);
  });

  it('keeps every pair strictly ascending when an item repeats', () => {
    const pairs = lcsPairs(['p', 'p', 'q'], ['p', 'q', 'p'], (x, y) => x === y);
    expect(pairs).toHaveLength(2);
    for (let k = 1; k < pairs.length; k++) {
      expect(pairs[k][0]).toBeGreaterThan(pairs[k - 1][0]);
      expect(pairs[k][1]).toBeGreaterThan(pairs[k - 1][1]);
    }
  });

  it('agrees with the table it walks', () => {
    const a = ['x', 'y', 'z', 'y'];
    const b = ['y', 'z', 'x', 'y'];
    const same = (x: string, y: string) => x === y;
    expect(lcsPairs(a, b, same)).toHaveLength(lcsTable(a, b, same)[0][0]);
  });
});
