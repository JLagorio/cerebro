/**
 * Changed files as a folder tree (M91.10): what the FileTree element draws
 * for a turn's changeset. Pure: no DOM.
 *
 * Folders come before files, each in name order, and a folder whose only
 * child is a folder is one row ("src/engine/ai"). A folder counts the files
 * under it and sums their lines, but only lines git counted (CV-05): a binary
 * file's counts are null, never 0, a folder holding nothing else has null
 * sums, and `uncounted` says how many of its files had none.
 */

import type { ChangedFile, ChangeKind } from '@/engine/changeset';

export interface FileChange {
  path: string;
  kind: ChangeKind;
  /** Where a renamed file was. */
  previousPath?: string;
  /** Null where git counted no lines: a binary file, or counts not recorded. */
  additions: number | null;
  deletions: number | null;
}

export interface FileTreeFile extends FileChange {
  type: 'file';
  /** The path's last segment. */
  name: string;
}

export interface FileTreeFolder {
  type: 'folder';
  /** One segment, or several joined by "/" where single-child folders
   * collapsed into this row. */
  name: string;
  /** From the root, without a trailing slash. */
  path: string;
  children: FileTreeNode[];
  /** Files under it, at any depth. */
  files: number;
  /** Summed over the files under it that have counts; null when none has. */
  additions: number | null;
  deletions: number | null;
  /** Files under it without line counts. */
  uncounted: number;
}

export type FileTreeNode = FileTreeFolder | FileTreeFile;

/** A changeset row (`engine/changeset.ts`) as a FileChange. */
export function fileChangeOf(file: ChangedFile): FileChange {
  const change: FileChange = {
    path: file.path,
    kind: file.kind,
    additions: file.additions,
    deletions: file.deletions,
  };
  if (file.previous_path !== null) change.previousPath = file.previous_path;
  return change;
}

interface Draft {
  folders: Map<string, Draft>;
  files: FileTreeFile[];
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The tree's top-level rows. A path listed twice keeps its first entry; a
 * path with no segments is skipped. */
export function buildFileTree(files: readonly FileChange[]): FileTreeNode[] {
  const root: Draft = { folders: new Map(), files: [] };
  const seen = new Set<string>();
  for (const change of files) {
    const segments = change.path.split('/').filter((segment) => segment !== '');
    const path = segments.join('/');
    if (segments.length === 0 || seen.has(path)) continue;
    seen.add(path);
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      let child = folder.folders.get(segment);
      if (child === undefined)
        folder.folders.set(segment, (child = { folders: new Map(), files: [] }));
      folder = child;
    }
    const file: FileTreeFile = {
      type: 'file',
      name: segments[segments.length - 1],
      path,
      kind: change.kind,
      additions: change.additions,
      deletions: change.deletions,
    };
    if (change.previousPath !== undefined) file.previousPath = change.previousPath;
    folder.files.push(file);
  }
  return childrenOf(root, '');
}

function childrenOf(draft: Draft, path: string): FileTreeNode[] {
  const folders = [...draft.folders].map(([name, child]) =>
    folderOf(name, path === '' ? name : `${path}/${name}`, child),
  );
  return [...folders.sort(byName), ...[...draft.files].sort(byName)];
}

function folderOf(name: string, path: string, draft: Draft): FileTreeFolder {
  const children = childrenOf(draft, path);
  const only = children.length === 1 ? children[0] : null;
  if (only !== null && only.type === 'folder') {
    return { ...only, name: `${name}/${only.name}` };
  }
  let files = 0;
  let uncounted = 0;
  let additions: number | null = null;
  let deletions: number | null = null;
  for (const child of children) {
    if (child.type === 'folder') {
      files += child.files;
      uncounted += child.uncounted;
      if (child.additions !== null) additions = (additions ?? 0) + child.additions;
      if (child.deletions !== null) deletions = (deletions ?? 0) + child.deletions;
      continue;
    }
    files += 1;
    // A file is counted only when git counted both sides of it.
    if (child.additions === null || child.deletions === null) {
      uncounted += 1;
      continue;
    }
    additions = (additions ?? 0) + child.additions;
    deletions = (deletions ?? 0) + child.deletions;
  }
  return { type: 'folder', name, path, children, files, additions, deletions, uncounted };
}
