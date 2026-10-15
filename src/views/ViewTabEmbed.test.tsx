// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/engine/schema';
import type { Entry, TabDef } from '@/engine/types';
import { resolveViewTab } from '@/engine/viewTab';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { makeEntry } from '@/test/factories';
import type { ViewCanvasProps } from './ViewCanvas';
import { ViewTabEmbed } from './ViewTabEmbed';

// The canvas supplies gestures; this seam proves that the real creation hooks
// inherit the resolver's type, host, key prefix and declared date-field shape.
vi.mock('./ViewCanvas', () => ({
  ViewCanvas: ({ onCreate, onCreateOn }: ViewCanvasProps) => (
    <div>
      {onCreate && (
        <button
          onClick={() => void onCreate('Ship docs', { groupBy: 'status', groupValue: 'todo' })}
        >
          Add record
        </button>
      )}
      {onCreateOn && (
        <button onClick={() => void onCreateOn('Plan cycle', '2026-10-20')}>Add on day</button>
      )}
    </div>
  ),
}));

function fixture() {
  const host = makeEntry({
    path: 'projects/atlas/project.md',
    title: 'Atlas renamed',
    type: 'Project',
    properties: { key: 'FLD' },
  });
  const entries: Entry[] = [
    makeEntry({ path: 'types/project.md', title: 'Project', type: 'Type' }),
    makeEntry({
      path: 'types/ticket.md',
      title: 'Ticket',
      type: 'Type',
      properties: {
        fields: {
          status: { kind: 'status' },
          project: { kind: 'relation', target: 'Project', limit: 1 },
          window: { kind: 'daterange' },
        },
      } as never,
    }),
    host,
    makeEntry({ path: 'old/fld-12.md', type: 'Ticket', properties: { key: 'fld-12' } }),
  ];
  const schema = buildSchema(entries);
  const createItem = vi.fn().mockResolvedValue('records/tickets/ship-docs.md');
  useVaultStore.setState({ entries, createItem });
  const tab: TabDef = {
    id: 'tasks',
    name: 'Tasks',
    icon: null,
    content: 'view',
    source: { type: 'Ticket' },
  };
  return { entries, schema, host, createItem, tab };
}

beforeEach(() => useUiStore.setState({ toasts: [] }));
afterEach(cleanup);

describe('ViewTabEmbed creation', () => {
  it('files related quick-add under the host with the next key in the database home', async () => {
    const { entries, schema, host, createItem, tab } = fixture();
    const resolution = resolveViewTab({ ...tab, scope: 'related' }, host, entries, schema, []);
    render(<ViewTabEmbed resolution={resolution} entries={entries} schema={schema} scope="test" />);
    fireEvent.click(screen.getByText('Add record'));
    await waitFor(() =>
      expect(createItem).toHaveBeenCalledWith({
        folder: 'records/tickets',
        slug: 'ship-docs',
        frontmatter: { type: 'Ticket', key: 'FLD-13', status: 'todo', project: '[[atlas]]' },
        body: '# Ship docs\n',
      }),
    );
  });

  it('an unscoped tab creates without a host link or key', async () => {
    const { entries, schema, host, createItem, tab } = fixture();
    render(
      <ViewTabEmbed
        resolution={resolveViewTab(tab, host, entries, schema, [])}
        entries={entries}
        schema={schema}
        scope="test"
      />,
    );
    expect(screen.queryByTestId('view-tab-add-existing')).toBeNull();
    fireEvent.click(screen.getByText('Add record'));
    await waitFor(() =>
      expect(createItem).toHaveBeenCalledWith({
        folder: 'records/tickets',
        slug: 'ship-docs',
        frontmatter: { type: 'Ticket', status: 'todo' },
        body: '# Ship docs\n',
      }),
    );
  });

  it('a calendar day keeps the host and serializes the declared date range', async () => {
    const { entries, schema, host, createItem, tab } = fixture();
    const resolution = resolveViewTab({ ...tab, scope: 'related' }, host, entries, schema, []);
    render(<ViewTabEmbed resolution={resolution} entries={entries} schema={schema} scope="test" />);
    fireEvent.click(screen.getByText('Add on day'));
    await waitFor(() =>
      expect(createItem).toHaveBeenCalledWith({
        folder: 'records/tickets',
        slug: 'plan-cycle',
        frontmatter: {
          type: 'Ticket',
          key: 'FLD-13',
          project: '[[atlas]]',
          window: { start: '2026-10-20', end: null },
        },
        body: '# Plan cycle\n',
      }),
    );
  });

  it('a broken tab has no create row, including after a live pointer breaks', () => {
    const { entries, schema, host, tab } = fixture();
    const { rerender } = render(
      <ViewTabEmbed
        resolution={resolveViewTab(tab, host, entries, schema, [])}
        entries={entries}
        schema={schema}
        scope="test"
      />,
    );
    rerender(
      <ViewTabEmbed
        resolution={{ kind: 'broken', reason: 'The database is gone.' }}
        entries={entries}
        schema={schema}
        scope="test"
      />,
    );
    expect(screen.queryByText('Add record')).toBeNull();
    expect(screen.queryByText('Add on day')).toBeNull();
    expect(screen.queryByTestId('view-tab-add-existing')).toBeNull();
    expect(screen.getByTestId('view-tab-broken').textContent).toContain('The database is gone.');
  });

  it('Add existing excludes all filed rows, including ones hidden by the view', () => {
    const { entries, schema, host, tab } = fixture();
    entries.push(
      makeEntry({
        path: 'old/hidden.md',
        title: 'Already filed and hidden',
        type: 'Ticket',
        relationships: { project: ['ATLAS RENAMED'] },
      }),
    );
    const resolution = resolveViewTab({ ...tab, scope: 'related' }, host, entries, schema, []);
    if (resolution.kind !== 'ok') throw new Error('expected related view');
    resolution.surface.entries = [];
    render(<ViewTabEmbed resolution={resolution} entries={entries} schema={schema} scope="test" />);
    fireEvent.click(screen.getByTestId('view-tab-add-existing'));
    expect(screen.queryByText('Already filed and hidden')).toBeNull();
    expect(screen.getByText('fld-12')).toBeTruthy();
  });

  it('closes a staged picker when the vault changes', async () => {
    const { entries, schema, host, tab } = fixture();
    render(
      <ViewTabEmbed
        resolution={resolveViewTab({ ...tab, scope: 'related' }, host, entries, schema, [])}
        entries={entries}
        schema={schema}
        scope="test"
      />,
    );
    fireEvent.click(screen.getByTestId('view-tab-add-existing'));
    expect(screen.getByTestId('relation-picker')).toBeTruthy();
    act(() => useVaultStore.setState({ vaultPath: '/different-vault' }));
    await waitFor(() => expect(screen.queryByTestId('relation-picker')).toBeNull());
  });
});
