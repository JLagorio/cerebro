// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/engine/schema';
import type { Entry } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { DatabaseBlockView } from './DatabaseBlockView';

afterEach(cleanup);

/**
 * Door 2 writes through `createDatabase`, which reaches the vault store
 * directly. Standing in for the disk here rather than mocking the action
 * keeps what the block asks for — a Type doc with a `folder:` — inside what
 * these tests can see.
 */
let created: Record<string, unknown>[];
let toasts: string[];
beforeEach(() => {
  created = [];
  toasts = [];
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries,
    status: 'ready',
    createItem: vi.fn(async (args: Record<string, unknown>) => {
      created.push(args);
      return 'types/new.md';
    }),
  });
  useUiStore.setState({
    toast: (message: string) => {
      toasts.push(message);
    },
  });
});

const typeDoc = (title: string, properties: Record<string, unknown> = {}): Entry =>
  makeEntry({
    path: `types/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    title,
    type: 'Type',
    properties: properties as Entry['properties'],
  });

const entries: Entry[] = [
  typeDoc('Reading list', {
    icon: 'book',
    color: '#DE8F0A',
    fields: { rating: { kind: 'text' } },
    views: [
      // Two views whose FILTERS differ, so a test can tell which one drew:
      // a view that only changes the layout would pass against a block that
      // ignored the pointer entirely.
      {
        id: 'shelf',
        name: 'Shelf',
        presentation: { type: 'table' },
      },
      {
        id: 'stack',
        name: 'Stack',
        filters: { all: [{ field: 'rating', op: 'equals', value: 'great' }] },
        presentation: { type: 'table' },
      },
    ],
  }),
  makeEntry({
    path: 'reading/dune.md',
    title: 'Dune',
    type: 'Reading list',
    properties: { rating: 'great' } as Entry['properties'],
  }),
  makeEntry({
    path: 'reading/ulysses.md',
    title: 'Ulysses',
    type: 'Reading list',
    properties: { rating: 'hard' } as Entry['properties'],
  }),
];
const schema = buildSchema(entries);

const show = (database: string, view = '') =>
  render(<DatabaseBlockView database={database} view={view} schema={schema} entries={entries} />);

describe('DatabaseBlockView', () => {
  it('names the database and the view it is showing', () => {
    show('Reading list', 'stack');
    const block = screen.getByTestId('database-block');
    expect(block.textContent).toContain('Reading list');
    expect(block.textContent).toContain('Stack');
  });

  it('falls back to the first view when the pointer names none', () => {
    show('Reading list');
    expect(screen.getByTestId('database-block').textContent).toContain('Shelf');
  });

  it('draws the database rows, not just its name', () => {
    show('Reading list', 'shelf');
    const block = screen.getByTestId('database-block');
    expect(block.textContent).toContain('Dune');
    expect(block.textContent).toContain('Ulysses');
  });

  /**
   * The discriminating one. A block that resolved the pointer for its LABEL
   * but drew the database's whole row set would pass every test above — the
   * two views here differ by a filter, so only a block that actually threads
   * the chosen view into the surface shows one book and not the other.
   */
  it('honours the chosen view filters, so the pointer decides the rows', () => {
    show('Reading list', 'stack');
    const block = screen.getByTestId('database-block');
    expect(block.textContent).toContain('Dune');
    expect(block.textContent).not.toContain('Ulysses');
  });

  /**
   * "Not there" and "empty" are opposite sentences, and this is the one the
   * doctrine exists for: rendering an empty table here would tell the reader
   * that Wine cellar exists and holds nothing. It says which database is
   * missing instead, and renders no table at all.
   */
  it('names a database that does not exist rather than rendering an empty one', () => {
    show('Wine cellar');
    const block = screen.getByTestId('database-block-missing');
    expect(block.textContent).toContain('Wine cellar');
    expect(screen.queryByTestId('database-block')).toBeNull();
  });

  /**
   * "Show the Board" with no Board is not "show whatever is first". The block
   * renders what it CAN — the fallback — and says what it could not, so the
   * reader is never quietly shown different data than the page asked for.
   */
  it('shows the fallback view but says the named one is missing', () => {
    show('Reading list', 'board');
    expect(screen.getByTestId('database-block').textContent).toContain('Shelf');
    const note = screen.getByTestId('database-block-view-missing');
    expect(note.textContent).toContain('board');
    expect(note.textContent).toContain('Shelf');
  });

  /**
   * A fence naming no database never becomes a block (`parseDatabaseRef`
   * returns null and the code block survives), so this state can only be
   * reached in memory — a create flow between inserting the block and picking
   * its database. It must not read as an error.
   */
  it('has a pending state for a block that has not chosen a database yet', () => {
    show('');
    expect(screen.getByTestId('database-block-unset')).toBeTruthy();
    expect(screen.queryByTestId('database-block-missing')).toBeNull();
  });

  /**
   * A database is recognisable in a page by the icon it wears everywhere else,
   * so the block reads its style from the schema rather than picking a generic
   * one. `Icon` applies the colour as an inline style, not an attribute.
   */
  it("wears the database's own icon and colour", () => {
    show('Reading list', 'shelf');
    const icon = screen.getByTestId('database-block').querySelector('svg');
    expect((icon as SVGElement | null)?.style.color).toBe('rgb(222, 143, 10)');
    expect(icon?.classList.toString()).toContain('book');
  });
});

/**
 * Door 1 (M47.3): the block asks in place rather than through a dialog.
 *
 * `onChange` is what separates an editable block from a rendered one, and the
 * split is behavioural, not cosmetic: a block with nowhere to write back must
 * offer no controls at all, because a picker that silently does nothing is
 * worse than none.
 */
describe('DatabaseBlockView pickers', () => {
  const editable = (database: string, view = '') => {
    const onChange = vi.fn();
    render(
      <DatabaseBlockView
        database={database}
        view={view}
        schema={schema}
        entries={entries}
        onChange={onChange}
      />,
    );
    return onChange;
  };

  it('offers no controls when there is nowhere to write back', () => {
    show('');
    expect(screen.queryByTestId('database-block-pick')).toBeNull();
    show('Reading list', 'shelf');
    expect(screen.queryByTestId('database-block-view-pick')).toBeNull();
  });

  it('an unset block picks a database in place and writes the pointer', () => {
    const onChange = editable('');
    fireEvent.click(screen.getByTestId('database-block-pick'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Reading list/ }));
    expect(onChange).toHaveBeenCalledWith({ database: 'Reading list', view: '' });
  });

  /**
   * The registry is one list — reading lists, grocery lists, Risk alike — so
   * the picker offers every database rather than a curated subset. Nothing is
   * excluded by name or by system-ness ("no type special-casing"), which is
   * the rule that keeps this honest as a vault grows.
   */
  it('offers every database in the vault, including the metamodel', () => {
    editable('');
    fireEvent.click(screen.getByTestId('database-block-pick'));
    const names = screen.getAllByRole('menuitem').map((i) => i.textContent ?? '');
    expect(names.some((n) => n.includes('Reading list'))).toBe(true);
    expect(names.some((n) => n.includes('Type'))).toBe(true);
  });

  it('switches which view the block shows, writing the view id', () => {
    const onChange = editable('Reading list', 'shelf');
    fireEvent.click(screen.getByTestId('database-block-view-pick'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stack' }));
    expect(onChange).toHaveBeenCalledWith({ database: 'Reading list', view: 'stack' });
  });

  /**
   * The id, never the name. They are equal for hand-written views and diverge
   * the moment one is renamed — writing the name would produce a pointer that
   * resolves to nothing the next time the file is read.
   */
  it('writes the view id even though the button shows the name', () => {
    const onChange = editable('Reading list', 'shelf');
    fireEvent.click(screen.getByTestId('database-block-view-pick'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Shelf' }));
    expect(onChange).toHaveBeenCalledWith({ database: 'Reading list', view: 'shelf' });
  });

  /**
   * Door 2 (M47.4). This is the complaint the milestone exists for: "to track
   * tasks I have to back out of this > go to databases > create a new type >
   * come back here and select said type." The door sits ABOVE the roster
   * because a database you are about to invent is the case the old flow could
   * not serve at all, and it must not be buried under the ones you have.
   */
  it('offers making a new database above the ones that exist', () => {
    editable('');
    fireEvent.click(screen.getByTestId('database-block-pick'));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent ?? '');
    expect(items[0]).toContain('New database');
  });

  it('asks for the name in place, without a dialog', () => {
    editable('');
    fireEvent.click(screen.getByTestId('database-block-pick'));
    fireEvent.click(screen.getByTestId('database-block-new'));
    expect(screen.getByLabelText('New database name')).toBeTruthy();
    expect(document.querySelector('.cb-dlg')).toBeNull();
  });

  it('creates the database and points the block at it, in one gesture', async () => {
    const onChange = editable('');
    fireEvent.click(screen.getByTestId('database-block-pick'));
    fireEvent.click(screen.getByTestId('database-block-new'));
    fireEvent.change(screen.getByLabelText('New database name'), {
      target: { value: 'Groceries' },
    });
    fireEvent.submit(screen.getByLabelText('New database name').closest('form')!);
    await waitFor(() => expect(created).toHaveLength(1));
    expect((created[0].frontmatter as Record<string, unknown>).folder).toBe('records/groceries');
    expect(onChange).toHaveBeenCalledWith({ database: 'Groceries', view: '' });
  });

  /**
   * `createDatabase` toasts its own refusals and answers null, so a duplicate
   * name must leave the block pointing at nothing and the menu open with what
   * the user typed still in the box to fix — not silently point at the
   * database that was already there.
   */
  it('leaves the block unset when the name is already taken', async () => {
    const onChange = editable('');
    fireEvent.click(screen.getByTestId('database-block-pick'));
    fireEvent.click(screen.getByTestId('database-block-new'));
    fireEvent.change(screen.getByLabelText('New database name'), {
      target: { value: 'Reading list' },
    });
    fireEvent.submit(screen.getByLabelText('New database name').closest('form')!);
    await waitFor(() => expect(toasts.join(' ')).toContain('already exists'));
    expect(created).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('New database name')).toBeTruthy();
  });
});

/**
 * Schema by use (M47.4).
 *
 * The table's "+" has declared real properties on a type since M12 — it was
 * simply never reachable from a page. What turns it on is `onColumnsChange`,
 * and what that means is that adding a column is HOW a schema comes to exist,
 * rather than a prerequisite to satisfy on another surface first.
 */
describe('DatabaseBlockView column editing', () => {
  it('offers no add-column button on a block with nowhere to write back', () => {
    show('Reading list', 'shelf');
    expect(screen.queryByTestId('add-column')).toBeNull();
  });

  it('offers it on an editable block', () => {
    render(
      <DatabaseBlockView
        database="Reading list"
        view="shelf"
        schema={schema}
        entries={entries}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('add-column')).toBeTruthy();
  });
});

/**
 * The empty state has to be true (M47.4).
 *
 * Found live, not in jsdom: a brand-new database rendered "No records yet /
 * Create the first one below." with nothing below it, because `buildRows`
 * emits the add row only when `onCreate` was passed and the block passed
 * none. The sentence pointed at a control that did not exist — the same
 * defect M20.5 fixed for a control that merely sat in the wrong place. The
 * dashboard's embed has the same shape and was making the same false promise.
 */
describe('DatabaseBlockView empty state', () => {
  const empty = buildSchema([typeDoc('Wishlist')]);

  it('does not promise a create row it cannot render', () => {
    render(<DatabaseBlockView database="Wishlist" view="" schema={empty} entries={[]} />);
    const block = screen.getByTestId('database-block');
    expect(block.textContent).toContain('No records yet');
    expect(block.textContent).not.toContain('below');
  });

  it('promises one when it can', () => {
    render(
      <DatabaseBlockView
        database="Wishlist"
        view=""
        schema={empty}
        entries={[]}
        onChange={vi.fn()}
        onCreate={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByTestId('database-block').textContent).toContain('Create the first one');
  });
});

/**
 * Inline and full page are one database seen two ways (M47.5).
 *
 * The block shows a single view among your prose; its own screen carries the
 * whole tab strip. The `↗` is the trip between them, spelled the way every
 * sidebar section already spells "open the surface this summarises".
 */
describe('DatabaseBlockView open full page', () => {
  it('opens the database at the view the block is showing', () => {
    const onOpenFullPage = vi.fn();
    render(
      <DatabaseBlockView
        database="Reading list"
        view="stack"
        schema={schema}
        entries={entries}
        onOpenFullPage={onOpenFullPage}
      />,
    );
    fireEvent.click(screen.getByTestId('database-block-open'));
    // The VIEW travels with it: arriving on the full page showing something
    // else than the block you clicked would read as a different database.
    expect(onOpenFullPage).toHaveBeenCalledWith('Reading list', 'stack');
  });

  it('passes the fallback view when the block named none', () => {
    const onOpenFullPage = vi.fn();
    render(
      <DatabaseBlockView
        database="Reading list"
        view=""
        schema={schema}
        entries={entries}
        onOpenFullPage={onOpenFullPage}
      />,
    );
    fireEvent.click(screen.getByTestId('database-block-open'));
    expect(onOpenFullPage).toHaveBeenCalledWith('Reading list', 'shelf');
  });

  it('offers nothing to open when no host can navigate', () => {
    show('Reading list', 'shelf');
    expect(screen.queryByTestId('database-block-open')).toBeNull();
  });
});
