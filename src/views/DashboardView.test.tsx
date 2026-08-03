import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DashboardView } from '@/views/DashboardView';
import { buildSchema } from '@/engine/schema';
import { parseListYaml } from '@/engine/views';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import type { DashboardBlock, Entry, ListFile, Presentation } from '@/engine/types';

/**
 * The dashboard (M16.28).
 *
 * What it must get right is the difference between its two block kinds. A
 * NUMBER measures the dashboard's own rows, so the view's filters reach it. A
 * VIEW block resolves a saved view out of the vault through `resolveSurface`,
 * the same function the List page calls — it stores a reference, so a deleted
 * List is one honest missing-block tile and never a stale copy of a query.
 *
 * And a block cannot embed another dashboard: without the guard, a dashboard
 * pointing at itself recurses until the stack runs out.
 */

const vault = (): Entry[] => [
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: { status: { kind: 'status' }, estimate: { kind: 'number' } },
      statuses: [{ id: 'todo', group: 'active', color: 'blue' }],
    } as unknown as Entry['properties'],
  }),
  makeEntry({
    path: 'items/a.md',
    title: 'Alpha',
    type: 'Work item',
    properties: { status: 'todo', estimate: 3 },
  }),
  makeEntry({
    path: 'items/b.md',
    title: 'Beta',
    type: 'Work item',
    properties: { status: 'todo', estimate: 5 },
  }),
];

const records = (entries: Entry[]) => entries.filter((e) => e.path.startsWith('items/'));

const lists = (): ListFile[] => [
  parseListYaml(
    'delivery',
    'name: Delivery\nsource:\n  type: Work item\nviews:\n  - id: grid\n    name: Grid\n    presentation:\n      type: table\n      columns: [status]\n',
    { path: 'delivery.list.yml' },
  ),
  parseListYaml(
    'overview',
    'name: Overview\nsource:\n  type: Work item\nviews:\n  - id: board\n    name: Board\n    presentation:\n      type: dashboard\n',
    { path: 'overview.list.yml' },
  ),
];

const view = (blocks: DashboardBlock[]): Presentation => ({
  type: 'dashboard',
  group: [],
  sort: [],
  columns: [],
  ...(blocks.length > 0 ? { dashboard: { blocks } } : {}),
});

afterEach(() => {
  cleanup();
  useVaultStore.setState({ entries: [], views: [] });
});

describe('DashboardView', () => {
  it('says what to do instead of rendering an empty grid', () => {
    const entries = vault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([])}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.getByText('No blocks yet')).toBeTruthy();
    expect(screen.getByTestId('dashboard-view').getAttribute('data-blocks')).toBe('0');
  });

  it('measures the dashboard’s OWN rows in a number block', () => {
    const entries = vault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([
          { id: 'b1', kind: 'number', agg: 'count' },
          { id: 'b2', kind: 'number', agg: 'sum', value: 'estimate', title: 'Points' },
        ])}
        schema={buildSchema(entries)}
      />,
    );
    const tiles = screen.getAllByTestId('dashboard-number');
    expect(tiles.map((t) => t.getAttribute('data-value'))).toEqual(['2', '8']);
    expect(screen.getByText('Points')).toBeTruthy();
  });

  it('embeds a saved view, resolved from the vault rather than copied', () => {
    const entries = vault();
    useVaultStore.setState({ entries, views: lists() });
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([{ id: 'b1', kind: 'view', list: 'delivery' }])}
        schema={buildSchema(entries)}
      />,
    );
    // The block shows the List's own layout and its own name — the block
    // stored neither, only a reference.
    expect(screen.getByTestId('table-view')).toBeTruthy();
    expect(screen.getByText('Delivery · Grid')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('names the list it can no longer find rather than rendering a blank tile', () => {
    const entries = vault();
    useVaultStore.setState({ entries, views: lists() });
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([{ id: 'b1', kind: 'view', list: 'deleted-one' }])}
        schema={buildSchema(entries)}
      />,
    );
    // Both the header and the message name it: the tile has to say WHICH
    // reference broke, or fixing it means guessing.
    expect(screen.getAllByText(/deleted-one/)).toHaveLength(2);
    expect(screen.getByText(/no longer in the vault/)).toBeTruthy();
  });

  // Without the guard this is unbounded recursion, not a rendering nit.
  it('refuses to draw a dashboard inside a dashboard', () => {
    const entries = vault();
    useVaultStore.setState({ entries, views: lists() });
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([{ id: 'b1', kind: 'view', list: 'overview' }])}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.getByText(/cannot show another dashboard/)).toBeTruthy();
    expect(screen.queryAllByTestId('dashboard-view')).toHaveLength(1);
  });

  it('spans a wide block across the grid', () => {
    const entries = vault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([
          { id: 'b1', kind: 'number', agg: 'count', wide: true },
          { id: 'b2', kind: 'number', agg: 'count' },
        ])}
        schema={buildSchema(entries)}
      />,
    );
    expect(
      screen.getAllByTestId('dashboard-block').map((b) => b.getAttribute('data-wide')),
    ).toEqual(['true', 'false']);
  });
});
