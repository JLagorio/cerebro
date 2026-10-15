// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mockIpc from '@/lib/mockIpc';
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
    // Prefilled with the VISIBLE name (the note's H1), not the slug on disk.
    expect((input as HTMLInputElement).value).toBe(KICKOFF_TITLE);
    fireEvent.change(input, { target: { value: 'Kickoff notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/kickoff-notes.md`)).toBe(true));
    expect(fs().has(`${ROOT}/meetings/kickoff.md`)).toBe(false);
  });

  // M29.21: renaming used to stamp `.md` onto every file node, so a rename
  // turned pipeline.mmd into pipeline.md — no longer a diagram — and then
  // spliced `# title` into raw mermaid source on top of it.
  it('renaming a .mmd keeps its extension and never writes an H1 into it', async () => {
    const MMD = '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B\n';
    await mockIpc.writeTextFile('/demo-vault', `${ROOT}/flow.mmd`, MMD);
    await useVaultStore.getState().rescan();
    renderTree();
    // Title comes from the filename stem — 'Flow'.
    fireEvent.click(screen.getByRole('button', { name: 'Options for Flow' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), {
      target: { value: 'Build flow' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(fs().has(`${ROOT}/build-flow.mmd`)).toBe(true));
    expect(fs().has(`${ROOT}/flow.mmd`)).toBe(false);
    expect(fs().has(`${ROOT}/build-flow.md`)).toBe(false);
    // The bytes are untouched: no `# Build flow` spliced into the source.
    expect(fs().get(`${ROOT}/build-flow.mmd`)).toBe(MMD);
  });

  // A row's label comes from the note's H1, so renaming only the filename
  // left every visible surface showing the old name.
  it('rename rewrites the H1 so the row label actually changes', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.click(screen.getByRole('button', { name: `Options for ${KICKOFF_TITLE}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), { target: { value: 'Team Sync' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(screen.getByText('Team Sync')).toBeTruthy());
    expect(fs().get(`${ROOT}/meetings/team-sync.md`)).toContain('# Team Sync');
    expect(screen.queryByText(KICKOFF_TITLE)).toBeNull();
  });

  // Renaming or moving the page you are READING must not strand the canvas
  // on "This page no longer exists" — follow the file.
  it('reopens the active page at its new path after a rename', async () => {
    const onOpen = vi.fn();
    render(
      <FileTree
        root={ROOT}
        hide={(p) => p === PROJECT}
        activePath={`${ROOT}/meetings/kickoff.md`}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.click(screen.getByRole('button', { name: `Options for ${KICKOFF_TITLE}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), { target: { value: 'Team Sync' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/meetings/team-sync.md`));
  });

  it('creates a folder inside a collapsed parent and reveals the chain', async () => {
    renderTree();
    // `meetings` starts collapsed — the new folder used to land invisibly.
    expect(useUiStore.getState().expandedFolders[`${ROOT}/meetings`]).toBeUndefined();
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New folder' }));
    fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: 'Sub' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(screen.getAllByTestId('tree-folder').map((el) => el.textContent)).toContain('Sub'),
    );
    expect(useUiStore.getState().expandedFolders[`${ROOT}/meetings`]).toBe(true);
  });

  // The per-row actions must stay in the tab order: `hidden` (display:none)
  // removed them entirely, so keyboard users had no path to them at all.
  it('keeps the per-row actions focusable while they are visually hidden', () => {
    renderTree();
    const actions = screen
      .getByRole('button', { name: /^Options for Meetings/ })
      .closest('span')?.parentElement;
    expect(actions?.className).toContain('opacity-0');
    expect(actions?.className).not.toContain('hidden');
    expect(actions?.className).toContain('group-focus-within:opacity-100');
  });

  // Docs-only mode prunes folders the record filter emptied. The prune used
  // to test only a folder's DIRECT children, so `records/` (whose files sit
  // one level deeper) survived and told the user it was an "Empty folder".
  it('prunes record-only folders transitively in docs-only mode', async () => {
    // strategy/ carried the yml-only assertion until M29.8 gave it a doc
    // (systems-map.md) — a synthetic Collection holding only collection.yml
    // and a List keeps that case covered.
    fs().set('roadmaps/collection.yml', 'name: Roadmaps\n');
    fs().set('roadmaps/big-rocks.list.yml', 'name: Big rocks\n');
    await useVaultStore.getState().openVault('/demo-vault');
    render(<FileTree root="" docsOnly onOpen={vi.fn()} />);
    const folders = screen.getAllByTestId('tree-folder').map((el) => el.textContent);
    expect(folders).not.toContain('Records');
    expect(folders).not.toContain('Types');
    // roadmaps/ holds only collection.yml and Lists — a Collection, not an
    // "Empty folder".
    expect(folders).not.toContain('Roadmaps');
    // strategy/ holds a doc now, so docs-only mode keeps it.
    expect(folders).toContain('Strategy');
  });

  it('never claims a surviving docs-only folder is empty when it is not', () => {
    useUiStore.setState({
      expandedFolders: Object.fromEntries(useVaultStore.getState().folders.map((f) => [f, true])),
    });
    render(<FileTree root="" docsOnly onOpen={vi.fn()} />);
    expect(screen.queryByText('Empty folder')).toBeNull();
  });

  // Task 14: right-click context menus.
  it('right-clicking a file offers rename and trash', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.contextMenu(screen.getByRole('button', { name: KICKOFF_TITLE }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByPlaceholderText('Page name') as HTMLInputElement;
    expect(input.value).toBe(KICKOFF_TITLE);
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

  // M60.8: the vault's own Trash, through trashPath, in the new words.
  it('moves a page into the vault Trash, byte for byte, and says Settings restores it', async () => {
    const page = `${ROOT}/meetings/kickoff.md`;
    const bytes = fs().get(page);
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.contextMenu(screen.getByRole('button', { name: KICKOFF_TITLE }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('It moves to the Trash.');
    expect(dialog.textContent).toContain('Restore from Settings → Recently deleted for 30 days.');
    expect(dialog.textContent).not.toMatch(/system Trash|not from the app/);
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(fs().has(page)).toBe(false));
    const trashed = [...fs().keys()].find((p) => p.startsWith('.trash/') && p.endsWith(page));
    expect(trashed && fs().get(trashed)).toBe(bytes);
    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        `Moved “${KICKOFF_TITLE}” to Trash`,
      ),
    );
  });

  it('says the folder and everything inside it move to the Trash', () => {
    renderTree();
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Meetings/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
    expect(screen.getByRole('dialog').textContent).toContain(
      'The folder and everything inside it move to the Trash.',
    );
  });

  // M2.x docs polish: a folder note renders as its page, its sub-pages beneath.
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
    // Expanding shows only the sub-pages, not the folder note itself.
    fireEvent.click(screen.getByRole('button', { name: 'Expand Team Notes' }));
    const files = screen.getAllByTestId('tree-file').map((el) => el.textContent);
    expect(files).toContain('Extra page');
    expect(files).not.toContain('Team Notes');
  });

  // M55.11 — a page's own icon comes first on its row; without one, the row
  // keeps its type's glyph (a file) or the stack (a doc).
  it('file rows and doc rows draw page icons, and fall back to the type style', async () => {
    const ROCKET = '\u{1F680}';
    const PARTY = '\u{1F389}';
    fs().set(`${ROOT}/notes/notes.md`, `---\nicon: ${ROCKET}\n---\n# Team Notes\n`);
    fs().set(`${ROOT}/notes/extra.md`, `---\nicon: ${PARTY}\n---\n# Extra page\n`);
    fs().set(`${ROOT}/notes/plain.md`, '# Plain page\n');
    await useVaultStore.getState().rescan();
    renderTree();
    const doc = screen.getByTestId('tree-doc');
    expect(doc.querySelector('[role="img"]')?.textContent).toBe(ROCKET);
    expect(doc.querySelector('[data-icon="file-stack"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Team Notes' }));
    const rows = screen.getAllByTestId('tree-file');
    const extra = rows.find((r) => r.textContent?.includes('Extra page'));
    const plain = rows.find((r) => r.textContent?.includes('Plain page'));
    expect(extra?.querySelector('[role="img"]')?.textContent).toBe(PARTY);
    expect(plain?.querySelector('[role="img"]')).toBeNull();
    expect(plain?.querySelector('[data-icon="file-text"]')).not.toBe(null);
    // A typed file with no icon keeps its type's glyph.
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    const kickoff = screen.getByRole('button', { name: KICKOFF_TITLE });
    expect(kickoff.querySelector('[role="img"]')).toBeNull();
    expect(kickoff.querySelector('svg[data-icon]')).not.toBe(null);
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
  // clientY: 0 → before, 0.5 → into, 1 → after. A file row that cannot take
  // sub-pages has no middle: below 0.5 is before, the rest after.

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

  // M55.13 — a page row takes a drop into its middle half as nesting; its
  // outer quarters still reorder.
  describe('sub-pages', () => {
    beforeEach(async () => {
      fs().set(`${ROOT}/alpha.md`, '# Alpha\n');
      fs().set(`${ROOT}/beta.md`, '# Beta\n');
      await useVaultStore.getState().rescan();
    });

    it('nests a page dropped on the middle of a page row, growing the target', async () => {
      const onOpen = vi.fn();
      render(
        <FileTree
          root={ROOT}
          hide={(p) => p === PROJECT}
          activePath={`${ROOT}/alpha.md`}
          onOpen={onOpen}
        />,
      );
      drag(`${ROOT}/beta.md`, `${ROOT}/alpha.md`, 0.5);
      await waitFor(() => expect(fs().get(`${ROOT}/alpha/beta.md`)).toBe('# Beta\n'));
      expect(fs().get(`${ROOT}/alpha/alpha.md`)).toBe('# Alpha\n');
      expect(fs().has(`${ROOT}/alpha.md`)).toBe(false);
      // The open page follows its file, and the new folder opens.
      expect(onOpen).toHaveBeenCalledWith(`${ROOT}/alpha/alpha.md`);
      expect(useUiStore.getState().expandedFolders[`${ROOT}/alpha`]).toBe(true);
    });

    it('still reorders on the outer quarters of a page row', async () => {
      renderTree();
      drag(`${ROOT}/beta.md`, `${ROOT}/alpha.md`, 0);
      await waitFor(() => expect(useUiStore.getState().treeOrder[ROOT]).toBeDefined());
      const order = useUiStore.getState().treeOrder[ROOT];
      expect(order.indexOf('beta')).toBeLessThan(order.indexOf('alpha'));
      drag(`${ROOT}/beta.md`, `${ROOT}/alpha.md`, 1);
      await waitFor(() => {
        const next = useUiStore.getState().treeOrder[ROOT];
        expect(next.indexOf('beta')).toBe(next.indexOf('alpha') + 1);
      });
      expect(fs().has(`${ROOT}/alpha.md`)).toBe(true);
      expect(fs().has(`${ROOT}/beta.md`)).toBe(true);
    });

    it('refuses a doc dropped onto its own sub-page, and moves nothing', async () => {
      fs().set(`${ROOT}/notes/notes.md`, '# Team Notes\n');
      fs().set(`${ROOT}/notes/extra.md`, '# Extra page\n');
      await useVaultStore.getState().rescan();
      renderTree();
      fireEvent.click(screen.getByRole('button', { name: 'Expand Team Notes' }));
      const before = new Map(fs());
      drag(`${ROOT}/notes`, `${ROOT}/notes/extra.md`, 0.5);
      await waitFor(() =>
        expect(
          useUiStore.getState().toasts.some((t) => t.message.startsWith("Couldn't add sub-page")),
        ).toBe(true),
      );
      expect(new Map(fs())).toEqual(before);
    });

    it("a page row's + and its menu open Add sub-page", async () => {
      const onOpen = renderTree();
      fireEvent.click(screen.getByRole('button', { name: 'Add a sub-page to Alpha' }));
      expect(screen.getByRole('dialog', { name: 'Add sub-page' })).toBeTruthy();
      expect(
        screen.getByText('"Alpha" moves into a folder of its own. Its text does not change.'),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Add sub-page' }));
      fireEvent.change(screen.getByPlaceholderText('Page name'), { target: { value: 'Goals' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/alpha/goals.md`));
      expect(fs().get(`${ROOT}/alpha/alpha.md`)).toBe('# Alpha\n');
      // The grown page is a doc row now, open, with its sub-page under it.
      expect(screen.getByTestId('tree-doc').textContent).toContain('Alpha');
      expect(screen.getAllByTestId('tree-file').map((el) => el.textContent)).toContain('Goals');
    });

    it('says No sub-pages under a page that has none', async () => {
      fs().set(`${ROOT}/notes/notes.md`, '# Team Notes\n');
      await useVaultStore.getState().rescan();
      renderTree();
      fireEvent.click(screen.getByRole('button', { name: 'Expand Team Notes' }));
      expect(screen.getByText('No sub-pages')).toBeTruthy();
    });
  });

  it('refuses to drop a folder into itself or its descendants', async () => {
    renderTree();
    fireEvent.click(screen.getByRole('button', { name: /^Meetings/ }));
    drag(`${ROOT}/meetings`, `${ROOT}/meetings`, 0.5);
    await waitFor(() => expect(fs().has(`${ROOT}/meetings/kickoff.md`)).toBe(true));
  });
});
