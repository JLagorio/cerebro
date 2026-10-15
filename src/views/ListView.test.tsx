import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListView } from '@/views/ListView';
import { FieldChip } from '@/views/FieldChip';
import { buildSchema } from '@/engine/schema';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';
import type { Presentation } from '@/engine/types';

const presentation: Presentation = {
  type: 'list',
  group: [{ field: 'status' }],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'status' }, { field: 'priority' }, { field: 'assignee' }],
};

function setup(
  onCreate?: (title: string, band: { groupBy: string; groupValue: string }) => Promise<boolean>,
) {
  const entries = fixtureVault();
  useVaultStore.setState({ entries });
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.path.startsWith('projects/onboarding/items/'));
  render(
    <ListView entries={items} presentation={presentation} schema={schema} onCreate={onCreate} />,
  );
}

afterEach(cleanup);

describe('ListView', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
  });

  it('renders group headers in the schema status order, including empty groups', () => {
    setup();
    const labels = screen.getAllByTestId('list-group-header').map((h) => h.textContent ?? '');
    expect(labels[0]).toContain('Todo');
    expect(labels[1]).toContain('Doing');
    expect(labels[2]).toContain('Done'); // empty group still renders, proving schema order
  });

  it('draws a multi-value record once in each of its bands', () => {
    const type = makeEntry({
      path: 'types/note.md',
      type: 'Type',
      title: 'Note',
      properties: { fields: { labels: { kind: 'multiselect', options: ['one', 'two'] } } } as never,
    });
    const record = makeEntry({
      path: 'notes/both.md',
      type: 'Note',
      title: 'In both bands',
      properties: { labels: ['one', 'two'] },
    });
    const entries = [type, record];
    render(
      <ListView
        entries={[record]}
        presentation={{ ...presentation, group: [{ field: 'labels' }] }}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Open In both bands' })).toHaveLength(2);
    expect(screen.getAllByTestId('list-group-header').map((row) => row.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('One'), expect.stringContaining('Two')]),
    );
  });

  it('renders a warning row for entries with a parse error', () => {
    setup();
    expect(screen.getByText('Cannot parse')).toBeTruthy();
    expect(screen.getByText('broken.md')).toBeTruthy();
  });

  it('offers add rows only when its caller supplies onCreate', () => {
    setup();
    expect(screen.queryAllByTestId('quick-add')).toHaveLength(0);
    cleanup();
    setup(vi.fn().mockResolvedValue(true));
    expect(screen.getAllByTestId('quick-add').length).toBeGreaterThan(0);
  });

  it('passes the authored title and band to its caller', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    setup(onCreate);
    await user.click(screen.getByRole('button', { name: 'New item in Doing' }));
    await user.type(
      screen.getByRole('textbox', { name: 'New item in Doing' }),
      'Ship the fix{Enter}',
    );
    expect(onCreate).toHaveBeenCalledWith('Ship the fix', {
      groupBy: 'status',
      groupValue: 'doing',
    });
  });

  it('ignores a second Enter while the first create is pending', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(() => new Promise<boolean>(() => {}));
    setup(onCreate);
    await user.click(screen.getByRole('button', { name: 'New item in Todo' }));
    await user.type(
      screen.getByRole('textbox', { name: 'New item in Todo' }),
      'Once only{Enter}{Enter}',
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft when its caller refuses the create', async () => {
    const user = userEvent.setup();
    setup(vi.fn().mockResolvedValue(false));
    await user.click(screen.getByRole('button', { name: 'New item in Todo' }));
    await user.type(screen.getByRole('textbox', { name: 'New item in Todo' }), 'Keep this{Enter}');
    expect(screen.getByRole('textbox', { name: 'New item in Todo' })).toHaveProperty(
      'value',
      'Keep this',
    );
  });

  it('quick-add cancels on Escape', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    setup(onCreate);
    await user.click(screen.getByRole('button', { name: 'New item in Todo' }));
    await user.type(screen.getByRole('textbox', { name: 'New item in Todo' }), 'never{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('an empty list still offers the caller a first record with no band seed', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    const entries = fixtureVault();
    render(
      <ListView
        entries={[]}
        presentation={presentation}
        schema={buildSchema(entries)}
        onCreate={onCreate}
      />,
    );
    expect(screen.getByTestId('list-group-header').textContent).toContain('All items');
    await user.click(screen.getByText('Add item'));
    await user.type(screen.getByRole('textbox'), 'First item{Enter}');
    expect(onCreate).toHaveBeenCalledWith('First item', { groupBy: '', groupValue: '' });
  });
});

