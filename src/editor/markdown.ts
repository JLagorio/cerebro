import type { BlockNoteEditor, PartialBlock } from '@blocknote/core';
import { DATABASE_FENCE, parseDatabaseRef, serializeDatabaseRef } from '@/engine/databaseBlock';
import { DATE_TOKEN_SOURCE, dateValueToChipProps, parseDateToken } from '@/engine/dates';
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
// Plain-text chip forms — `[[target|alias]]`, `@[[person]]`, `📅 2026-07-30`
// — are promoted to custom inline nodes after parse (enrichChips) and
// serialized back to the same plain text (the chips' toExternalHTML), so the
// file on disk never stops being ordinary markdown.

const CHIP_PATTERN = new RegExp(
  String.raw`@\[\[([^\][|]+?)(?:\|[^\][]*)?\]\]|\[\[([^\][|]+?)(?:\|([^\][]*))?\]\]|(${DATE_TOKEN_SOURCE})`,
  'gu',
);

interface TextNode {
  type: 'text';
  text: string;
  styles?: Record<string, unknown>;
}

const isPlainTextNode = (item: unknown): item is TextNode => {
  if (typeof item !== 'object' || item === null) return false;
  const n = item as TextNode;
  return n.type === 'text' && typeof n.text === 'string' && !(n.styles?.code === true);
};

function splitTextNode(node: TextNode): unknown[] {
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

function enrichInlineArray(items: unknown[]): unknown[] {
  return items.flatMap((item) => (isPlainTextNode(item) ? splitTextNode(item) : [item]));
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
      b.content = enrichInlineArray(b.content);
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
      // A fence that names no database stays the code block it already is —
      // `parseDatabaseRef` returns null rather than an empty pointer, so a
      // half-typed fence keeps showing what the user typed instead of being
      // replaced by a database block complaining about it.
      const ref = parseDatabaseRef(blockText(b.content));
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
      return {
        type: 'codeBlock',
        props: { language: DATABASE_FENCE },
        content: [{ type: 'text', text: serializeDatabaseRef({ database, view }), styles: {} }],
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

export async function markdownToBlocks(editor: AnyEditor, markdown: string): Promise<AnyBlocks> {
  // Loosen FIRST: the parser only gives each `:::` marker its own paragraph
  // when the markers are blank-line separated, and collapses a tight run of
  // them into one paragraph with soft breaks. The file on disk is the tight
  // form, because nobody wants to read a page that is half blank lines.
  const source = loosenColumnMarkers(markdown);
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
  const demoted = demoteRichBlocks(
    demoteColumns(JSON.parse(JSON.stringify(source)) as PartialBlock[]),
  );
  return tightenColumnMarkers(unescapeChipMarkdown(await editor.blocksToMarkdownLossy(demoted)));
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
