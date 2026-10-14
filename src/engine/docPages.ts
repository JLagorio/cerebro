import { humanizeSlug } from '@/lib/slug';
import { isTemplate, isTemplateFolderPath } from '@/lib/templates';
import { COLLECTION_TYPE, isCollectionPage } from './collections';
import { isLibraryEntry } from './library';
import { hfsHeard, isKnowledgePath } from './okf';
import type { Entry } from './types';
import { isDocEntry } from './typeCatalog';

/**
 * Pages and their sub-pages (M2.x docs polish; M55.13). The vault stays plain
 * markdown, so a page's sub-pages live in its folder, by the folder-note
 * convention: `plan/plan.md` is the page "Plan", and every doc directly in
 * `plan/` is one of its sub-pages — and so is every doc folder directly in it,
 * through that folder's own note (`plan/rollout/rollout.md`), which is a
 * sub-page that has sub-pages of its own.
 *
 * A page with no sub-pages is just a file. Its first sub-page moves it to
 * `plan/plan.md` by rename (`growPlan`), so its bytes never change and its
 * stem links keep resolving; adding a sub-page never rewrites the parent.
 */

export interface DocPages {
  /** The page's folder. */
  folder: string;
  /** The folder note — the page itself, first in the Pages panel. */
  main: Entry;
  /** The page, then its sub-pages by creation date. */
  pages: Entry[];
}

/** The fence a child-page list block is written as: ```cerebro-subpages, empty. */
export const SUBPAGES_FENCE = 'cerebro-subpages';

const basename = (path: string): string => path.split('/').pop() ?? path;
const stem = (filename: string): string => filename.replace(/\.md$/, '');
const parentDir = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/** The folder note for `folder`, or null when the folder isn't a doc. */
export function folderNote(folder: string, entries: Entry[]): Entry | null {
  if (folder === '') return null;
  const notePath = `${folder}/${basename(folder)}.md`;
  return entries.find((e) => e.path === notePath) ?? null;
}

/** True when `entry` is its folder's note: `plan/plan.md`. */
export function isFolderNote(entry: Entry): boolean {
  return entry.folder !== '' && basename(entry.folder) === stem(entry.filename);
}

/** Where `entry`'s sub-pages live: its own folder when it is a folder note,
 * otherwise the folder it would grow into. */
export function subPageFolder(entry: Entry): string {
  return isFolderNote(entry) ? entry.folder : docFolderPathFor(entry);
}

/**
 * Whether `entry` can take sub-pages: docs and records can. The knowledge
 * bundle is written through the ledger, templates are stationery, agents and
 * skills are how the vault works (and moving an agent's file changes its
 * identity), a Type doc is the schema, a Collection page is its container,
 * `project.md` belongs to its project and a `.mmd` is raw diagram source.
 */
export function canHaveSubPages(entry: Entry): boolean {
  if (!entry.filename.endsWith('.md')) return false;
  if (entry.filename === 'project.md') return false;
  if (isKnowledgePath(entry.path)) return false;
  if (isTemplate(entry) || isLibraryEntry(entry)) return false;
  if (entry.type === 'Type') return false;
  return !isCollectionPage(entry);
}

/**
 * The sub-pages of `entry`: every doc directly in its folder, plus the folder
 * note of every doc folder directly in it. Only a folder note has any — a
 * plain `plan.md` beside a `plan/` folder does not adopt that folder's pages.
 * Records sharing the folder are not sub-pages (M12.1); nor is `project.md`
 * or a Collection page.
 */
export function childPagesOf(entry: Entry, entries: Entry[]): Entry[] {
  if (!isFolderNote(entry)) return [];
  const folder = entry.folder;
  return entries
    .filter(
      (e) =>
        e.path !== entry.path &&
        e.filename !== 'project.md' &&
        isDocEntry(e) &&
        !isCollectionPage(e) &&
        (e.folder === folder || (parentDir(e.folder) === folder && isFolderNote(e))),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.title.localeCompare(b.title));
}

/**
 * The page `entry` belongs to and its sub-pages, or null for a plain page.
 * project.md files never participate — projects have their own surface.
 *
 * Nor does a Collection page (M47.5). Once a container declares itself with a
 * folder note, `delivery/delivery.md` matches the folder-note convention
 * exactly — and the doc beside it, `how-we-schedule.md`, started rendering as
 * a page of a document called Delivery. Both conventions read the same file
 * and mean different things by it; the container wins, because it is the one
 * that also owns the sidebar row and the page you navigate to.
 */
export function docPagesFor(entry: Entry, entries: Entry[]): DocPages | null {
  if (entry.filename === 'project.md') return null;
  const main = folderNote(entry.folder, entries);
  if (main === null || main.filename === 'project.md') return null;
  if (main.type === COLLECTION_TYPE) return null;
  return { folder: entry.folder, main, pages: [main, ...childPagesOf(main, entries)] };
}

