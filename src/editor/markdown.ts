import type { BlockNoteEditor, PartialBlock } from '@blocknote/core';
import { DATABASE_FENCE, parseDatabaseRef, serializeDatabaseRef } from '@/engine/databaseBlock';
import {
  chipPropsToDateValue,
  DATE_TOKEN_SOURCE,
  dateValueToChipProps,
  parseDateToken,
  serializeDateValue,
  type DateChipProps,
} from '@/engine/dates';
import {
  BASE_MARKER_DEPTH,
  closeMarker,
  DEFAULT_COLUMN_WIDTH,
  fenceReader,
  loosenColumnMarkers,
  openColumnMarker,
  openListMarker,
  parseColumnMarker,
  tightenColumnMarkers,
  type ColumnMarker,
} from '@/engine/pageColumns';

/** Schema-agnostic editor view: custom inline specs (chips) change the
 * concrete BlockNoteEditor generics, but these helpers only need the
 * markdown conversion surface. Blocks flow back into the same editor's
 * replaceBlocks, so the erased typing is safe by construction. */
type AnyEditor = BlockNoteEditor<any, any, any>;
type AnyBlocks = any[];

/**
 * BlockNote 0.46 markdown round-trip helpers.
 *
 * The editor only ever sees a note BODY — frontmatter is split off before
 * markdown reaches these helpers (a leading `---` would otherwise parse as a
 * divider and corrupt the file).
 *
 * Fidelity policy (M2): `blocksToMarkdownLossy` normalizes formatting
 * (`-` bullets become `*`, loose lists, table padding). That is accepted —
 * but the round trip must be STABLE: saving an unedited document twice must
 * produce identical bytes, or every open/edit cycle grows the file.
 */

/**
 * BlockNote parses every markdown hard break (trailing backslash or two
 * spaces) into TWO `\n` characters in the block's text, while serialization
 * emits one backslash-break per `\n`. Left alone, each open/save cycle
 * doubles the breaks inside quotes, callouts, and paragraphs. Halving the
 * `\n\n` runs after parse exactly inverts the doubling: soft breaks parse to
 * a single `\n`, and adjacent breaks cannot exist in markdown, so runs of
 * two or more only ever come from the parser.
 */
const halveBreakRuns = (text: string): string => text.replace(/\n\n/g, '\n');

function normalizeInlineValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizeInlineValue(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  if (typeof node.text === 'string') node.text = halveBreakRuns(node.text);
  if ('content' in node) normalizeInlineValue(node.content);
  if ('rows' in node) normalizeInlineValue(node.rows);
  if ('cells' in node) normalizeInlineValue(node.cells);
}

/** Undo the parser's hard-break doubling. Code blocks are exempt: their `\n` characters are literal code lines. */
export function normalizeParsedBlocks<T extends PartialBlock>(blocks: T[]): T[] {
  for (const block of blocks) {
    if (block.type === 'codeBlock') continue;
    normalizeInlineValue(block.content);
    if (Array.isArray(block.children)) normalizeParsedBlocks(block.children);
  }
  return blocks;
}

// --- Chip round-trip (M2.x docs polish) -----------------------------------
// Plain-text chip forms — `[[target|alias]]`, `@[[person]]`, `📅 2026-07-30`,
// and footnote citations `[^id]` / `[^id]:` (M51.5) — are promoted to custom
// inline nodes after parse (enrichChips) and demoted back to the same plain
// text before serialization (demoteChips), so the file on disk never stops
// being ordinary markdown. The chips' toExternalHTML emits the same text for
// the clipboard.

export const wikilinkText = (props: { target: string; alias: string }): string =>
  props.alias !== '' ? `[[${props.target}|${props.alias}]]` : `[[${props.target}]]`;

export const assigneeText = (props: { target: string }): string => `@[[${props.target}]]`;

export const dueText = (props: Partial<DateChipProps>): string =>
  serializeDateValue(chipPropsToDateValue(props));

/** `def` is `'1'` for a definition and `''` for a reference — prop defaults are primitives. */
export const citationText = (props: { id: string; def: string }): string =>
  props.def === '1' ? `[^${props.id}]:` : `[^${props.id}]`;

// The citation alternative is last and its class is `protectFootnotes`'s own,
// so exactly what that escaped before the parse is what comes back a chip. At
// a `[[` the wikilink alternatives are tried first, so a citation can never be
// read out of the middle of a link.
const CHIP_PATTERN = new RegExp(
  String.raw`@\[\[([^\][|]+?)(?:\|[^\][]*)?\]\]|\[\[([^\][|]+?)(?:\|([^\][]*))?\]\]|(${DATE_TOKEN_SOURCE})|\[\^([^\]\s]+)\]`,
  'gu',
);

/** A footnote DEFINITION's marker, tried only where a line starts (M51.5). */
const DEFINITION_MARK = /\[\^([^\]\s]+)\]:/y;

interface TextNode {
  type: 'text';
  text: string;
  styles?: Record<string, unknown>;
}

const isTextNode = (item: unknown): item is TextNode =>
  typeof item === 'object' &&
  item !== null &&
  (item as TextNode).type === 'text' &&
  typeof (item as TextNode).text === 'string';

const isPlainTextNode = (item: unknown): item is TextNode =>
  isTextNode(item) && !(item.styles?.code === true);

/**
 * Chips are only read out of UNSTYLED text — every kind, one rule. A chip
 * cannot carry a style, so one promoted out of emphasis comes back from the
 * serializer outside it — measured, `*a claim[^id]*` as `*a claim*[^id]`, one
 * from mid-run as `*a claim*[^id]*&#x20;more*`, and (M52.4, which widened the
 * rule from citations to all four) `**[[kickoff]]**` as `[[kickoff]]` with its
 * bold gone — and a file nobody edited would change on its next save. Left as
 * text it round-trips exactly.
 *
 * M52.1 measured the two ways of showing a citation's number anyway, and
 * neither ships. A chip DOES take the emphasis as a ProseMirror mark — but
 * BlockNote's block JSON, which is what the serializer reads, has no styles
 * on custom inline content, so the mark is dropped on the way out and the
 * marker is still written outside the run; keeping it would take a second
 * copy of the marks in a prop, kept in step with them by hand. A decoration
 * drawing the number over text that stays text would leave the bytes alone
 * by construction, but it needs `prosemirror-view`, which is BlockNote's
 * dependency and not the app's. So inside emphasis the marker reads as
 * written, and typing one there (citationInput.ts) leaves it written too.
 * markdown.test.ts holds the first measurement ("would lose the emphasis if
 * the marker were a chip"), so a BlockNote that starts carrying the mark
 * says so.
 */
