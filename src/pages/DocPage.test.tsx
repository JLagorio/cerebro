// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { DocPage } from './DocPage';

const DOC = 'projects/guided-onboarding-ga/meetings/kickoff.md';
const PROJECT = 'projects/guided-onboarding-ga/project.md';

describe('DocPage', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'doc', path: DOC },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });
  afterEach(cleanup);

  it('shows the doc title, its project crumb, and the editor', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    const entry = useVaultStore.getState().entries.find((e) => e.path === DOC);
    expect(screen.getByTestId('doc-title').textContent).toBe(entry?.title);
    const project = useVaultStore.getState().entries.find((e) => e.path === PROJECT);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(project!.title) }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'project', path: PROJECT });
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    // Task 15: the floating outline appears once the editor is ready (the
    // doc's H1 is its first item).
    await waitFor(() => expect(screen.getByTestId('doc-outline')).toBeTruthy(), {
      timeout: 5_000,
    });
  });

  it('falls back gracefully when the doc no longer exists', () => {
    render(<DocPage selection={{ kind: 'doc', path: 'nope/gone.md' }} />);
    expect(screen.getByText('This page no longer exists')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go home' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });
});
