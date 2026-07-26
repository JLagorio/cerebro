// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
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

  it('lists recent docs without work items or project files', () => {
    render(<DocsPage />);
    const recents = screen.getAllByTestId('recent-doc').map((el) => el.textContent ?? '');
    expect(recents.length).toBeGreaterThan(0);
    expect(recents.length).toBeLessThanOrEqual(6);
    const entries = useVaultStore.getState().entries;
    const items = new Set(
      entries.filter((e) => e.type === 'Work item' || e.type === 'Project').map((e) => e.title),
    );
    for (const label of recents) {
      for (const title of items) expect(label.startsWith(title)).toBe(false);
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
