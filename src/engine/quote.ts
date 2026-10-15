/**
 * Quote-anchored body edits (M55.5): the TS twin of
 * `src-tauri/src/vault/quote.rs`, which `edit_note` plans with.
 *
 * Both replay `src-tauri/fixtures/quote-cases.json`, which pins every message
 * byte for byte (D3). The mock backend's `agentEdit` plans with this, so the
 * browser refuses what the packaged app refuses, in the same words; its
 * `agentComment` (M70.3) finds and lists an agent's comment quote with the
 * same finder and lines, filtered by `commentMatches`, which both sides
 * replay from `src-tauri/fixtures/comment-tools.json`.
 *
 * Offsets here are UTF-16 units and Rust's are bytes, so the cases pin lines
 * and code-point contexts only: the overlapping search steps one code point,
 * and a context is cut and counted in code points, never inside a surrogate
 * pair.
 */

import { DATE_TOKEN_SOURCE } from './dates';

export const QUOTE_LIMITS = {
  /** The most edits one call may carry. */
  maxEdits: 100,
  /** Code points of context shown on each side of a listed match. */
  contextChars: 40,
  /** Code points of a listed match shown before the context after it. */
  matchChars: 80,
  /** Matches listed under a refused edit before the rest are counted. */
  maxListed: 20,
} as const;

/** One replacement: the passage quoted in `old`, the markdown in `new`, and
 * which appearance of `old` is meant (counting from 1) when there are several. */
export interface QuoteEdit {
  old: string;
  new: string;
  occurrence?: number;
}

/** Every edit landed in one splice, with the 1-based line where each edit's
 * new text starts, in the order given; or the refusal, every failing edit
 * listed. */
export type QuotePlan =
  { ok: true; text: string; lines: number[] } | { ok: false; message: string };

const NOTHING_WRITTEN = 'Nothing was written.';

/**
 * Plan `edits` against `body`, the note body as get_note prints it. `prefix`
 * is every character before it (BOM, fences and YAML): never matched or
 * changed, and asked only to say that a quote missing from the body sits in
 * the frontmatter.
 */
export function planEdits(body: string, prefix: string, edits: readonly QuoteEdit[]): QuotePlan {
  if (edits.length === 0) return refused(['edit_note needs at least one edit.']);
  if (edits.length > QUOTE_LIMITS.maxEdits) {
    return refused([
      `edit_note takes at most ${QUOTE_LIMITS.maxEdits} edits in one call; this call has ${edits.length}.`,
    ]);
  }
  const failures: string[] = [];
  const spans: [number, number][] = [];
  edits.forEach((edit, index) => {
    const start = resolve(body, prefix, index + 1, edit);
    if (typeof start === 'number') spans.push([start, start + edit.old.length]);
    else failures.push(...start);
  });
  if (failures.length > 0) return refused(failures);
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const start = Math.max(spans[i][0], spans[j][0]);
      if (start < Math.min(spans[i][1], spans[j][1])) {
        failures.push(
          `Edits ${i + 1} and ${j + 1} overlap at line ${lineAt(body, start)}; each edit must replace a passage of its own.`,
        );
      }
    }
  }
  if (failures.length > 0) return refused(failures);
  const order = spans.map((_, i) => i).sort((a, b) => spans[a][0] - spans[b][0]);
  let text = '';
  const lines = new Array<number>(edits.length).fill(0);
  let at = 0;
  for (const i of order) {
    text += body.slice(at, spans[i][0]);
    lines[i] = lineAt(text, text.length);
    text += edits[i].new;
    at = spans[i][1];
  }
  text += body.slice(at);
  return { ok: true, text, lines };
}

/** Where edit `i` lands in `body`, or the lines that say why it cannot. */
function resolve(body: string, prefix: string, i: number, edit: QuoteEdit): number | string[] {
  if (edit.old === '') return [`Edit ${i}: \`old\` is empty — quote the text to replace.`];
  if (edit.new === edit.old) {
    return [`Edit ${i}: \`new\` is the same as \`old\`, so it changes nothing.`];
  }
  if (edit.occurrence === 0) return [`Edit ${i}: \`occurrence\` counts from 1.`];
  const found = occurrencesOf(body, edit.old);
  const n = found.length;
  const k = edit.occurrence;
  if (n === 0) {
    return prefix.includes(edit.old)
      ? [
          `Edit ${i}: the quoted text is in the frontmatter, which edit_note never changes. Use update_frontmatter for properties.`,
        ]
      : [
          `Edit ${i}: the quoted text is not in the note's body. Quote it exactly as get_note shows it, spacing, line breaks and markdown included, or read the note again if it may have changed.`,
        ];
  }
  if (k === undefined) {
    if (n === 1) return found[0];
    return listed(
      `Edit ${i}: the quoted text appears ${n} times. Pass \`occurrence\` (counting from 1) or quote a longer passage:`,
      body,
      edit.old,
      found,
    );
  }
  if (k > n) {
    return listed(
      `Edit ${i}: \`occurrence\` is ${k}, but the quoted text appears ${n} ${n === 1 ? 'time' : 'times'}:`,
      body,
      edit.old,
      found,
    );
  }
  return found[k - 1];
}

