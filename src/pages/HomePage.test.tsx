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

const STATUSES: StatusDef[] = [
  { id: 'todo', label: 'Todo', color: '#3D8BE8', group: 'active' },
  { id: 'done', label: 'Done', color: '#34B764', group: 'done' },
];

const fakeSchema: Schema = {
  types: new Map(),
  projectForEntry: () => project,
  statusSetForProject: () => STATUSES,
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
  const entries = [project, itemDone, itemOpen];

  it('counts done-group items over total contained Work items', () => {
    expect(projectProgress(project, entries, fakeSchema)).toEqual({ total: 2, done: 1 });
  });

  it('returns zeros for a project with no items', () => {
    const empty = mkEntry({
      path: 'projects/empty/project.md',
      title: 'Empty',
      type: 'Project',
    });
    expect(projectProgress(empty, entries, fakeSchema)).toEqual({ total: 0, done: 0 });
  });

  it('does not count items whose status is not in the status set', () => {
    const ghost = mkEntry({
      path: 'projects/foundations/items/fld-3.md',
      filename: 'fld-3.md',
      project: FOUNDATIONS,
      type: 'Work item',
      properties: { status: 'someday' },
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
      entries: [project, itemDone, itemOpen],
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

  it('renders the projects grid with key tags and progress', () => {
    render(<HomePage />);
    expect(screen.getByText('1 project')).toBeTruthy();
    expect(screen.getByText('Foundations')).toBeTruthy();
    expect(screen.getByText('FLD')).toBeTruthy();
    expect(screen.getByText('1/2 done')).toBeTruthy();
  });

  // M1.x fresh-vault empty state: a brand-new vault rendered a bare section
  // heading with nothing actionable under it.
  it('shows an empty state when the vault has no projects', () => {
    useVaultStore.setState({ entries: [] });
    render(<HomePage />);
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    expect(screen.getByText('Use New to create your first project.')).toBeTruthy();
  });
});
