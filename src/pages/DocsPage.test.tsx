// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { DocsPage } from './DocsPage';

const KICKOFF = 'projects/guided-onboarding-ga/meetings/kickoff.md';

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

  it('shows the whole vault as a folder tree', () => {
    render(<DocsPage />);
    const folders = screen.getAllByTestId('tree-folder').map((el) => el.textContent);
    expect(folders).toContain('projects');
    expect(folders).toContain('inbox');
  });

  it('routes tree opens by entry kind: project, work item, doc', () => {
    render(<DocsPage />);
    // Drill into projects → guided-onboarding-ga.
    fireEvent.click(screen.getByRole('button', { name: /^projects$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^guided-onboarding-ga/ }));
    // project.md navigates to the project canvas.
    fireEvent.click(screen.getByRole('button', { name: /^project$/ }));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'project',
      path: 'projects/guided-onboarding-ga/project.md',
    });
    // A work item opens the detail panel on its project.
    fireEvent.click(screen.getByRole('button', { name: /^items$/ }));
    fireEvent.click(screen.getAllByTestId('tree-file').find((el) => el.textContent === 'fld-1')!);
    expect(useUiStore.getState().detailPath).toBe(
      'projects/guided-onboarding-ga/items/fld-1.md',
    );
    // A meeting note opens as a document.
    fireEvent.click(screen.getByRole('button', { name: /^meetings$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^kickoff$/ }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: KICKOFF });
  });
});
