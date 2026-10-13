import type { BlockNoteEditor, BlockNoteEditorOptions } from '@blocknote/core';
import { protectFootnotes } from './markdown';

/**
 * Typing a citation (M52.1).
 *
 * M51.5 made `[^id]` a chip when a page LOADS; a marker typed by hand stayed
 * text until the next reload, so the page on screen and the same page reopened
 * disagreed. These are the two ways a citation is written in the editor — the
 * `[^` menu's insert and a hand-typed marker turning into a chip as its `]`
 * lands — and each makes exactly the chip `enrichChips` (markdown.ts) would
 * read out of the same bytes on the next load, so a reload changes nothing.
 * That is the rule every guard below answers to:
 *
 * - Code — a code block, or text carrying the inline-code mark — is never
 *   read, as the parser never reads it.
 * - STYLED text is never read. A chip cannot carry a style, and a marker
 *   promoted out of emphasis is written back outside it (markdown.ts
 *   `isUnstyled` has the measurement), so a citation typed inside emphasis
 *   stays the text it is on disk.
 * - Nor is a marker after a delimiter still OPEN on its line — a `` ` `` or
 *   a `*`/`_` that its closing twin, typed after the `]`, turns into code or
 *   emphasis. A chip in between stops that mark landing: measured,
 *   `**b[^a]**` typed that way showed `**b`, a chip and `**`, while the bytes
 *   it saved reopen as bold text with no chip.
 * - `]` always closes a marker, one that opens a line too: a reference is
 *   what the next load reads there unless a `:` follows, and a `:` typed after
 *   a line-opening chip makes it the definition the file will then say.
 *
 * Handed to TipTap as a view prop rather than a plugin: `prosemirror-state`
 * is not a dependency of the app, only of BlockNote, and a direct prop needs
 * no Plugin to exist.
 */

type View = BlockNoteEditor<any, any, any>['prosemirrorView'];
type State = View['state'];

// The id class is `CHIP_PATTERN`'s own (markdown.ts), so what converts here is
// what the parser promotes; `\uFFFC` is what a chip or line break reads as in
// the text before the cursor, and no marker runs through one.
const OPEN_MARKER = /\[\^([^\]\s\uFFFC]+)$/;
const CLOSED_MARKER = /\[\^([^\]\s\uFFFC]+)\]$/;
/** How far back a marker can start. Ids are slugs; nothing real is this long. */
const LOOKBACK = 200;

/** Is every node from `from` to `to` unmarked? Leaf nodes are excluded by the patterns. */
function unmarked(state: State, from: number, to: number): boolean {
  let plain = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && node.marks.length > 0) plain = false;
  });
  return plain;
}

/** Does a line of the textblock start at `pos` — its start, or just after a hard break? */
function atLineStart(state: State, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  return $pos.parentOffset === 0 || $pos.nodeBefore?.type.name === 'hardBreak';
}

/** The text of the cursor's textblock up to the cursor, leaf nodes as `\uFFFC`. */
function textBefore(state: State, pos: number): string {
  const $pos = state.doc.resolve(pos);
  const start = Math.max(0, $pos.parentOffset - LOOKBACK);
  return $pos.parent.textBetween(start, $pos.parentOffset, undefined, '\uFFFC');
}

/** Marks a character typed at `pos` would carry. */
const marksAt = (state: State, pos: number) => state.storedMarks ?? state.doc.resolve(pos).marks();

/**
 * The `handleTextInput` view prop. `onConvert` runs after a typed `]` makes a
 * chip — the `[` of the marker opened the link menu, and it is closed there.
 */