/** Every start of `quote` in `body`, as UTF-16 offsets, overlapping ones
 * included: after a match the search goes on one code point later, so `aa` is
 * in `aaa` twice. The one matcher (M70.1): comment anchors filter what it
 * finds (`validMatches` in commentAnchor.ts, `commentMatches` below for an
 * agent's quote, M70.3) and never search on their own.
 * An empty quote is in no body: it would match everywhere, and forever. */
export function occurrencesOf(body: string, quote: string): number[] {
  if (quote === '') return [];
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const start = body.indexOf(quote, from);
    if (start === -1) return found;
    found.push(start);
    from = start + ((body.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
  }
}

/** `head`, then one line per match (at most `maxListed`), then the count of
 * the rest. */
export function listed(head: string, body: string, quote: string, found: number[]): string[] {
  const lines = [head];
  found.slice(0, QUOTE_LIMITS.maxListed).forEach((start, k) => {
    lines.push(
      `  ${k + 1}. line ${lineAt(body, start)}: ${context(body, start, start + quote.length)}`,
    );
  });
  if (found.length > QUOTE_LIMITS.maxListed) {
    lines.push(`  … and ${found.length - QUOTE_LIMITS.maxListed} more`);
  }
  return lines;
}

/** The 1-based line `offset` falls on. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) {
    line++;
  }
  return line;
}

/** The body around the match `start..end`, counted in code points, with an
 * ellipsis at each end that was cut, JSON-escaped. */
export function context(body: string, start: number, end: number): string {
  const before = Array.from(body.slice(0, start)).length;
  const within = Array.from(body.slice(start, end)).length;
  const points = Array.from(body);
  const from = Math.max(0, before - QUOTE_LIMITS.contextChars);
  const to = Math.min(
    points.length,
    before + Math.min(within, QUOTE_LIMITS.matchChars) + QUOTE_LIMITS.contextChars,
  );
  const shown =
    (from > 0 ? '…' : '') + points.slice(from, to).join('') + (to < points.length ? '…' : '');
  return JSON.stringify(shown);
}

function refused(lines: string[]): QuotePlan {
  return { ok: false, message: [...lines, NOTHING_WRITTEN].join('\n') };
}

// --- Comment quotes (M70.3) --------------------------------------------------
//
// The twin of quote.rs's section. An agent anchors a comment by quoting plain
// words as get_note prints the body; a quote with markdown is refused and the
// finder's matches are kept only where the page shows them as text: not
// inside a fence, not on a `:::` line (a toggle's title excepted), not in a
// line's marker, a link's target, an image or a chip (a wikilink, an
// assignee, a footnote or a date, which the editor draws as one atom).

/** The characters a comment quote may not hold; a context stops at one. */
const QUOTE_MARKDOWN = new Set(['*', '_', '`', '~', '[', ']', '<', '>', '\\', '|']);

/** The markdown a comment quote holds, named for its refusal, or null. */
export function quoteMarkdown(quote: string): string | null {
  for (const c of quote) {
    if (c === '\n' || c === '\r') return 'a line break';
    if (c === '`') return 'a backtick';
    if (QUOTE_MARKDOWN.has(c)) return `\`${c}\``;
  }
  return null;
}

/** The length of the run of `c` that opens `text`. */
function runOf(text: string, c: string): number {
  let n = 0;
  while (text[n] === c) n++;
  return n;
}

/** How many spaces and tabs open `text`. */
function blankRun(text: string): number {
  let n = 0;
  while (text[n] === ' ' || text[n] === '\t') n++;
  return n;
}

const isBlank = (text: string): boolean => blankRun(text) === text.length;

/** The units of `line` a block marker takes before its text: blockquote
 * `>`s, then a heading's `#`s, or a bullet or number and a task box. */
function markerLength(line: string): number {
  let at = blankRun(line);
  while (line[at] === '>') {
    at += 1;
    at += blankRun(line.slice(at));
  }
  const rest = line.slice(at);
  const spaced = (n: number) => rest.length === n || rest[n] === ' ' || rest[n] === '\t';
  const hashes = runOf(rest, '#');
  if (hashes >= 1 && hashes <= 6 && spaced(hashes)) {
    return at + hashes + blankRun(rest.slice(hashes));
  }
  const digits = /^[0-9]*/.exec(rest)?.[0].length ?? 0;
  let item: number;
  if ((rest[0] === '-' || rest[0] === '*' || rest[0] === '+') && spaced(1)) {
    item = 1;
  } else if (
    digits >= 1 &&
    digits <= 9 &&
    (rest[digits] === '.' || rest[digits] === ')') &&
    spaced(digits + 1)
  ) {
    item = digits + 1;
  } else {
    return at;
  }
  at += item + blankRun(rest.slice(item));
  for (const task of ['[ ]', '[x]', '[X]']) {
    const after = line.slice(at);
    if (after.startsWith(task) && (after.length === 3 || after[3] === ' ' || after[3] === '\t')) {
      return at + 3 + blankRun(after.slice(3));
    }
  }
  return at;
}

/** What the page draws as no text where it starts: an image (`![alt](target)`)
 * or a chip, as `src/editor/markdown.ts`'s CHIP_PATTERN finds one
 * (`@[[target|alias]]`, `[[target|alias]]`, `[^id]` or a date token). The
 * editor draws a chip as one atom, and M70.1 counts no match inside an atom.
 * quote.rs spells the same grammar by hand. */
const NOT_TEXT = new RegExp(
  String.raw`!\[[^\]]*\]\([^)]*\)|@?\[\[[^\][|]+(?:\|[^\][]*)?\]\]|\[\^[^\]\s]+\]|${DATE_TOKEN_SOURCE}`,
  'uy',
);

/** The characters a match of `NOT_TEXT` can start with (📅 by its first unit). */
const NOT_TEXT_STARTS = new Set(['!', '@', '[', '\uD83D']);

/** `from..to` of `body` less what the page does not show as text there: every
 * link target (`](` to its `)`), every image and every chip. */
function pageTextIn(body: string, from: number, to: number, out: [number, number][]) {
  const line = body.slice(from, to);
  let kept = 0;
  let at = 0;
  while (at < line.length) {
    let cut: [number, number] | null = null;
    if (line.startsWith('](', at)) {
      // A link's text keeps its `]`; its target goes.
      const close = line.indexOf(')', at + 1);
      cut = [at + 1, close === -1 ? line.length : close + 1];
    } else if (NOT_TEXT_STARTS.has(line[at])) {
      NOT_TEXT.lastIndex = at;
      const m = NOT_TEXT.exec(line);
      if (m !== null) cut = [at, at + m[0].length];
    }
    if (cut === null) {
      at++;
      continue;
    }
    if (cut[0] > kept) out.push([from + kept, from + cut[0]]);
    kept = cut[1];
    at = cut[1];
  }
  if (kept < line.length) out.push([from + kept, to]);
}

/** The ranges of `body` the page shows as text, in order: each line's own
 * text, less its marker, its link targets, its images and its chips, outside
 * every fence and every `:::` line but a toggle's title. A line's `\r` is
 * never text. */
function textRanges(body: string): [number, number][] {
  const out: [number, number][] = [];
  let fence: { c: string; n: number } | null = null;
  let start = 0;
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const from = start;
    const end = start + line.length;
    start += raw.length + 1;
    const indent = runOf(line, ' ');
    const fenced = line.slice(indent);
    if (fence !== null) {
      const closing = runOf(fenced, fence.c);
      if (indent <= 3 && closing >= fence.n && isBlank(fenced.slice(closing))) fence = null;
      continue;
    }
    if (indent <= 3) {
      const c = ['`', '~'].find((mark) => runOf(fenced, mark) >= 3);
      if (c !== undefined) {
        fence = { c, n: runOf(fenced, c) };
        continue;
      }
    }
    const directive = line.slice(blankRun(line));
    if (directive.startsWith(':::')) {
      const after = directive.slice(runOf(directive, ':'));
      if (after.startsWith('toggle ')) {
        const title = after.slice('toggle '.length);
        pageTextIn(body, end - title.length, end, out);
      }
      continue;
    }
    pageTextIn(body, from + markerLength(line), end, out);
  }
  return out;
}

