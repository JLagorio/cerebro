import type { Source } from '@/engine/okf';
import type { Entry } from '@/engine/types';

/**
 * Footnote citations in a page body (M51.5): what a `citation` chip needs to
 * know about the document around it, as pure functions over block JSON.
 *
 * OKF cites a concept's sources with `[^id]` and defines them as `[^id]: …`.
 * markdown.ts promotes both forms into the chip and writes them back as the
 * same text, so the file never changes; the chip shows a NUMBER in their
 * place. That number has to be the one the concept's Sources list prints
 * beside the same source (KnowledgePanel's SourceRow counts `index + 1`), or
 * the page and its own sidebar would disagree about which source is which.
 */

/** What one state of a document says about its citations. */
export interface CitationIndex {
  /** Each id the document defines (`[^id]: …`), in the order the definitions appear. */
  defined: string[];
  /** Each id the document cites (`[^id]`), in the order of its first reference. */
  cited: string[];
  /** A definition's text, to the end of its line. The first definition of an id wins. */
  definitions: Map<string, string>;
}

interface InlineItem {
  type?: string;
  text?: string;
  props?: Record<string, unknown>;
  content?: unknown;
}

/** The words an inline item reads as, for a definition's tooltip. */
function textOf(item: InlineItem): string {
  if (item.type === 'text') return item.text ?? '';
  if (item.type === 'link' && Array.isArray(item.content)) {
    return (item.content as InlineItem[]).map(textOf).join('');
  }
  if (item.type === 'wikilink') {
    const { target, alias } = item.props ?? {};
    return typeof alias === 'string' && alias !== ''
      ? alias
      : typeof target === 'string'
        ? target
        : '';
  }
  return '';
}

function indexInline(items: unknown[], index: CitationIndex): void {
  // The definition whose words are being read, and the words so far. A
  // definition runs to the end of its line: consecutive definitions are one
  // paragraph to the parser, with a line break between each.
  let open: string | null = null;
  let words = '';
  const close = () => {
    if (open !== null && !index.definitions.has(open)) index.definitions.set(open, words.trim());
    open = null;
    words = '';
  };
  for (const raw of items) {
    const item = raw as InlineItem;
    if (item.type === 'citation') {
      const id = typeof item.props?.id === 'string' ? item.props.id : '';
      if (id === '') continue;
      if (item.props?.def === '1') {
        close();
        if (!index.defined.includes(id)) index.defined.push(id);
        open = id;
      } else if (!index.cited.includes(id)) {
        index.cited.push(id);
      }
      continue;
    }
    if (open === null) continue;
    const text = textOf(item);
    const end = text.indexOf('\n');
    if (end === -1) {
      words += text;
    } else {
      words += text.slice(0, end);
      close();
    }
  }
  close();
}

function indexBlocks(blocks: readonly unknown[], index: CitationIndex): void {
  for (const raw of blocks) {
    const block = raw as { content?: unknown; children?: unknown[] };
    if (Array.isArray(block.content)) {
      indexInline(block.content, index);
    } else if (typeof block.content === 'object' && block.content !== null) {
      // A table: its cells are inline arrays in a partial block, and
      // `{ type: 'tableCell', content }` in the editor's own document.
      for (const row of (block.content as { rows?: { cells?: unknown[] }[] }).rows ?? []) {
        for (const cell of row.cells ?? []) {
          if (Array.isArray(cell)) indexInline(cell, index);
          else {
            const content = (cell as { content?: unknown } | null)?.content;
            if (Array.isArray(content)) indexInline(content, index);
          }
        }
      }
    }
    if (Array.isArray(block.children)) indexBlocks(block.children, index);
  }
}

/** Read a document's citations in document order, nested blocks and table cells included. */
export function indexCitations(blocks: readonly unknown[]): CitationIndex {
  const index: CitationIndex = { defined: [], cited: [], definitions: new Map() };
  indexBlocks(blocks, index);
  return index;
}

/**
 * Every citation chip in a document and the `[^` menu read the same index, so
 * it is built once per document state rather than once per chip per keystroke.
 * Keyed by the ProseMirror doc, which is immutable: an edit makes a new one,
 * and the old index is dropped with the old doc.
 */
const indexes = new WeakMap<object, CitationIndex>();

