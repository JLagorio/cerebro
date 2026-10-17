import { seedBytes, reset as resetBytes } from '@/lib/mockBytes';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GalleryView, coverOf } from '@/views/GalleryView';
import { buildSchema } from '@/engine/schema';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import type { Entry, Presentation } from '@/engine/types';
beforeEach(() => vi.stubGlobal('IntersectionObserver', undefined));
afterEach(() => vi.unstubAllGlobals());

it('renders one gallery card in each value band (M61.1)', () => {
  const entry = makeEntry({
    path: 'shared.md',
    title: 'Shared',
    properties: { tags: ['a', 'b', 'a'] },
  });
  render(
    <GalleryView
      entries={[entry]}
      presentation={{ type: 'gallery', group: [{ field: 'tags' }], columns: [], sort: [] }}
      schema={buildSchema([entry])}
      filtered={false}
    />,
  );
  expect(screen.getAllByTestId('gallery-card')).toHaveLength(2);
  expect(screen.getAllByText('Shared')).toHaveLength(2);
});

/**
 * The gallery (M16.22).
 *
 * Two things it must not do, both of which the other layouts got wrong first:
 * render a card that advertises itself as clickable and then does nothing on
 * Enter (BoardView's div-with-role="button", M15), and render a blank canvas
 * when a query returns nothing (BoardView again, note 17a).
 *
 */

const vault = (): Entry[] => [
  makeEntry({
    path: 'types/asset.md',
    title: 'Asset',
    type: 'Type',
    properties: {
      icon: 'image',
      fields: {
        status: { kind: 'status' },
        artwork: { kind: 'files' },
      },
      statuses: [
        { id: 'draft', group: 'active', color: 'blue' },
        { id: 'final', group: 'done', color: 'green' },
      ],
    } as unknown as Entry['properties'],
  }),
  makeEntry({
    path: 'assets/poster.md',
    title: 'Launch poster',
    type: 'Asset',
    properties: { status: 'draft', artwork: ['attachments/poster.png'] },
  }),
  makeEntry({
    path: 'assets/banner.md',
    title: 'Site banner',
    type: 'Asset',
    properties: { status: 'final', artwork: ['https://example.com/banner.png'] },
  }),
  makeEntry({
    path: 'assets/untitled.md',
    title: 'No artwork yet',
    type: 'Asset',
    properties: { status: 'draft' },
  }),
];

const records = (entries: Entry[]) => entries.filter((e) => e.path.startsWith('assets/'));

const presentation = (over: Partial<Presentation> = {}): Presentation => ({
  type: 'gallery',
  group: [],
  sort: [{ field: 'title', dir: 'asc' }],
  columns: [{ field: 'status' }],
  ...over,
});

beforeEach(resetBytes);
afterEach(cleanup);