const rangeHolding = (
  ranges: [number, number][],
  start: number,
  end: number,
): [number, number] | undefined => ranges.find(([from, to]) => from <= start && end <= to);

/** Every start of `quote` in `body` that reads as text on the page: the
 * finder's matches, kept when one text range holds the whole match. A
 * comment's occurrence counts among these. */
export function commentMatches(body: string, quote: string): number[] {
  const ranges = textRanges(body);
  return occurrencesOf(body, quote).filter(
    (start) => rangeHolding(ranges, start, start + quote.length) !== undefined,
  );
}

/** The context a comment's anchor stores for the match `start..end`, from
 * its own line: back to the last markdown character or the start of its
 * text, and on to the next, each cut to `contextChars` code points nearest
 * the match. */
export function anchorContext(
  body: string,
  start: number,
  end: number,
): { before: string; after: string } {
  const [from, to] = rangeHolding(textRanges(body), start, end) ?? [start, end];
  let before = body.slice(from, start);
  for (let i = before.length - 1; i >= 0; i--) {
    if (QUOTE_MARKDOWN.has(before[i])) {
      before = before.slice(i + 1);
      break;
    }
  }
  let after = body.slice(end, to);
  for (let i = 0; i < after.length; i++) {
    if (QUOTE_MARKDOWN.has(after[i])) {
      after = after.slice(0, i);
      break;
    }
  }
  const points = Array.from(before);
  return {
    before: points.slice(Math.max(0, points.length - QUOTE_LIMITS.contextChars)).join(''),
    after: Array.from(after).slice(0, QUOTE_LIMITS.contextChars).join(''),
  };
}
