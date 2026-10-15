import type { Entry } from '@/engine/types';
import { parseLinkTarget, resolveLink, resolveTarget } from '@/engine/wikilink';

/**
 * What a link or person chip SAYS on the page (M59.6), in one place: the
 * chips in chips.tsx render these strings, and find (findMatches.ts) searches
 * them, so a word find counts is a word the reader can see.
 *
 * This is the label, not the file's bytes: `markdown.ts` `chipText` writes a
 * chip to disk as `[[target]]`, and nothing here touches that.
 */

/** Where a page link goes: a page, and a heading on it when it names one. */
export interface WikilinkDest {
  path: string;
  title: string;
  type: string | null;
  section: string | null;
}

/**
 * The page and heading `target` reaches (M55.8). `[[#Heading]]` is a heading
 * of the note the chip sits in (`notePath`), and `[[page#Heading]]` reaches
 * its page through `resolveLink`. Null when the link dangles.
 */
export function wikilinkDest(
  target: string,
  entries: Entry[],
  notePath: string | null,
): WikilinkDest | null {
  const { page, section } = parseLinkTarget(target);
  if (page === '' && section !== null) {
    if (notePath === null) return null;
    const own = entries.find((e) => e.path === notePath);
    return {
      path: notePath,
      title: own?.title ?? notePath.slice(notePath.lastIndexOf('/') + 1).replace(/\.md$/i, ''),
      type: own?.type ?? null,
      section,
    };
  }
  // Null section when the whole target names a page by itself (`C# notes`).
  const link = resolveLink(target, entries);
  if (link === null) return null;
  const { path, title, type } = link.entry;
  return { path, title, type, section: link.section };
}

/** A page link's label, given where it goes: the alias first, then
 * `Title › Heading` or the title, and the raw target when it dangles. */
export function wikilinkDestLabel(
  { target, alias }: { target: string; alias: string },
  dest: WikilinkDest | null,
): string {
  if (alias !== '') return alias;
  if (dest === null) return target;
  return dest.section !== null ? `${dest.title} › ${dest.section}` : dest.title;
}

/** A page link's label, as `WikilinkChip` renders it. */
export function wikilinkLabel(
  props: { target: string; alias: string },
  entries: Entry[],
  notePath: string | null = null,
): string {
  return wikilinkDestLabel(props, wikilinkDest(props.target, entries, notePath));
}

/** A person chip's label, as `AssigneeChip` renders it: the person's title,
 * or the raw target when nobody answers to it. */
export function assigneeLabel({ target }: { target: string }, entries: Entry[]): string {
  return resolveTarget(target, entries)?.title ?? target;
}
