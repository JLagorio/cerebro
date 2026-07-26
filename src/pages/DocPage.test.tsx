// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { DocPage } from './DocPage';

const DOC = 'projects/guided-onboarding-ga/meetings/kickoff.md';

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
});
