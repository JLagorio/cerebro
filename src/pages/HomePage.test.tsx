import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { emptyMockVault, resetMockFs } from '@/lib/mockIpc';
import type { Entry } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useLauncherStore } from '@/stores/launcherStore';
import { useVaultStore } from '@/stores/vaultStore';
import { greetingForHour, HomePage } from './HomePage';

function mkEntry(partial: Partial<Entry> & { path: string }): Entry {
  return {
    filename: partial.path.split('/').pop() ?? '',
    folder: partial.path.includes('/') ? partial.path.slice(0, partial.path.lastIndexOf('/')) : '',
    project: null,
    title: 'Untitled',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
    hash: null,
    ...partial,
  };
}

const FOUNDATIONS = 'projects/foundations/project.md';
const project = mkEntry({
  path: FOUNDATIONS,
  filename: 'project.md',
  project: FOUNDATIONS,
  title: 'Foundations',
  type: 'Project',
  properties: { key: 'FLD' },
});
const itemDone = mkEntry({
  path: 'projects/foundations/items/fld-1.md',
  filename: 'fld-1.md',
  project: FOUNDATIONS,
  title: 'Ship tokens',
  type: 'Work item',
  properties: { status: 'done' },
});
const itemOpen = mkEntry({
  path: 'projects/foundations/items/fld-2.md',
  filename: 'fld-2.md',
  project: FOUNDATIONS,
  title: 'Port primitives',
  type: 'Work item',
  properties: { status: 'todo' },
});

describe('greetingForHour', () => {
  it('says good morning before noon', () => {
    expect(greetingForHour(0)).toBe('Good morning');
    expect(greetingForHour(9)).toBe('Good morning');
  });
  it('says good afternoon from noon to 6pm', () => {
    expect(greetingForHour(12)).toBe('Good afternoon');
    expect(greetingForHour(17)).toBe('Good afternoon');
  });
  it('says good evening from 6pm', () => {
    expect(greetingForHour(18)).toBe('Good evening');
    expect(greetingForHour(23)).toBe('Good evening');
  });
});

describe('HomePage', () => {
  beforeEach(() => {
    useUiStore.setState({
      aiPanelOpen: false,
      aiPanelPresentation: 'panel',
      quickOpenVisible: false,
    });
    useLauncherStore.setState({ flow: null });
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entriesVault: '/demo-vault',
      entries: [project, itemDone, itemOpen],
      views: [],
      collections: [],
      status: 'ready',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetMockFs();
  });

  // M12.5: the grid shows Collections. A legacy project folder reads as one
  // — named after its project.md, nothing rewritten on disk.
  it('renders a legacy project folder as a collection card', async () => {
    await act(async () => {
      render(<HomePage />);
    });
    expect(screen.getByText('1 collection')).toBeTruthy();
    const card = screen.getByTestId('home-collection-card');
    expect(card.textContent).toContain('Foundations');
    fireEvent.click(card);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'collection',
      folder: 'projects/foundations',
    });
  });

  it('offers a kit when the vault has no pages', async () => {
    emptyMockVault();
    useVaultStore.setState({ entries: [] });
    render(<HomePage />);
    expect(await screen.findByRole('button', { name: 'Add the starter kit' })).toBeTruthy();
  });
  it('never reads the starter marker for the populated demo', async () => {
    const read = vi.spyOn(ipc, 'starterMarker');
    await act(async () => {
      render(<HomePage />);
    });
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByTestId('starter-offer')).toBeNull();
  });

  // M91.14 — Home's ask is a Suggestion that sends nothing: it opens the
  // conversation on its question, named by it and described by its line.
  it('draws its ask as a Suggestion that opens the conversation and sends nothing', async () => {
    useUiStore.setState({ handoffs: [] });
    await act(async () => {
      render(<HomePage />);
    });
    const ask = screen.getByRole('button', { name: 'What would you like to work on?' });
    expect(ask.dataset.slot).toBe('suggestion');
    expect(ask.className).toContain('cb-home-ask');
    expect(ask.getAttribute('aria-describedby')).not.toBeNull();
    const described = document.getElementById(ask.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('Think it through with your assistant');
    fireEvent.click(ask);
    expect(useUiStore.getState().aiPanelOpen).toBe(true);
    expect(useUiStore.getState().handoffs).toEqual([]);
  });

  it('opens the floating assistant and the existing create and search flows', async () => {
    await act(async () => {
      render(<HomePage />);
    });
    fireEvent.click(screen.getByRole('button', { name: /What would you like to work on/ }));
    expect(useUiStore.getState()).toMatchObject({
      aiPanelOpen: true,
      aiPanelPresentation: 'floating',
      aiPanelMinimized: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    expect(useLauncherStore.getState().flow).toMatchObject({ id: 'page', vault: '/demo-vault' });
    fireEvent.click(screen.getByRole('button', { name: 'New whiteboard' }));
    expect(useLauncherStore.getState().flow).toMatchObject({
      id: 'whiteboard',
      vault: '/demo-vault',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find something' }));
    expect(useUiStore.getState().quickOpenVisible).toBe(true);
  });
});
