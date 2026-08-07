import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TableView } from '@/views/TableView';
import { buildSchema } from '@/engine/schema';
import { columnUniverse } from '@/engine/columns';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';
import type { ColumnDef } from '@/engine/columns';
import type { Entry, Presentation } from '@/engine/types';

const presentation: Presentation = {
  type: 'table',
  group: [],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'status' }, { field: 'priority' }],
};

function setup() {
  const entries = fixtureVault();
  useVaultStore.setState({ entries });
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.type === 'Work item');
  const fields = schema.types.get('Work item')?.fields ?? [];
  render(<TableView entries={items} presentation={presentation} schema={schema} fields={fields} />);
  return { items };
}

afterEach(cleanup);

describe('TableView row opening (M9.3)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ detailPath: null });
    // Standing in a saved view — the case that used to navigate away.
    useNavStore.setState({
      selection: { kind: 'list', id: 'at-risk-work' },
      history: [{ kind: 'list', id: 'at-risk-work' }],
      historyIndex: 0,
    });
  });

  it('opens a work item in the detail panel without leaving the view', async () => {
    const user = userEvent.setup();
    const { items } = setup();
    const item = items[0];

    await user.click(screen.getByLabelText(`Open ${item.title}`));

    expect(useUiStore.getState().detailPath).toBe(item.path);
    // The regression: this used to become { kind: 'project', … }.
    expect(useNavStore.getState().selection).toEqual({ kind: 'list', id: 'at-risk-work' });
  });

  it('opens a Project record in the panel too — no type moves you (M12.5)', async () => {
    const user = userEvent.setup();
    const entries = fixtureVault();
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    const project = entries.find((e) => e.type === 'Project')!;
    render(
      <TableView
        entries={[project]}
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Project')?.fields ?? []}
      />,
    );

    await user.click(screen.getByLabelText(`Open ${project.title}`));

    // The project page is retired: a legacy project.md is an ordinary record,
    // and in-place callers keep the view they were reading.
    expect(useUiStore.getState().detailPath).toBe(project.path);
    expect(useNavStore.getState().selection).toEqual({ kind: 'list', id: 'at-risk-work' });
  });
});

/**
 * Keyboard reachability of the grid (M15).
 *
 * The record name was a bare <span> and the only opener was a chip that was
 * `display:none` until hover — absent from the DOM and from the tab order, so
 * there was no keyboard path into a record from the app's primary data
 * surface. The grid was also `outline-none` with no substitute, and the hook's
 * rowProps were never spread, so the cursor moved invisibly and never scrolled.
 */
describe('TableView keyboard access (M15)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ detailPath: null });
    useNavStore.setState({
      selection: { kind: 'list', id: 'at-risk-work' },
      history: [{ kind: 'list', id: 'at-risk-work' }],
      historyIndex: 0,
    });
  });

  it('exposes the record name as a real focusable control', async () => {
    const user = userEvent.setup();
    const { items } = setup();
    const opener = screen.getByRole('button', { name: `Open ${items[0].title}` });
    // Not a hover-only chip: it is in the tab order and reachable by focus.
    opener.focus();
    expect(document.activeElement).toBe(opener);
    await user.keyboard('{Enter}');
    expect(useUiStore.getState().detailPath).toBe(items[0].path);
  });

  it('announces itself as a grid with a row count', () => {
    const { items } = setup();
    const grid = screen.getByTestId('table-view');
    expect(grid.getAttribute('aria-label')).toBeTruthy();
    expect(grid.getAttribute('aria-rowcount')).toBe(String(items.length));
    // The native ring is no longer suppressed with nothing in its place.
    expect(grid.className).not.toContain('outline-none ');
  });

  it('lands the cursor on the first row when the grid takes focus', () => {
    setup();
    const grid = screen.getByTestId('table-view');
    fireEvent.focus(grid, { target: grid });
    const rows = screen.getAllByTestId('table-row');
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    // …and points assistive tech at it, since focus never leaves the container.
    expect(grid.getAttribute('aria-activedescendant')).toBe(rows[0].id);
  });

  it('moves the cursor with the arrows and opens with Enter', () => {
    const { items } = setup();
    const grid = screen.getByTestId('table-view');
    fireEvent.focus(grid, { target: grid });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    const rows = screen.getAllByTestId('table-row');
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(useUiStore.getState().detailPath).toBe(items[1].path);
  });
});

/**
 * Column resizing (M11).
 *
 * The old resizer called `onColumnsChange` on every mousemove, which meant a
 * YAML write and a vault rescan per pixel — the drag fought a stream of
 * re-renders carrying stale widths, which is why it "barely worked". These pin
 * the fix: paint continuously, persist exactly once.
 */
