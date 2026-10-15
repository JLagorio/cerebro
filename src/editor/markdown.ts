import type { BlockNoteEditor, PartialBlock } from '@blocknote/core';
import { DATABASE_FENCE, parseDatabaseRef, serializeDatabaseRef } from '@/engine/databaseBlock';
import { SUBPAGES_FENCE } from '@/engine/docPages';
import { PAGE_CARD_FENCE, parsePageRef, serializePageRef } from '@/engine/pageCard';
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
import {
  formatMediaLine,
  mediaKindOf,
  parseMediaLine,
  readMediaAt,
  type MediaKind,
  type PageMedia,
} from '@/engine/pageMedia';

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
 * by construction, and was not built. So inside emphasis the marker reads as
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

/** A chip's plain-text form, or null for anything that is not a chip. Reader
 * text (readerText.ts, M70.1) spells a chip with it too, so a comment's quote
 * reads a chip the way the file does. */
export function chipText(item: unknown): string | null {
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

// --- Callout / mermaid / database / sub-pages / page card round-trip --------
// On disk a callout is an Obsidian-style `> [!info] …` quote, a diagram is a
// ```mermaid fence, an embedded database is a ```cerebro-database fence
// holding a pointer (M47.2), a child-page list is an EMPTY ```cerebro-subpages
// fence (M55.13), and a page card is a ```cerebro-page fence holding one
// wikilink (M55.14). promoteRichBlocks upgrades those plain forms into the
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
    // Only an EMPTY fence is the list: one holding text stays the code block
    // it is, so promoting it can never replace a word anyone wrote.
    if (
      b.type === 'codeBlock' &&
      (b.props as { language?: string })?.language === SUBPAGES_FENCE &&
      blockText(b.content) === ''
    ) {
      return { type: 'subPages', props: {} } as unknown as T;
    }
    // An empty fence is the unset card and one link is a set one; anything
    // else stays the code block it is, holding exactly what was typed.
    if (
      b.type === 'codeBlock' &&
      (b.props as { language?: string })?.language === PAGE_CARD_FENCE
    ) {
      const ref = parsePageRef(blockText(b.content));
      if (ref !== null) return { type: 'pageCard', props: ref } as unknown as T;
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
    // Read off the type alone, never the rendering (DOM trap 10): the list is
    // derived, so the fence holds nothing.
    if (b.type === 'subPages') {
      return {
        type: 'codeBlock',
        props: { language: SUBPAGES_FENCE },
        content: [],
      } as unknown as T;
    }
    // The pointer exactly as held: never re-resolved, never made a path, and
    // read off the props alone, never the rendering (DOM trap 10).
    if (b.type === 'pageCard') {
      const text = serializePageRef({
        target: typeof b.props?.target === 'string' ? b.props.target : '',
        alias: typeof b.props?.alias === 'string' ? b.props.alias : '',
      });
      return {
        type: 'codeBlock',
        props: { language: PAGE_CARD_FENCE },
        content: text === '' ? [] : [{ type: 'text', text, styles: {} }],
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

// --- Containers: columns (M48.2), the AI block (M53.9), toggles, nested -----
// --- children and media (M55.4) ---------------------------------------------
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
// M55.4 gave every other block the `/` menu offers a carrier the same way
// (the markdown.test.ts describe that walks the menu holds it):
//
//   :::toggle The summary, any inline markdown     a toggle list item
//   ::::toggle-heading                             a heading that folds, its
//   ## The heading                                 own line kept a real heading
//   ::::                                           (the colons step with depth)
//   :::indent                                      the children of the block
//   :::                                            just above it (Tab-nesting)
//   ![name|300](attachments/a.png "Caption")       an image, video, audio clip
//                                                  or file, by its extension
//
// BlockNote's serializer kept none of them: a toggle wrote a bullet, a child
// of anything but a list item was flattened into its parent's flow, and media
// wrote invented alt text ("BlockNote image") or a bare link.
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

const TOGGLE_OPEN = /^(:{3,})toggle(?:[ \t]+(.*?))?[ \t]*$/;
const TOGGLE_HEADING_OPEN = /^(:{3,})toggle-heading[ \t]*$/;
const INDENT_OPEN = /^(:{3,})indent[ \t]*$/;

/** What a toggle list item's opening line says: its depth, and its summary as markdown. */
export interface ToggleOpener {
  depth: number;
  summary: string;
}

/**
 * Read one line as a toggle list item's opening line (M55.4), or null. The
 * summary is the rest of the line, inline markdown; a summary with a hard
 * break goes on over the lines after it (`liftMarkers` joins them).
 */
export function parseToggleOpener(line: string): ToggleOpener | null {
  const open = TOGGLE_OPEN.exec(line);
  return open === null ? null : { depth: open[1].length, summary: open[2] ?? '' };
}

/** The opening line of a toggle list item at this depth. */
export const formatToggleOpener = (depth: number, summary: string): string =>
  `${':'.repeat(depth)}toggle${summary === '' ? '' : ` ${summary}`}`;

/** Read one line as a toggle heading's opening line (M55.4): its depth, or null. */
export function parseToggleHeadingOpener(line: string): number | null {
  const open = TOGGLE_HEADING_OPEN.exec(line);
  return open === null ? null : open[1].length;
}

export const formatToggleHeadingOpener = (depth: number): string =>
  `${':'.repeat(depth)}toggle-heading`;

/** Read one line as a nested-children opening line (M55.4): its depth, or null. */
export function parseIndentOpener(line: string): number | null {
  const open = INDENT_OPEN.exec(line);
  return open === null ? null : open[1].length;
}

export const formatIndentOpener = (depth: number): string => `${':'.repeat(depth)}indent`;

/**
 * Is this a marker some marker reader would take: a column's, or one of the
 * openers? A kept toggle opener can run over several lines (a hard break in
 * its summary), and is judged by its first.
 */
const isMarkerLine = (text: string): boolean => {
  const line = text.split('\n')[0];
  return (
    parseColumnMarker(line) !== null ||
    parseAiMarker(line) !== null ||
    parseToggleOpener(line) !== null ||
    parseToggleHeadingOpener(line) !== null ||
    parseIndentOpener(line) !== null
  );
};

/** A line a fence could open on. */
const FENCE_START = /^[ \t]*(`{3,}|~{3,})/;

/** An odd run of trailing backslashes: the line ends in a hard break. */
const endsInBreak = (line: string): boolean => (/\\+$/.exec(line)?.[0].length ?? 0) % 2 === 1;

/**
 * A placeholder spelling no file will hold — fresh for every call, and nothing
 * but letters, digits and hyphens, which the parser and serializer pass
 * through untouched.
 */
const placeholderPrefix = (): string =>
  `cerebro-line-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}-`;

/**
 * A line lifted out of a file on the way in, by kind: an escaped column
 * marker (text), one of the openers, or a media line.
 */
type Lifted =
  | { kind: 'column'; line: string }
  | { kind: 'ai'; line: string; ai: AiMarker }
  | {
      kind: 'toggle';
      line: string;
      depth: number;
      summary: string;
      /** The summary read as inline content; null when it is not one paragraph. */
      content?: unknown[] | null;
    }
  | { kind: 'toggleHeading'; line: string; depth: number }
  | { kind: 'indent'; line: string; depth: number }
  | { kind: 'media'; line: string; media: PageMedia };

type Opener = Extract<Lifted, { kind: 'ai' | 'toggle' | 'toggleHeading' | 'indent' }>;

/** An image the parser will read itself, with its destination swapped for a token. */
interface SwappedSource {
  /** The embed exactly as the file wrote it. */
  raw: string;
  media: PageMedia;
}

/** The lines lifted out of one file, by the placeholder written in each one's place. */
interface LiftedLines {
  prefix: string;
  lines: Map<string, Lifted>;
  /** Swapped image destinations, by token (`swapSources`). */
  sources: Map<string, SwappedSource>;
}

/** `\:::columns` — a column marker written as text (`escapeMarkerLines`). */
const isEscapedColumnMarker = (line: string): boolean =>
  line.startsWith('\\') && parseColumnMarker(line.slice(1)) !== null;

/** The opener or media line a whole line is, or null. */
function liftedKindOf(line: string): Exclude<Lifted, { kind: 'column' }> | null {
  const ai = parseAiMarker(line);
  if (ai !== null) return { kind: 'ai', line, ai };
  const toggle = parseToggleOpener(line);
  if (toggle !== null) return { kind: 'toggle', line, ...toggle };
  const heading = parseToggleHeadingOpener(line);
  if (heading !== null) return { kind: 'toggleHeading', line, depth: heading };
  const indent = parseIndentOpener(line);
  if (indent !== null) return { kind: 'indent', line, depth: indent };
  const media = parseMediaLine(line);
  if (media !== null) return { kind: 'media', line, media };
  return null;
}

/**
 * Swap the destination of every image embed on a line the parser will read
 * for a token (M55.4), outside code spans.
 *
 * A media line on its own is lifted, but one the parser reads itself — inside
 * a list item, say — comes back as an image block whose url is `img.src`,
 * which a browser resolves against the page: MEASURED in jsdom,
 * `* ![](attachments/a.png)` reopened as `http://localhost:3000/attachments/a.png`,
 * its title dropped. A token is an absolute url already, so it comes back as
 * written, and `promoteMedia` puts the embed's own name, url and caption back.
 */
function swapSources(line: string, lifted: LiftedLines): string {
  if (!line.includes('![')) return line;
  return line
    .split('`')
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = '';
      let at = 0;
      for (let found = part.indexOf('![', at); found !== -1; found = part.indexOf('![', at)) {
        const escapes = /\\*$/.exec(part.slice(0, found))?.[0].length ?? 0;
        const read = escapes % 2 === 0 ? readMediaAt(part, found) : null;
        if (read === null) {
          out += part.slice(at, found + 2);
          at = found + 2;
          continue;
        }
        const token = `cerebro-src:${lifted.prefix.slice('cerebro-line-'.length)}${lifted.sources.size}`;
        lifted.sources.set(token, { raw: part.slice(found, read.end), media: read.media });
        out += `${part.slice(at, found)}![](${token})`;
        at = read.end;
      }
      return out + part.slice(at);
    })
    .join('`');
}

/**
 * Swap lines for placeholders before the parse.
 *
 * An opening line — an AI block's, a toggle's, a toggle heading's or an
 * indent's — and a media line on its own never meet the markdown parser, nor,
 * on the way out (`restoreSetAside`), the serializer. A question or a summary
 * is free text and both sides read text as markdown: MEASURED, a prompt
 * holding `*why*` came back from the parser as emphasis with its asterisks
 * gone, `<div>` was dropped as HTML, a `\"` lost its backslash, and the
 * serializer collapsed every run of spaces. The placeholder carries only an
 * index, so the line's bytes stay this module's alone. It gets blank lines
 * round it, which is what `loosenColumnMarkers` does for the column markers:
 * the parser only gives a line its own paragraph when it is blank-line
 * separated. A toggle's summary that ends in a hard break (an odd run of
 * backslashes) goes on over the next line, and that line joins its entry.
 *
 * An ESCAPED column marker is text, but the parser reads `\:::columns` back as
 * `:::columns`, which the fold — it reads the column markers off paragraph
 * text — would take for a marker. Its placeholder stands exactly where the
 * line stood, with no blank lines, so a paragraph it belongs to stays one
 * paragraph, and the text goes back after the fold (`restorePlaceholders`).
 * An escaped opener needs neither: it is not lifted, so nothing reads it as
 * one.
 *
 * Every other line has its image destinations swapped (`swapSources`).
 *
 * Fenced code is skipped (`fenceReader`): a marker in a fence is somebody's
 * example of this syntax.
 */
function liftMarkers(markdown: string): { text: string; lifted: LiftedLines } {
  const lifted: LiftedLines = { prefix: placeholderPrefix(), lines: new Map(), sources: new Map() };
  const read = fenceReader();
  const out: string[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (read(line) !== 'text') {
      out.push(line);
      continue;
    }
    const placeholder = `${lifted.prefix}${lifted.lines.size}`;
    if (isEscapedColumnMarker(line)) {
      lifted.lines.set(placeholder, { kind: 'column', line });
      out.push(placeholder);
      continue;
    }
    const entry = liftedKindOf(line);
    if (entry === null) {
      out.push(swapSources(line, lifted));
      continue;
    }
    if (entry.kind === 'toggle') {
      let last = line;
      // A fence line ends the summary rather than joining it, and is left for
      // the fence reader to read in its turn.
      while (endsInBreak(last) && i + 1 < lines.length && !FENCE_START.test(lines[i + 1])) {
        i += 1;
        last = lines[i];
        read(last);
        entry.line += `\n${last}`;
        entry.summary += `\n${last}`;
      }
    }
    lifted.lines.set(placeholder, entry);
    out.push('', placeholder, '');
  }
  return { text: out.join('\n'), lifted };
}

/**
 * Read each lifted toggle's summary as inline content (M55.4), on its own,
 * through the same passes a page takes. A summary is one paragraph or
 * nothing; anything else (a `# heading`, a list) marks the entry, and the fold
 * keeps its line as the text it is.
 */
function readLiftedSummaries(editor: AnyEditor, lifted: LiftedLines): void {
  for (const entry of lifted.lines.values()) {
    if (entry.kind !== 'toggle') continue;
    if (entry.summary.trim() === '') {
      entry.content = [];
      continue;
    }
    const blocks = enrichChips(
      normalizeParsedBlocks(
        editor.tryParseMarkdownToBlocks(protectFootnotes(entry.summary)) as PartialBlock[],
      ),
    ) as { type?: string; content?: unknown; children?: unknown[] }[];
    const [only] = blocks;
    if (blocks.length === 0) entry.content = [];
    else if (
      blocks.length === 1 &&
      only.type === 'paragraph' &&
      (only.children ?? []).length === 0 &&
      Array.isArray(only.content)
    ) {
      entry.content = only.content;
    } else entry.content = null;
  }
}

/** A line at the start of a summary line that a parser would read as a block of its own. */
const BLOCK_START = [
  /^(\s*)(#{1,6}(?:[ \t]|$))/,
  /^(\s*)([>])/,
  /^(\s*)([-+*](?:[ \t]|$))/,
  /^(\s*)(`{3,}|~{3,})/,
  /^(\s*)([=-]+[ \t]*$)/,
];
const ORDERED_START = /^(\s*\d{1,9})([.)])(?=[ \t]|$)/;

/**
 * Put a backslash in front of whatever would make one line of a summary a
 * block rather than text: a heading's `#`, a quote's `>`, a list marker, a
 * fence or a setext underline. The serializer writes paragraph text raw, so a
 * summary reading `# Q4` would otherwise reopen as a heading.
 */
function escapeBlockStart(line: string): string {
  for (const start of BLOCK_START) {
    if (start.test(line))
      return line.replace(start, (_m, space: string, mark: string) => `${space}\\${mark}`);
  }
  return line.replace(ORDERED_START, '$1\\$2');
}

/**
 * Serialize every toggle's summary on the copy `blocksToMarkdown` makes,
 * before `demoteContainers` flattens it (M55.4): chips to their text, through
 * the serializer, the same escapes taken back off, and the final newline
 * dropped. A line after the first that looks like a marker is escaped, as a
 * paragraph's would be.
 */
function writeToggleSummaries(
  editor: AnyEditor,
  blocks: PartialBlock[],
  summaries: Map<object, string> = new Map(),
): Map<object, string> {
  for (const block of blocks) {
    const b = block as { type?: string; content?: unknown; children?: PartialBlock[] };
    if (b.type === 'toggleListItem') {
      const content = Array.isArray(b.content) ? b.content : [];
      const paragraph = demoteChips([{ type: 'paragraph', content } as PartialBlock]);
      const markdown = restoreFootnotes(
        unescapeChipMarkdown(editor.blocksToMarkdownLossy(paragraph)),
      ).replace(/\n$/, '');
      const [head, ...tail] = markdown.split('\n').map(escapeBlockStart);
      summaries.set(
        block,
        tail.length === 0 ? head : `${head}\n${escapeMarkerLines(tail.join('\n'))}`,
      );
    }
    if (Array.isArray(b.children)) writeToggleSummaries(editor, b.children, summaries);
  }
  return summaries;
}

/** The marker lines `demoteContainers` set aside, by the placeholder written in each one's place. */
interface SetAside {
  prefix: string;
  lines: Map<string, string>;
  /** Each toggle's summary as markdown, by its block in the copy (`writeToggleSummaries`). */
  summaries: Map<object, string>;
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
 * Drop the blank lines just under an opening line, inside its container: an
 * AI block's, a toggle heading's or an indent's, and a toggle's after the
 * last line of its summary.
 *
 * `tightenColumnMarkers` already drops the blank before a container's close
 * (a close is a close, whoever opened it) but cannot see these opening lines,
 * because they are not column markers. The blank BEFORE an opening line is the
 * author's paragraph break and stays, as it does before a `:::columns`.
 */
function tightenOpeners(markdown: string): string {
  const out: string[] = [];
  const read = fenceReader();
  let afterOpen = false;
  let summary = false;
  for (const line of markdown.split('\n')) {
    const text = read(line) === 'text';
    if (summary) {
      summary = endsInBreak(line);
      afterOpen = !summary;
      out.push(line);
      continue;
    }
    if (line === '' && afterOpen) continue;
    if (line !== '') {
      afterOpen =
        text &&
        (parseAiMarker(line) !== null ||
          parseToggleHeadingOpener(line) !== null ||
          parseIndentOpener(line) !== null ||
          parseToggleOpener(line) !== null);
      if (afterOpen && parseToggleOpener(line) !== null && endsInBreak(line)) {
        summary = true;
        afterOpen = false;
      }
    }
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

/** The lifted line a paragraph stands in for, or undefined. */
function liftedOf(block: PartialBlock, lifted: LiftedLines): Lifted | undefined {
  const b = block as { type?: string; content?: unknown; children?: PartialBlock[] };
  if (lifted.lines.size === 0 || b.type !== 'paragraph') return undefined;
  if (Array.isArray(b.children) && b.children.length > 0) return undefined;
  const text = markerText(b.content);
  return text === null ? undefined : lifted.lines.get(text);
}

/** The lifted opening line a paragraph stands in for, or undefined. */
function liftedOpenerOf(block: PartialBlock, lifted: LiftedLines): Opener | undefined {
  const entry = liftedOf(block, lifted);
  return entry === undefined || entry.kind === 'column' || entry.kind === 'media'
    ? undefined
    : entry;
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file']);

/** The props each media block has (BlockNote 0.46's prop schemas). */
const MEDIA_PROPS: Record<MediaKind, readonly string[]> = {
  image: [
    'textAlignment',
    'backgroundColor',
    'name',
    'url',
    'caption',
    'showPreview',
    'previewWidth',
  ],
  video: [
    'textAlignment',
    'backgroundColor',
    'name',
    'url',
    'caption',
    'showPreview',
    'previewWidth',
  ],
  audio: ['backgroundColor', 'name', 'url', 'caption', 'showPreview'],
  file: ['backgroundColor', 'name', 'url', 'caption'],
};

/** A media block for what a line says, typed by its extension, keeping only that type's props. */
function mediaBlock(
  media: PageMedia,
  base: { props?: Record<string, unknown>; children?: PartialBlock[] } = {},
): PartialBlock {
  const kind = mediaKindOf(media.url);
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base.props ?? {})) {
    if (MEDIA_PROPS[kind].includes(key)) props[key] = value;
  }
  props.name = media.name;
  props.url = media.url;
  props.caption = media.caption;
  delete props.previewWidth;
  if (media.width !== undefined && MEDIA_PROPS[kind].includes('previewWidth')) {
    props.previewWidth = media.width;
  }
  return { ...base, type: kind, props, children: base.children ?? [] } as unknown as PartialBlock;
}

/**
 * Make each media line a media block (M55.4), before the fold.
 *
 * A lifted media line becomes its block, typed by its extension. An image,
 * video, audio or file block the parser read itself — a media line inside a
 * list item — is retyped the same way, its url and words taken back from the
 * swapped embed when it has one (`swapSources`): BlockNote calls anything that
 * is not a video an image.
 */
function promoteMedia<T extends PartialBlock>(blocks: T[], lifted: LiftedLines): T[] {
  return blocks.map((block) => {
    const entry = liftedOf(block, lifted);
    if (entry?.kind === 'media') return mediaBlock(entry.media) as T;
    const b = block as {
      type?: string;
      props?: Record<string, unknown>;
      children?: PartialBlock[];
    };
    const children = Array.isArray(b.children) ? promoteMedia(b.children, lifted) : b.children;
    if (b.type !== undefined && MEDIA_TYPES.has(b.type)) {
      const url = typeof b.props?.url === 'string' ? b.props.url : '';
      const swapped = lifted.sources.get(url);
      const media: PageMedia = swapped?.media ?? {
        name: typeof b.props?.name === 'string' ? b.props.name : '',
        url,
        caption: typeof b.props?.caption === 'string' ? b.props.caption : '',
        ...(typeof b.props?.previewWidth === 'number' ? { width: b.props.previewWidth } : {}),
      };
      return mediaBlock(media, { ...b, children }) as T;
    }
    return (children === b.children ? block : { ...b, children }) as T;
  });
}

const KEPT_MARKER = 'kept-marker-';

/**
 * Ids for the paragraphs that hold a marker line the FILE has and the fold
 * could not use (M53.9): a stray close, a column outside any list, an opener
 * that could not be built (M55.4), or every marker on a page whose fold was
 * abandoned.
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

/** A block that cannot take an `:::indent` as its children: it has its own, or it is a column. */
const holdsOwnChildren = (block: PartialBlock | undefined): boolean => {
  const b = block as { type?: string; props?: { isToggleable?: unknown } } | undefined;
  return (
    b === undefined ||
    b.type === 'columnList' ||
    b.type === 'column' ||
    b.type === 'ai' ||
    b.type === 'toggleListItem' ||
    (b.type === 'heading' && b.props?.isToggleable === true)
  );
};

/**
 * Fold a flat run of marker paragraphs into containers — one stack for every
 * kind, because they nest inside each other and a close belongs to whichever
 * container is innermost.
 *
 * A row, a column and an AI block push their block when they open. A toggle,
 * a toggle heading and an indent push theirs when they close (M55.4), because
 * only then is it known whether they can be built: a toggle whose summary is
 * not one paragraph, a toggle heading with no heading first, an indent with
 * nothing above it to hold its children.
 *
 * Tolerance is the whole design here, and it is asymmetric on purpose:
 *
 * - A stray close, a `::::column` outside any list, or an opener that could
 *   not be built stays the PARAGRAPH it already is, kept (`keptMarkerIds`),
 *   with what it held in place after it. The reader sees the marker text and
 *   can fix the file.
 * - An UNCLOSED container abandons the fold entirely and returns the document
 *   as it arrived — every marker a kept paragraph, and every opening line
 *   back as the text it was. A half-built nest could silently swallow every
 *   block after the opening marker into a container nobody can see the end
 *   of, and losing sight of somebody's writing is worse than showing them a
 *   `:::`.
 */
function promoteContainers<T extends PartialBlock>(blocks: T[], lifted: LiftedLines): T[] {
  type Frame = {
    depth: number;
    kind: 'list' | 'column' | Opener['kind'];
    children: PartialBlock[];
    /** Where a container that pushes at its close goes, and the line it opened with. */
    parent?: PartialBlock[];
    opener?: Opener;
  };
  const keptId = keptMarkerIds();
  const kept = (block: PartialBlock): PartialBlock => ({ ...block, id: keptId() });
  const keptLine = (line: string): PartialBlock =>
    kept({
      type: 'paragraph',
      content: [{ type: 'text', text: line, styles: {} }],
    } as PartialBlock);
  const out: PartialBlock[] = [];
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  const target = (): PartialBlock[] => top()?.children ?? out;
  const open = (kind: Frame['kind'], depth: number, node: Record<string, unknown>) => {
    const children: PartialBlock[] = [];
    target().push({ ...node, children } as unknown as PartialBlock);
    stack.push({ depth, kind, children });
  };

  /** Build a container that pushes at its close, or keep its lines as the text they are. */
  const settle = (frame: Frame, close: PartialBlock): void => {
    const parent = frame.parent ?? out;
    const opener = frame.opener!;
    const [first, ...rest] = frame.children as {
      type?: string;
      props?: Record<string, unknown>;
      children?: PartialBlock[];
    }[];
    if (opener.kind === 'toggle' && Array.isArray(opener.content)) {
      parent.push({
        type: 'toggleListItem',
        content: opener.content,
        children: frame.children,
      } as unknown as PartialBlock);
      return;
    }
    if (opener.kind === 'toggleHeading' && first?.type === 'heading') {
      parent.push({
        ...first,
        props: { ...first.props, isToggleable: true },
        children: [...(first.children ?? []), ...(rest as PartialBlock[])],
      } as unknown as PartialBlock);
      return;
    }
    const previous = parent[parent.length - 1];
    if (opener.kind === 'indent' && !holdsOwnChildren(previous)) {
      // Replaced, never mutated: `previous` may be one of the blocks that
      // arrived, and an unclosed container later on rebuilds the page from
      // those (see the docblock), which must not find the children in it too.
      const p = previous as { children?: PartialBlock[] };
      parent[parent.length - 1] = {
        ...p,
        children: [...(p.children ?? []), ...frame.children],
      } as PartialBlock;
      return;
    }
    parent.push(keptLine(opener.line), ...frame.children, kept(close));
  };

  for (const block of blocks) {
    const opening = liftedOpenerOf(block, lifted);
    if (opening?.kind === 'ai') {
      const { depth, prompt, generated } = opening.ai;
      open('ai', depth, { type: 'ai', props: { prompt, generated } });
      continue;
    }
    if (opening !== undefined) {
      const { depth, kind } = opening;
      stack.push({ depth, kind, children: [], parent: target(), opener: opening });
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
      const frame = stack.pop()!;
      if (frame.opener !== undefined) settle(frame, block);
      continue;
    }
    target().push(kept(block));
  }

  if (stack.length === 0) return settleNumbering(out) as T[];
  return blocks.map((block) => {
    const opening = liftedOpenerOf(block, lifted);
    if (opening !== undefined) {
      const text = [{ type: 'text', text: opening.line, styles: {} }];
      return kept({ ...block, content: text } as unknown as PartialBlock);
    }
    return markerOfBlock(block) === null ? block : kept(block);
  }) as T[];
}

/** The number a numbered item shows, given the item before it in its parent. */
const numberOf = (block: PartialBlock, previous: number | null): number => {
  const start = (block as { props?: { start?: unknown } }).props?.start;
  return typeof start === 'number' ? start : (previous ?? 0) + 1;
};

/**
 * Drop a numbered item's `start` where it only says what the editor would
 * count anyway (M55.4): an item after an `:::indent` opens a new list on disk,
 * so it is written with the number it had (`demoteContainers`), and once the
 * indent's children are back inside the item above it the two are one list
 * again.
 */
function settleNumbering(blocks: PartialBlock[]): PartialBlock[] {
  let previous: number | null = null;
  for (const block of blocks) {
    const b = block as {
      type?: string;
      props?: Record<string, unknown>;
      children?: PartialBlock[];
    };
    if (b.type === 'numberedListItem') {
      const number = numberOf(block, previous);
      if (previous !== null && b.props?.start === previous + 1) {
        const { start: _start, ...props } = b.props;
        b.props = props;
      }
      previous = number;
    } else previous = null;
    if (Array.isArray(b.children)) settleNumbering(b.children);
  }
  return blocks;
}

/**
 * Every placeholder still in the document, back to the line it stood for — so
 * none can reach the screen or the disk.
 *
 * `'code'` runs straight after the parse, on code text, before a ```mermaid or
 * database fence is promoted out of its code block. A placeholder there is a
 * line the fence reader took for text and the parser put in code (the
 * disagreements `fenceReader` names): it goes back exactly, and a lifted
 * opener or media line takes the two blank lines the lift put round it with
 * it. A swapped image goes back as the file wrote it.
 *
 * `'text'` runs after the fold, on inline text: an escaped column marker
 * becomes the text the parser would have read (`:::columns`), and every other
 * lifted line anywhere but where the fold used it becomes its line.
 */
function restorePlaceholders<T extends PartialBlock>(
  blocks: T[],
  lifted: LiftedLines,
  where: 'code' | 'text',
): T[] {
  if (lifted.lines.size === 0 && lifted.sources.size === 0) return blocks;
  const pattern = new RegExp(`${lifted.prefix}\\d+`, 'g');
  const sourceToken = new RegExp(
    `!\\[\\]\\((cerebro-src:${lifted.prefix.slice('cerebro-line-'.length)}\\d+)\\)`,
    'g',
  );
  const sources = (text: string): string =>
    lifted.sources.size === 0
      ? text
      : text.replace(sourceToken, (token, key: string) => lifted.sources.get(key)?.raw ?? token);
  const asText = (text: string): string =>
    sources(
      text.replace(pattern, (placeholder) => {
        const entry = lifted.lines.get(placeholder);
        if (entry === undefined) return placeholder;
        return entry.kind === 'column' ? entry.line.slice(1) : entry.line;
      }),
    );
  const inCode = (text: string): string => {
    const lines = text.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const entry = lifted.lines.get(lines[i]);
      if (entry !== undefined && entry.kind !== 'column') {
        if (out[out.length - 1] === '') out.pop();
        if (lines[i + 1] === '') i += 1;
      }
      out.push(entry?.line ?? sources(lines[i]));
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
 * The colons a container's markers take: its nesting depth, unless a kept
 * marker among its children (`keptMarkerIds`) is a close at that depth.
 * Shared by the AI block, the toggles and the indent.
 *
 * A kept marker is written back as the marker it is, so a close at the
 * container's own depth would end it early when the file is read back, and
 * the rest of its children would spill out below it. The container steps past
 * every depth such a line uses, the way a code fence lengthens past the
 * backticks inside it. Text that only looks like a close needs no room: it is
 * escaped on the way out.
 */
function containerColons(children: PartialBlock[], depth: number): number {
  const taken = new Set<number>();
  for (const block of children) {
    const marker = isKeptMarker(block) ? markerOfBlock(block) : null;
    if (marker?.kind === 'close') taken.add(marker.depth);
  }
  let colons = depth;
  while (taken.has(colons)) colons += 1;
  return colons;
}

const LIST_ITEMS = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);

/**
 * Children markdown nests natively: list items all the way down. Anything
 * else under a list item — a paragraph, an image, a toggle — goes in an
 * `:::indent`, because the serializer flattens it.
 */
const isPureListTree = (children: PartialBlock[]): boolean =>
  children.every((child) => {
    const c = child as { type?: string; children?: PartialBlock[] };
    return c.type !== undefined && LIST_ITEMS.has(c.type) && isPureListTree(c.children ?? []);
  });

/**
 * Flatten the nest back into marker paragraphs.
 *
 * Marker depth grows with nesting depth so an inner container's close can
 * never be read as the outer one's — the property `parseColumnMarker` keeps
 * and `promoteContainers` relies on.
 *
 * Every marker line is set aside in `setAside` and written as a placeholder,
 * which `restoreSetAside` swaps back after serialization: an opening line so
 * the serializer never reads its question or summary, a media line so it is
 * written as the line it is, and all of them so that `escapeMarkerLines`,
 * which runs in between, can tell them from text that only looks like a
 * marker. A kept marker goes the same way, exactly as the file had it.
 *
 * Children leave their block here (M55.4): a list item keeps them natively
 * only when they are a pure list tree (`isPureListTree`); every other block
 * with children is written, then an `:::indent` holding them. An empty
 * paragraph's children, and an empty media block's, move up a level instead,
 * because the block writes nothing for an indent to follow.
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
  const indent = (children: PartialBlock[]): PartialBlock[] => {
    const colons = containerColons(children, depth);
    return [
      marker(formatIndentOpener(colons)),
      ...demoteContainers(children, colons + 1, setAside),
      marker(closeMarker(colons)),
    ];
  };
  const out: PartialBlock[] = [];
  let number: number | null = null;
  let renumber: number | null = null;
  for (const block of blocks) {
    const b = block as {
      type?: string;
      props?: Record<string, unknown>;
      content?: unknown;
      children?: PartialBlock[];
    };
    const children = b.children ?? [];
    // An item after a split list opens a new list on disk: it says the number
    // it had (`settleNumbering` takes it back off).
    if (b.type === 'numberedListItem') {
      if (renumber !== null && typeof b.props?.start !== 'number') {
        b.props = { ...b.props, start: renumber };
      }
      number = numberOf(block, number);
    } else number = null;
    renumber = null;
    if (b.type === 'columnList') {
      out.push(marker(openListMarker(depth)));
      for (const child of children) {
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
      const colons = containerColons(children, depth);
      out.push(
        marker(
          formatAiMarker(colons, {
            prompt: typeof b.props?.prompt === 'string' ? b.props.prompt : '',
            generated: typeof b.props?.generated === 'string' ? b.props.generated : '',
          }),
        ),
      );
      out.push(...demoteContainers(children, colons + 1, setAside));
      out.push(marker(closeMarker(colons)));
      continue;
    }
    if (b.type === 'toggleListItem') {
      const colons = containerColons(children, depth);
      out.push(marker(formatToggleOpener(colons, setAside.summaries.get(block) ?? '')));
      out.push(...demoteContainers(children, colons + 1, setAside));
      out.push(marker(closeMarker(colons)));
      continue;
    }
    if (b.type === 'heading' && b.props?.isToggleable === true) {
      const colons = containerColons(children, depth);
      out.push(marker(formatToggleHeadingOpener(colons)));
      out.push({
        ...b,
        props: { ...b.props, isToggleable: false },
        children: [],
      } as unknown as PartialBlock);
      out.push(...demoteContainers(children, colons + 1, setAside));
      out.push(marker(closeMarker(colons)));
      continue;
    }
    if (b.type !== undefined && MEDIA_TYPES.has(b.type)) {
      const url = typeof b.props?.url === 'string' ? b.props.url : '';
      if (url === '') {
        out.push(...demoteContainers(children, depth, setAside));
        continue;
      }
      const width = b.props?.previewWidth;
      out.push(
        marker(
          formatMediaLine({
            name: typeof b.props?.name === 'string' ? b.props.name : '',
            url,
            caption: typeof b.props?.caption === 'string' ? b.props.caption : '',
            ...(typeof width === 'number' ? { width } : {}),
          }),
        ),
      );
      if (children.length > 0) out.push(...indent(children));
      continue;
    }
    // A kept paragraph somebody has linked, styled or put a chip in is not a
    // marker any more (`markerText`): it falls through and is written as the
    // text it now is.
    const keptLine = b.type === 'paragraph' && isKeptMarker(block) ? markerText(b.content) : null;
    if (keptLine !== null && isMarkerLine(keptLine)) {
      out.push(marker(keptLine));
      if (children.length > 0) out.push(...indent(children));
      continue;
    }
    if (children.length === 0) {
      out.push(block);
      continue;
    }
    if (b.type !== undefined && LIST_ITEMS.has(b.type) && isPureListTree(children)) {
      out.push({
        ...b,
        children: demoteContainers(children, depth, setAside),
      } as unknown as PartialBlock);
      continue;
    }
    if (b.type === 'paragraph' && (!Array.isArray(b.content) || b.content.length === 0)) {
      out.push(...demoteContainers(children, depth, setAside));
      continue;
    }
    out.push({ ...b, children: [] } as unknown as PartialBlock);
    out.push(...indent(children));
    if (b.type === 'numberedListItem' && number !== null) renumber = number + 1;
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

/**
 * A note body as editor blocks, synchronously (M55.6). BlockNote 0.46 parses
 * markdown synchronously, so an outside write can be planned and applied in
 * one task, with no keystroke landing in between.
 */
export function markdownToBlocksNow(editor: AnyEditor, markdown: string): AnyBlocks {
  // Lift and loosen FIRST: the parser only gives each `:::` marker its own
  // paragraph when the markers are blank-line separated, and collapses a tight
  // run of them into one paragraph with soft breaks. The file on disk is the
  // tight form, because nobody wants to read a page that is half blank lines —
  // except between two layouts in a row, where the blank is the author's
  // (see `tightenColumnMarkers`).
  const { text, lifted } = liftMarkers(markdown);
  readLiftedSummaries(editor, lifted);
  const source = protectFootnotes(loosenColumnMarkers(text));
  const parsed = restorePlaceholders(
    normalizeParsedBlocks(editor.tryParseMarkdownToBlocks(source) as PartialBlock[]),
    lifted,
    'code',
  );
  return restorePlaceholders(
    promoteContainers(promoteMedia(promoteRichBlocks(enrichChips(parsed)), lifted), lifted),
    lifted,
    'text',
  ) as AnyBlocks;
}

/** `markdownToBlocksNow`, as a promise, for the callers that await it. It
 * runs at the call, as the async form always started to. */
export async function markdownToBlocks(editor: AnyEditor, markdown: string): Promise<AnyBlocks> {
  return markdownToBlocksNow(editor, markdown);
}

/** Blocks (the live document by default) as a note body, synchronously (M55.6). */
export function blocksToMarkdownNow(editor: AnyEditor, blocks?: PartialBlock[]): string {
  const source = (blocks ?? editor.document) as PartialBlock[];
  // Deep copy: demotion must never touch live editor state. Every custom
  // block and chip is plain markdown before the serializer sees it, because
  // the serializer renders whatever is left — and inside the unmount flush
  // nothing renders (see `demoteChips`).
  const copy = JSON.parse(JSON.stringify(source)) as PartialBlock[];
  const setAside: SetAside = {
    prefix: placeholderPrefix(),
    lines: new Map(),
    summaries: writeToggleSummaries(editor, copy),
  };
  const demoted = demoteChips(
    demoteRichBlocks(demoteContainers(copy, BASE_MARKER_DEPTH, setAside)),
  );
  return tightenOpeners(
    tightenColumnMarkers(
      restoreSetAside(
        escapeMarkerLines(
          restoreFootnotes(unescapeChipMarkdown(editor.blocksToMarkdownLossy(demoted))),
        ),
        setAside,
      ),
    ),
  );
}

/** `blocksToMarkdownNow`, as a promise, for the callers that await it. The
 * document is read at the call, so an unmount flush still serializes the
 * blocks it was handed. */
export async function blocksToMarkdown(
  editor: AnyEditor,
  blocks?: PartialBlock[],
): Promise<string> {
  return blocksToMarkdownNow(editor, blocks);
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

const CONTAINER_NAME = /^(\\?:{3,})(?:columns|column|ai|toggle-heading|toggle|indent)/;

/**
 * The text with each container's NAME taken off its marker line (M55.4),
 * outside fenced code, escaped or not: `:::indent` becomes `:::`, and the
 * rest of the line stays. A save may add a container the file did not have —
 * a hand-written list continuation comes back in an `:::indent` — and its name
 * is not a word anyone wrote.
 */
function withoutContainerNames(markdown: string): string {
  const read = fenceReader();
  return markdown
    .split('\n')
    .map((line) => (read(line) === 'text' ? line.replace(CONTAINER_NAME, '$1') : line))
    .join('\n');
}

/** The letters and digits of a text, each with how many times it appears. */
function charCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return counts;
}

/** Whether `a` holds some letter or digit more times than `b` does. */
function holdsMore(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const [ch, n] of a) if (n > (b.get(ch) ?? 0)) return true;
  return false;
}

/** An HTML tag or comment, which the parser drops (an autolink is neither). */
const RAW_HTML = /<!--|<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/][^<>]*)?>/;

/** Raw HTML outside fenced code and inline code spans. */
function hasRawHtml(markdown: string): boolean {
  const read = fenceReader();
  return markdown
    .split('\n')
    .some((line) => read(line) === 'text' && RAW_HTML.test(line.replace(/`+[^`]*`+/g, '')));
}

/**
 * Why a save from the rich editor would change a file's words (M55.15):
 *
 * - `html`: it would drop text, and the file holds raw HTML, which the
 *   parser drops whole;
 * - `dropped`: it would drop text some other markdown carried (a link
 *   reference definition, say);
 * - `added`: it would add text the file never had;
 * - `rewritten`: the same letters, in another order.
 *
 * The banner over a page opened read-only names the cause, where it once
 * blamed raw HTML for all four.
 */
export type LossyCause = 'html' | 'dropped' | 'added' | 'rewritten';

/**
 * What the parse→serialize round trip did to a file's text, or null when it
 * kept it. Formatting normalization (bullet chars, escapes, padding) is not a
 * change, because only letters and digits are compared, once the container
 * names a save adds are taken off both sides (`withoutContainerNames`); every
 * word inside a container still counts. Consumers open such a page read-only.
 */
export function lossyImportCause(source: string, roundTripped: string): LossyCause | null {
  const before = significantChars(withoutContainerNames(source));
  const after = significantChars(withoutContainerNames(roundTripped));
  if (before === after) return null;
  const [had, has] = [charCounts(before), charCounts(after)];
  if (holdsMore(had, has)) return hasRawHtml(source) ? 'html' : 'dropped';
  return holdsMore(has, had) ? 'added' : 'rewritten';
}

/** True when the round trip changed the file's text (`lossyImportCause`). */
export function isLossyImport(source: string, roundTripped: string): boolean {
  return lossyImportCause(source, roundTripped) !== null;
}
