// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/engine/schema';
import type { Entry } from '@/engine/types';
import { makeEntry } from '@/test/factories';
import { DatabaseBlockView } from './DatabaseBlockView';

afterEach(cleanup);

const typeDoc = (title: string, properties: Record<string, unknown> = {}): Entry =>
  makeEntry({
    path: `types/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    title,
    type: 'Type',
    properties: properties as Entry['properties'],
  });

const schema = buildSchema([
  typeDoc('Reading list', {
    icon: 'book',
    color: '#DE8F0A',
    views: [
      { id: 'shelf', name: 'Shelf', presentation: { type: 'table' } },
      { id: 'stack', name: 'Stack', presentation: { type: 'board' } },
    ],
  }),
]);

const show = (database: string, view = '') =>
  render(<DatabaseBlockView database={database} view={view} schema={schema} />);

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
