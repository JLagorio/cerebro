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

// --- Column round-trip (M48.2) ---------------------------------------------
// On disk a column layout is a `:::columns` / `::::column` directive
// container, so a column's CONTENTS stay ordinary markdown blocks — a
// wikilink inside a column still resolves and a database fence inside one
// still renders. The markers arrive from the parser as ordinary paragraphs
// (that is what `loosenColumnMarkers` is for); `promoteColumns` folds that
// flat run back into the nest BlockNote lays out, and `demoteColumns`
// flattens it again on the way to disk.

/** The marker a paragraph IS, or null if the block is anything else. */
function markerOfBlock(block: PartialBlock): ColumnMarker | null {
  const b = block as { type?: string; content?: unknown; children?: PartialBlock[] };
  if (b.type !== 'paragraph') return null;
  if (Array.isArray(b.children) && b.children.length > 0) return null;
  return parseColumnMarker(blockText(b.content));
}

/**
 * Fold a flat run of marker paragraphs into `columnList` / `column` blocks.
 *
 * Tolerance is the whole design here, and it is asymmetric on purpose:
 *
 * - A stray close, or a `::::column` outside any list, stays the PARAGRAPH it
 *   already is. The reader sees the marker text and can fix the file.
 * - An UNCLOSED container abandons the fold entirely and returns the document
 *   exactly as it arrived. A half-built nest could silently swallow every
 *   block after the opening marker into a column nobody can see the end of,
 *   and losing sight of somebody's writing is worse than showing them a `:::`.
 */
export function promoteColumns<T extends PartialBlock>(blocks: T[]): T[] {
  type Frame = { depth: number; kind: 'list' | 'column'; children: PartialBlock[] };
  const out: PartialBlock[] = [];
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  const target = (): PartialBlock[] => top()?.children ?? out;
  let folded = false;

  for (const block of blocks) {
    const marker = markerOfBlock(block);
    if (marker === null) {
      target().push(block);
      continue;
    }
    if (marker.kind === 'open-list') {
      const node: PartialBlock = { type: 'columnList', children: [] } as unknown as PartialBlock;
      target().push(node);
      stack.push({ depth: marker.depth, kind: 'list', children: node.children as PartialBlock[] });
      folded = true;
      continue;
    }
    if (marker.kind === 'open-column') {
      // A column outside a list has no row to sit in. Left as text rather than
      // invented a container for: the file says something we do not understand,
      // and guessing at it is how an editor eats a document.
      if (top()?.kind !== 'list') {
        target().push(block);
        continue;
      }
      const node: PartialBlock = {
        type: 'column',
        props: { width: marker.width },
        children: [],
      } as unknown as PartialBlock;
      target().push(node);
      stack.push({
        depth: marker.depth,
        kind: 'column',
        children: node.children as PartialBlock[],
      });
      continue;
    }
    if (top()?.depth === marker.depth) {
      stack.pop();
      continue;
    }
    target().push(block);
  }

  if (stack.length > 0) return blocks;
  return (folded ? out : blocks) as T[];
}

/**
 * Flatten the nest back into marker paragraphs.
 *
 * Marker depth grows with nesting depth so an inner container's close can
 * never be read as the outer one's — the property `parseColumnMarker` keeps
 * and `promoteColumns` relies on.
 */
export function demoteColumns<T extends PartialBlock>(blocks: T[], depth = BASE_MARKER_DEPTH): T[] {
  const paragraph = (text: string): PartialBlock =>
    ({
      type: 'paragraph',
      content: [{ type: 'text', text, styles: {} }],
    }) as unknown as PartialBlock;
  const out: PartialBlock[] = [];
  for (const block of blocks) {
    const b = block as {
      type?: string;
      props?: Record<string, unknown>;
      children?: PartialBlock[];
    };
    if (b.type === 'columnList') {
      out.push(paragraph(openListMarker(depth)));
      for (const child of b.children ?? []) {
        const column = child as PartialBlock & {
          props?: Record<string, unknown>;
          children?: PartialBlock[];
        };
        const width =
          typeof column.props?.width === 'number' ? column.props.width : DEFAULT_COLUMN_WIDTH;
        out.push(paragraph(openColumnMarker(depth + 1, width)));
        out.push(...demoteColumns((column.children ?? []) as PartialBlock[], depth + 2));
        out.push(paragraph(closeMarker(depth + 1)));
      }
      out.push(paragraph(closeMarker(depth)));
      continue;
    }
    if (Array.isArray(b.children) && b.children.length > 0) {
      out.push({ ...b, children: demoteColumns(b.children, depth) } as unknown as PartialBlock);
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
  // Loosen FIRST: the parser only gives each `:::` marker its own paragraph
  // when the markers are blank-line separated, and collapses a tight run of
  // them into one paragraph with soft breaks. The file on disk is the tight
  // form, because nobody wants to read a page that is half blank lines —
  // except between two layouts in a row, where the blank is the author's
  // (see `tightenColumnMarkers`).
  const source = protectFootnotes(loosenColumnMarkers(markdown));
  return promoteColumns(
    promoteRichBlocks(
      enrichChips(
        normalizeParsedBlocks((await editor.tryParseMarkdownToBlocks(source)) as PartialBlock[]),
      ),
    ),
  ) as AnyBlocks;
}

export async function blocksToMarkdown(
  editor: AnyEditor,
  blocks?: PartialBlock[],
): Promise<string> {
  const source = (blocks ?? editor.document) as PartialBlock[];
  // Deep copy: demotion must never touch live editor state.
  const demoted = demoteChips(
    demoteRichBlocks(demoteColumns(JSON.parse(JSON.stringify(source)) as PartialBlock[])),
  );
  return tightenColumnMarkers(
    restoreFootnotes(unescapeChipMarkdown(await editor.blocksToMarkdownLossy(demoted))),
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
