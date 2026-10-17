// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Selection } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { WindowTitle } from './WindowTitle';

describe('WindowTitle (M59.1)', () => {
  beforeEach(() => {
    document.title = 'Cerebro';
    useUiStore.setState({ aiPanelOpen: false, aiPanelPresentation: 'panel' });
    useVaultStore.setState({ entries: [], views: [], collections: [] });
    useNavStore.setState({ selection: { kind: 'home' } });
  });

  afterEach(cleanup);

  const go = (selection: Selection) => act(() => useNavStore.setState({ selection }));

  it('names Home, and History for pulse', () => {
    render(<WindowTitle />);
    expect(document.title).toBe('Home — Cerebro');
    go({ kind: 'pulse' });
    expect(document.title).toBe('History — Cerebro');
  });

  it("names a page by its title, a gone page by its file's stem, and a database by name", () => {
    useVaultStore.setState({
      entries: [makeEntry({ path: 'strategy/systems-map.md', title: 'Systems map' })],
    });
    render(<WindowTitle />);
    go({ kind: 'doc', path: 'strategy/systems-map.md' });
    expect(document.title).toBe('Systems map — Cerebro');
    go({ kind: 'doc', path: 'old/retired-plan.md' });
    expect(document.title).toBe('retired-plan — Cerebro');
    go({ kind: 'type', name: 'Decision', view: 'board' });
    expect(document.title).toBe('Decision — Cerebro');
  });

  it('retitles when a rescan renames the open page', () => {
    const path = 'strategy/systems-map.md';
    useVaultStore.setState({ entries: [makeEntry({ path, title: 'Systems map' })] });
    useNavStore.setState({ selection: { kind: 'doc', path } });
    render(<WindowTitle />);
    expect(document.title).toBe('Systems map — Cerebro');
    act(() => useVaultStore.setState({ entries: [makeEntry({ path, title: 'Landscape' })] }));
    expect(document.title).toBe('Landscape — Cerebro');
  });

  it('names the assistant canvas and restores the retained page title when docked', () => {
    useNavStore.setState({ selection: { kind: 'pulse' } });
    render(<WindowTitle />);
    act(() => useUiStore.getState().openAssistantCanvas());
    expect(document.title).toBe('Assistant — Cerebro');
    act(() => useUiStore.getState().setAiPanelPresentation('panel'));
    expect(document.title).toBe('History — Cerebro');
  });

  it('puts the app name back when it unmounts', () => {
    const { unmount } = render(<WindowTitle />);
    expect(document.title).toBe('Home — Cerebro');
    unmount();
    expect(document.title).toBe('Cerebro');
  });
});
