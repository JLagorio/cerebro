/**
 * Page columns as directive containers (M48.1).
 *
 * Not to be confused with `engine/columns.ts`, which is about the columns of a
 * TABLE. These are the columns of a page — Notion's `/columns`, side-by-side
 * layout for prose and embeds.
 *
 * A page with columns is still an ordinary markdown file. The layout is
 * carried by `:::` container markers — the spelling remark-directive,
 * Docusaurus and Quartz all use — so a column's CONTENTS stay real markdown
 * blocks. That is the whole point: a wikilink inside a column still resolves,
 * a `cerebro-database` fence inside a column still renders, and a file opened
 * in Obsidian or on GitHub shows every word with only the arrangement lost.
 *
 * ```markdown
 * :::columns
 * ::::column
 * ## Left
 * ::::
 * ::::column width=2
 * ## Right, twice as wide
 * ::::
 * :::
 * ```
 *
 * Marker depth grows with nesting depth so an inner container can never be
 * confused for the outer one's close. `width=` is written only when it
 * deviates from 1 (the deviations-only rule this codebase serializes by).
 *
 * This module is pure line↔marker translation. The block-tree folding that
 * uses it lives in `src/editor/markdown.ts`, beside the chip and
 * database-fence passes it is a sibling of.
 */

/** The default flex ratio — a column that never says otherwise. */
export const DEFAULT_COLUMN_WIDTH = 1;

/** The shallowest legal marker. A `columnList` at the top of a page opens with `:::`. */
export const BASE_MARKER_DEPTH = 3;

export type ColumnMarker =
  | { kind: 'open-list'; depth: number }
  | { kind: 'open-column'; depth: number; width: number }
  | { kind: 'close'; depth: number };

const OPEN_LIST = /^(:{3,})columns[ \t]*$/;
const OPEN_COLUMN = /^(:{3,})column(?:[ \t]+width=(\d+(?:\.\d+)?))?[ \t]*$/;
const CLOSE = /^(:{3,})[ \t]*$/;

/**
 * Read one line as a marker, or `null` if it is ordinary text.
 *
 * Vault-tolerant by construction: anything that is not exactly one of these
 * three shapes is not a marker, and a line that LOOKS like one but carries
 * trailing junk (`:::columns 3`) stays the paragraph it is rather than being
 * guessed at. A file the app cannot read as layout is still a file whose words
 * it renders.
 */
export function parseColumnMarker(line: string): ColumnMarker | null {
  const list = line.match(OPEN_LIST);
  if (list !== null) return { kind: 'open-list', depth: list[1].length };
  const column = line.match(OPEN_COLUMN);
  if (column !== null) {
    // An explicit `width=0` is not a column, it is a mistake — a zero-ratio
    // flex child is invisible, and silently hiding someone's writing is the
    // worst reading available of an ambiguous file.
    const declared = column[2] === undefined ? DEFAULT_COLUMN_WIDTH : Number(column[2]);
    return {
      kind: 'open-column',
      depth: column[1].length,
      width: declared > 0 ? declared : DEFAULT_COLUMN_WIDTH,
    };
  }
  const close = line.match(CLOSE);
  if (close !== null) return { kind: 'close', depth: close[1].length };
  return null;
}

/** The marker line a `columnList` at this nesting depth opens with. */
export const openListMarker = (depth: number): string => `${':'.repeat(depth)}columns`;

/** The marker line a `column` opens with — `width=` only when it deviates. */
export const openColumnMarker = (depth: number, width: number): string =>
  width === DEFAULT_COLUMN_WIDTH
    ? `${':'.repeat(depth)}column`
    : `${':'.repeat(depth)}column width=${width}`;

/** The marker line that closes a container at this depth. */
export const closeMarker = (depth: number): string => ':'.repeat(depth);

const FENCE = /^[ \t]*(```|~~~)/;

/**
 * Put a blank line on either side of every marker line.
 *
 * MEASURED against `@blocknote/core@0.46.2`: the markdown parser gives each
 * marker its own paragraph when the markers are blank-line separated, and
 * collapses a tight run of them into ONE paragraph joined by soft breaks. We
 * want the first, and we want the file on disk to be the second — nobody wants
 * to read a page that is half blank lines. So loosening happens on the way IN,
 * and `tightenColumnMarkers` undoes it on the way out.
 *
 * Fenced code is skipped: `:::` inside a ``` block is somebody's example, not
 * our layout.
 */
export function loosenColumnMarkers(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  // A marker owes exactly ONE blank line after it — satisfied by the next line
  // if that line is already blank. Without this the function is not
  // idempotent, and a file loosened twice grows a blank per marker per pass.
  let owed = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && parseColumnMarker(line) !== null) {
      while (out.length > 0 && out[out.length - 1] === '') out.pop();
      if (out.length > 0) out.push('');
      out.push(line);
      owed = true;
      continue;
    }
    if (owed) {
      out.push('');
      owed = false;
      // The blank we owed IS this line, if this line is blank.
      if (line === '') continue;
    }
    out.push(line);
  }
  // Nothing is owed at end of input: the end of the file already terminates
  // the marker's paragraph, and a trailing blank here would be one `tighten`
  // could not tell from a blank the author typed.
  return out.join('\n');
}

/**
 * Drop the blank lines that sit INSIDE a container, and keep the ones that
 * separate the container from the prose around it.
 *
 * "Inside" is what makes this the inverse of `loosenColumnMarkers` rather than
 * merely its opposite. Both the blank before an opening `:::columns` and the
 * blank after `::::column` touch a marker, but only the second one is ours:
 * the first is the ordinary paragraph break an author would type between a
 * sentence and the layout that follows it, and eating it would reflow their
 * file every time they saved.
 *
 * So the test is which SIDE of the marker the blank is on:
 *
 *   text ␣ :::columns      keep — outside, an author's paragraph break
 *   :::columns ␣ ::::column  drop — between two markers
 *   ::::column ␣ text      drop — just inside an opening marker
 *   text ␣ ::::            drop — just inside a closing marker
 *   ::: ␣ text             keep — outside, after the container closed
 *
 * Exactness is the point. Saving an unedited page must produce identical
 * bytes — the fidelity policy `markdown.ts` has held since M2 — and a round
 * trip that grows one blank line per save grows the file forever.
 */
export function tightenColumnMarkers(markdown: string): string {
  const lines = markdown.split('\n');
  const markers: (ColumnMarker | null)[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    markers.push(inFence ? null : parseColumnMarker(line));
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === '') {
      let b = i - 1;
      while (b >= 0 && lines[b] === '') b -= 1;
      let a = i + 1;
      while (a < lines.length && lines[a] === '') a += 1;
      const before = b >= 0 ? markers[b] : null;
      const after = a < lines.length ? markers[a] : null;
      const inside =
        (before !== null && after !== null) ||
        (before !== null && before.kind !== 'close') ||
        (after !== null && after.kind === 'close');
      if (inside) continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}