describe('TableView column resizing (M11)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
  });

  function grid(onColumnsChange = vi.fn(), onPresentationChange = vi.fn()) {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Work item')}
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
        onColumnsChange={onColumnsChange}
        onPresentationChange={onPresentationChange}
      />,
    );
    return { onColumnsChange, onPresentationChange };
  }

  // jsdom has no PointerEvent, and testing-library's `pointerDown` helper then
  // falls back to a bare Event, which silently drops clientX. Dispatching a
  // MouseEvent named `pointerdown` reaches the same listener with coordinates
  // intact — the listeners are registered by name, not by event class.
  const at = (type: string, clientX: number) => new MouseEvent(type, { clientX, bubbles: true });

  const drag = (handle: HTMLElement, from: number, to: number) => {
    fireEvent(handle, at('pointerdown', from));
    fireEvent(window, at('pointermove', (from + to) / 2));
    fireEvent(window, at('pointermove', to));
    fireEvent(window, at('pointerup', to));
  };

  it('persists a column width once, on release — not per pointer move', () => {
    const { onColumnsChange } = grid();
    drag(screen.getByLabelText('Resize Status column'), 100, 160);
    // One write for the whole gesture. Anything more is a disk write and a
    // rescan per pixel.
    expect(onColumnsChange).toHaveBeenCalledTimes(1);
    expect(onColumnsChange.mock.calls[0][0]).toContainEqual({ field: 'status', width: 210 });
  });

  it('measures from where the drag started, so a fast drag lands on the pointer', () => {
    // The old resizer accumulated per-event deltas, which drifted whenever a
    // move outran a repaint. Two moves ending at the same x must produce the
    // same width as one.
    const { onColumnsChange } = grid();
    const handle = screen.getByLabelText('Resize Status column');
    fireEvent(handle, at('pointerdown', 0));
    fireEvent(window, at('pointermove', 500));
    fireEvent(window, at('pointermove', 40));
    fireEvent(window, at('pointerup', 40));
    expect(onColumnsChange.mock.calls[0][0]).toContainEqual({ field: 'status', width: 190 });
  });

  it('clamps a column to the minimum rather than collapsing it', () => {
    const { onColumnsChange } = grid();
    drag(screen.getByLabelText('Resize Status column'), 400, 0);
    expect(onColumnsChange.mock.calls[0][0]).toContainEqual({ field: 'status', width: 60 });
  });

  it('resizes the name column, which nothing could resize before', () => {
    const { onPresentationChange } = grid();
    drag(screen.getByLabelText('Resize Name column'), 280, 380);
    expect(onPresentationChange).toHaveBeenCalledTimes(1);
    expect(onPresentationChange.mock.calls[0][0].titleWidth).toBe(380);
  });

  it('resizes from the keyboard, so the affordance is not pointer-only', () => {
    const { onColumnsChange } = grid();
    fireEvent.keyDown(screen.getByLabelText('Resize Status column'), { key: 'ArrowRight' });
    expect(onColumnsChange.mock.calls[0][0]).toContainEqual({ field: 'status', width: 158 });
  });

  it('offers no resizer on a surface with no view file to write to', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Work item')}
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
      />,
    );
    expect(screen.queryByLabelText('Resize Status column')).toBeNull();
    expect(screen.queryByLabelText('Resize Name column')).toBeNull();
  });
});

/**
 * The cell cursor (M16.17).
 *
 * Every cell is an always-live `FieldEditor`, so there was no inert state to
 * escape from, nothing bound Tab, and no cell carried an id or an
 * `aria-colindex`. `useRowKeyboard` was a ROW cursor that bailed on
 * INPUT/TEXTAREA — including on Escape, which is the one key whose whole job
 * is getting back out of an editor.
 */
describe('TableView cell cursor (M16.17)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ detailPath: null });
    useNavStore.setState({
      selection: { kind: 'list', id: 'at-risk-work' },
      history: [{ kind: 'list', id: 'at-risk-work' }],
      historyIndex: 0,
    });
  });

  const cursorCell = () => document.querySelector('[data-cursor="true"]');

  /** A table whose third display slot is a plain text cell, so Enter lands on
   * a text field rather than on a chip that opens a popover. */
  function textGrid() {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Work item')}
        presentation={{ ...presentation, columns: [{ field: 'status' }, { field: 'notes' }] }}
        schema={schema}
        // `notes` is deliberately NOT in the field universe: a view file may
        // name a column no type declares, and `resolveColumns` synthesizes a
        // text def for it — which is what production does here, and what
        // M20.1's ownership check reads to keep such a column editable.
        fields={schema.types.get('Work item')?.fields ?? []}
      />,
    );
    return screen.getByTestId('table-view');
  }

  it('numbers its columns, so a screen reader can say where the cursor is', () => {
    setup();
    const grid = screen.getByTestId('table-view');
    // Name + the two data columns.
    expect(grid.getAttribute('aria-colcount')).toBe('3');
    const cells = screen.getAllByRole('gridcell');
    expect(cells.some((c) => c.getAttribute('aria-colindex') === '1')).toBe(true);
  });

  it('the row cursor stays column-less until you arrow sideways', () => {
    const { items } = setup();
    const grid = screen.getByTestId('table-view');
    fireEvent.focus(grid, { target: grid });
    expect(cursorCell()).toBeNull();
    // Enter still opens the record while no cell is picked out — the M15
    // contract this must not break.
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(useUiStore.getState().detailPath).toBe(items[0].path);
  });

  it('arrows and Tab walk a ring across the cells', () => {
    setup();
    const grid = screen.getByTestId('table-view');
    fireEvent.focus(grid, { target: grid });
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(cursorCell()?.getAttribute('aria-colindex')).toBe('1');
    fireEvent.keyDown(grid, { key: 'Tab' });
    expect(cursorCell()?.getAttribute('aria-colindex')).toBe('2');
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(cursorCell()?.getAttribute('aria-colindex')).toBe('1');
    // ArrowLeft off the first cell hands the ROW back rather than wrapping
    // onto the row above: the row cursor is where Enter opens the record.
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(cursorCell()).toBeNull();
  });

  it('Tab is only bound once a cell is picked out', () => {
    setup();
    const grid = screen.getByTestId('table-view');
    fireEvent.focus(grid, { target: grid });
    fireEvent.keyDown(grid, { key: 'Tab' });
    // A grid that swallowed Tab unconditionally would trap every keyboard
    // user who merely tabbed onto it on their way somewhere else.
    expect(cursorCell()).toBeNull();
  });

  it('Tab wraps onto the next row instead of stopping at the last cell', () => {
    setup();
    const grid = screen.getByTestId('table-view');
    fireEvent.focus(grid, { target: grid });
    const rows = screen.getAllByTestId('table-row');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'Tab' });
    fireEvent.keyDown(grid, { key: 'Tab' });
    expect(rows[0].contains(cursorCell())).toBe(true);
    expect(cursorCell()?.getAttribute('aria-colindex')).toBe('3');
    fireEvent.keyDown(grid, { key: 'Tab' });
    expect(rows[1].contains(cursorCell())).toBe(true);
    expect(cursorCell()?.getAttribute('aria-colindex')).toBe('1');
  });

  it('points aria-activedescendant at the CELL once one is picked out', () => {
    setup();
    const grid = screen.getByTestId('table-view');
    fireEvent.focus(grid, { target: grid });
    const rows = screen.getAllByTestId('table-row');
    expect(grid.getAttribute('aria-activedescendant')).toBe(rows[0].id);
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(grid.getAttribute('aria-activedescendant')).toBe(cursorCell()?.id);
  });

  it('Enter hands the cell to its control, and Escape takes it back', async () => {
    const grid = textGrid();
    fireEvent.focus(grid, { target: grid });
    // Third display slot: the text column. The name column is first and its
    // control opens the record rather than editing a value.
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(grid, { key: 'ArrowRight' });
    const cell = cursorCell();
    expect(cell?.getAttribute('aria-colindex')).toBe('3');
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(cell?.contains(document.activeElement)).toBe(true);
    // FieldEditor's own Escape stops propagation and unmounts the input, and
    // removing a focused element fires no blur — so focus used to land on
    // the body with the cursor still on the cell, and the grid answered
    // nothing at all.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(grid));
    expect(cursorCell()).toBe(cell);
  });

  it('leaves the arrows alone while an editor has focus', () => {
    const grid = textGrid();
    fireEvent.focus(grid, { target: grid });
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    const before = cursorCell();
    // Moving the caret is what an arrow means inside a text field.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(cursorCell()).toBe(before);
  });
});