/**
 * Keyboard access and the empty state (M15).
 *
 * ListRow was a `<div role="row">` with an onClick, no tabIndex and no roving
 * container — the hook was imported by TableView alone, so this layout had no
 * keyboard path to a record at all. A zero-row view also rendered nothing but
 * the grey "All items 0" strip, which reads as a load failure.
 */
describe('ListView keyboard and empty state (M15)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ detailPath: null });
  });

  it('lands a visible cursor on the first row when the list takes focus', () => {
    setup();
    const list = screen.getByTestId('list-view');
    expect(list.getAttribute('role')).toBe('grid');
    fireEvent.focus(list, { target: list });
    const rows = screen.getAllByTestId('list-row');
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    expect(list.getAttribute('aria-activedescendant')).toBe(rows[0].id);
  });

  it('opens a record with Enter after arrowing to it', () => {
    setup();
    const list = screen.getByTestId('list-view');
    fireEvent.focus(list, { target: list });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(useUiStore.getState().detailPath).not.toBeNull();
  });

  it('creates from the canvas when only onCreate is passed — no project needed', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    const entries = fixtureVault();
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.path.startsWith('projects/onboarding/items/'));
    render(
      <ListView entries={items} presentation={presentation} schema={schema} onCreate={onCreate} />,
    );
    await user.click(screen.getByRole('button', { name: 'New item in Doing' }));
    await user.type(screen.getByRole('textbox', { name: 'New item in Doing' }), 'Ship it{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Ship it', { groupBy: 'status', groupValue: 'doing' });
  });

  it('says why a filtered view is empty instead of showing a bare count strip', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(<ListView entries={[]} presentation={presentation} schema={schema} filtered />);
    expect(screen.getByText('Nothing matches these filters')).toBeTruthy();
  });
});

/**
 * Row affordances (M16.21).
 *
 * A list row was a `<div role="row">` with an onClick: clickable with a mouse,
 * openable with the grid's Enter key, and carrying no NAMED control anywhere —
 * so assistive tech saw a strip of text with no announced way to act on it.
 * And opening was the only thing a list could do to a record: copying a link,
 * duplicating, deleting all meant opening it first to reach the panel header.
 */
describe('ListView row affordances (M16.21)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ detailPath: null });
  });

  it('gives every row a named Open control', () => {
    setup();
    const open = screen.getAllByTestId('row-open-affordance');
    expect(open.length).toBeGreaterThan(0);
    expect(open[0].getAttribute('aria-label')).toBe('Open Design first-run flow');
  });

  it('opens the record from that control', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Open Design first-run flow' }));
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/items/fld-1.md');
  });

  it('offers the record actions the panel header has, without opening the record', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Design first-run flow' }));
    expect(screen.getByTestId('row-copy-link')).toBeTruthy();
    expect(screen.getByTestId('row-duplicate')).toBeTruthy();
    expect(screen.getByTestId('row-delete')).toBeTruthy();
    // Opening the menu is not opening the row — the click must not fall
    // through to the row's own handler.
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  it('copies a filename-stem link from a row', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Design first-run flow' }));
    await user.click(screen.getByTestId('row-copy-link'));
    expect(await navigator.clipboard.readText()).toBe('[[fld-1]]');
  });

  it('confirms before deleting, naming what links to the record', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Design first-run flow' }));
    await user.click(screen.getByTestId('row-delete'));
    expect(screen.getByText('Delete "Design first-run flow"?')).toBeTruthy();
  });
});

describe('FieldChip', () => {
  afterEach(cleanup);

  it('renders ghost values with dashed muted styling', () => {
    const { container } = render(
      <FieldChip
        resolved={{ def: null, raw: 'weird', display: 'weird', color: null, ghost: true }}
      />,
    );
    expect((container.firstChild as HTMLElement).className).toContain('border-dashed');
  });

  it('renders nothing for empty values', () => {
    const { container } = render(
      <FieldChip resolved={{ def: null, raw: null, display: '', color: null, ghost: false }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