describe('GalleryView', () => {
  it('draws one card per record with its title and visible properties', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    render(
      <GalleryView
        filtered={false}
        entries={records(entries)}
        presentation={presentation()}
        schema={schema}
      />,
    );
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(3);
    expect(screen.getByText('Launch poster')).toBeTruthy();
    // The card's chips come from `columns`, the same list the table reads —
    // there is no gallery-only property list to drift from it.
    expect(screen.getAllByText('Draft')).toHaveLength(2);
    expect(screen.getByText('Final')).toBeTruthy();
  });

  it('shows no cover tile until a cover property is chosen', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    render(
      <GalleryView
        filtered={false}
        entries={records(entries)}
        presentation={presentation()}
        schema={schema}
      />,
    );
    expect(screen.queryByTestId('gallery-cover')).toBeNull();
  });

  it('draws image covers, keeps URL tiles and falls back without losing the card', async () => {
    seedBytes('0', 'attachments/poster.png', { bytes: [1, 2] });
    const entries = vault();
    const schema = buildSchema(entries);
    const { container } = render(
      <GalleryView
        filtered={false}
        entries={records(entries)}
        presentation={presentation({ gallery: { cover: 'artwork' } })}
        schema={schema}
      />,
    );
    expect(screen.getAllByTestId('gallery-cover')).toHaveLength(3);
    const image = await screen.findByRole('img', { name: 'poster.png' });
    expect(image.style.objectFit).toBe('cover');
    expect(screen.getByText('https://example.com/banner.png')).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(1);
    fireEvent.error(image);
    await waitFor(() => expect(screen.getByText("Couldn't show this image")).toBeTruthy());
    expect(screen.getByText('poster.png')).toBeTruthy();
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(3);
  });

  it('reports the card size and fit it was configured with', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    render(
      <GalleryView
        filtered={false}
        entries={records(entries)}
        presentation={presentation({
          cardSize: 'large',
          gallery: { cover: 'artwork', fit: true },
        })}
        schema={schema}
      />,
    );
    expect(screen.getByTestId('gallery-view').getAttribute('data-card-size')).toBe('large');
    expect(screen.getAllByTestId('gallery-cover')[0].getAttribute('data-fit')).toBe('contain');
  });

  it('defaults to medium cards when the view says nothing about size', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    render(
      <GalleryView
        filtered={false}
        entries={records(entries)}
        presentation={presentation()}
        schema={schema}
      />,
    );
    expect(screen.getByTestId('gallery-view').getAttribute('data-card-size')).toBe('medium');
  });

  // Grouping is not a layout's business — the cards band through the same
  // groupTree the list's rows do, including the declared status order and the
  // empty declared group.
  it('bands cards by the grouping chain', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    render(
      <GalleryView
        filtered={false}
        entries={records(entries)}
        presentation={presentation({ group: [{ field: 'status' }] })}
        schema={schema}
      />,
    );
    const bands = screen.getAllByTestId('gallery-band');
    expect(bands).toHaveLength(2);
    expect(bands[0].textContent).toContain('Draft');
    expect(bands[1].textContent).toContain('Final');
  });

  it('collapses a band, hiding its cards but not its heading', async () => {
    const user = userEvent.setup();
    const entries = vault();
    const schema = buildSchema(entries);
    render(
      <GalleryView
        filtered={false}
        entries={records(entries)}
        presentation={presentation({ group: [{ field: 'status' }] })}
        schema={schema}
        scope="gallery-test"
      />,
    );
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(3);
    await user.click(screen.getAllByRole('button', { expanded: true })[0]);
    expect(screen.getAllByTestId('gallery-card')).toHaveLength(1);
    expect(screen.getAllByTestId('gallery-band')).toHaveLength(2);
  });

  // BoardView shipped cards that took focus and did nothing on Enter, because
  // a div with role="button" gets no native activation. A real <button> does.
  it('opens a record on Enter, not only on click', async () => {
    const user = userEvent.setup();
    const entries = vault();
    useVaultStore.setState({ entries });
    useUiStore.setState({ detailPath: null });
    const schema = buildSchema(entries);
    render(
      <GalleryView
        filtered={false}
        entries={[entries.find((e) => e.path === 'assets/poster.md')!]}
        presentation={presentation()}
        schema={schema}
      />,
    );
    screen.getByTestId('gallery-card').focus();
    await user.keyboard('{Enter}');
    expect(useUiStore.getState().detailPath).toBe('assets/poster.md');
  });

  it('says why the canvas is empty instead of drawing nothing', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    render(<GalleryView entries={[]} presentation={presentation()} schema={schema} filtered />);
    expect(screen.getByTestId('gallery-view')).toBeTruthy();
    expect(screen.getByText('Nothing matches these filters')).toBeTruthy();
  });

  it('marks an unparseable record instead of hiding it', () => {
    const entries = [
      ...vault(),
      makeEntry({ path: 'assets/broken.md', type: 'Asset', parseError: 'bad yaml: line 2' }),
    ];
    const schema = buildSchema(entries);
    render(
      <GalleryView
        filtered={false}
        entries={records(entries)}
        presentation={presentation()}
        schema={schema}
      />,
    );
    expect(screen.getByText('Cannot parse')).toBeTruthy();
    expect(screen.getByText('broken.md')).toBeTruthy();
  });
});

describe('coverOf', () => {
  const entry = makeEntry({
    path: 'assets/poster.md',
    properties: {
      artwork: ['attachments/2026/poster.png', 'attachments/alt.png'],
      link: 'https://example.com/a.png',
      solo: 'attachments/solo.png',
      empty: [],
    },
  });

  it('takes the FIRST value, not a guess at which one looks like an image', () => {
    // A files property is an ordered list the user arranged; picking a
    // favourite would make the cover move when an attachment is renamed.
    expect(coverOf(entry, 'artwork')).toEqual({
      value: 'attachments/2026/poster.png',
      kind: 'file',
      label: 'poster.png',
    });
  });

  it('labels a path with its basename and a URL with itself', () => {
    expect(coverOf(entry, 'link')).toEqual({
      value: 'https://example.com/a.png',
      kind: 'url',
      label: 'https://example.com/a.png',
    });
  });

  it('accepts a bare string, which is what a one-file property serializes to', () => {
    expect(coverOf(entry, 'solo')?.label).toBe('solo.png');
  });

  it('returns null for no cover field, an unknown field, and an empty one', () => {
    expect(coverOf(entry, undefined)).toBeNull();
    expect(coverOf(entry, 'nope')).toBeNull();
    expect(coverOf(entry, 'empty')).toBeNull();
  });
});