/**
 * Row gutter and bulk actions (M16.16).
 *
 * `TableRow` had none of it: the `maximize-2` glyph in the title cell was
 * `aria-hidden` decoration, there was no row menu, and bulk selection did not
 * exist anywhere in the app — `useRowKeyboard` holds a scalar cursor index,
 * not a set.
 */
describe('TableView row gutter (M16.16)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
    useUiStore.setState({ detailPath: null, toasts: [] });
    useNavStore.setState({
      selection: { kind: 'list', id: 'at-risk-work' },
      history: [{ kind: 'list', id: 'at-risk-work' }],
      historyIndex: 0,
    });
  });

  function grid(props: Partial<React.ComponentProps<typeof TableView>> = {}) {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.type === 'Work item');
    render(
      <TableView
        entries={items}
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
        {...props}
      />,
    );
    return { items };
  }

  it('gives every row a checkbox and raises a bulk bar once one is ticked', async () => {
    const user = userEvent.setup();
    const { items } = grid();
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
    await user.click(screen.getByLabelText(`Select ${items[0].title}`));
    expect(screen.getByTestId('bulk-bar').getAttribute('aria-label')).toBe('1 selected');
  });

  it('shift-click extends from the last box touched', async () => {
    const user = userEvent.setup();
    // Four rows, because a range of two is indistinguishable from two clicks.
    const extra = ['One', 'Two', 'Three', 'Four'].map((title, i) =>
      makeEntry({ path: `records/row-${i}.md`, title, type: 'Work item' }),
    );
    const entries = [...fixtureVault(), ...extra];
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    render(
      <TableView
        entries={extra}
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
      />,
    );
    await user.click(screen.getByLabelText('Select One'));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByLabelText('Select Three'));
    await user.keyboard('{/Shift}');
    // Without an anchor a range select is just a second single click.
    expect(screen.getByTestId('bulk-bar').getAttribute('aria-label')).toBe('3 selected');
  });

  it('select-all ticks every row and clicking it again clears them', async () => {
    const user = userEvent.setup();
    const { items } = grid();
    await user.click(screen.getByTestId('select-all'));
    expect(screen.getByTestId('bulk-bar').getAttribute('aria-label')).toBe(
      `${items.length} selected`,
    );
    await user.click(screen.getByTestId('select-all'));
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
  });

  it('drops a selected path the row set no longer contains', () => {
    // A rescan, a filter or a delete renumbers the rows; a bulk delete must
    // not still be holding a path that resolves to nothing.
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.type === 'Work item');
    const view = (list: Entry[]) => (
      <TableView
        entries={list}
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
      />
    );
    const { rerender } = render(view(items));
    fireEvent.click(screen.getByLabelText(`Select ${items[0].title}`));
    expect(screen.getByTestId('bulk-bar')).toBeTruthy();
    rerender(view(items.slice(1)));
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
  });

  it('the grip opens a row menu, which is what a grip can honestly do here', async () => {
    const user = userEvent.setup();
    const { items } = grid();
    await user.click(screen.getAllByLabelText(`Actions for ${items[0].title}`)[0]);
    await user.click(screen.getByTestId('row-open'));
    // Row ORDER is the view's sort chain — there is no stored index a drag
    // could write to — so the grip carries the half of Notion's affordance
    // that means something: the menu.
    expect(useUiStore.getState().detailPath).toBe(items[0].path);
  });

  it('deleting from the row menu asks first', async () => {
    const user = userEvent.setup();
    const { items } = grid();
    await user.click(screen.getAllByLabelText(`Actions for ${items[0].title}`)[0]);
    await user.click(screen.getByTestId('row-delete'));
    expect(screen.getByText(`Delete "${items[0].title}"?`)).toBeTruthy();
  });

  it('offers no insert affordance on a surface that cannot create', () => {
    grid();
    expect(screen.queryByTestId('row-insert')).toBeNull();
  });

  it('the insert affordance opens an input inheriting the row it was clicked on', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    grid({ onCreate });
    await user.click(screen.getAllByTestId('row-insert')[0]);
    const input = screen.getByLabelText('New record title');
    await user.type(input, 'Fresh work');
    await user.keyboard('{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Fresh work', { groupBy: '', groupValue: '' });
  });
});