export function citationTextInput(onConvert?: () => void) {
  return (view: View, from: number, to: number, text: string): boolean => {
    if (from !== to || text.length !== 1) return false;
    const { state } = view;
    const citation = state.schema.nodes.citation;
    const $from = state.doc.resolve(from);
    const parent = $from.parent;
    if (citation === undefined || !parent.isTextblock || parent.type.spec.code) return false;
    if (marksAt(state, from).length > 0) return false;
    const paragraph = parent.type.name === 'paragraph';
    const before = textBefore(state, from);

    if (text === ']') {
      const m = OPEN_MARKER.exec(before);
      if (m === null) return false;
      const start = from - m[0].length;
      if (!unmarked(state, start, from)) return false;
      // `[[^x]]` is a wikilink being typed — the file reads the finished one
      // as a link, and a chip made at its first `]` would say otherwise.
      if (before.charAt(before.length - m[0].length - 1) === '[') return false;
      // An open delimiter earlier on the line — the text since the last chip
      // or break. An odd count of backticks is a code span still being typed;
      // `*`/`_` after a space, then a word, is emphasis still being typed. A
      // `2 * 3` or a `snake_id` opens nothing.
      const head = before.slice(0, before.length - m[0].length);
      const line = head.slice(head.lastIndexOf('\uFFFC') + 1);
      if (line.split('`').length % 2 === 0) return false;
      if (/(^|[\s(])(\*{1,3}|_{1,3})\S[^*_]*$/.test(line)) return false;
      view.dispatch(state.tr.replaceWith(start, from, citation.create({ id: m[1], def: '' })));
      onConvert?.();
      return true;
    }

    if (!paragraph) return false;

    // A marker PASTED as text where a line opens — a typed one is a chip from
    // its `]`, so only a paste leaves one behind. The character typed after
    // it decides: `:` makes it the definition it now is, anything else a
    // reference followed by that character. The `:` is not typed — a
    // definition chip already writes it.
    const closed = CLOSED_MARKER.exec(before);
    if (closed !== null) {
      const start = from - closed[0].length;
      if (!atLineStart(state, start) || !unmarked(state, start, from)) return false;
      const definition = text === ':';
      const tr = state.tr.replaceWith(
        start,
        from,
        citation.create({ id: closed[1], def: definition ? '1' : '' }),
      );
      if (!definition) tr.insertText(text);
      view.dispatch(tr);
      return true;
    }

    // A reference chip that opens a line, then `:` — a marker typed there, or
    // the menu's insert at the head of a sources paragraph. On disk that is
    // `[^id]:`, which the next load reads as a definition, so the editor reads
    // it as one now.
    const node = $from.nodeBefore;
    if (
      text === ':' &&
      node?.type === citation &&
      node.attrs.def !== '1' &&
      atLineStart(state, from - node.nodeSize)
    ) {
      view.dispatch(
        state.tr.setNodeMarkup(from - node.nodeSize, undefined, { ...node.attrs, def: '1' }),
      );
      return true;
    }
    return false;
  };
}

/**
 * Put a citation of `id` at the cursor — the `[^` menu's pick (M52.1).
 *
 * A chip where the text is plain. Inside emphasis or code it is the marker as
 * TEXT, carrying the marks around it: a chip there would be written back
 * outside the emphasis — measured, `*a claim[^id] more*` saved as
 * `*a claim*[^id]*&#x20;more*` — and a hand-typed marker there stays text too.
 */
export function insertCitation(view: View, id: string): void {
  const { state } = view;
  const { from } = state.selection;
  const citation = state.schema.nodes.citation;
  const $from = state.doc.resolve(from);
  if (citation === undefined || $from.parent.type.spec.code || marksAt(state, from).length > 0) {
    view.dispatch(state.tr.insertText(`[^${id}]`));
    return;
  }
  view.dispatch(state.tr.replaceSelectionWith(citation.create({ id, def: '' }), false));
}

/** BlockNote's clipboard formats, in the order its own paste handler tries
 * them (`acceptedMIMETypes`, which the package does not export). */
const PASTE_FORMATS = [
  'vscode-editor-data',
  'blocknote/html',
  'text/markdown',
  'text/html',
  'text/plain',
  'Files',
] as const;

type PasteContext = Parameters<
  NonNullable<BlockNoteEditorOptions<any, any, any>['pasteHandler']>
>[0];

/**
 * The editor's paste handler (M52.4): pasted markdown keeps its footnotes.
 *
 * BlockNote reads pasted markdown — and plain text, which it reads as markdown
 * — with the GFM parser, which rewrites `[^id]` into a numbered link and its
 * definition into a generated "Footnotes" list: the rewrite `protectFootnotes`
 * stops on load (markdown.ts). A paste whose format BlockNote would read as
 * markdown, and that holds a marker, goes through the same escape. Everything
 * else is BlockNote's own — HTML, a VS Code copy, the editor's own clipboard,
 * files, and anything pasted into a code block.
 *
 * The pasted markers stay text until the page is next loaded. The bytes they
 * save are the citation either way; the chip is the next load's.
 */
export function citationPasteHandler({
  event,
  editor,
  defaultPasteHandler,
}: PasteContext): boolean | undefined {
  const { $from, $to } = editor.prosemirrorState.selection;
  if ($from.parent.type.spec.code || $to.parent.type.spec.code) return defaultPasteHandler();
  const clipboard = event.clipboardData;
  const format = PASTE_FORMATS.find((type) => clipboard?.types.includes(type));
  if (clipboard === null || (format !== 'text/markdown' && format !== 'text/plain')) {
    return defaultPasteHandler();
  }
  const data = clipboard.getData(format);
  if (!/\[\^[^\]\s]+\]/.test(data)) return defaultPasteHandler();
  editor.pasteMarkdown(protectFootnotes(data));
  return true;
}