/** How many pages sit anywhere inside `folder`, its own folder note aside. */
export function descendantPageCount(folder: string, entries: Entry[]): number {
  const note = `${folder}/${basename(folder)}.md`;
  return entries.filter((e) => e.path.startsWith(`${folder}/`) && e.path !== note && isDocEntry(e))
    .length;
}

/** True when `folder` renders as a doc (not a plain folder) in file trees. */
export function isDocFolder(folder: string, entries: Entry[]): boolean {
  return folderNote(folder, entries) !== null;
}

/** Where a page's folder would live once it has a sub-page. */
export function docFolderPathFor(entry: Entry): string {
  const dir = entry.folder === '' ? '' : `${entry.folder}/`;
  return `${dir}${stem(entry.filename)}`;
}

/**
 * A folder name the scanner never descends into: a hidden one, as HFS+ hears
 * it, or exactly `views` or `attachments`. Mirrors scan.rs `is_skipped_dir`;
 * docPages.test replays src-tauri/fixtures/note-targets.json against it.
 */
export function isHiddenFolderName(name: string): boolean {
  return hfsHeard(name).startsWith('.') || name === 'views' || name === 'attachments';
}

export interface PageMove {
  from: string;
  to: string;
}

export type GrowPlan = { folder: string; move: PageMove | null } | { refused: string };

/**
 * What giving `entry` its first sub-page takes: the folder its sub-pages go
 * in, and the rename that makes it that folder's note — none for a page that
 * already is one. Refused when a folder of that name already sits beside it
 * (its pages are not adopted, Q27), when the scanner would hide the folder,
 * and inside templates/ or the knowledge bundle.
 */
export function growPlan(entry: Entry, entries: Entry[], folders: string[]): GrowPlan {
  if (isFolderNote(entry)) return { folder: entry.folder, move: null };
  const folder = docFolderPathFor(entry);
  const name = basename(folder);
  if (isKnowledgePath(folder)) return { refused: 'Knowledge pages have no sub-pages' };
  if (isTemplateFolderPath(folder)) return { refused: 'Templates have no sub-pages' };
  if (isHiddenFolderName(name)) {
    return { refused: `A folder named "${name}" is hidden from the vault` };
  }
  if (folders.includes(folder) || entries.some((e) => e.path.startsWith(`${folder}/`))) {
    return { refused: `A folder "${folder}/" already sits beside it` };
  }
  return { folder, move: { from: entry.path, to: `${folder}/${entry.filename}` } };
}

export type NestPlan = { folder: string; moves: PageMove[] } | { refused: string };

/**
 * What dropping `srcPath` onto `target` takes: grow the target if it has to,
 * then move the source into its folder. The source is a file or a doc folder;
 * a folder note given by its file moves with its folder, so its own sub-pages
 * come along. Refused onto itself, into its own subtree, onto a name the
 * folder already holds, and when it is a sub-page there already.
 */
export function nestPlan(
  srcPath: string,
  target: Entry,
  entries: Entry[],
  folders: string[],
): NestPlan {
  if (!canHaveSubPages(target)) return { refused: `"${target.title}" can't have sub-pages` };
  const srcEntry = entries.find((e) => e.path === srcPath);
  const src = srcEntry !== undefined && isFolderNote(srcEntry) ? srcEntry.folder : srcPath;
  if (src === target.path) return { refused: "A page can't go inside itself" };
  const grow = growPlan(target, entries, folders);
  if ('refused' in grow) return grow;
  const { folder } = grow;
  if (folder === src || folder.startsWith(`${src}/`)) {
    return { refused: "A page can't go inside its own sub-pages" };
  }
  if (parentDir(src) === folder) return { refused: `Already a sub-page of "${target.title}"` };
  const dest = `${folder}/${basename(src)}`;
  const taken =
    dest === grow.move?.to ||
    folders.includes(dest) ||
    entries.some((e) => e.path === dest || e.path.startsWith(`${dest}/`));
  if (taken) return { refused: `"${target.title}" already has a page named "${basename(src)}"` };
  const move = { from: src, to: dest };
  return { folder, moves: grow.move === null ? [move] : [grow.move, move] };
}

export type Crumb = { kind: 'page'; entry: Entry } | { kind: 'folder'; label: string };

/**
 * The way up from `entry`: each ancestor folder, as the page it is when it
 * has a folder note and as a folder otherwise. A folder note's own folder is
 * the page itself, so it is left out.
 */
export function crumbTrail(entry: Entry, entries: Entry[]): Crumb[] {
  if (entry.folder === '') return [];
  const segments = entry.folder.split('/');
  const own = isFolderNote(entry) ? entry.folder : null;
  const crumbs: Crumb[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const folder = segments.slice(0, i + 1).join('/');
    if (folder === own) continue;
    const note = folderNote(folder, entries);
    crumbs.push(
      note === null
        ? { kind: 'folder', label: humanizeSlug(segments[i]) }
        : { kind: 'page', entry: note },
    );
  }
  return crumbs;
}