/**
 * Calculations (M16.15, retriggered M19.5).
 *
 * There was no footer element at all and no aggregate module in the engine, so
 * the single most-used question about a column of numbers — what do they add
 * up to — could not be asked anywhere in the app.
 *
 * M16.15 then put the OFFER in the footer, revealed on hover, which made the
 * commonest state of the row a rule under the grid advertising a feature
 * nobody had used. The offer now lives in the column header menu beside every
 * other per-column setting, and the footer only reports.
 */
describe('TableView calculations (M16.15, M19.5)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
  });

  function footer(columns: Presentation['columns'], extra: Partial<Presentation> = {}) {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const onColumnsChange = vi.fn();
    const onPresentationChange = vi.fn();
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Work item')}
        presentation={{ ...presentation, columns, ...extra }}
        schema={schema}
        fields={[
          ...(schema.types.get('Work item')?.fields ?? []),
          { name: 'estimate', kind: 'number' },
        ]}
        onColumnsChange={onColumnsChange}
        onPresentationChange={onPresentationChange}
      />,
    );
    return { onColumnsChange, onPresentationChange };
  }

  /** Open a column's header menu and expand its Calculate list. */
  async function calcMenu(user: ReturnType<typeof userEvent.setup>, column: string) {
    await user.click(screen.getByLabelText(`${column} column menu`));
    await user.click(screen.getByTestId('calculate'));
  }

  it('nothing offers a calculation until a header menu is opened', async () => {
    const user = userEvent.setup();
    footer([{ field: 'status' }, { field: 'priority' }]);
    // The defect this replaces: a footer that existed on every table with a
    // row in it, lighting up a ghost "Calculate" per column on hover.
    expect(screen.queryByTestId('table-footer')).toBeNull();
    expect(screen.queryByText('Calculate')).toBeNull();
    await calcMenu(user, 'Status');
    expect(screen.queryByTestId('calc-option-count_all')).not.toBeNull();
  });

  it('computes the configured calculation over the rows on screen', () => {
    const { onColumnsChange } = footer([{ field: 'status', calc: 'count_all' }]);
    const items = fixtureVault().filter((e) => e.type === 'Work item');
    expect(screen.getByTestId('calc-status').textContent).toContain(String(items.length));
    expect(onColumnsChange).not.toHaveBeenCalled();
  });

  it('keeps a slot for the columns that calculate nothing, so results stay under their column', () => {
    footer([{ field: 'status', calc: 'count_all' }, { field: 'priority' }]);
    expect(screen.getByTestId('table-footer')).toBeTruthy();
    expect(screen.getByTestId('calc-priority').textContent).toBe('');
  });

  it('persists the choice to the column, not to component state', async () => {
    const user = userEvent.setup();
    const { onColumnsChange } = footer([{ field: 'status' }]);
    await calcMenu(user, 'Status');
    await user.click(screen.getByTestId('calc-option-count_empty'));
    expect(onColumnsChange.mock.calls[0][0]).toContainEqual({
      field: 'status',
      calc: 'count_empty',
    });
  });

  it('says what a column already calculates without opening the list', async () => {
    const user = userEvent.setup();
    footer([{ field: 'status', calc: 'count_all' }]);
    await user.click(screen.getByLabelText('Status column menu'));
    expect(screen.getByTestId('calculate').textContent).toContain('Count all');
  });

  it('None clears the key rather than storing a "none" calculation', async () => {
    const user = userEvent.setup();
    const { onColumnsChange } = footer([{ field: 'status', calc: 'count_all' }]);
    await calcMenu(user, 'Status');
    await user.click(screen.getByTestId('calc-option-none'));
    expect(onColumnsChange.mock.calls[0][0]).toEqual([{ field: 'status' }]);
  });

  it('offers Sum on a number column and withholds it from a select', async () => {
    const user = userEvent.setup();
    footer([{ field: 'estimate' }, { field: 'status' }]);
    await calcMenu(user, 'Estimate');
    expect(screen.queryByTestId('calc-option-sum')).not.toBeNull();
    await user.keyboard('{Escape}');
    await calcMenu(user, 'Status');
    // Capability-gated on the KIND, so a status column cannot be asked for a
    // total it has no numbers to produce.
    expect(screen.queryByTestId('calc-option-sum')).toBeNull();
  });

  it('the name column calculates too, and writes to the presentation', async () => {
    const user = userEvent.setup();
    const { onPresentationChange } = footer([{ field: 'status' }]);
    await calcMenu(user, 'Name');
    await user.click(screen.getByTestId('calc-option-count_all'));
    // The name column has been a peer of the data columns since M12.8, but it
    // has no ColumnSpec to carry a calc on.
    expect(onPresentationChange.mock.calls[0][0].titleCalc).toBe('count_all');
  });

  it('renders no footer at all when there is nothing to count', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <TableView
        entries={[]}
        // A calculation IS set — so the footer is absent because there are no
        // rows, which is what this test claims to be about.
        presentation={{ ...presentation, titleCalc: 'count_all' }}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
      />,
    );
    expect(screen.queryByTestId('table-footer')).toBeNull();
  });
});

/**
 * Header and column settings (M16.18).
 *
 * The 15-item header menu had zero UI coverage in any unit or e2e test, and
 * four of Notion's column controls had no equivalent at all: freeze past the
 * name column, fit to content, an inline "+", and a row height — the last of
 * which was parsed and serialized and consumed by NOTHING.
 */