const isUnstyled = (node: TextNode): boolean =>
  node.styles === undefined || Object.keys(node.styles).length === 0;

function splitTextNode(node: TextNode): unknown[] {
  // Styled text is not even split into pieces. Measured: two italic pieces
  // handed to the serializer come back `*a claim**[^id]*`, one emphasis run
  // per piece, which is not the emphasis the file had.
  if (!isUnstyled(node)) return [node];
  const out: unknown[] = [];
  let last = 0;
  CHIP_PATTERN.lastIndex = 0;
  for (const m of node.text.matchAll(CHIP_PATTERN)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ ...node, text: node.text.slice(last, index) });
    if (m[1] !== undefined) {
      out.push({ type: 'assignee', props: { target: m[1].trim() } });
    } else if (m[2] !== undefined) {
      out.push({ type: 'wikilink', props: { target: m[2].trim(), alias: (m[3] ?? '').trim() } });
    } else if (m[5] !== undefined) {
      out.push({ type: 'citation', props: { id: m[5], def: '' } });
    } else {
      const value = parseDateToken(m[4]);
      if (value === null) {
        out.push({ ...node, text: m[0] }); // malformed token: keep as text
      } else {
        out.push({ type: 'due', props: dateValueToChipProps(value) });
      }
    }
    last = index + m[0].length;
  }
  if (out.length === 0) return [node];
  if (last < node.text.length) out.push({ ...node, text: node.text.slice(last) });
  return out;
}

/**
 * Split the footnote definitions out of one text node of a paragraph (M51.5).
 *
 * A definition is `[^id]:` where a LINE starts, and it becomes a definition
 * chip followed by the rest of its line as the text it already was. Where a
 * line starts is the whole question: the parser hands a run of definitions —
 * `[^a]: …` lines with nothing between them, which is how OKF writes them —
 * to us as ONE paragraph with a `\n` between each, so the start of the
 * paragraph is not the only place one can begin. `atLineStart` says whether
 * this node's own first character begins a line.
 */
function splitDefinitions(node: TextNode, atLineStart: boolean): unknown[] {
  const starts: number[] = atLineStart ? [0] : [];
  for (let at = node.text.indexOf('\n'); at !== -1; at = node.text.indexOf('\n', at + 1)) {
    starts.push(at + 1);
  }
  const out: unknown[] = [];
  let pending = 0;
  for (const start of starts) {
    DEFINITION_MARK.lastIndex = start;
    const m = DEFINITION_MARK.exec(node.text);
    if (m === null) continue;
    if (start > pending) out.push({ ...node, text: node.text.slice(pending, start) });
    out.push({ type: 'citation', props: { id: m[1], def: '1' } });
    pending = start + m[0].length;
  }
  if (out.length === 0) return [node];
  if (pending < node.text.length) out.push({ ...node, text: node.text.slice(pending) });
  return out;
}

function enrichInlineArray(items: unknown[], definitions = false): unknown[] {
  let lineStart = true;
  return items.flatMap((item) => {
    const atLineStart = lineStart;
    lineStart = isTextNode(item) && item.text.endsWith('\n');
    if (!isPlainTextNode(item)) return [item];
    const pieces = definitions && isUnstyled(item) ? splitDefinitions(item, atLineStart) : [item];
    return pieces.flatMap((piece) => (isTextNode(piece) ? splitTextNode(piece) : [piece]));
  });
}

/** Promote chip text to inline nodes across blocks (incl. table cells). */
export function enrichChips<T extends PartialBlock>(blocks: T[]): T[] {
  for (const block of blocks) {
    if (block.type === 'codeBlock') continue;
    const b = block as {
      content?: unknown;
      children?: unknown[];
    };
    if (Array.isArray(b.content)) {
      // Definitions only open a PARAGRAPH, which is where OKF writes them. A
      // `[^id]:` leading a heading or a list item stays a citation that
      // happens to be followed by a colon.
      b.content = enrichInlineArray(b.content, block.type === 'paragraph');
    } else if (typeof b.content === 'object' && b.content !== null) {
      const rows = (b.content as { rows?: { cells?: unknown[] }[] }).rows;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!Array.isArray(row.cells)) continue;
          row.cells = row.cells.map((cell) => {
            if (Array.isArray(cell)) return enrichInlineArray(cell);
            const c = cell as { content?: unknown[] };
            if (typeof c === 'object' && c !== null && Array.isArray(c.content)) {
              c.content = enrichInlineArray(c.content);
            }
            return cell;
          });
        }
      }
    }
    if (Array.isArray(b.children)) enrichChips(b.children as PartialBlock[]);
  }
  return blocks;
}

/** A chip's plain-text form, or null for anything that is not a chip. */
function chipText(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) return null;
  const { type, props = {} } = item as { type?: string; props?: Record<string, string> };
  switch (type) {
    case 'wikilink':
      return wikilinkText({ target: props.target ?? '', alias: props.alias ?? '' });
    case 'assignee':
      return assigneeText({ target: props.target ?? '' });
    case 'due':
      return dueText(props);
    case 'citation':
      return citationText({ id: props.id ?? '', def: props.def ?? '' });
    default:
      return null;
  }
}

const demoteInline = (items: unknown[]): unknown[] =>
  items.map((item) => {
    const text = chipText(item);
    return text === null ? item : { type: 'text', text, styles: {} };
  });

/**
 * Turn chips back into their text before the serializer sees them — in place,
 * so only ever on the copy `blocksToMarkdown` makes.
 *
 * Left as chips, the serializer renders each one through React to read its
 * toExternalHTML, and the one save that runs inside React's own commit — the
 * flush of a pending edit when the editor unmounts — is where React refuses
 * to render. Measured: `See [[kickoff]] and a claim.[^a]` flushed on unmount
 * as `See and a claim.`, every chip written as nothing. As text they need no
 * rendering at all, and the markdown they come out as is the same.
 */
