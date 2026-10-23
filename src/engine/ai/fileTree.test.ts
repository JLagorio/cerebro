import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '@/engine/changeset';
import {
  buildFileTree,
  fileChangeOf,
  type FileChange,
  type FileTreeFolder,
  type FileTreeNode,
} from './fileTree';

const change = (
  path: string,
  additions: number | null,
  deletions: number | null,
  kind: FileChange['kind'] = 'modified',
): FileChange => ({ path, kind, additions, deletions });

/** Each row as `name` (a folder's with its counts), indented by depth. */
function outline(nodes: FileTreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const pad = '  '.repeat(depth);
    if (node.type === 'file') return [`${pad}${node.name}`];
    const counts = `${node.files} files, +${node.additions ?? '?'} −${node.deletions ?? '?'}, ${node.uncounted} uncounted`;
    return [`${pad}${node.name}/ (${counts})`, ...outline(node.children, depth + 1)];
  });
}

describe('buildFileTree', () => {
  it('puts folders before files, each in name order, numbers in counting order', () => {
    const tree = buildFileTree([
      change('README.md', 1, 0),
      change('notes/b.md', 2, 0),
      change('notes/a.md', 3, 1),
      change('notes/2026/day10.md', 1, 1),
      change('notes/2026/day9.md', 1, 1),
      change('assets/logo.png', null, null, 'added'),
      change('Notes.md', 1, 0),
    ]);
    expect(outline(tree)).toEqual([
      'assets/ (1 files, +? −?, 1 uncounted)',
      '  logo.png',
      'notes/ (4 files, +7 −3, 0 uncounted)',
      '  2026/ (2 files, +2 −2, 0 uncounted)',
      '    day9.md',
      '    day10.md',
      '  a.md',
      '  b.md',
      'Notes.md',
      'README.md',
    ]);
  });

  it('collapses a chain of single-child folders into one row', () => {
    const tree = buildFileTree([
      change('src/engine/ai/types.ts', 120, 0, 'added'),
      change('src/engine/ai/steps.ts', 30, 0, 'added'),
    ]);
    expect(tree).toHaveLength(1);
    const folder = tree[0] as FileTreeFolder;
    expect(folder).toMatchObject({
      type: 'folder',
      name: 'src/engine/ai',
      path: 'src/engine/ai',
      files: 2,
      additions: 150,
      deletions: 0,
      uncounted: 0,
    });
    expect(folder.children.map((child) => child.path)).toEqual([
      'src/engine/ai/steps.ts',
      'src/engine/ai/types.ts',
    ]);
  });

  it('keeps a folder holding a file and a folder as its own row', () => {
    const tree = buildFileTree([change('a/b/c.md', 1, 0), change('a/d.md', 1, 0)]);
    expect(outline(tree)).toEqual([
      'a/ (2 files, +2 −0, 0 uncounted)',
      '  b/ (1 files, +1 −0, 0 uncounted)',
      '    c.md',
      '  d.md',
    ]);
  });

  it('never counts a binary file as zero lines', () => {
    const [folder] = buildFileTree([
      change('media/a.png', null, null),
      change('media/b.png', null, null),
    ]) as FileTreeFolder[];
    expect(folder).toMatchObject({ files: 2, additions: null, deletions: null, uncounted: 2 });
    const [mixed] = buildFileTree([
      change('docs/a.md', 4, 2),
      change('docs/b.pdf', null, null),
    ]) as FileTreeFolder[];
    expect(mixed).toMatchObject({ files: 2, additions: 4, deletions: 2, uncounted: 1 });
  });

  it('keeps a file’s change, and where a renamed one was', () => {
    const [file] = buildFileTree([
      { path: 'plan.md', kind: 'renamed', previousPath: 'draft.md', additions: 0, deletions: 0 },
    ]);
    expect(file).toEqual({
      type: 'file',
      name: 'plan.md',
      path: 'plan.md',
      kind: 'renamed',
      previousPath: 'draft.md',
      additions: 0,
      deletions: 0,
    });
  });

  it('reads stray slashes away, keeps the first of a path listed twice, and skips an empty one', () => {
    const tree = buildFileTree([
      change('/notes//a.md/', 1, 0),
      change('notes/a.md', 9, 9),
      change('', 1, 1),
      change('/', 1, 1),
    ]);
    expect(outline(tree)).toEqual(['notes/ (1 files, +1 −0, 0 uncounted)', '  a.md']);
    expect((tree[0] as FileTreeFolder).children[0].path).toBe('notes/a.md');
  });

  it('is empty for no files', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe('fileChangeOf', () => {
  it('reads a changeset row', () => {
    const row: ChangedFile = {
      path: 'b.md',
      previous_path: 'a.md',
      kind: 'renamed',
      additions: null,
      deletions: null,
      also_by: ['human:me'],
    };
    expect(fileChangeOf(row)).toEqual({
      path: 'b.md',
      kind: 'renamed',
      previousPath: 'a.md',
      additions: null,
      deletions: null,
    });
    expect(fileChangeOf({ ...row, previous_path: null, kind: 'added' })).not.toHaveProperty(
      'previousPath',
    );
  });
});