describe('TableView header settings (M16.18)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
  });

  function grid(over: Partial<Presentation> = {}, extraFields: ColumnDef[] = []) {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const onColumnsChange = vi.fn();
    const onPresentationChange = vi.fn();
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Work item')}
        presentation={{ ...presentation, ...over }}
        schema={schema}
        // Through `columnUniverse`, as every page does — it is what tags a def
        // with the type that OWNS it, and the header's schema operations write
        // to that type rather than to the view's source (M20.2).
        fields={[
          ...columnUniverse({ type: 'Work item', project: null }, entries, schema),
          ...extraFields,
        ]}
        sourceType="Work item"
        onColumnsChange={onColumnsChange}
        onPresentationChange={onPresentationChange}
      />,
    );
    return { onColumnsChange, onPresentationChange };
  }

  /**
   * Deleting a property destroys a schema declaration and, with it, the way
   * every record of the type is read. There is no undo in the app — recovery
   * is git. `PropertyMenu` and `PropertyEditor` were given a confirmation;
   * THIS menu has its own `Delete property` item, which called
   * `removeFieldFromType` on the single click, from a surface that already
   * tells you it edits N records. Third call site, same dialog.
   */
  it('does not delete a property until the confirmation is accepted', async () => {
    const user = userEvent.setup();
    const written: string[] = [];
    useVaultStore.setState({
      entries: fixtureVault(),
      patchFrontmatter: vi.fn(async (path: string) => {
        written.push(path);
      }),
    });
    const { onColumnsChange } = grid();
    await user.click(screen.getByLabelText('Status column menu'));
    await user.click(screen.getByRole('menuitem', { name: /Delete property/ }));
    // Nothing written to the type doc, and the column is still in the view.
    expect(written).toEqual([]);
    expect(onColumnsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('backing out of the confirmation leaves the property alone', async () => {
    const user = userEvent.setup();
    const { onColumnsChange } = grid();
    await user.click(screen.getByLabelText('Status column menu'));
    await user.click(screen.getByRole('menuitem', { name: /Delete property/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onColumnsChange).not.toHaveBeenCalled();
  });

  it('freezes up to a column, not just the name one', async () => {
    const user = userEvent.setup();
    const { onPresentationChange } = grid();
    await user.click(screen.getByLabelText('Priority column menu'));
    await user.click(screen.getByRole('menuitem', { name: /Freeze up to this column/ }));
    // Priority is display slot 3 (name, status, priority), so freezing
    // through it pins three columns.
    expect(onPresentationChange.mock.calls[0][0].frozenColumns).toBe(3);
  });

  it('unfreezing a frozen column leaves the ones before it pinned', async () => {
    const user = userEvent.setup();
    const { onPresentationChange } = grid({ frozenColumns: 3 });
    await user.click(screen.getByLabelText('Priority column menu'));
    await user.click(screen.getByRole('menuitem', { name: /Unfreeze up to here/ }));
    expect(onPresentationChange.mock.calls[0][0].frozenColumns).toBe(2);
  });

  it('the name column can be unfrozen from its own menu', async () => {
    const user = userEvent.setup();
    const { onPresentationChange } = grid();
    await user.click(screen.getByLabelText('Name column menu'));
    await user.click(screen.getByRole('menuitem', { name: /Unfreeze up to here/ }));
    expect(onPresentationChange.mock.calls[0][0].frozenColumns).toBe(0);
  });

  it('offers the hidden columns behind the header "+"', async () => {
    const user = userEvent.setup();
    const { onColumnsChange } = grid({
      columns: [{ field: 'status' }, { field: 'priority', hidden: true }],
    });
    await user.click(screen.getByTestId('add-column'));
    await user.click(screen.getByTestId('show-column-priority'));
    // `hiddenColumns` has been exported since M9.2 with no call site; this is
    // it, and re-showing keeps the column's slot rather than appending it.
    expect(onColumnsChange.mock.calls[0][0]).toEqual([
      { field: 'status' },
      { field: 'priority', hidden: false },
    ]);
  });

  // M19.4: the "+" used to open a menu whose only creation command was "New
  // property", which opened this panel — a click spent on an indirection,
  // while the detail panel's own "+ Add property" had always gone straight to
  // the same surface.
  it('the "+" opens the property panel itself, not a menu that opens it', async () => {
    const user = userEvent.setup();
    grid();
    await user.click(screen.getByTestId('add-column'));
    expect(screen.getByTestId('add-property-panel')).toBeTruthy();
    expect(screen.queryByTestId('add-column-new')).toBeNull();
    expect(screen.getByLabelText('Property name')).toBeTruthy();
  });

  it('a typeless view can only re-show, because it has no schema to declare on', async () => {
    const user = userEvent.setup();
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Work item')}
        presentation={{
          ...presentation,
          columns: [{ field: 'status' }, { field: 'priority', hidden: true }],
        }}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
        onColumnsChange={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId('add-column'));
    expect(screen.queryByTestId('add-property-panel')).toBeNull();
    expect(screen.getByTestId('show-column-priority')).toBeTruthy();
  });

  it('defaults its rows to the default height', () => {
    grid();
    expect(screen.getAllByTestId('table-row')[0].className).toContain('h-9');
  });

  it('renders the stored row height instead of ignoring it', () => {
    grid({ rowHeight: 'compact' });
    expect(screen.getAllByTestId('table-row')[0].className).toContain('h-8');
  });

  /**
   * Row height and "Wrap all columns" left this menu in M16.29. They are
   * settings for the WHOLE table and this was the only place either could be
   * reached — a menu whose every other item acts on the name column, and which
   * no other column's header carries, so someone hunting for row height opened
   * Priority's menu and found nothing. They live in view settings › Rows now
   * (see ViewSettingsPanel.test.tsx), and offering them in both places would
   * be the same duplication that gave "Card size" two homes.
   */
  it('keeps whole-table settings out of the name column’s menu', async () => {
    const user = userEvent.setup();
    grid();
    await user.click(screen.getByLabelText('Name column menu'));
    expect(screen.queryByTestId('row-height')).toBeNull();
    expect(screen.queryByTestId('wrap-all')).toBeNull();
    // What IS the name column's business stays.
    expect(screen.getByRole('menuitem', { name: /Sort ascending/ })).toBeTruthy();
  });

  /** Per-COLUMN wrapping is a column's own business and stays on its menu. */
  it('still wraps one column from that column’s menu', async () => {
    const user = userEvent.setup();
    const { onColumnsChange } = grid({
      columns: [{ field: 'status' }, { field: 'priority' }],
    });
    await user.click(screen.getByLabelText('Status column menu'));
    await user.click(screen.getByRole('menuitem', { name: /Wrap content/ }));
    expect(onColumnsChange.mock.calls[0][0]).toEqual([
      { field: 'status', wrap: true },
      { field: 'priority' },
    ]);
  });

  it('marks every sort key, not only the first', () => {
    grid({
      sort: [
        { field: 'status', dir: 'asc' },
        { field: 'priority', dir: 'desc' },
      ],
    });
    // The second key used to render nothing at all, so a two-key sort looked
    // like a one-key sort with a mysterious order.
    expect(screen.getByTestId('sort-mark-status').textContent).toBe('1');
    expect(screen.getByTestId('sort-mark-priority').textContent).toBe('2');
  });

  it('offers fit-to-content from the column menu and the divider', async () => {
    const user = userEvent.setup();
    const { onColumnsChange } = grid();
    await user.click(screen.getByLabelText('Status column menu'));
    await user.click(screen.getByRole('menuitem', { name: 'Fit to content' }));
    // jsdom reports every scrollWidth as 0, and an unmeasurable grid is not a
    // reason to slam the column to its minimum — so this writes nothing.
    expect(onColumnsChange).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByLabelText('Resize Status column'));
    expect(onColumnsChange).not.toHaveBeenCalled();
  });
});

/**
 * The name cell and the whole-cell hit target (M19.2, M19.3).
 *
 * The affordance used to be inverted: the title WAS the opener, so the name
 * was the one cell in the grid that could not be edited, and the `maximize-2`
 * glyph beside it was `aria-hidden` decoration that answered no click at all.
 * Every other cell had the mirror-image problem — its editor was a button
 * sized to its value, so most of the column answered no click either, and the
 * part that did painted an inset hover box that read as a floating pill.
 */
describe('TableView name cell and cell hit target (M19.2, M19.3)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ detailPath: null });
  });

  it('the name is an editable cell, and the pill is what opens the record', async () => {
    const user = userEvent.setup();
    const { items } = setup();
    const item = items[0];

    await user.click(screen.getByRole('button', { name: item.title }));
    // Clicking the name edits it in place — it does not navigate.
    expect(screen.getByLabelText('Title')).toBeTruthy();
    expect(useUiStore.getState().detailPath).toBeNull();

    await user.keyboard('{Escape}');
    await user.click(screen.getByLabelText(`Open ${item.title}`));
    expect(useUiStore.getState().detailPath).toBe(item.path);
  });

  it('commits a renamed title through the store, which never throws', async () => {
    const user = userEvent.setup();
    const setTitle = vi.fn().mockResolvedValue(true);
    useVaultStore.setState({ setTitle });
    const { items } = setup();

    await user.click(screen.getByRole('button', { name: items[0].title }));
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Renamed in place');
    await user.keyboard('{Enter}');

    expect(setTitle).toHaveBeenCalledWith(items[0].path, 'Renamed in place');
  });

  it('Escape discards the draft rather than writing it', async () => {
    const user = userEvent.setup();
    const setTitle = vi.fn().mockResolvedValue(true);
    useVaultStore.setState({ setTitle });
    const { items } = setup();

    await user.click(screen.getByRole('button', { name: items[0].title }));
    await user.type(screen.getByLabelText('Title'), ' and more');
    await user.keyboard('{Escape}');

    expect(setTitle).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Title')).toBeNull();
  });

  it('the open affordance is a real focusable control, not a hidden glyph', () => {
    const { items } = setup();
    const pill = screen.getAllByTestId('row-open-affordance')[0];
    // The M15 defect this must not recreate: an opener that CSS keeps out of
    // hit-testing is an opener no keyboard user can reach. `cb-row-open` fades
    // with opacity for exactly this reason.
    expect(pill.className).toContain('cb-row-open');
    expect(pill.getAttribute('aria-label')).toBe(`Open ${items[0].title}`);
    pill.focus();
    expect(document.activeElement).toBe(pill);
  });

  /**
   * A table over a type declaring the two kinds whose cells hold a control
   * that must NOT be what a gesture on the CELL activates. Declared locally
   * rather than in `fixtureVault`, whose field list eight other tests assert
   * exactly.
   */
  function riskyKinds(properties: Entry['properties']) {
    const base = fixtureVault();
    const entries = base.map((e) =>
      e.path === 'types/work-item.md'
        ? {
            ...e,
            properties: {
              ...e.properties,
              fields: {
                blocked: { kind: 'checkbox' },
                attachments: { kind: 'files' },
              },
            } as unknown as Entry['properties'],
          }
        : e,
    );
    const item = { ...entries.find((e) => e.type === 'Work item')!, properties };
    const schema = buildSchema(entries);
    useVaultStore.setState({ entries });
    render(
      <TableView
        entries={[item]}
        presentation={{
          ...presentation,
          columns: [{ field: 'blocked' }, { field: 'attachments' }],
        }}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
      />,
    );
  }

  // The forwarder resolves the cell's PRIMARY control, not the first focusable
  // in DOM order. A files chip renders `Remove <file>` before `+ Add`, so
  // resolving by DOM order made a click on the cell's padding — and Enter,
  // which had the same bug before this — delete an attachment.
  it('a click on a files cell never reaches the chip’s Remove button', async () => {
    const user = userEvent.setup();
    riskyKinds({ attachments: ['notes/spec.pdf'] });
    const remove = screen.getByLabelText('Remove notes/spec.pdf');
    const removed = vi.fn();
    remove.addEventListener('click', removed);

    const cell = screen
      .getAllByRole('gridcell')
      .find((c) => c.querySelector('[aria-label^="Remove "]') !== null)!;
    await user.click(cell);

    expect(removed).not.toHaveBeenCalled();
  });

  // Switch is a <label> around a hidden input, so the browser fires its OWN
  // click on that input after the one that bubbled up here. Forwarding as well
  // wrote true and then false — two disk writes ending where they started, so
  // the checkbox looked inert.
  it('a checkbox cell toggles once per click, not twice', async () => {
    const user = userEvent.setup();
    riskyKinds({ blocked: false });
    // `role="switch"`, not `checkbox` — the row gutter's select box is the
    // only thing in this grid with the checkbox role.
    const box = screen.getByRole('switch');
    const toggles = vi.fn();
    box.addEventListener('click', toggles);

    await user.click(box.closest('label')!);
    expect(toggles).toHaveBeenCalledTimes(1);
  });

  it('a click on the cell padding reaches the editor, and only once', async () => {
    const user = userEvent.setup();
    setup();
    const cell = screen
      .getAllByRole('gridcell')
      .find((c) => c.querySelector('.cb-cell-chrome button') !== null);
    expect(cell).toBeTruthy();
    const trigger = cell!.querySelector<HTMLButtonElement>('.cb-cell-chrome button')!;
    const clicks = vi.fn();
    trigger.addEventListener('click', clicks);

    // The cell itself, not the button inside it — the padding and the unused
    // width of the column used to answer nothing.
    await user.click(cell!);
    expect(clicks).toHaveBeenCalledTimes(1);

    // And a click that already landed on the control is not forwarded again.
    clicks.mockClear();
    await user.click(trigger);
    expect(clicks).toHaveBeenCalledTimes(1);
  });
});