function demoteChips<T extends PartialBlock>(blocks: T[]): T[] {
  for (const block of blocks) {
    const b = block as { content?: unknown; children?: unknown[] };
    if (Array.isArray(b.content)) {
      b.content = demoteInline(b.content);
    } else if (typeof b.content === 'object' && b.content !== null) {
      for (const row of (b.content as { rows?: { cells?: unknown[] }[] }).rows ?? []) {
        if (!Array.isArray(row.cells)) continue;
        row.cells = row.cells.map((cell) => {
          if (Array.isArray(cell)) return demoteInline(cell);
          const c = cell as { content?: unknown[] } | null;
          if (typeof c === 'object' && c !== null && Array.isArray(c.content)) {
            c.content = demoteInline(c.content);
          }
          return cell;
        });
      }
    }
    if (Array.isArray(b.children)) demoteChips(b.children as PartialBlock[]);
  }
  return blocks;
}

/**
 * The markdown serializer escapes brackets in text (`\[\[target\]\]`), which
 * would corrupt wikilinks on disk. Undo exactly the double-bracket escapes
 * outside fenced code — single brackets keep their escaping.
 */
export function unescapeChipMarkdown(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replaceAll('\\[\\[', '[[').replaceAll('\\]\\]', ']]');
    })
    .join('\n');
}

// --- Callout / mermaid / database round-trip (M2.x, M47.2) -----------------
// On disk a callout is an Obsidian-style `> [!info] …` quote, a diagram is a
// ```mermaid fence, and an embedded database is a ```cerebro-database fence
// holding a pointer. promoteRichBlocks upgrades those plain forms into the
// custom blocks after parse; demoteRichBlocks reverses it before
// serialization, on a deep copy so the live editor state is never mutated.

const CALLOUT_KIND_SET = new Set(['info', 'note', 'tip', 'success', 'warning', 'danger']);
const CALLOUT_MARK = /^\[!([a-z]+)\]\s?/;

const blockText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((n) =>
          typeof (n as { text?: string }).text === 'string' ? (n as { text: string }).text : '',
        )
        .join('')
    : '';

export function promoteRichBlocks<T extends PartialBlock>(blocks: T[]): T[] {
  return blocks.map((block) => {
    const b = block as PartialBlock & { content?: unknown; children?: PartialBlock[] };
    if (b.type === 'codeBlock' && (b.props as { language?: string })?.language === 'mermaid') {
      return { type: 'mermaid', props: { code: blockText(b.content) } } as unknown as T;
    }
    if (b.type === 'codeBlock' && (b.props as { language?: string })?.language === DATABASE_FENCE) {
      const text = blockText(b.content);
      // An EMPTY fence is how an unset block — the picker `/database` inserts
      // before anything is chosen — reaches disk, and it comes back as that
      // picker. Nothing is lost by the promotion: an empty body holds no text.
      if (text.trim() === '') {
        return { type: 'database', props: { database: '', view: '' } } as unknown as T;
      }
      // A fence that names no database stays the code block it already is —
      // `parseDatabaseRef` returns null rather than an empty pointer, so a
      // half-typed fence keeps showing what the user typed instead of being
      // replaced by a database block complaining about it.
      const ref = parseDatabaseRef(text);
      if (ref !== null) {
        // `view: ''` is the prop-schema spelling of "named none" — BlockNote
        // prop defaults are primitives, so null does not survive the trip.
        return {
          type: 'database',
          props: { database: ref.database, view: ref.view ?? '' },
        } as unknown as T;
      }
    }
    if (b.type === 'quote' && Array.isArray(b.content)) {
      const first = b.content[0] as { type?: string; text?: string } | undefined;
      if (first?.type === 'text' && typeof first.text === 'string') {
        const m = CALLOUT_MARK.exec(first.text);
        if (m !== null && CALLOUT_KIND_SET.has(m[1])) {
          const rest = first.text.replace(CALLOUT_MARK, '');
          const content = [
            ...(rest === '' ? [] : [{ ...first, text: rest }]),
            ...b.content.slice(1),
          ];
          return { type: 'callout', props: { kind: m[1] }, content } as unknown as T;
        }
      }
    }
    if (Array.isArray(b.children) && b.children.length > 0) {
      b.children = promoteRichBlocks(b.children);
    }
    return block;
  });
}

export function demoteRichBlocks<T extends PartialBlock>(blocks: T[]): T[] {
  return blocks.map((block) => {
    const b = block as {
      type?: string;
      props?: Record<string, unknown>;
      content?: unknown;
      children?: PartialBlock[];
    };
    if (b.type === 'mermaid') {
      const code = typeof b.props?.code === 'string' ? b.props.code : '';
      return {
        type: 'codeBlock',
        props: { language: 'mermaid' },
        content: [{ type: 'text', text: code, styles: {} }],
      } as unknown as T;
    }
    if (b.type === 'database') {
      const database = typeof b.props?.database === 'string' ? b.props.database : '';
      const view = typeof b.props?.view === 'string' && b.props.view !== '' ? b.props.view : null;
      // Unset writes an empty fence, which `promoteRichBlocks` reads back as
      // the picker. `database: ` would read back as a pointer to nothing —
      // a code block the picker can never return from.
      const text = database === '' ? '' : serializeDatabaseRef({ database, view });
      return {
        type: 'codeBlock',
        props: { language: DATABASE_FENCE },
        content: text === '' ? [] : [{ type: 'text', text, styles: {} }],
      } as unknown as T;
    }
    if (b.type === 'callout') {
      const kind = typeof b.props?.kind === 'string' ? b.props.kind : 'info';
      const content = Array.isArray(b.content) ? b.content : [];
      return {
        ...b,
        type: 'quote',
        props: {},
        content: [{ type: 'text', text: `[!${kind}] `, styles: {} }, ...content],
      } as unknown as T;
    }
    if (Array.isArray(b.children) && b.children.length > 0) {
      return { ...b, children: demoteRichBlocks(b.children) } as unknown as T;
    }
    return block;
  });
}