/** The index of what an editor holds now. Structural, so this module stays free of BlockNote. */
export function citationIndexOf(editor: {
  prosemirrorState: { doc: object };
  document: readonly unknown[];
}): CitationIndex {
  const doc = editor.prosemirrorState.doc;
  let index = indexes.get(doc);
  if (index === undefined) {
    index = indexCitations(editor.document);
    indexes.set(doc, index);
  }
  return index;
}

/**
 * The number a citation shows, or null when there is nothing to count it by.
 *
 * A source the frontmatter lists is numbered by its place in that list —
 * id-less entries included, because the Sources list counts them too. Any
 * other id is numbered AFTER the listed sources, by the order the document
 * defines it and then by the order it is first cited: an ordinary page with
 * footnotes has no `sources` at all and reads 1, 2, 3, and a concept citing
 * something its frontmatter does not list gets a number the Sources list does
 * not show, rather than borrowing the number of a source it is not.
 */
export function citationNumber(
  id: string,
  sources: readonly Pick<Source, 'id'>[],
  index: CitationIndex,
): number | null {
  const listed = sources.findIndex((s) => s.id === id);
  if (listed >= 0) return listed + 1;
  const known = new Set(sources.map((s) => s.id));
  const rest = [...new Set([...index.defined, ...index.cited])].filter((x) => !known.has(x));
  const at = rest.indexOf(id);
  return at === -1 ? null : sources.length + at + 1;
}

/**
 * What a citation is called, the ONE rule for the chip's tooltip and the `[^`
 * menu (M52.1): what the Sources list calls it, then what the page's own
 * definition says, then the title of the vault page it points at, then the
 * resource itself. An id that is none of those is named as missing — a claim
 * that cites nothing is what a reviewer most needs to see, so it is never
 * given an empty name.
 */
export function citationName(
  id: string,
  sources: readonly Pick<Source, 'id' | 'resource' | 'title'>[],
  index: CitationIndex,
  entries: readonly Pick<Entry, 'path' | 'title'>[],
): string {
  const source = sources.find((s) => s.id === id) ?? null;
  const says = index.definitions.get(id) ?? '';
  const target = source === null ? null : sourceTarget(source.resource, entries);
  const page =
    target !== null && 'internal' in target
      ? entries.find((e) => e.path === target.internal)
      : undefined;
  return (
    source?.title ??
    (says !== '' ? says : null) ??
    page?.title ??
    source?.resource ??
    `No source "${id}"`
  );
}

/** One source a new citation can point at, as the `[^` menu offers it. */
export interface CitationChoice {
  id: string;
  number: number;
  name: string;
}

/**
 * What typing `[^` offers (M52.1): every source the frontmatter lists with an
 * id, then every id the page already defines or cites that it does not — in
 * the order their numbers run, so the menu reads like the Sources list it
 * cites from. A listed source with no id cannot be cited and is left out; it
 * still holds its number, so the ones after it are not renumbered.
 */
export function citationChoices(
  sources: readonly Pick<Source, 'id' | 'resource' | 'title'>[],
  index: CitationIndex,
  entries: readonly Pick<Entry, 'path' | 'title'>[],
): CitationChoice[] {
  const ids = [
    ...sources.flatMap((s) => (s.id === null ? [] : [s.id])),
    ...index.defined,
    ...index.cited,
  ];
  const choices: CitationChoice[] = [];
  for (const id of new Set(ids)) {
    const number = citationNumber(id, sources, index);
    if (number === null) continue;
    choices.push({ id, number, name: citationName(id, sources, index, entries) });
  }
  return choices.sort((a, b) => a.number - b.number);
}

export type SourceTarget = { external: string } | { internal: string } | null;

/**
 * Where a source's `resource` leads — ONE rule for the citation chips and the
 * Sources list (KnowledgePanel's SourceRow): a URL scheme is outside the vault,
 * a path (vault-relative, usually with a leading `/`) is a page if the vault
 * has one there, and anything else is a scope descriptor ("all sync telemetry
 * in eu-west") that names something but cannot be followed.
 */
export function sourceTarget(
  resource: string,
  entries: readonly Pick<Entry, 'path'>[],
): SourceTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(resource)) return { external: resource };
  const path = resource.replace(/^\/+/, '');
  return entries.some((e) => e.path === path) ? { internal: path } : null;
}
