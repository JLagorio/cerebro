// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry, Schema, StatusDef } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { greetingForHour, HomePage, projectProgress } from './HomePage';

function mkEntry(partial: Partial<Entry> & { path: string }): Entry {
  return {
    filename: partial.path.split('/').pop() ?? '',
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

const space = mkEntry({
  path: 'spaces/product.md',
  filename: 'product.md',
  title: 'Product',
  type: 'Space',
  properties: { color: '#3D8BE8' },
  snippet: 'Everything customer-facing.',
});
const project = mkEntry({
  path: 'projects/foundations.md',
  filename: 'foundations.md',
  title: 'Foundations',
  type: 'Project',
  properties: { key: 'FLD' },
  relationships: { space: ['product'] },
});
const itemDone = mkEntry({
  path: 'items/fld-1.md',
  filename: 'fld-1.md',
  title: 'Ship tokens',
  properties: { status: 'done' },
  relationships: { project: ['foundations'] },
});
const itemOpen = mkEntry({
  path: 'items/fld-2.md',
  filename: 'fld-2.md',
  title: 'Port primitives',
  properties: { status: 'todo' },
  relationships: { project: ['foundations'] },
});

const STATUSES: StatusDef[] = [
  { id: 'todo', label: 'Todo', color: '#3D8BE8', group: 'active' },
  { id: 'done', label: 'Done', color: '#34B764', group: 'done' },
];

const fakeSchema: Schema = {
  types: new Map(),
  spaceForEntry: () => space,
  statusSetForSpace: () => STATUSES,
  resolveField: () => ({ def: null, raw: null, display: '', color: null, ghost: false }),
};

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

describe('projectProgress', () => {
  const entries = [space, project, itemDone, itemOpen];

  it('counts done-group items over total items of the project', () => {
    expect(projectProgress(project, entries, fakeSchema)).toEqual({ total: 2, done: 1 });
  });

  it('returns zeros for a project with no items', () => {
    const empty = mkEntry({ path: 'projects/empty.md', title: 'Empty', type: 'Project' });
    expect(projectProgress(empty, entries, fakeSchema)).toEqual({ total: 0, done: 0 });
  });

  it('does not count items whose status is not in the status set', () => {
    const ghost = mkEntry({
      path: 'items/fld-3.md',
      filename: 'fld-3.md',
      properties: { status: 'someday' },
      relationships: { project: ['foundations'] },
    });
    expect(projectProgress(project, [...entries, ghost], fakeSchema)).toEqual({
      total: 3,
      done: 1,
    });
  });
});

describe('HomePage', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [space, project, itemDone, itemOpen],
      views: [],
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

  it('renders space tiles with project counts and the projects grid', () => {
    render(<HomePage />);
    // "Product" appears twice by design: the space tile and the project card's
    // space subtitle — the plan's getByText throws on multiple matches.
    expect(screen.getAllByText('Product').length).toBeGreaterThan(0);
    expect(screen.getByText('1 project')).toBeTruthy();
    expect(screen.getByText('Foundations')).toBeTruthy();
    expect(screen.getByText('FLD')).toBeTruthy();
    expect(screen.getByText('1/2 done')).toBeTruthy();
  });
});