// --- Container round-trip: columns (M48.2) and the AI block (M53.9) --------
// On disk a column layout is a `:::columns` / `::::column` directive
// container, so a column's CONTENTS stay ordinary markdown blocks — a
// wikilink inside a column still resolves and a database fence inside one
// still renders. The markers arrive from the parser as ordinary paragraphs
// (that is what `loosenColumnMarkers` is for); `promoteContainers` folds that
// flat run back into the nest BlockNote lays out, and `demoteContainers`
// flattens it again on the way to disk.
//
// An AI block is the same kind of container, in the same spelling:
//
//   :::ai{prompt="The open questions in this document" generated="2026-10-12"}
//   * Who owns the migration?
//   :::
//
// The standing question and the day it was last answered ride on the opening
// line, and the ANSWER is the block's children — ordinary markdown blocks, so
// the file reads in any editor and a wikilink in an answer still resolves.
// Before M53.9 the block had no carrier at all: the serializer rendered it, so
// a save wrote its chrome (the prompt glued to the "Answer" button's label, in
// one paragraph, type and props gone) and a save inside the unmount flush,
// where nothing renders, wrote nothing.
//
// The attributes sit in braces, remark-directive's spelling for them, because
// a question is free text and needs delimiting where a column's `width=2`
// does not. Each value is a JSON string — `"`, `\`, control characters and
// the line and paragraph separators escaped (`attributeValue`), nothing else —
// and, like `width=`, written only when it is set.
//
// A line that only LOOKS like a marker — `:::columns` typed as a paragraph,
// an agent's answer quoting the page's own carrier — is written with a
// backslash in front (`escapeMarkerLines`). CommonMark reads `\:` as `:`, so
// every editor shows the line as typed, and no marker reader matches it.
// Written bare, it came back as a marker on the next open, and an opening
// marker with no close abandons the fold for the whole page. The marker lines
// the FILE holds and the fold could not use are the file's, not text, and go
// back exactly as they were (`keptMarkerIds`).

/** The attributes an AI marker may carry, in the order they are written. */
const AI_ATTRIBUTES = ['prompt', 'generated'] as const;

const AI_OPEN = /^(:{3,})ai(?:\{(.*)\})?[ \t]*$/;
const AI_ATTRIBUTE = /[ \t]*([A-Za-z]+)=("(?:[^"\\]|\\.)*")[ \t]*/y;

/** What an AI block's opening line says. `''` is "not set", the prop default. */
export interface AiMarker {
  depth: number;
  prompt: string;
  generated: string;
}

/**
 * Read one line as an AI block's opening marker, or `null` if it is not one.
 *
 * As strict as `parseColumnMarker`, for the same reason: an attribute this
 * does not know, a value that is not a well-formed string, a key given twice
 * or anything trailing the braces is not a marker, and the line stays the
 * paragraph it is. Accepting what it cannot carry would drop it on the next
 * save, and a file the app cannot read as a block is still a file whose words
 * it shows.
 */
export function parseAiMarker(line: string): AiMarker | null {
  const open = AI_OPEN.exec(line);
  if (open === null) return null;
  const values: Partial<Record<(typeof AI_ATTRIBUTES)[number], string>> = {};
  const list = open[2] ?? '';
  let at = 0;
  while (list.slice(at).trim() !== '') {
    AI_ATTRIBUTE.lastIndex = at;
    const attribute = AI_ATTRIBUTE.exec(list);
    if (attribute === null) return null;
    const key = AI_ATTRIBUTES.find((known) => known === attribute[1]);
    if (key === undefined || values[key] !== undefined) return null;
    let value: unknown;
    try {
      value = JSON.parse(attribute[2]);
    } catch {
      return null;
    }
    if (typeof value !== 'string') return null;
    values[key] = value;
    at = AI_ATTRIBUTE.lastIndex;
  }
  return { depth: open[1].length, prompt: values.prompt ?? '', generated: values.generated ?? '' };
}

/**
 * One attribute's value as the opening line holds it: a JSON string.
 *
 * `JSON.stringify` escapes `"`, `\` and the control characters, and leaves
 * U+2028 and U+2029 as they are — legal in JSON, and with `\n` and `\r` the
 * characters `.` will not match, so `AI_OPEN` stopped reading the line at
 * one: a question holding a line or paragraph separator was written raw, and
 * its block reopened as paragraphs. Escaped, `JSON.parse` reads them back.
 */
const attributeValue = (value: string): string =>
  JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/** The opening line an AI block at this marker depth is written with. */
export function formatAiMarker(depth: number, props: Omit<AiMarker, 'depth'>): string {
  const set = AI_ATTRIBUTES.filter((key) => props[key] !== '').map(
    (key) => `${key}=${attributeValue(props[key])}`,
  );
  return `${':'.repeat(depth)}ai${set.length === 0 ? '' : `{${set.join(' ')}}`}`;
}

/** Is this one line a marker some marker reader would take — a column's, or an AI block's? */
const isMarkerLine = (line: string): boolean =>
  parseColumnMarker(line) !== null || parseAiMarker(line) !== null;

/**
 * A placeholder spelling no file will hold — fresh for every call, and nothing
 * but letters, digits and hyphens, which the parser and serializer pass
 * through untouched.
 */
const placeholderPrefix = (): string =>
  `cerebro-line-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}-`;

/** A line lifted out of a file on the way in: an AI opening line, or an escaped column marker. */
interface Lifted {
  line: string;
  /** What an AI opening line says. Unset for an escaped column marker, which is text. */
  ai?: AiMarker;
}

/** The lines lifted out of one file, by the placeholder written in each one's place. */
interface LiftedLines {
  prefix: string;
  lines: Map<string, Lifted>;
}

/** `\:::columns` — a column marker written as text (`escapeMarkerLines`). */
const isEscapedColumnMarker = (line: string): boolean =>
  line.startsWith('\\') && parseColumnMarker(line.slice(1)) !== null;

