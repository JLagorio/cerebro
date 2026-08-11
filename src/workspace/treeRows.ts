/**
 * The tree as a flat list of visible rows.
 *
 * Flat because a recursive component tree cannot be windowed, and windowing is
 * deferred rather than ruled out (M30.14) — this shape is what keeps that a
 * one-file decision. Pure because it makes every ordering and visibility rule
 * testable without rendering anything.
 */
import type { DirEntry, Root } from '@/engine/roots';

export interface TreeRow {
  key: string;
  rootId: string;
  /** Root-relative; `''` is the root row itself. */
  path: string;
  label: string;
  depth: number;
  isDir: boolean;
  ignored: boolean;
  /** True for the root's own row, which renders its status chip. */
  isRoot: boolean;
}

export const nodeKey = (rootId: string, path: string): string => `${rootId} ${path}`;

export function flattenTree(
  roots: Root[],
  expanded: Record<string, boolean>,
  children: Record<string, DirEntry[]>,
  showIgnored: boolean,
): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (rootId: string, path: string, depth: number): void => {
    const key = nodeKey(rootId, path);
    if (expanded[key] !== true) return;
    for (const child of children[key] ?? []) {
      if (child.ignored && !showIgnored) continue;
      rows.push({
        key: nodeKey(rootId, child.path),
        rootId,
        path: child.path,
        label: child.name,
        depth,
        isDir: child.isDir,
        ignored: child.ignored,
        isRoot: false,
      });
      if (child.isDir) walk(rootId, child.path, depth + 1);
    }
  };

  for (const root of roots) {
    rows.push({
      key: nodeKey(root.id, ''),
      rootId: root.id,
      path: '',
      label: root.label,
      depth: 0,
      isDir: true,
      ignored: false,
      isRoot: true,
    });
    walk(root.id, '', 1);
  }
  return rows;
}
