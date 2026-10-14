/**
 * What the editor's `[` and `@` menus read from the text typed into them
 * (M55.7): whether a link is being typed, whether a mention can start here,
 * and whether the name typed could become a new page.
 *
 * No React and no BlockNote, so each rule is a table in linkMenu.test.tsx;
 * MarkdownEditor wires them into the menus.
 */

/** The slice of a ProseMirror EditorState that `charBeforeTrigger` reads. */
export interface TriggerState {
  selection: { from: number };
  doc: {
    textBetween(from: number, to: number, blockSeparator?: string, leafText?: string): string;
    resolve(pos: number): { parentOffset: number };
  };
}

/**
 * The name a Create row would make a page of: the text, trimmed.
 *
 * Null when nothing is left, or when the text is link syntax rather than a
 * name: `[` and `]` bracket a link, `|` starts its alias, `#` its section,
 * and a leading `^` makes it a citation.
 */
export function creatableTitle(text: string): string | null {
  const title = text.trim();
  if (title === '' || title.startsWith('^') || /[[\]|#]/.test(title)) return null;
  return title;
}

/**
 * The character just before the trigger that opened a menu on `query`: ''
 * when the trigger opens its block, and `\uFFFC` for a chip or other leaf.
 *
 * Null when the trigger is not where the query puts it, or the state cannot
 * answer; it never throws. BlockNote opens the `[` menu again on the second
 * bracket of `[[`, so the query starts after both, and the character before
 * the trigger is what tells a link being typed from a lone bracket
 * (linkMenu.test.tsx measures it).
 */
export function charBeforeTrigger(
  state: TriggerState,
  query: string,
  trigger: string,
): string | null {
  try {
    const at = state.selection.from - query.length - trigger.length;
    if (at < 0 || state.doc.textBetween(at, at + trigger.length) !== trigger) return null;
    if (state.doc.resolve(at).parentOffset === 0) return '';
    return state.doc.textBetween(at - 1, at, '\n', '\uFFFC');
  } catch {
    return null;
  }
}

/** What the `[` menu's query asks for. */
export type LinkQuery =
  | { kind: 'cite'; text: string }
  | { kind: 'closed' }
  | { kind: 'page'; text: string; double: boolean };

/**
 * Read the `[` menu's query, given the character before its trigger.
 *
 * A leading `^` cites a source (M52.1). Otherwise one leading `[` is dropped:
 * BlockNote puts the second bracket of `[[` before the query today, and this
 * keeps reading it right if a bump ever lands that bracket in the query
 * instead. A `]` closes the link being typed. Anything else names a page, and
 * `double` says it follows `[[`.
 */
export function readLinkQuery(query: string, before: string | null): LinkQuery {
  if (query.startsWith('^')) return { kind: 'cite', text: query.slice(1) };
  const stripped = query.startsWith('[');
  const text = stripped ? query.slice(1) : query;
  if (text.includes(']')) return { kind: 'closed' };
  return { kind: 'page', text, double: stripped || before === '[' };
}

/**
 * Can an `@` typed after `before` start a mention? Yes where a block starts,
 * or after anything that cannot belong to a word or an address. No after a
 * letter, a digit, `_`, `.`, `-` or `+`, so `ana@example.com` stays an
 * address. Null, a trigger that could not be read, is no.
 */
export function mentionAtWordStart(before: string | null): boolean {
  if (before === null) return false;
  return before === '' || !/[\p{L}\p{M}\p{N}_.+-]/u.test(before);
}

/** The stem a link names a note by: `notes/launch-notes.md` is `launch-notes`. */
export function stemOfPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}