/**
 * Swap two kinds of line for placeholders before the parse.
 *
 * An AI block's opening line never meets the markdown parser — nor, on the
 * way out (`restoreSetAside`), the serializer. A question is free text and
 * both sides read text as markdown: MEASURED, a prompt holding `*why*` came
 * back from the parser as emphasis with its asterisks gone, `<div>` was
 * dropped as HTML, a `\"` lost its backslash, and the serializer collapsed
 * every run of spaces. The placeholder carries only an index, so the line's
 * bytes stay this module's alone. It gets blank lines round it, which is what
 * `loosenColumnMarkers` does for the column markers: the parser only gives a
 * line its own paragraph when it is blank-line separated.
 *
 * An ESCAPED column marker is text, but the parser reads `\:::columns` back as
 * `:::columns`, which the fold — it reads the column markers off paragraph
 * text — would take for a marker. Its placeholder stands exactly where the
 * line stood, with no blank lines, so a paragraph it belongs to stays one
 * paragraph, and the text goes back after the fold (`restorePlaceholders`).
 * An escaped AI line needs neither: it is not lifted, so nothing reads it as
 * one.
 *
 * Fenced code is skipped (`fenceReader`): a marker in a fence is somebody's
 * example of this syntax.
 */
function liftMarkers(markdown: string): { text: string; lifted: LiftedLines } {
  const lifted: LiftedLines = { prefix: placeholderPrefix(), lines: new Map() };
  const read = fenceReader();
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    const code = read(line) !== 'text';
    const ai = code ? null : parseAiMarker(line);
    if (code || (ai === null && !isEscapedColumnMarker(line))) {
      out.push(line);
      continue;
    }
    const placeholder = `${lifted.prefix}${lifted.lines.size}`;
    if (ai === null) {
      lifted.lines.set(placeholder, { line });
      out.push(placeholder);
    } else {
      lifted.lines.set(placeholder, { line, ai });
      out.push('', placeholder, '');
    }
  }
  return { text: out.join('\n'), lifted };
}

/** The marker lines `demoteContainers` set aside, by the placeholder written in each one's place. */
interface SetAside {
  prefix: string;
  lines: Map<string, string>;
}

/** Put each set-aside marker line back where its placeholder was written. */
function restoreSetAside(markdown: string, setAside: SetAside): string {
  if (setAside.lines.size === 0) return markdown;
  return markdown.replace(
    new RegExp(`${setAside.prefix}\\d+`, 'g'),
    (placeholder) => setAside.lines.get(placeholder) ?? placeholder,
  );
}

/**
 * Put a backslash in front of every line outside fenced code that a marker
 * reader would take for a marker (M53.9).
 *
 * Run on the serializer's output while every marker of our own is still a
 * placeholder, so each line it finds is text that only looks like one: `:::`
 * typed on a line of its own, or an answer quoting the page's carrier.
 * MEASURED before it: an answer holding a bare `:::columns` line was written
 * that way, and the next open read it as a layout that never closed and
 * showed every container on the page as raw marker text. Escaped, it reads as
 * the same text in any editor and stays text here.
 */
export function escapeMarkerLines(markdown: string): string {
  const read = fenceReader();
  return markdown
    .split('\n')
    .map((line) => (read(line) === 'text' && isMarkerLine(line) ? `\\${line}` : line))
    .join('\n');
}

/**
 * Drop the blank lines just under an AI block's opening line, inside the block.
 *
 * The AI half of `tightenColumnMarkers`, which already drops the blank before
 * the block's close (a close is a close, whoever opened it) but cannot see the
 * opening line, because it is not a column marker. The blank BEFORE the
 * opening line is the author's paragraph break and stays, as it does before a
 * `:::columns`.
 */
function tightenAiMarkers(markdown: string): string {
  const out: string[] = [];
  const read = fenceReader();
  let afterOpen = false;
  for (const line of markdown.split('\n')) {
    const text = read(line) === 'text';
    if (line === '' && afterOpen) continue;
    if (line !== '') afterOpen = text && parseAiMarker(line) !== null;
    out.push(line);
  }
  return out.join('\n');
}

