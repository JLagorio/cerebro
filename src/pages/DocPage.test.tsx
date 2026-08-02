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
    // The Docs crumb navigates back to the all-docs surface.
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'docs' });
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    // The side panel's Outline tab fills once the editor is ready.
    await waitFor(() => expect(screen.getByTestId('doc-outline')).toBeTruthy(), {
      timeout: 5_000,
    });
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
