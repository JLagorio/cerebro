// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { StudioPage } from './StudioPage';

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

describe('StudioPage', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'studio' },
      history: [{ kind: 'studio' }],
      historyIndex: 0,
    });
    useUiStore.setState({ aiPanelOpen: false, agentPendingPrompt: null });
  });
  afterEach(cleanup);

  it('starts empty with an explanation, and creating a prototype lands inside it', async () => {
    render(<StudioPage selection={{ kind: 'studio' }} />);
    expect(screen.getByText('Nothing on the bench')).toBeTruthy();

    fireEvent.click(screen.getByTestId('studio-new'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Prototype name' }), {
      target: { value: 'Pricing page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The folder-with-index shape lands on disk and the selection opens it.
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({ kind: 'studio', project: 'pricing-page' }),
    );
    expect(fs().get('studio/pricing-page/index.md')).toContain('# Pricing page');
  });

  it('previews the main page and re-renders it as a live body', async () => {
    fs().set('studio/landing/index.md', '# Landing\n\nHero copy here.\n');
    await useVaultStore.getState().rescan();
    render(<StudioPage selection={{ kind: 'studio', project: 'landing' }} />);
    // The preview is the RENDERED body, via the read-only renderer.
    await waitFor(() => expect(screen.getByText('Hero copy here.')).toBeTruthy());
  });

  it('Build with the assistant seeds the panel at the prototype folder', async () => {
    fs().set('studio/landing/index.md', '# Landing\n\nHero.\n');
    await useVaultStore.getState().rescan();
    render(<StudioPage selection={{ kind: 'studio', project: 'landing' }} />);
    fireEvent.click(await screen.findByTestId('studio-build'));
    const ui = useUiStore.getState();
    // The chat rail IS the assistant panel — opened, aimed at the folder.
    expect(ui.aiPanelOpen).toBe(true);
    expect(ui.agentPendingPrompt?.text).toContain('studio/landing/');
    expect(ui.agentPendingPrompt?.subject).toBe('studio/landing/index.md');
  });

  it('says plainly when a deep-linked prototype no longer exists', async () => {
    render(<StudioPage selection={{ kind: 'studio', project: 'gone' }} />);
    // Absent said as absent — never a blank preview of nothing.
    expect(screen.getByText('This prototype no longer exists')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All prototypes' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'studio' });
  });

  it('a failed page read says could-not-read, never an empty preview', async () => {
    fs().set('studio/landing/index.md', '# Landing\n\nHero.\n');
    await useVaultStore.getState().rescan();
    // The entry survives the scan but the body read will miss: simulate a
    // file that vanished between scan and read.
    fs().delete('studio/landing/index.md');
    render(<StudioPage selection={{ kind: 'studio', project: 'landing' }} />);
    await waitFor(() => expect(screen.getByTestId('studio-preview-unavailable')).toBeTruthy());
  });
});