/** A fence that says it holds markdown — ```markdown or ```md, in any case. */
const MARKDOWN_FENCE = /^(`{3,}|~{3,})[ \t]*(?:markdown|md)[ \t]*$/i;
/** A line that is a fence and nothing else. */
const BARE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * An agent's reply, without the one fence wrapped round ALL of it if it has
 * one (M53.9).
 *
 * The run asks for markdown with no code fence, and a reply sometimes comes
 * back as one fenced block anyway. Only that fence is taken off: a fence that
 * closes on the reply's last line and nowhere before it. The regex this
 * replaced stripped a fence line from each END of the reply, so a reply that
 * opened with one code block and closed with another lost one line of each:
 * the fence left open read the prose between them as code.
 *
 * A markdown fence is the exception, because a markdown reply holds code
 * blocks of its own, and the first of them closes the wrapper as CommonMark
 * reads it — which left the wrapper on, the whole answer one code block. One
 * on the first line, with a bare fence of the same character and at least its
 * length on the last, comes off however many fences sit between them, as long
 * as every one of those closes again: taking it off must not leave a fence
 * open.
 */
export function unwrapReplyFence(reply: string): string {
  const trimmed = reply.trim();
  const lines = trimmed.split('\n');
  const inner = lines.slice(1, -1);
  const open = MARKDOWN_FENCE.exec(lines[0])?.[1];
  const close = lines.length > 1 ? BARE_FENCE.exec(lines[lines.length - 1])?.[1] : undefined;
  if (
    open !== undefined &&
    close !== undefined &&
    close[0] === open[0] &&
    close.length >= open.length
  ) {
    const readInner = fenceReader();
    const end = inner.map((line) => readInner(line)).pop();
    if (end !== 'open' && end !== 'code') return inner.join('\n');
  }
  const read = fenceReader();
  const kinds = lines.map((line) => read(line));
  if (kinds[0] !== 'open' || kinds.indexOf('close') !== lines.length - 1) return trimmed;
  return inner.join('\n');
}

/**
 * A paragraph's text if it is nothing but plain text, or null (M53.9) — the
 * only text a marker can be read from.
 *
 * A marker line is plain text, so a paragraph holding anything else is not
 * one: a link, a chip, any style. `blockText` reads text and drops the rest,
 * and read through it `::: [a link](…)`, `**:::**`, `` `:::columns` `` and
 * `::: [[kickoff]]` were all markers. MEASURED: on the way in a code span of
 * `:::columns` opened a live layout and a code span of `:::` ended an AI block
 * early; on the way out a paragraph the fold had kept was written back as the
 * bare marker, its link or chip deleted. Anything else is text, which the
 * serializer writes and `escapeMarkerLines` still guards.
 */
function markerText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const node of content) {
    if (!isTextNode(node) || Object.values(node.styles ?? {}).some(Boolean)) return null;
    text += node.text;
  }
  return text;
}

/** The marker a paragraph IS, or null if the block is anything else (`markerText`). */
function markerOfBlock(block: PartialBlock): ColumnMarker | null {
  const b = block as { type?: string; content?: unknown; children?: PartialBlock[] };
  if (b.type !== 'paragraph') return null;
  if (Array.isArray(b.children) && b.children.length > 0) return null;
  const text = markerText(b.content);
  return text === null ? null : parseColumnMarker(text);
}

/** The lifted AI opening line a paragraph stands in for, or undefined. */
function liftedAiOf(block: PartialBlock, lifted: LiftedLines): Required<Lifted> | undefined {
  const b = block as { type?: string; content?: unknown; children?: PartialBlock[] };
  if (lifted.lines.size === 0 || b.type !== 'paragraph') return undefined;
  if (Array.isArray(b.children) && b.children.length > 0) return undefined;
  const text = markerText(b.content);
  const entry = text === null ? undefined : lifted.lines.get(text);
  return entry?.ai === undefined ? undefined : { line: entry.line, ai: entry.ai };
}

const KEPT_MARKER = 'kept-marker-';

/**
 * Ids for the paragraphs that hold a marker line the FILE has and the fold
 * could not use (M53.9): a stray close, a column outside any list, or every
 * marker on a page whose fold was abandoned.
 *
 * Text that only looks like a marker is escaped on the way out, so it stays
 * text. These must not be: they are the file's markers, and the file is the
 * source of truth (M48 §6). Escaped, one stray `:::` would turn every
 * container on its page into text for good, on whatever save came next. So
 * the fold marks them, and `demoteContainers` writes each one back exactly as
 * it was, for as long as it is still nothing but marker text (`markerText`) —
 * an AI opening line round the serializer, which collapsed every run of spaces
 * in its question while the line was saved as ordinary text.
 *
 * The id is how the mark rides through the editor: BlockNote keeps the id a
 * block is inserted with, and keeps it while the block is edited or moved.
 */
const keptMarkerIds = (): (() => string) => {
  const prefix = `${KEPT_MARKER}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}-`;
  let next = 0;
  return () => `${prefix}${next++}`;
};

const isKeptMarker = (block: PartialBlock): boolean =>
  typeof block.id === 'string' && block.id.startsWith(KEPT_MARKER);

/**
 * Fold a flat run of marker paragraphs into `columnList` / `column` / `ai`
 * blocks — one stack for all three, because they nest inside each other and a
 * close belongs to whichever container is innermost.
 *
 * Tolerance is the whole design here, and it is asymmetric on purpose:
 *
 * - A stray close, or a `::::column` outside any list, stays the PARAGRAPH it
 *   already is, kept (`keptMarkerIds`). The reader sees the marker text and
 *   can fix the file.
 * - An UNCLOSED container abandons the fold entirely and returns the document
 *   as it arrived — every marker a kept paragraph, and every AI opening line
 *   back as the text it was. A half-built nest could silently swallow every
 *   block after the opening marker into a container nobody can see the end
 *   of, and losing sight of somebody's writing is worse than showing them a
 *   `:::`.
 */
function promoteContainers<T extends PartialBlock>(blocks: T[], lifted: LiftedLines): T[] {
  type Frame = { depth: number; kind: 'list' | 'column' | 'ai'; children: PartialBlock[] };
  const keptId = keptMarkerIds();
  const kept = (block: PartialBlock): PartialBlock => ({ ...block, id: keptId() });
  const out: PartialBlock[] = [];
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  const target = (): PartialBlock[] => top()?.children ?? out;
  const open = (kind: Frame['kind'], depth: number, node: Record<string, unknown>) => {
    const children: PartialBlock[] = [];
    target().push({ ...node, children } as unknown as PartialBlock);
    stack.push({ depth, kind, children });
  };

  for (const block of blocks) {
    const opening = liftedAiOf(block, lifted);
    if (opening !== undefined) {
      const { depth, prompt, generated } = opening.ai;
      open('ai', depth, { type: 'ai', props: { prompt, generated } });
      continue;
    }
    const marker = markerOfBlock(block);
    if (marker === null) {
      target().push(block);
      continue;
    }
    if (marker.kind === 'open-list') {
      open('list', marker.depth, { type: 'columnList' });
      continue;
    }
    if (marker.kind === 'open-column') {
      // A column outside a list has no row to sit in. Left as text rather than
      // invented a container for: the file says something we do not understand,
      // and guessing at it is how an editor eats a document.
      if (top()?.kind !== 'list') {
        target().push(kept(block));
        continue;
      }
      open('column', marker.depth, { type: 'column', props: { width: marker.width } });
      continue;
    }
    if (top()?.depth === marker.depth) {
      stack.pop();
      continue;
    }
    target().push(kept(block));
  }

  if (stack.length === 0) return out as T[];
  return blocks.map((block) => {
    const opening = liftedAiOf(block, lifted);
    if (opening !== undefined) {
      const text = [{ type: 'text', text: opening.line, styles: {} }];
      return kept({ ...block, content: text } as unknown as PartialBlock);
    }
    return markerOfBlock(block) === null ? block : kept(block);
  }) as T[];
}

/**
 * Every placeholder still in the document, back to the line it stood for — so
 * none can reach the screen or the disk.
 *
 * `'code'` runs straight after the parse, on code text, before a ```mermaid or
 * database fence is promoted out of its code block. A placeholder there is a
 * line the fence reader took for text and the parser put in code (the
 * disagreements `fenceReader` names): it goes back exactly, and an AI line
 * takes the two blank lines the lift put round it with it.
 *
 * `'text'` runs after the fold, on inline text: an escaped column marker
 * becomes the text the parser would have read (`:::columns`), and an AI line
 * anywhere but on its own at the top of the page becomes its line.
 */
