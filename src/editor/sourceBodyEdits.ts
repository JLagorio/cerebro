import { splitFrontmatter } from '@/engine/frontmatter';
/** Textareas display one LF for either stored newline spelling. */
export const sourceBodyDisplay = (raw: string): string => raw.replace(/\r\n?/g, '\n');

function splitsPair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1),
    after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function rawOffset(raw: string, displayOffset: number): number {
  let index = 0;
  for (let shown = 0; shown < displayOffset; shown += 1) {
    index += raw[index] === '\r' && raw[index + 1] === '\n' ? 2 : 1;
  }
  return index;
}

/** Only the edited span adopts the first detected newline style. Everything
 * outside that span remains byte-for-byte equivalent UTF-8 source. */
export function applySourceBodyEdit(
  raw: string,
  range: { from: number; to: number },
  insert: string,
): string {
  const displayed = sourceBodyDisplay(raw);
  const { from, to } = range;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to > displayed.length ||
    splitsPair(displayed, from) ||
    splitsPair(displayed, to)
  )
    throw new Error('The source edit does not identify a complete text range.');
  for (const character of insert) {
    const unit = character.charCodeAt(0);
    if (character.length === 1 && unit >= 0xd800 && unit <= 0xdfff)
      throw new Error('The source edit contains an incomplete Unicode character.');
  }
  const newline = /\r\n|\r|\n/.exec(raw)?.[0] ?? '\n';
  const replacement = insert.replace(/\r\n|\r|\n/g, newline);
  return raw.slice(0, rawOffset(raw, from)) + replacement + raw.slice(rawOffset(raw, to));
}

/** Translate a textarea input to one bounded replacement, widening common
 * UTF-16 prefixes/suffixes when they would bisect a Unicode character. */
export function sourceBodyInput(raw: string, value: string): string {
  const before = sourceBodyDisplay(raw),
    after = sourceBodyDisplay(value);
  if (before === after) return raw;
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
  let oldTo = before.length,
    newTo = after.length;
  while (oldTo > from && newTo > from && before[oldTo - 1] === after[newTo - 1]) {
    oldTo -= 1;
    newTo -= 1;
  }
  if (splitsPair(before, from) || splitsPair(after, from)) from -= 1;
  if (splitsPair(before, oldTo) || splitsPair(after, newTo)) {
    oldTo += 1;
    newTo += 1;
  }
  return applySourceBodyEdit(raw, { from, to: oldTo }, after.slice(from, newTo));
}

/** Derive the exact suffix without reconstructing BOM or fence bytes. */
export function sourceBodyFromFile(content: string): string {
  return splitFrontmatter(content).body;
}

/** Source never introduces metadata to a document that did not have it. */
export function replaceSourceBody(current: string, body: string): string {
  const before = splitFrontmatter(current);
  const prefix = current.slice(0, current.length - before.body.length);
  const after = prefix + body;
  const next = splitFrontmatter(after);
  if (before.yaml !== next.yaml || next.body !== body)
    throw new Error('Source body edits cannot change page properties or their body boundary.');
  return after;
}