/**
 * Relation chips (M11).
 *
 * A related record is a chip, not an arrow glyph followed by a title. Whether
 * the chip also carries the target type's icon is a per-view setting, because
 * it is a question about this table's density rather than about the data.
 */
describe('TableView relation chips (M11)', () => {
  const OBJECTIVE = 'records/objectives/grow-eu.md';

  function withRelation(chips?: 'plain' | 'type-icon') {
    const entries: Entry[] = [
      ...fixtureVault(),
      makeEntry({
        path: 'types/objective.md',
        title: 'Objective',
        type: 'Type',
        properties: { icon: 'target', color: '#3D8BE8' } as Entry['properties'],
      }),
      makeEntry({
        path: 'types/bet.md',
        title: 'Bet',
        type: 'Type',
        properties: {
          fields: { objective: { kind: 'relation', target: 'Objective' } },
        } as unknown as Entry['properties'],
      }),
      makeEntry({ path: OBJECTIVE, title: 'Grow EU revenue', type: 'Objective' }),
      makeEntry({
        path: 'records/bets/eu-push.md',
        title: 'EU push',
        type: 'Bet',
        relationships: { objective: ['grow-eu'] },
      }),
    ];
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Bet')}
        presentation={{
          type: 'table',
          group: [],
          sort: [],
          columns: [{ field: 'objective' }],
          ...(chips === undefined ? {} : { chips }),
        }}
        schema={schema}
        fields={schema.types.get('Bet')?.fields ?? []}
      />,
    );
  }

  it('renders the linked record as a chip carrying its title', () => {
    withRelation();
    const chip = screen.getByTestId('relation-chip');
    expect(chip.textContent).toBe('Grow EU revenue');
    // The arrow glyph is gone: the chip shape already says "this is a link",
    // and in a narrow cell the icon cost a fifth of the width.
    expect(chip.querySelector('svg')).toBeNull();
  });

  it('carries the target type’s icon when the view asks for it', () => {
    withRelation('type-icon');
    const chip = screen.getByTestId('relation-chip');
    expect(chip.textContent).toBe('Grow EU revenue');
    expect(chip.querySelector('svg')).not.toBeNull();
  });

  it('defaults to plain chips', () => {
    withRelation(undefined);
    expect(screen.getByTestId('relation-chip').querySelector('svg')).toBeNull();
  });
});