function restorePlaceholders<T extends PartialBlock>(
  blocks: T[],
  lifted: LiftedLines,
  where: 'code' | 'text',
): T[] {
  if (lifted.lines.size === 0) return blocks;
  const pattern = new RegExp(`${lifted.prefix}\\d+`, 'g');
  const asText = (text: string): string =>
    text.replace(pattern, (placeholder) => {
      const entry = lifted.lines.get(placeholder);
      if (entry === undefined) return placeholder;
      return entry.ai === undefined ? entry.line.slice(1) : entry.line;
    });
  const inCode = (text: string): string => {
    const lines = text.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const entry = lifted.lines.get(lines[i]);
      if (entry !== undefined && entry.ai !== undefined) {
        if (out[out.length - 1] === '') out.pop();
        if (lines[i + 1] === '') i += 1;
      }
      out.push(entry?.line ?? lines[i]);
    }
    return out.join('\n');
  };
  const inline = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) inline(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Record<string, unknown>;
    if (typeof node.text === 'string') node.text = asText(node.text);
    if ('content' in node) inline(node.content);
    if ('rows' in node) inline(node.rows);
    if ('cells' in node) inline(node.cells);
  };
  for (const block of blocks) {
    const b = block as { type?: string; content?: unknown; children?: PartialBlock[] };
    if (b.type === 'codeBlock') {
      if (where === 'code' && Array.isArray(b.content)) {
        for (const node of b.content as { text?: unknown }[]) {
          if (typeof node.text === 'string') node.text = inCode(node.text);
        }
      }
    } else if (where === 'text') {
      inline(b.content);
    }
    if (Array.isArray(b.children)) restorePlaceholders(b.children, lifted, where);
  }
  return blocks;
}

/**
 * The colons an AI block's markers take: its nesting depth, unless a kept
 * marker in its answer (`keptMarkerIds`) is a close at that depth.
 *
 * A kept marker is written back as the marker it is, so a close at the
 * block's own depth would end the block early when the file is read back, and
 * the rest of the answer would spill out below it. The block steps past every
 * depth such a line uses, the way a code fence lengthens past the backticks
 * inside it. Text that only looks like a close needs no room: it is escaped
 * on the way out.
 */
function aiMarkerDepth(answer: PartialBlock[], depth: number): number {
  const taken = new Set<number>();
  for (const block of answer) {
    const marker = isKeptMarker(block) ? markerOfBlock(block) : null;
    if (marker?.kind === 'close') taken.add(marker.depth);
  }
  let colons = depth;
  while (taken.has(colons)) colons += 1;
  return colons;
}

/**
 * Flatten the nest back into marker paragraphs.
 *
 * Marker depth grows with nesting depth so an inner container's close can
 * never be read as the outer one's — the property `parseColumnMarker` keeps
 * and `promoteContainers` relies on.
 *
 * Every marker line is set aside in `setAside` and written as a placeholder,
 * which `restoreSetAside` swaps back after serialization: an AI opening line
 * so the serializer never reads its question, and all of them so that
 * `escapeMarkerLines`, which runs in between, can tell them from text that
 * only looks like a marker. A kept marker goes the same way, exactly as the
 * file had it.
 */
function demoteContainers<T extends PartialBlock>(
  blocks: T[],
  depth: number,
  setAside: SetAside,
): T[] {
  const marker = (line: string): PartialBlock => {
    const placeholder = `${setAside.prefix}${setAside.lines.size}`;
    setAside.lines.set(placeholder, line);
    return {
      type: 'paragraph',
      content: [{ type: 'text', text: placeholder, styles: {} }],
    } as unknown as PartialBlock;
  };
  const out: PartialBlock[] = [];
  for (const block of blocks) {
    const b = block as {
      type?: string;
      props?: Record<string, unknown>;
      content?: unknown;
      children?: PartialBlock[];
    };
    if (b.type === 'columnList') {
      out.push(marker(openListMarker(depth)));
      for (const child of b.children ?? []) {
        const column = child as {
          type?: string;
          props?: Record<string, unknown>;
          children?: PartialBlock[];
        };
        // Only a hand-edited file puts anything else in a row (text between
        // two columns lands there). Written as it is, so it comes back where
        // it was: written as a column it came back an EMPTY column, its own
        // text gone.
        if (column.type !== 'column') {
          out.push(...demoteContainers([child], depth + 1, setAside));
          continue;
        }
        const width =
          typeof column.props?.width === 'number' ? column.props.width : DEFAULT_COLUMN_WIDTH;
        out.push(marker(openColumnMarker(depth + 1, width)));
        out.push(
          ...demoteContainers((column.children ?? []) as PartialBlock[], depth + 2, setAside),
        );
        out.push(marker(closeMarker(depth + 1)));
      }
      out.push(marker(closeMarker(depth)));
      continue;
    }
    if (b.type === 'ai') {
      const answer = b.children ?? [];
      const colons = aiMarkerDepth(answer, depth);
      out.push(
        marker(
          formatAiMarker(colons, {
            prompt: typeof b.props?.prompt === 'string' ? b.props.prompt : '',
            generated: typeof b.props?.generated === 'string' ? b.props.generated : '',
          }),
        ),
      );
      out.push(...demoteContainers(answer, colons + 1, setAside));
      out.push(marker(closeMarker(colons)));
      continue;
    }
    // A kept paragraph somebody has linked, styled or put a chip in is not a
    // marker any more (`markerText`): it falls through and is written as the
    // text it now is.
    const keptLine = b.type === 'paragraph' && isKeptMarker(block) ? markerText(b.content) : null;
    if (keptLine !== null && isMarkerLine(keptLine)) {
      const line = marker(keptLine);
      const children = b.children ?? [];
      out.push(
        children.length === 0
          ? line
          : ({ ...line, children: demoteContainers(children, depth, setAside) } as PartialBlock),
      );
      continue;
    }
    if (Array.isArray(b.children) && b.children.length > 0) {
      out.push({
        ...b,
        children: demoteContainers(b.children, depth, setAside),
      } as unknown as PartialBlock);
      continue;
    }
    out.push(block);
  }
  return out as T[];
}

