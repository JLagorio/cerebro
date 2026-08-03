import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TableView } from '@/views/TableView';
import { buildSchema } from '@/engine/schema';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';
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
 * The calculation footer (M16.15).
 *
 * There was no footer element at all and no aggregate module in the engine, so
 * the single most-used question about a column of numbers — what do they add
 * up to — could not be asked anywhere in the app.
 */
describe('TableView calculation footer (M16.15)', () => {
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

  it('shows a footer cell per column, blank until one is configured', () => {
    footer([{ field: 'status' }, { field: 'priority' }]);
    expect(screen.getByTestId('table-footer')).toBeTruthy();
    // Notion's resting state: the offer is there, the number is not. A table
    // that volunteers nine totals nobody asked for is noise.
    expect(screen.getByTestId('calc-status').textContent).toBe('Calculate');
  });

  it('computes the configured calculation over the rows on screen', () => {
    const { onColumnsChange } = footer([{ field: 'status', calc: 'count_all' }]);
    const items = fixtureVault().filter((e) => e.type === 'Work item');
    expect(screen.getByTestId('calc-status').textContent).toContain(String(items.length));
    expect(onColumnsChange).not.toHaveBeenCalled();
  });

  it('persists the choice to the column, not to component state', async () => {
    const user = userEvent.setup();
    const { onColumnsChange } = footer([{ field: 'status' }]);
    await user.click(screen.getByTestId('calc-status'));
    await user.click(screen.getByTestId('calc-option-count_empty'));
    expect(onColumnsChange.mock.calls[0][0]).toContainEqual({
      field: 'status',
      calc: 'count_empty',
    });
  });

  it('None clears the key rather than storing a "none" calculation', async () => {
    const user = userEvent.setup();
    const { onColumnsChange } = footer([{ field: 'status', calc: 'count_all' }]);
    await user.click(screen.getByTestId('calc-status'));
    await user.click(screen.getByTestId('calc-option-none'));
    expect(onColumnsChange.mock.calls[0][0]).toEqual([{ field: 'status' }]);
  });

  it('offers Sum on a number column and withholds it from a select', async () => {
    const user = userEvent.setup();
    footer([{ field: 'estimate' }, { field: 'status' }]);
    await user.click(screen.getByTestId('calc-estimate'));
    expect(screen.queryByTestId('calc-option-sum')).not.toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId('calc-status'));
    // Capability-gated on the KIND, so a status column cannot be asked for a
    // total it has no numbers to produce.
    expect(screen.queryByTestId('calc-option-sum')).toBeNull();
  });

  it('the name column calculates too, and writes to the presentation', async () => {
    const user = userEvent.setup();
    const { onPresentationChange } = footer([{ field: 'status' }]);
    await user.click(screen.getByTestId('calc-title'));
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
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Work item')?.fields ?? []}
      />,
    );
    expect(screen.queryByTestId('table-footer')).toBeNull();
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
