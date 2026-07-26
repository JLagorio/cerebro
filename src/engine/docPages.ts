import type { Entry } from './types';

/**
 * Multi-page docs (M2.x docs polish) use the folder-note convention so the
 * vault stays plain markdown: a folder `josef-1-1/` whose direct child
 * `josef-1-1.md` matches the folder name IS a doc named "Josef 1 1"; every
 * other .md directly inside is an extra page (a Google-Docs-style tab). A
 * single-file doc is just a file — it only becomes a folder when a second
 * page is added.
 */

export interface DocPages {
  /** The doc folder path. */
  folder: string;
  /** The folder note — the doc's default page (first tab). */
  main: Entry;
  /** All pages in tab order: main first, then by creation date. */
  pages: Entry[];
}

const basename = (path: string): string => path.split('/').pop() ?? path;
const stem = (filename: string): string => filename.replace(/\.md$/, '');

/** The folder note for `folder`, or null when the folder isn't a doc. */
export function folderNote(folder: string, entries: Entry[]): Entry | null {
  if (folder === '') return null;
  const notePath = `${folder}/${basename(folder)}.md`;
  return entries.find((e) => e.path === notePath) ?? null;
}

/** Pages of the multi-page doc `entry` belongs to, or null for plain docs.
 * project.md files never participate — projects have their own surface. */
export function docPagesFor(entry: Entry, entries: Entry[]): DocPages | null {
  if (entry.filename === 'project.md') return null;
  const main = folderNote(entry.folder, entries);
  if (main === null || main.filename === 'project.md') return null;
  const rest = entries
    .filter(
      (e) =>
        e.folder === entry.folder &&
        e.path !== main.path &&
        e.filename !== 'project.md' &&
        e.type !== 'Work item',
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.title.localeCompare(b.title));
  return { folder: entry.folder, main, pages: [main, ...rest] };
}

/** True when `folder` renders as a doc (not a plain folder) in file trees. */
export function isDocFolder(folder: string, entries: Entry[]): boolean {
  return folderNote(folder, entries) !== null;
}

/** Where a doc's folder would live if it grew a second page. */
export function docFolderPathFor(entry: Entry): string {
  const dir = entry.folder === '' ? '' : `${entry.folder}/`;
  return `${dir}${stem(entry.filename)}`;
}