/**
 * Footnote citations, kept as the text they are on disk (M50.1).
 *
 * OKF cites a concept's sources with `[^id]` and defines them as `[^id]: …`.
 * Concepts open in this editor now, and the GFM parser read those as
 * footnotes: it rewrote the reference into `[1](#user-content-fn-id)` and the
 * definitions into a generated "Footnotes" list — so opening a concept either
 * rewrote its citations on the next save or, via the lossy-import check,
 * locked it read-only. Escaped before the parse they stay text, which
 * `enrichChips` then promotes into citation chips (M51.5); the chips write the
 * same text back, the serializer writes text brackets escaped, and
 * `restoreFootnotes` takes exactly that escape back off. Code — fenced or
 * inline — is never touched.
 */
function mapOutsideCode(markdown: string, map: (text: string) => string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // Odd segments of a backtick split are inline code.
      return line
        .split('`')
        .map((part, i) => (i % 2 === 0 ? map(part) : part))
        .join('`');
    })
    .join('\n');
}

export function protectFootnotes(markdown: string): string {
  return mapOutsideCode(markdown, (text) => text.replace(/(?<!\\)\[\^([^\]\s]+)\]/g, '\\[^$1]'));
}

export function restoreFootnotes(markdown: string): string {
  return joinDefinitionRuns(
    mapOutsideCode(markdown, (text) => text.replace(/\\\[\^([^\]\s\\]+)\\?\]/g, '[^$1]')),
  );
}

/** A line that opens a footnote definition, once its escape is off. */
const DEFINITION_LINE = /^[ \t]*\[\^[^\]\s]+\]:/;

/**
 * Put a run of definitions back on consecutive lines (M51.5).
 *
 * OKF writes definitions one per line with nothing between them, which the
 * parser reads as ONE paragraph with soft breaks — and the serializer writes
 * every break inside a paragraph as a hard one, a trailing `\`. In the file's
 * own terms that backslash is no break at all: GFM ends a definition where the
 * next one begins, so it reads as a literal `\` at the end of every definition
 * but the last. Taken back off, the run is byte for byte what was read.
 *
 * Only the break directly above a definition line goes. Every other break in
 * a paragraph stays the hard break it has been since M2.
 */
function joinDefinitionRuns(markdown: string): string {
  const lines = markdown.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // An odd run of trailing backslashes ends in a break; an even run is
    // escaped backslashes, which are text.
    const trailing = /\\+$/.exec(line)?.[0].length ?? 0;
    if (trailing % 2 === 1 && DEFINITION_LINE.test(lines[i + 1])) lines[i] = line.slice(0, -1);
  }
  return lines.join('\n');
}

export async function markdownToBlocks(editor: AnyEditor, markdown: string): Promise<AnyBlocks> {
  // Lift and loosen FIRST: the parser only gives each `:::` marker its own
  // paragraph when the markers are blank-line separated, and collapses a tight
  // run of them into one paragraph with soft breaks. The file on disk is the
  // tight form, because nobody wants to read a page that is half blank lines —
  // except between two layouts in a row, where the blank is the author's
  // (see `tightenColumnMarkers`).
  const { text, lifted } = liftMarkers(markdown);
  const source = protectFootnotes(loosenColumnMarkers(text));
  const parsed = restorePlaceholders(
    normalizeParsedBlocks((await editor.tryParseMarkdownToBlocks(source)) as PartialBlock[]),
    lifted,
    'code',
  );
  return restorePlaceholders(
    promoteContainers(promoteRichBlocks(enrichChips(parsed)), lifted),
    lifted,
    'text',
  ) as AnyBlocks;
}

export async function blocksToMarkdown(
  editor: AnyEditor,
  blocks?: PartialBlock[],
): Promise<string> {
  const source = (blocks ?? editor.document) as PartialBlock[];
  const setAside: SetAside = { prefix: placeholderPrefix(), lines: new Map() };
  // Deep copy: demotion must never touch live editor state. Every custom
  // block and chip is plain markdown before the serializer sees it, because
  // the serializer renders whatever is left — and inside the unmount flush
  // nothing renders (see `demoteChips`).
  const demoted = demoteChips(
    demoteRichBlocks(
      demoteContainers(
        JSON.parse(JSON.stringify(source)) as PartialBlock[],
        BASE_MARKER_DEPTH,
        setAside,
      ),
    ),
  );
  return tightenAiMarkers(
    tightenColumnMarkers(
      restoreSetAside(
        escapeMarkerLines(
          restoreFootnotes(unescapeChipMarkdown(await editor.blocksToMarkdownLossy(demoted))),
        ),
        setAside,
      ),
    ),
  );
}

/**
 * Mirror of write.rs replace_h1 at the block level: rewrite the first H1
 * block in the LIVE editor, or insert one at the top when the document has
 * none. Applied after a successful rename so a later body save can't write
 * the old title back over the renamed file (M1.x stale-body-after-rename
 * policy). Fence-awareness is inherent — code fences are codeBlock blocks,
 * never headings.
 */
/**
 * Does the live document carry its own title? A note's title IS its first H1
 * — that is what the scanner reads. When there is none the scanner falls back
 * to the filename, and the document itself shows the title nowhere (M15).
 */
export function hasTitleBlock(editor: AnyEditor): boolean {
  return editor.document.some(
    (b) => b.type === 'heading' && (b.props as { level?: number }).level === 1,
  );
}

export function spliceTitleIntoBlocks(editor: AnyEditor, title: string): void {
  const h1 = editor.document.find(
    (b) => b.type === 'heading' && (b.props as { level?: number }).level === 1,
  );
  if (h1 !== undefined) {
    editor.updateBlock(h1, { content: title });
    return;
  }
  const first = editor.document[0];
  if (first === undefined) return; // live editors always hold >= 1 block
  editor.insertBlocks([{ type: 'heading', props: { level: 1 }, content: title }], first, 'before');
}

const significantChars = (s: string): string => s.normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * True when the parse→serialize round trip lost textual content — e.g. raw
 * HTML blocks, which BlockNote drops entirely. Formatting normalization
 * (bullet chars, escapes, padding) compares equal because only letters and
 * digits are considered. Consumers surface a warning before edits overwrite
 * the file.
 */
export function isLossyImport(source: string, roundTripped: string): boolean {
  return significantChars(roundTripped) !== significantChars(source);
}
