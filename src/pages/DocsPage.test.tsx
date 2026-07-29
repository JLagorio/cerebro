// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDocEntry } from '@/engine/typeCatalog';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { getSchema, useVaultStore } from '@/stores/vaultStore';
import { DocsPage } from './DocsPage';

describe('DocsPage', () => {
  beforeEach(async () => {
    resetMockFs();
    window.localStorage.clear();
    useUiStore.setState({ expandedFolders: {}, toasts: [], detailPath: null });
    useNavStore.setState({
      selection: { kind: 'docs' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    await useVaultStore.getState().openVault('/demo-vault');
  });
  afterEach(cleanup);

  it('lists recent docs without records, type docs, or templates', () => {
    render(<DocsPage />);
    // Paths, not title prefixes: a meeting note legitimately starts with its
    // project's name ("Field App launch campaign kickoff").
    const paths = screen
      .getAllByTestId('recent-doc')
      .map((el) => el.getAttribute('data-path') ?? '');
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBeLessThanOrEqual(6);
    const byPath = new Map(useVaultStore.getState().entries.map((e) => [e.path, e]));
    const schema = getSchema(useVaultStore.getState().entries);
    for (const path of paths) {
      const entry = byPath.get(path);
      expect(entry).toBeDefined();
      // M3.1 (isDocEntry): Docs holds untyped notes PLUS types that opt in
      // with `display: doc` — meeting notes and journals are written, not
      // tracked. Records (Work item, Person, Project) and `type: Type`
      // declarations live on their type screen and never appear here.
      expect(entry !== undefined && isDocEntry(entry, schema)).toBe(true);
      expect(entry?.type).not.toBe('Type');
      expect(path.startsWith('templates/')).toBe(false);
    }
  });

  it('opens a recent doc as a full-page document', () => {
    render(<DocsPage />);
    fireEvent.click(screen.getAllByTestId('recent-doc')[0]);
    expect(useNavStore.getState().selection.kind).toBe('doc');
  });

  // Task 14: the folder tree moved to the docs-mode Sidebar; the canvas is
  // recents only.
  it('no longer hosts the folder tree on the canvas', () => {
    render(<DocsPage />);
    expect(screen.queryByTestId('file-tree')).toBeNull();
  });

  it('shows an empty state when the vault has no documents', () => {
    useVaultStore.setState({
      entries: useVaultStore
        .getState()
        .entries.filter((e) => e.type === 'Work item' || e.path.endsWith('project.md')),
    });
    render(<DocsPage />);
    expect(screen.getByText('No documents yet')).toBeTruthy();
  });
});
