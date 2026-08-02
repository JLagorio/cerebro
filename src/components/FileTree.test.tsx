// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { FileTree } from './FileTree';

const ROOT = 'projects/guided-onboarding-ga';
const PROJECT = `${ROOT}/project.md`;
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

const renderTree = (onOpen = vi.fn()) => {
  render(<FileTree root={ROOT} hide={(p) => p === PROJECT} onOpen={onOpen} />);
  return onOpen;
};

describe('FileTree', () => {
  beforeEach(async () => {
    resetMockFs();
    window.localStorage.clear();
    useUiStore.setState({ expandedFolders: {}, treeOrder: {}, toasts: [], detailPath: null });
    await useVaultStore.getState().openVault('/demo-vault');
  });
  afterEach(cleanup);

  // Rows show humanized folder names and note titles (M2.x feedback):
  // 'meetings' renders as "Meetings", kickoff.md as its H1 title.
  const KICKOFF_TITLE = 'Guided onboarding GA kickoff';

  it('lists folders and files, hides the excluded project.md', () => {
    renderTree();
    const folders = screen.getAllByTestId('tree-folder').map((el) => el.textContent);
    expect(folders).toContain('Meetings');
    expect(folders).toContain('Items');
    // Root holds only folders (project.md is hidden), so no file rows yet.
    expect(screen.queryAllByTestId('tree-file')).toHaveLength(0);
  });

  it('expands a folder on click and persists the expand state', () => {
    renderTree();
    expect(screen.queryByText(KICKOFF_TITLE)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    expect(screen.getByText(KICKOFF_TITLE)).toBeTruthy();
    expect(useUiStore.getState().expandedFolders[`${ROOT}/meetings`]).toBe(true);
    expect(window.localStorage.getItem('cerebro.expandedFolders')).toContain(`${ROOT}/meetings`);
  });

  it('opens a file through onOpen', () => {
    const onOpen = renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.click(screen.getByRole('button', { name: KICKOFF_TITLE }));
    expect(onOpen).toHaveBeenCalledWith(`${ROOT}/meetings/kickoff.md`);
  });

  it('creates a page with the typed capitalization and opens it', async () => {
    const onOpen = renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), {
      target: { value: 'Design Notes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/design-notes.md`));
    expect(fs().get(`${ROOT}/design-notes.md`)).toBe('# Design Notes\n');
    expect(useVaultStore.getState().entries.some((e) => e.path === `${ROOT}/design-notes.md`)).toBe(
      true,
    );
  });

  it('creates a folder and shows it expanded even while empty', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByPlaceholderText('Folder name'), {
      target: { value: 'Research' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(screen.getAllByTestId('tree-folder').map((el) => el.textContent)).toContain(
        'Research',
      ),
    );
    expect(screen.getByText('Empty folder')).toBeTruthy();
  });

  it('renames a file on disk (via the row options menu)', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.click(screen.getByRole('button', { name: `Options for ${KICKOFF_TITLE}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByPlaceholderText('Page name');
    expect((input as HTMLInputElement).value).toBe('kickoff');
    fireEvent.change(input, { target: { value: 'kickoff-notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/kickoff-notes.md`)).toBe(true));
    expect(fs().has(`${ROOT}/meetings/kickoff.md`)).toBe(false);
  });

  // Task 14: right-click context menus.
  it('right-clicking a file offers rename and trash', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.contextMenu(screen.getByRole('button', { name: KICKOFF_TITLE }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByPlaceholderText('Page name') as HTMLInputElement;
    expect(input.value).toBe('kickoff');
    fireEvent.change(input, { target: { value: 'standup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/standup.md`)).toBe(true));
  });

  it('right-clicking a folder creates a page inside it', async () => {
    const onOpen = renderTree();
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New page' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), {
      target: { value: 'Retro' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/meetings/retro.md`));
  });

  it('right-clicking the background targets the tree root', async () => {
    const onOpen = renderTree();
    fireEvent.contextMenu(screen.getByTestId('file-tree'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New page' }));
    // No rename/trash on the background menu — there is no target node.
    fireEvent.change(screen.getByPlaceholderText('Page name'), {
      target: { value: 'Scratch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/scratch.md`));
  });

  it('right-clicking a file and choosing Move to Trash deletes after confirm', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.contextMenu(screen.getByRole('button', { name: KICKOFF_TITLE }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/kickoff.md`)).toBe(false));
  });

  it('moves a file to the Trash after confirmation (via the row options menu)', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.click(screen.getByRole('button', { name: `Options for ${KICKOFF_TITLE}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/kickoff.md`)).toBe(false));
  });

  // M2.x docs polish: folder-note docs render as documents with page tabs.
  it('renders a folder-note as a doc row that opens its main page', async () => {
    fs().set(`${ROOT}/notes/notes.md`, '# Team Notes\n');
    fs().set(`${ROOT}/notes/extra.md`, '# Extra page\n');
    await useVaultStore.getState().rescan();
    const onOpen = renderTree();
    const doc = screen.getByTestId('tree-doc');
    // Doc rows carry the folder note's TITLE, not the slug.
    expect(doc.textContent).toContain('Team Notes');
    fireEvent.click(doc);
    expect(onOpen).toHaveBeenCalledWith(`${ROOT}/notes/notes.md`);
    // Expanding shows only the extra pages, not the folder note itself.
    fireEvent.click(screen.getByRole('button', { name: 'Expand Team Notes' }));
    const files = screen.getAllByTestId('tree-file').map((el) => el.textContent);
    expect(files).toContain('Extra page');
    expect(files).not.toContain('Team Notes');
  });

  it('creates a page from a template with placeholders filled', async () => {
    const onOpen = renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), {
      target: { value: 'Sprint Review' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Template' }));
    fireEvent.click(screen.getByRole('option', { name: /meeting/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/sprint-review.md`));
    const raw = fs().get(`${ROOT}/sprint-review.md`) ?? '';
    expect(raw).toContain('# Sprint Review');
    expect(raw).toContain('type: Meeting');
    expect(raw).not.toContain('{{title}}');
    expect(raw).not.toContain('{{date}}');
  });

  // --- Drag & drop (M2.x): reorder siblings, move into folders ------------
  // jsdom rects are zero-sized, so onRowDragOver's ratio reduces to the raw
  // clientY: 0 → before, 0.5 → into, 1 → after.

  const rowFor = (path: string) =>
    screen
      .getAllByTestId('tree-row')
      .find((el) => el.getAttribute('data-path') === path) as HTMLElement;

  // testing-library's fireEvent drops clientY from drag events in jsdom, so
  // dispatch native events with the fields the handlers read assigned on
  // (act-wrapped so each event sees the previous one's committed state).
  const fireDnd = (el: HTMLElement, type: string, dt: object, clientY: number) => {
    const ev = new Event(type, { bubbles: true, cancelable: true }) as unknown as Record<
      string,
      unknown
    >;
    ev.dataTransfer = dt;
    ev.clientY = clientY;
    act(() => {
      el.dispatchEvent(ev as unknown as Event);
    });
  };

  const drag = (from: string, to: string, clientY: number) => {
    const dt = { setData: vi.fn(), dropEffect: '', effectAllowed: '' };
    fireDnd(rowFor(from), 'dragstart', dt, 0);
    fireDnd(rowFor(to), 'dragover', dt, clientY);
    fireDnd(rowFor(to), 'drop', dt, clientY);
    fireDnd(rowFor(from), 'dragend', dt, 0);
  };

  it('reorders siblings on drop-before and persists the order', async () => {
    renderTree();
    drag(`${ROOT}/meetings`, `${ROOT}/items`, 0);
    await waitFor(() => {
      const order = screen.getAllByTestId('tree-row').map((el) => el.getAttribute('data-path'));
      expect(order.indexOf(`${ROOT}/meetings`)).toBeLessThan(order.indexOf(`${ROOT}/items`));
    });
    expect(useUiStore.getState().treeOrder[ROOT]).toEqual(['meetings', 'items']);
    expect(window.localStorage.getItem('cerebro.treeOrder')).toContain('meetings');
  });

  it('moves a file (and keeps it) when dropped onto a folder', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    drag(`${ROOT}/meetings/kickoff.md`, `${ROOT}/items`, 0.5);
    await waitFor(() => expect(fs().has(`${ROOT}/items/kickoff.md`)).toBe(true));
    expect(fs().has(`${ROOT}/meetings/kickoff.md`)).toBe(false);
    // The destination folder reveals the moved file.
    expect(useUiStore.getState().expandedFolders[`${ROOT}/items`]).toBe(true);
  });

  it('refuses to drop a folder into itself or its descendants', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    drag(`${ROOT}/meetings`, `${ROOT}/meetings`, 0.5);
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/kickoff.md`)).toBe(true));
  });
});
