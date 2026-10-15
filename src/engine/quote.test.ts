import { describe, expect, it } from 'vitest';
import COMMENT_TOOLS from '../../src-tauri/fixtures/comment-tools.json';
import QUOTE_CASES from '../../src-tauri/fixtures/quote-cases.json';
import {
  anchorContext,
  commentMatches,
  lineAt,
  occurrencesOf,
  planEdits,
  QUOTE_LIMITS,
  quoteMarkdown,
  type QuoteEdit,
} from './quote';

/**
 * The TS half of edit_note's quote rules (M55.5). Rust replays the same file
 * in `src-tauri/src/vault/quote.rs`, so a message or a line that drifts in
 * either twin fails here or there.
 */

interface QuoteCase {
  why: string;
  prefix?: string;
  body: string;
  edits: QuoteEdit[];
  result?: string;
  lines?: number[];
  refused?: string;
}

const cases = QUOTE_CASES.cases as QuoteCase[];

describe('planEdits', () => {
  it.each(cases.map((c) => [c.why, c] as const))('replays the shared case: %s', (_why, c) => {
    const plan = planEdits(c.body, c.prefix ?? '', c.edits);
    if (c.refused !== undefined) {
      expect(plan).toEqual({ ok: false, message: c.refused });
    } else {
      expect(plan).toEqual({ ok: true, text: c.result, lines: c.lines });
    }
  });

  it('holds the limits the shared cases name', () => {
    expect({
      max_edits: QUOTE_LIMITS.maxEdits,
      context_chars: QUOTE_LIMITS.contextChars,
      match_chars: QUOTE_LIMITS.matchChars,
      max_listed: QUOTE_LIMITS.maxListed,
    }).toEqual(QUOTE_CASES.limits);
  });

  it('refuses 101 edits in one call', () => {
    const edits = Array.from({ length: 101 }, () => ({ old: 'x', new: 'y', occurrence: 1 }));
    expect(planEdits('x'.repeat(101), '', edits)).toEqual({
      ok: false,
      message:
        'edit_note takes at most 100 edits in one call; this call has 101.\nNothing was written.',
    });
  });
});

/* The finder, exported for comment anchors (M70.1) with no change to what it
   finds: the shared cases above replay through it unchanged. */
describe('occurrencesOf', () => {
  it('returns every start, overlapping ones included, as UTF-16 offsets', () => {
    expect(occurrencesOf('aaa', 'aa')).toEqual([0, 1]);
    expect(occurrencesOf('Owner: TBD. Deadline: TBD.', 'TBD')).toEqual([7, 22]);
    expect(occurrencesOf('😀ab😀ab', 'ab')).toEqual([2, 6]);
  });

  it('steps one code point, never into a surrogate pair', () => {
    expect(occurrencesOf('😀😀😀', '😀😀')).toEqual([0, 2]);
  });

  it('finds nothing for a missing or an empty quote', () => {
    expect(occurrencesOf('abc', 'x')).toEqual([]);
    expect(occurrencesOf('abc', '')).toEqual([]);
  });
});

describe('comment quotes (M70.3)', () => {
  // The twin of comment_tools.rs's replays_the_shared_quote_filter: the same
  // cases, so the mock finds an agent's quote where the packaged app does.
  it.each(COMMENT_TOOLS.quotes.map((c) => [c.quote, c.markdown] as const))(
    'names the markdown in %j as %j',
    (quote, markdown) => {
      expect(quoteMarkdown(quote)).toBe(markdown);
    },
  );

  it.each(COMMENT_TOOLS.matches.map((c) => [c.why, c] as const))('%s', (_why, c) => {
    const found = commentMatches(c.body, c.quote);
    expect(found.map((at) => lineAt(c.body, at))).toEqual(c.lines);
    expect(found.map((at) => anchorContext(c.body, at, at + c.quote.length))).toEqual(c.anchors);
  });

  it('keeps only matches the finder found', () => {
    const body = 'a freeze, then [a freeze](freeze.md)\n';
    expect(commentMatches(body, 'freeze')).toEqual(
      occurrencesOf(body, 'freeze').filter((at) => body.slice(at - 1, at) !== '('),
    );
  });
});
