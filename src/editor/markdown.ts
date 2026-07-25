import type { Block, BlockNoteEditor, PartialBlock } from '@blocknote/core';

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

export async function markdownToBlocks(
  editor: BlockNoteEditor,
  markdown: string,
): Promise<Block[]> {
  return normalizeParsedBlocks(await editor.tryParseMarkdownToBlocks(markdown));
}

export async function blocksToMarkdown(
  editor: BlockNoteEditor,
  blocks?: PartialBlock[],
): Promise<string> {
  return editor.blocksToMarkdownLossy(blocks ?? editor.document);
}

/**
 * Mirror of write.rs replace_h1 at the block level: rewrite the first H1
 * block in the LIVE editor, or insert one at the top when the document has
 * none. Applied after a successful rename so a later body save can't write
 * the old title back over the renamed file (M1.x stale-body-after-rename
 * policy). Fence-awareness is inherent — code fences are codeBlock blocks,
 * never headings.
 */
export function spliceTitleIntoBlocks(editor: BlockNoteEditor, title: string): void {
  const h1 = editor.document.find(
    (b) => b.type === 'heading' && (b.props as { level?: number }).level === 1,
  );
  if (h1 !== undefined) {
    editor.updateBlock(h1, { content: title });
    return;
  }
  const first = editor.document[0];
  if (first === undefined) return; // live editors always hold >= 1 block
  editor.insertBlocks(
    [{ type: 'heading', props: { level: 1 }, content: title }],
    first,
    'before',
  );
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