/**
 * A grid holding rows of more than one type (M20.1).
 *
 * The grouping chain can DESCEND a relation (M10 nesting), which puts records
 * of foreign types in one grid — the demo vault's OKR tree holds Objectives
 * with Key results and Work items nested beneath them. `buildRows` builds rows
 * from the source type plus every relation the chain descends into;
 * `columnUniverse` builds columns from the source type ALONE. Everything below
 * comes from that mismatch.
 */
describe('TableView nested rows of a foreign type (M20.1)', () => {
  function okrGrid() {
    const entries = [
      makeEntry({
        path: 'types/objective.md',
        title: 'Objective',
        type: 'Type',
        properties: {
          fields: {
            owner: { kind: 'person' },
            progress: { kind: 'number', format: 'progress' },
          },
        } as unknown as Entry['properties'],
      }),
      makeEntry({
        path: 'types/key-result.md',
        title: 'Key result',
        type: 'Type',
        // Deliberately declares NEITHER owner NOR progress: it has its own
        // `lead`, which the Objective-sourced grid has no column for.
        properties: {
          fields: { lead: { kind: 'person' }, objective: { kind: 'relation' } },
        } as unknown as Entry['properties'],
      }),
      makeEntry({ path: 'types/person.md', title: 'Person', type: 'Type' }),
      makeEntry({ path: 'people/ana-rios.md', title: 'Ana Rios', type: 'Person' }),
      makeEntry({
        path: 'records/objectives/o1.md',
        title: 'Grow EU revenue',
        type: 'Objective',
        properties: { progress: 40 },
      }),
      makeEntry({
        path: 'records/key-results/kr1.md',
        title: 'Signups up 20%',
        type: 'Key result',
        relationships: { objective: ['Grow EU revenue'] },
      }),
    ];
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    const objectives = entries.filter((e) => e.type === 'Objective');
    render(
      <TableView
        entries={objectives}
        allEntries={entries}
        presentation={{
          ...presentation,
          group: [
            {
              field: 'objective',
              descend: { direction: 'reverse', type: 'Key result', field: 'objective' },
            },
          ],
          columns: [{ field: 'owner' }, { field: 'progress' }],
        }}
        schema={schema}
        fields={schema.types.get('Objective')?.fields ?? []}
        onCreate={vi.fn().mockResolvedValue(true)}
      />,
    );
    const rows = screen.getAllByTestId('table-row');
    return {
      parent: rows.find((r) => r.getAttribute('data-depth') === '0')!,
      child: rows.find((r) => r.getAttribute('data-depth') === '1')!,
    };
  }

  const cell = (row: HTMLElement, colIndex: string) =>
    row.querySelector<HTMLElement>(`[role="gridcell"][aria-colindex="${colIndex}"]`)!;

  /**
   * The hole, exactly. `validatePatch` looks a field up on the record's own
   * type, so grafting a parent's SELECT onto a child's number field of the
   * same name was already refused. What sailed through was the case with no
   * def to validate against at all — undeclared keys are legal by design — so
   * picking a person in the Objective's Owner column wrote `owner: [[…]]` onto
   * a Key result that has never heard of `owner`.
   */
  it('a nested row of another type offers no editor in a column it does not declare', async () => {
    const user = userEvent.setup();
    const { parent, child } = okrGrid();

    // The parent owns Owner and is editable in it.
    await user.click(cell(parent, '2'));
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    await user.keyboard('{Escape}');

    // The child does not, so there is nothing to click into.
    await user.click(cell(child, '2'));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(cell(child, '2').querySelector('button')).toBeNull();
  });

  // The neighbouring read-only kinds show an em-dash for the same absence, so
  // an empty grey track on every nested row was two read-only branches
  // contradicting each other about what "no value" looks like.
  it('draws no progress bar for a row with no such property', () => {
    const { parent, child } = okrGrid();
    expect(cell(parent, '3').textContent).toContain('40');
    expect(cell(child, '3').textContent).toBe('—');
  });

  /**
   * `onCreate` is bound to the SURFACE's type, so "insert a record after this
   * one" on a nested Key result created an Objective — the wrong type, in the
   * wrong folder, at depth 0. Creating the type at that depth has to link the
   * new record back through the relation that produced the level, which for a
   * forward descent the child cannot express at all; until that exists,
   * offering nothing beats offering the wrong thing.
   */
  it('offers no insert affordance on a nested row', () => {
    const { parent, child } = okrGrid();
    expect(parent.querySelector('[data-testid="row-insert"]')).not.toBeNull();
    expect(child.querySelector('[data-testid="row-insert"]')).toBeNull();
  });
});

