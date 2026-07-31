// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
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
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [project, itemDone, itemOpen],
      views: [],
      collections: [],
      status: 'ready',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });

  afterEach(cleanup);

  // M12.5: the grid shows Collections. A legacy project folder reads as one
  // — named after its project.md, nothing rewritten on disk.
  it('renders a legacy project folder as a collection card', () => {
    render(<HomePage />);
    expect(screen.getByText('1 collection')).toBeTruthy();
    const card = screen.getByTestId('home-collection-card');
    expect(card.textContent).toContain('Foundations');
    fireEvent.click(card);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'collection',
      folder: 'projects/foundations',
    });
  });

  // M1.x fresh-vault empty state: a brand-new vault rendered a bare section
  // heading with nothing actionable under it.
  it('shows an empty state when the vault has no collections', () => {
    useVaultStore.setState({ entries: [] });
    render(<HomePage />);
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    expect(screen.getByText('Use New to create your first collection.')).toBeTruthy();
  });
});
