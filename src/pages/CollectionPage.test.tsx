// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollectionPage } from '@/pages/CollectionPage';
import type { CollectionFile, ListFile, Presentation } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';

const presentation: Presentation = {
  type: 'table',
  group: [],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'status' }],
};

const collection = (
  folder: string,
  name: string,
  extra: Partial<CollectionFile['definition']> = {},
): CollectionFile => ({
  folder,
  declared: true,
  definition: { name, icon: 'rocket', color: null, order: null, description: null, ...extra },
});

function mkList(id: string, folder: string, name: string, viewCount = 1): ListFile {
  return {
    id,
    project: null,
    collection: folder,
    path: `${folder}/${id}.list.yml`,
    definition: {
      name,
      icon: null,
      color: null,
      order: null,
      source: { type: 'Work item', project: null },
      views: Array.from({ length: viewCount }, (_, i) => ({
        id: i === 0 ? 'grid' : `v${i}`,
        name: i === 0 ? 'Table' : `Board ${i}`,
        icon: null,
        filters: null,
        presentation,
      })),
    },
  };
}

function setup(
  collections: CollectionFile[],
  views: ListFile[],
  extraEntries = [] as ReturnType<typeof makeEntry>[],
) {
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: [...fixtureVault(), ...extraEntries],
    views,
    collections,
    status: 'ready',
    error: null,
  });
  useNavStore.setState({
    selection: { kind: 'collection', folder: 'delivery' },
    history: [{ kind: 'collection', folder: 'delivery' }],
    historyIndex: 0,
  });
  render(<CollectionPage selection={{ kind: 'collection', folder: 'delivery' }} />);
}

afterEach(cleanup);

describe('CollectionPage home (M11)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: [], views: [], collections: [] });
  });

  it('names the collection and the folder it lives in', () => {
    setup([collection('delivery', 'Delivery')], [mkList('sprint', 'delivery', 'Sprint')]);
    expect(screen.getByText('Delivery')).toBeTruthy();
    expect(screen.getByText('delivery/')).toBeTruthy();
  });

  it('shows each list as a card carrying its record count and source type', () => {
    setup([collection('delivery', 'Delivery')], [mkList('sprint', 'delivery', 'Sprint')]);
    const card = screen.getAllByTestId('collection-card').find((c) => c.dataset.kind === 'list');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('Sprint');
    // Two Work items in the fixture vault — the count is what the List holds,
    // which a flat "List" tag could never say.
    expect(card!.textContent).toContain('2');
    expect(card!.textContent).toContain('Work item');
  });

  it('links each of a list’s views, so a tab is reachable from here', () => {
    setup([collection('delivery', 'Delivery')], [mkList('sprint', 'delivery', 'Sprint', 2)]);
    const views = screen.getAllByTestId('collection-card-view');
    expect(views.map((v) => v.textContent)).toEqual(['Table', 'Board 1']);
    fireEvent.click(views[1]);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'list',
      id: 'sprint',
      collection: 'delivery',
      view: 'v1',
    });
  });

  it('opens a list when its name is pressed', () => {
    setup([collection('delivery', 'Delivery')], [mkList('sprint', 'delivery', 'Sprint')]);
    fireEvent.click(screen.getByText('Sprint'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'list',
      id: 'sprint',
      collection: 'delivery',
    });
  });

  it('shows nested collections as their own cards', () => {
    setup(
      [collection('delivery', 'Delivery'), collection('delivery/eu', 'EU')],
      [mkList('sprint', 'delivery', 'Sprint'), mkList('eu-work', 'delivery/eu', 'EU work')],
    );
    const nested = screen
      .getAllByTestId('collection-card')
      .find((c) => c.dataset.kind === 'collection');
    expect(nested?.textContent).toContain('EU');
  });

  it('lists the docs inside it', () => {
    const doc = makeEntry({ path: 'delivery/how-we-schedule.md', title: 'How we schedule' });
    setup([collection('delivery', 'Delivery')], [mkList('sprint', 'delivery', 'Sprint')], [doc]);
    expect(screen.getByText('How we schedule')).toBeTruthy();
  });

  it('surfaces recently updated records across the collection’s lists', () => {
    setup([collection('delivery', 'Delivery')], [mkList('sprint', 'delivery', 'Sprint')]);
    const recent = screen.getAllByTestId('collection-recent-row').map((r) => r.textContent ?? '');
    expect(recent.join(' ')).toContain('Design first-run flow');
  });

  it('offers to add a description when there is none', () => {
    setup([collection('delivery', 'Delivery')], [mkList('sprint', 'delivery', 'Sprint')]);
    expect(screen.getByTestId('collection-add-description')).toBeTruthy();
    expect(screen.queryByTestId('collection-description')).toBeNull();
  });

  it('shows the description it has, and opens it for editing', () => {
    setup(
      [collection('delivery', 'Delivery', { description: 'Everything we are shipping.' })],
      [mkList('sprint', 'delivery', 'Sprint')],
    );
    const shown = screen.getByTestId('collection-description');
    expect(shown.textContent).toBe('Everything we are shipping.');
    fireEvent.click(shown);
    expect(screen.getByLabelText('Collection description')).toBeTruthy();
  });

  it('says an implied collection is one, since it has no marker of its own', () => {
    // A folder holding a List IS a Collection — nothing on disk declares it.
    setup([], [mkList('sprint', 'delivery', 'Sprint')]);
    expect(screen.getByText(/implied by its contents/)).toBeTruthy();
    // …and there is nothing to remove.
    expect(screen.queryByLabelText('Remove collection')).toBeNull();
  });

  it('says so when the collection is empty', () => {
    setup([collection('delivery', 'Delivery')], []);
    expect(screen.getByText('Nothing in here yet')).toBeTruthy();
  });
});
