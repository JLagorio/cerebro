// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFileTree, type FileChange, type FileTreeFolder } from '@/engine/ai/fileTree';
import { FileTree, fileLineWords, folderWords } from './FileTree';

/**
 * File Tree (M91.9): the files a turn changed, folders first. Each file says
 * how it changed in words and counts its lines only as git counted them —
 * "binary" or "not recorded", never 0 (CV-05) — and opens through the
 * caller, never an href (CV-16).
 */

afterEach(cleanup);

const CHANGES: FileChange[] = [
  { path: 'src/engine/ai/fileTree.ts', kind: 'modified', additions: 12, deletions: 3 },
  { path: 'src/engine/ai/types.ts', kind: 'added', additions: 40, deletions: 0 },
  { path: 'assets/logo.png', kind: 'modified', additions: null, deletions: null },
  {
    path: 'notes/new.md',
    kind: 'renamed',
    previousPath: 'notes/old.md',
    additions: 1,
    deletions: 1,
  },
  { path: 'notes/gone.md', kind: 'deleted', additions: 0, deletions: 20 },
];

const TREE = buildFileTree(CHANGES);

const file = (path: string) =>
  document.querySelector(`[data-slot="file-tree-file"][data-path="${path}"]`) as HTMLElement;

describe('FileTree', () => {
  it('opens every folder from the start, each counting its files and lines', () => {
    render(<FileTree tree={TREE} onOpenPath={() => undefined} />);
    const folders = screen
      .getAllByRole('button', { expanded: true })
      .map((button) => button.textContent);
    expect(folders).toEqual([
      'assets1 file · 1 binary',
      'notes2 files · +1 −21',
      'src/engine/ai2 files · +52 −3',
    ]);
  });

  it('says how each file changed, in words, and opens it through the caller', () => {
    const onOpenPath = vi.fn();
    render(<FileTree tree={TREE} onOpenPath={onOpenPath} />);
    const open = screen.getByRole('button', { name: 'Open fileTree.ts modified · +12 −3' });
    expect(open.getAttribute('title')).toBe('src/engine/ai/fileTree.ts');
    fireEvent.click(open);
    expect(onOpenPath).toHaveBeenCalledWith('src/engine/ai/fileTree.ts');
    expect(screen.getByRole('button', { name: 'Open types.ts added · +40 −0' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open new.md renamed · +1 −1' })).toBeTruthy();
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('reads a binary file "binary", never a count of 0', () => {
    render(<FileTree tree={TREE} onOpenPath={() => undefined} />);
    const logo = screen.getByRole('button', { name: 'Open logo.png modified · binary' });
    expect(logo.textContent).not.toMatch(/\d/);
  });

  it('reads counts nobody kept "not recorded" when the caller says so', () => {
    const tree = buildFileTree([
      { path: 'notes/a.md', kind: 'modified', additions: null, deletions: null },
      { path: 'notes/b.md', kind: 'added', additions: null, deletions: null },
    ]);
    render(<FileTree tree={tree} missingCounts="not_recorded" onOpenPath={() => undefined} />);
    expect(screen.getByRole('button', { name: 'notes 2 files · 2 not recorded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open a.md modified · not recorded' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\+0|−0|binary/);
  });

  it('draws a deleted file as text: there is nothing left to open', () => {
    render(<FileTree tree={TREE} onOpenPath={() => undefined} />);
    const gone = file('notes/gone.md');
    expect(within(gone).queryByRole('button')).toBeNull();
    expect(gone.textContent).toBe('gone.mddeleted · +0 −20');
  });

  it('says where a renamed file was', () => {
    render(<FileTree tree={TREE} />);
    expect(file('notes/new.md').querySelector('[data-slot="file-tree-moved"]')?.textContent).toBe(
      'from notes/old.md',
    );
  });

  it('puts a file’s actions beside its button, and the caller’s lines under it', () => {
    const viewDiff = vi.fn();
    render(
      <FileTree
        tree={TREE}
        onOpenPath={() => undefined}
        actions={(changed) => (
          <button type="button" onClick={() => viewDiff(changed.path)}>
            View diff of {changed.name}
          </button>
        )}
        detail={(changed) => (changed.kind === 'added' ? <span>also edited by you</span> : null)}
      />,
    );
    const view = screen.getByRole('button', { name: 'View diff of fileTree.ts' });
    const open = screen.getByRole('button', { name: 'Open fileTree.ts modified · +12 −3' });
    expect(open.contains(view)).toBe(false);
    expect(view.closest('[data-slot="file-tree-actions"]')).not.toBeNull();
    fireEvent.click(view);
    expect(viewDiff).toHaveBeenCalledWith('src/engine/ai/fileTree.ts');
    expect(file('src/engine/ai/types.ts').textContent).toContain('also edited by you');
    expect(file('src/engine/ai/fileTree.ts').querySelector('.cb-ai-file-tree-detail')).toBeNull();
    // A deleted file keeps its actions: its diff is still there to see.
    expect(
      within(file('notes/gone.md')).getByRole('button', { name: 'View diff of gone.md' }),
    ).toBeTruthy();
  });

  it('marks the file shown beside it', () => {
    render(
      <FileTree tree={TREE} onOpenPath={() => undefined} selectedPath="src/engine/ai/types.ts" />,
    );
    const current = document.querySelectorAll('[aria-current]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('aria-current')).toBe('true');
    expect(current[0].getAttribute('title')).toBe('src/engine/ai/types.ts');
  });

  it('opens only the folders it is told to, and keeps the others’ files in the document', () => {
    render(<FileTree tree={TREE} defaultExpanded={new Set(['notes'])} />);
    expect(screen.getByRole('button', { name: /^notes/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    const closed = screen.getByRole('button', { name: /^src\/engine\/ai/ });
    expect(closed.getAttribute('aria-expanded')).toBe('false');
    expect(file('src/engine/ai/fileTree.ts').closest('[hidden]')).not.toBeNull();
    fireEvent.click(closed);
    expect(file('src/engine/ai/fileTree.ts').closest('[hidden]')).toBeNull();
  });

  it('is text, not buttons, with nothing to open files', () => {
    render(<FileTree tree={TREE} />);
    expect(screen.queryAllByRole('button', { name: /^Open / })).toHaveLength(0);
  });

  it('opens no path that leaves the vault', () => {
    const tree = buildFileTree([
      { path: '../outside.md', kind: 'modified', additions: 1, deletions: 0 },
    ]);
    render(<FileTree tree={tree} onOpenPath={() => undefined} />);
    expect(screen.queryAllByRole('button', { name: /^Open / })).toHaveLength(0);
    expect(file('../outside.md').textContent).toContain('outside.md');
  });

  it('draws nothing for nothing changed', () => {
    const { container } = render(<FileTree tree={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('gives every row, a file’s button and a folder’s fold, the tab stop asked for (M92.4)', () => {
    render(
      <FileTree
        data-testid="tree"
        tree={TREE}
        onOpenPath={() => undefined}
        tabIndex={0}
        actions={() => <button type="button">View diff</button>}
      />,
    );
    const rows = [
      ...screen.getAllByRole('button', { expanded: true }),
      ...screen.getAllByRole('button', { name: /^Open / }),
    ];
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.getAttribute('tabindex'), row.textContent ?? '').toBe('0');
    // The tree is no stop, and a row's actions are the caller's own.
    expect(screen.getByTestId('tree').hasAttribute('tabindex')).toBe(false);
    for (const action of screen.getAllByRole('button', { name: 'View diff' })) {
      expect(action.hasAttribute('tabindex')).toBe(false);
    }
    cleanup();
    // Unasked, a row keeps its own.
    render(<FileTree tree={TREE} onOpenPath={() => undefined} />);
    expect(document.querySelector('[tabindex]')).toBeNull();
  });
});

describe('the words', () => {
  it('counts a file’s lines, or says why it cannot', () => {
    expect(fileLineWords({ additions: 3, deletions: 0 })).toBe('+3 −0');
    expect(fileLineWords({ additions: null, deletions: null })).toBe('binary');
    expect(fileLineWords({ additions: null, deletions: null }, 'not_recorded')).toBe(
      'not recorded',
    );
    expect(fileLineWords({ additions: 3, deletions: null })).toBe('binary');
  });

  it('counts a folder’s files, the lines git counted, and the files it could not', () => {
    const folder = (over: Partial<FileTreeFolder>): FileTreeFolder => ({
      type: 'folder',
      name: 'notes',
      path: 'notes',
      children: [],
      files: 3,
      additions: 10,
      deletions: 2,
      uncounted: 0,
      ...over,
    });
    expect(folderWords(folder({}))).toBe('3 files · +10 −2');
    expect(folderWords(folder({ uncounted: 1 }))).toBe('3 files · +10 −2 · 1 binary');
    expect(folderWords(folder({ files: 1, additions: null, deletions: null, uncounted: 1 }))).toBe(
      '1 file · 1 binary',
    );
    expect(
      folderWords(folder({ additions: null, deletions: null, uncounted: 3 }), 'not_recorded'),
    ).toBe('3 files · 3 not recorded');
  });
});
