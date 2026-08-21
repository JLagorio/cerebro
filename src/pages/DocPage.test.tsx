// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { DocPage } from './DocPage';

const DOC = 'projects/guided-onboarding-ga/meetings/kickoff.md';
const DOC_FOLDER = 'projects/guided-onboarding-ga/spec';
const DOC_MAIN = `${DOC_FOLDER}/spec.md`;
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

describe('DocPage', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'doc', path: DOC },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    useUiStore.setState({ docPanelOpen: true, docPanelTab: 'outline' });
  });
  afterEach(cleanup);

  it('shows the breadcrumb bar, title, editor, and outline panel', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    const entry = useVaultStore.getState().entries.find((e) => e.path === DOC);
    expect(screen.getByTestId('doc-title').textContent).toBe(entry?.title);
    // Breadcrumb: folder segments render as humanized crumbs.
    expect(screen.getByText('Meetings')).toBeTruthy();
    // M38.2: the kickoff note is `type: Meeting` — a record — so its crumb
    // roots at its backdrop (the type screen), not at Docs, which never
    // owned it.
    fireEvent.click(screen.getByRole('button', { name: 'Meeting' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Meeting' });
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    // The side panel's Outline tab fills once the editor is ready.
    await waitFor(() => expect(screen.getByTestId('doc-outline')).toBeTruthy(), {
      timeout: 5_000,
    });
  });

  // M38.2 — a record is a page too: the peek's property surface renders on
  // the page canvas, and the crumb roots at the record's backdrop rather
  // than at Docs, which never owned it.
  it('renders a record as a page: properties above the body, backdrop crumb', async () => {
    const entries = useVaultStore.getState().entries;
    const record = entries.find((e) => e.type === 'Work item');
    if (record === undefined) throw new Error('fixture vault has no Work item');
    render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
    expect(screen.getByTestId('page-properties')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Docs' })).toBeNull();
    cleanup();

    // And a DOC keeps its document form: no property surface conjured for it.
    const doc = entries.find(
      (e) => (e.type === null || e.type === '') && !e.path.startsWith('knowledge/'),
    );
    if (doc === undefined) throw new Error('fixture vault has no untyped doc');
    render(<DocPage selection={{ kind: 'doc', path: doc.path }} />);
    expect(screen.queryByTestId('page-properties')).toBeNull();
    // M38.3: the crumb root is a plain 'Pages' label — the Docs surface it
    // used to navigate to is gone, and the nav's tree is the way up.
    expect(screen.getByText('Pages')).toBeTruthy();
  });

  it('the panel toggle hides and shows the side panel', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    expect(screen.getByTestId('doc-side-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }));
    expect(screen.queryByTestId('doc-side-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }));
    expect(screen.getByTestId('doc-side-panel')).toBeTruthy();
  });

  it('the Links tab lists backlinks from other notes', async () => {
    useUiStore.setState({ docPanelTab: 'links' });
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    // Work items in the fixture vault reference people/docs via wikilinks;
    // the kickoff doc links to people in its body.
    await waitFor(() => expect(screen.getByTestId('doc-links')).toBeTruthy());
  });

  it('falls back gracefully when the doc no longer exists', () => {
    render(<DocPage selection={{ kind: 'doc', path: 'nope/gone.md' }} />);
    expect(screen.getByText('This page no longer exists')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go home' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });

  // 'Add page' and 'Move to folder' both live in the overflow menu; the
  // toolbar's only LABELLED control used to be a duplicate of the action
  // users need least.
  it('does not duplicate overflow-menu actions in the toolbar', () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    expect(screen.queryByRole('button', { name: 'Add page' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move to folder' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    const labels = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(labels).toContain('Add page');
    expect(labels).toContain('Move to folder…');
    // Rename is reachable without going back to the file tree.
    expect(labels).toContain('Rename…');
  });

  it('renames the doc by rewriting its H1, not its filename', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), { target: { value: 'Team Sync' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(fs().get(DOC)).toContain('# Team Sync'), { timeout: 5_000 });
    // The file itself never moves — the path the user navigated to still works.
    expect(fs().has(DOC)).toBe(true);
  });

  // Move already operated on the whole doc folder; Trash deleted one file,
  // removing the folder note and dissolving the doc without warning.
  it('trashing a multi-page doc from its main page takes the whole doc', async () => {
    fs().set(DOC_MAIN, '# Spec\n');
    fs().set(`${DOC_FOLDER}/two.md`, '# Two\n');
    await useVaultStore.getState().rescan();
    render(<DocPage selection={{ kind: 'doc', path: DOC_MAIN }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move doc to Trash' }));
    expect(screen.getByText(/and its 1 other page to Trash\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(fs().has(`${DOC_FOLDER}/two.md`)).toBe(false), { timeout: 5_000 });
    expect(fs().has(DOC_MAIN)).toBe(false);
  });

  // M15: a doc whose body has no H1 had its title in the breadcrumb and
  // nowhere else — the document itself was untitled.
  describe('the title of an untitled doc', () => {
    const UNTITLED = 'inbox/capture-untitled.md';

    it('renders in the document, and only when the body has none', async () => {
      fs().set(UNTITLED, 'Sync error rate looked spiky again overnight.\n');
      await useVaultStore.getState().rescan();
      render(<DocPage selection={{ kind: 'doc', path: UNTITLED }} />);
      await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
        timeout: 5_000,
      });
      const heading = await screen.findByTestId('doc-title-heading');
      const entry = useVaultStore.getState().entries.find((e) => e.path === UNTITLED);
      expect((heading as HTMLTextAreaElement).value).toBe(entry?.title);

      // The doc that DOES carry an H1 must not grow a second title.
      cleanup();
      render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
      await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
        timeout: 5_000,
      });
      expect(screen.queryByTestId('doc-title-heading')).toBeNull();
    });

    it('committing it writes a real H1 into the body', async () => {
      fs().set(UNTITLED, 'Sync error rate looked spiky again overnight.\n');
      await useVaultStore.getState().rescan();
      render(<DocPage selection={{ kind: 'doc', path: UNTITLED }} />);
      const heading = await screen.findByTestId('doc-title-heading');
      fireEvent.change(heading, { target: { value: 'Sync error spike' } });
      fireEvent.blur(heading);
      await waitFor(() => expect(fs().get(UNTITLED)?.includes('# Sync error spike')).toBe(true), {
        timeout: 5_000,
      });
      // The body it was written above is still there — this adds a title, it
      // does not replace the document.
      expect(fs().get(UNTITLED)).toContain('Sync error rate looked spiky');
    });
  });

  it('trashing a non-main page of a doc still takes only that page', async () => {
    fs().set(DOC_MAIN, '# Spec\n');
    fs().set(`${DOC_FOLDER}/two.md`, '# Two\n');
    await useVaultStore.getState().rescan();
    render(<DocPage selection={{ kind: 'doc', path: `${DOC_FOLDER}/two.md` }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(fs().has(`${DOC_FOLDER}/two.md`)).toBe(false), { timeout: 5_000 });
    expect(fs().has(DOC_MAIN)).toBe(true);
  });
});