/**
 * The nesting model (M20.2): the grid's columns come from its CHAIN, and each
 * cell renders by its OWN row's declaration.
 */
describe('TableView union columns across the chain (M20.2)', () => {
  function chainGrid(columns: { field: string }[]) {
    const entries = [
      makeEntry({
        path: 'types/objective.md',
        title: 'Objective',
        type: 'Type',
        properties: {
          fields: { owner: { kind: 'person' }, size: { kind: 'number' } },
        } as unknown as Entry['properties'],
      }),
      makeEntry({
        path: 'types/key-result.md',
        title: 'Key result',
        type: 'Type',
        properties: {
          fields: {
            objective: { kind: 'relation', target: 'Objective' },
            // Same NAME as Objective's, a different KIND — what `heterogeneous`
            // marks, and what used to take the whole column read-only.
            size: { kind: 'select', options: [{ id: 's' }, { id: 'l' }] },
          },
        } as unknown as Entry['properties'],
      }),
      makeEntry({ path: 'types/person.md', title: 'Person', type: 'Type' }),
      makeEntry({
        path: 'records/objectives/o1.md',
        title: 'Grow EU revenue',
        type: 'Objective',
        properties: { size: 3 },
      }),
      makeEntry({
        path: 'records/key-results/kr1.md',
        title: 'Signups up 20%',
        type: 'Key result',
        properties: { size: 'l' },
        relationships: { objective: ['Grow EU revenue'] },
      }),
    ];
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    const group = [
      {
        field: 'objective',
        descend: { direction: 'reverse' as const, type: 'Key result', field: 'objective' },
      },
    ];
    const fields = columnUniverse({ type: 'Objective', project: null }, entries, schema, group);
    render(
      <TableView
        entries={entries.filter((e) => e.type === 'Objective')}
        allEntries={entries}
        presentation={{ ...presentation, group, columns }}
        schema={schema}
        fields={fields}
        sourceType="Objective"
        onColumnsChange={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId('table-row');
    return {
      fields,
      parent: rows.find((r) => r.getAttribute('data-depth') === '0')!,
      child: rows.find((r) => r.getAttribute('data-depth') === '1')!,
    };
  }

  // The Phase 1 fix made a child blank in a column it does not declare. This
  // is the other half: the columns it DOES declare now exist to be blank in.
  it('the descended type’s own properties are available as columns', () => {
    const { fields } = chainGrid([{ field: 'size' }]);
    expect(fields.map((f) => f.name)).toContain('objective');
    expect(fields.find((f) => f.name === 'objective')?.owners).toEqual(['Key result']);
  });

  /**
   * The header shows one kind and the cells disagree with it, correctly.
   * Rendering every row through the COLUMN's def gave the Key result a number
   * input for a select — the wrong editor over the wrong value — which is what
   * `heterogeneous` used to suppress by taking the column read-only for
   * everyone, including the rows that were right.
   */
  it('each row renders its own type’s declaration of a shared name', async () => {
    const user = userEvent.setup();
    const { parent, child } = chainGrid([{ field: 'size' }]);
    const cell = (row: HTMLElement) =>
      row.querySelector<HTMLElement>('[role="gridcell"][aria-colindex="2"]')!;

    // Objective's `size` is a number: its editor is a textbox.
    await user.click(cell(parent));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(cell(parent).querySelector('input')).not.toBeNull();

    // Key result's is a select: its editor is an option list, and it is not
    // read-only the way the old heterogeneous guard would have left it.
    await user.click(cell(child));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['S', 'L']);
  });
});
