// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@/engine/columns';
import { buildSchema } from '@/engine/schema';
import type { GroupSpec, ListDefinition, Presentation } from '@/engine/types';
import { MAX_SORT_KEYS } from '@/engine/views';
import { ViewSettingsPanel } from './ViewSettingsPanel';

afterEach(cleanup);

const fields: ColumnDef[] = [
  { name: 'status', kind: 'status' },
  { name: 'priority', kind: 'select' },
  { name: 'due', kind: 'date' },
  { name: 'estimate', kind: 'number' },
];

const listWith = (presentation: Partial<Presentation>): ListDefinition => ({
  name: 'Delivery',
  icon: null,
  color: null,
  order: null,
  source: { type: 'Work item', project: null },
  views: [
    {
      id: 'grid',
      name: 'All work',
      icon: null,
      filters: null,
      presentation: {
        type: 'table',
        group: [],
        sort: [],
        columns: [{ field: 'status' }],
        ...presentation,
      },
    },
  ],
});

function setup(presentation: Partial<Presentation> = {}, extraFields: ColumnDef[] = []) {
  const onChange = vi.fn();
  render(
    <ViewSettingsPanel
      list={listWith(presentation)}
      viewId="grid"
      fields={[...fields, ...extraFields]}
      schema={buildSchema([])}
      onChange={onChange}
      onClose={vi.fn()}
    />,
  );
  const nextPresentation = () =>
    (onChange.mock.calls.at(-1)?.[0] as ListDefinition).views[0].presentation;
  return { onChange, nextPresentation };
}

/**
 * `ViewSettingsPanel` is 1,000 lines and had NO test file — the plan lists it
 * under test debt this milestone must not inherit. These cover the sections
 * M16.26 touched; the rest is still uncovered.
 */
describe('load limit (M16.26)', () => {
  it('starts at All, because every view rendered its records in full', () => {
    setup();
    expect(screen.getByTestId('view-settings-load limit').textContent).toContain('All');
  });

  it('picks a limit', () => {
    const { nextPresentation } = setup();
    fireEvent.click(screen.getByTestId('view-settings-load limit'));
    fireEvent.click(screen.getByTestId('view-limit-25'));
    expect(nextPresentation().limit).toBe(25);
  });

  /**
   * "All" is an ABSENT key, not `limit: 0` or `limit: Infinity` — a view that
   * never wanted a limit must carry nothing about one in its YAML, and the
   * parser drops a non-positive limit anyway.
   */
  it('All clears the key rather than storing a sentinel', () => {
    const { nextPresentation } = setup({ limit: 50 });
    fireEvent.click(screen.getByTestId('view-settings-load limit'));
    fireEvent.click(screen.getByTestId('view-limit-all'));
    expect(nextPresentation().limit).toBeUndefined();
  });
});

/**
 * `hideEmpty` has been honoured by `grouping.ts:140` since M9.1 and NO UI ever
 * set it, so the only way to drop the empty bands a twelve-option select
 * produces was to hand-edit the YAML (M16.26).
 */
describe('hide empty groups (M16.26)', () => {
  const grouped = { group: [{ field: 'status' }] as GroupSpec[] };

  it('offers a toggle per band level', () => {
    setup(grouped);
    fireEvent.click(screen.getByTestId('view-settings-group'));
    expect(screen.getByLabelText('Hide empty status groups')).toBeTruthy();
  });

  it('sets it on the level it belongs to', () => {
    const { nextPresentation } = setup({
      group: [{ field: 'status' }, { field: 'priority' }],
    });
    fireEvent.click(screen.getByTestId('view-settings-group'));
    fireEvent.click(screen.getByLabelText('Hide empty priority groups'));
    expect(nextPresentation().group).toEqual([
      { field: 'status' },
      { field: 'priority', hideEmpty: true },
    ]);
  });

  /**
   * Off is the default, so it is stored as an ABSENT key rather than `false`
   * — the rule every other optional presentation key follows, and what keeps
   * a view that never touched this from growing a line about it.
   */
  it('turning it back off removes the key instead of writing false', () => {
    const { nextPresentation } = setup({ group: [{ field: 'status', hideEmpty: true }] });
    fireEvent.click(screen.getByTestId('view-settings-group'));
    fireEvent.click(screen.getByLabelText('Hide empty status groups'));
    expect(nextPresentation().group).toEqual([{ field: 'status' }]);
  });

  /**
   * A relation level NESTS rather than bands, so it has no groups that could
   * be empty — offering the switch there would be a control that does nothing.
   */
  it('no toggle for a nesting level', () => {
    setup({
      group: [{ field: 'children', descend: { direction: 'forward', field: 'children' } }],
    });
    fireEvent.click(screen.getByTestId('view-settings-group'));
    expect(screen.queryByLabelText(/^Hide empty/)).toBeNull();
  });
});

/**
 * Card settings, gated on the capability each one actually needs (M16.29).
 *
 * The whole card section hung off `showsCards`, which is true for the board
 * AND the gallery — so a gallery offered "Color columns", wrote
 * `colorColumns: true` into its view file, and changed nothing on screen: a
 * gallery has no columns to colour. "Card preview" was the same shape, read
 * only by the board's card. And "Card size" appeared TWICE for both kinds,
 * once in the root panel and once inside Cards, writing two different keys.
 */
describe('card settings (M16.29)', () => {
  const openCards = () => fireEvent.click(screen.getByTestId('view-settings-cards'));

  it('offers Color columns on the board, whose groups ARE columns', () => {
    setup({ type: 'board' });
    openCards();
    expect(screen.getByLabelText('Color columns')).toBeTruthy();
  });

  /** Anywhere in the panel: the dead controls used to sit on the ROOT page,
   * beside the Cards row rather than inside it. */
  const absent = (query: () => unknown) => {
    expect(query()).toBeNull();
    openCards();
    expect(query()).toBeNull();
  };

  it('does not offer Color columns on a gallery, which has no columns', () => {
    setup({ type: 'gallery' });
    absent(() => screen.queryByLabelText('Color columns'));
  });

  it('does not offer Card preview on a gallery, whose card draws no snippet', () => {
    setup({ type: 'gallery' });
    absent(() => screen.queryByText('Card preview'));
  });

  it('does not offer a cover on the board, whose card draws none', () => {
    setup({ type: 'board' }, [{ name: 'artwork', kind: 'files' }]);
    absent(() => screen.queryByText('Card cover'));
    expect(screen.queryByLabelText('Fit media')).toBeNull();
  });

  /** Card size lived in the root panel AND in Cards, writing `cardSize` in one
   * place and `gallery.size` in the other — two controls, two keys, one
   * setting, and only one of them was read by any given layout. */
  it('states card size exactly once, on the Cards page', () => {
    setup({ type: 'gallery' });
    expect(screen.queryByText('Card size')).toBeNull();
    openCards();
    expect(screen.getAllByText('Card size')).toHaveLength(1);
  });

  it('writes one card-size key, whichever card layout set it', () => {
    const { nextPresentation } = setup({ type: 'gallery' });
    openCards();
    fireEvent.change(screen.getByDisplayValue('Medium'), { target: { value: 'large' } });
    expect(nextPresentation().cardSize).toBe('large');
    expect(nextPresentation().gallery).toBeUndefined();
  });

  /** Off is the default, so it is an ABSENT key rather than `false` — the rule
   * every optional presentation key follows. */
  it('deletes colorColumns rather than storing a false when switched back off', () => {
    const { nextPresentation } = setup({ type: 'board', colorColumns: true });
    openCards();
    fireEvent.click(screen.getByLabelText('Color columns'));
    expect(nextPresentation()).not.toHaveProperty('colorColumns');
  });

  it('has no Cards row at all on a layout that draws no cards', () => {
    setup({ type: 'table' });
    expect(screen.queryByTestId('view-settings-cards')).toBeNull();
  });
});

/**
 * The Chart page's footnote named a shape the chart was not drawing (M16.29).
 *
 * "The bars come from the view's grouping" is correct for a bar chart and a
 * lie for the other two thirds of the control right above it: a donut has
 * slices and a line has points. The one sentence explaining where a chart's X
 * axis comes from — which is the Group row, not this page — was the sentence
 * describing the wrong chart.
 */
/**
 * Row height and "Wrap all columns" are settings for the WHOLE table, and the
 * only place either could be reached was the Name column's header menu
 * (M16.29). Not view settings, where every other whole-view setting lives, and
 * not any other column's menu — so a user looking for them opened Priority's
 * menu, found neither, and had no reason to think Name's was different.
 */
describe('row settings (M16.29)', () => {
  const openRows = () => fireEvent.click(screen.getByTestId('view-settings-rows'));

  it('reports the current height on the root row', () => {
    setup({ rowHeight: 'tall' });
    expect(screen.getByTestId('view-settings-rows').textContent).toContain('Tall');
  });

  it('sets the row height', () => {
    const { nextPresentation } = setup();
    openRows();
    fireEvent.click(screen.getByTestId('row-height-compact'));
    expect(nextPresentation().rowHeight).toBe('compact');
  });

  it('wraps every column at once', () => {
    const { nextPresentation } = setup({ columns: [{ field: 'status' }, { field: 'due' }] });
    openRows();
    fireEvent.click(screen.getByLabelText('Wrap all columns'));
    expect(nextPresentation().columns).toEqual([
      { field: 'status', wrap: true },
      { field: 'due', wrap: true },
    ]);
  });

  /** Unwrapping deletes the key rather than storing `wrap: false` per column. */
  it('unwraps them the same way, without leaving a false behind', () => {
    const { nextPresentation } = setup({
      columns: [
        { field: 'status', wrap: true },
        { field: 'due', wrap: true },
      ],
    });
    openRows();
    fireEvent.click(screen.getByLabelText('Wrap all columns'));
    expect(nextPresentation().columns).toEqual([{ field: 'status' }, { field: 'due' }]);
  });

  /** A board has no rows to make taller and no columns to wrap. */
  it('is absent on a layout that draws no table', () => {
    setup({ type: 'board' });
    expect(screen.queryByTestId('view-settings-rows')).toBeNull();
  });
});

describe('chart settings (M16.29)', () => {
  const openChart = () => fireEvent.click(screen.getByTestId('view-settings-chart'));

  it('says bars for a bar chart', () => {
    setup({ type: 'chart', group: [{ field: 'status' }] });
    openChart();
    expect(screen.getByText(/^The bars come from/)).toBeTruthy();
  });

  it('says slices for a donut', () => {
    setup({ type: 'chart', group: [{ field: 'status' }], chart: { kind: 'donut' } });
    openChart();
    expect(screen.getByText(/^The slices come from/)).toBeTruthy();
  });

  it('says points for a line', () => {
    setup({ type: 'chart', group: [{ field: 'status' }], chart: { kind: 'line' } });
    openChart();
    expect(screen.getByText(/^The points come from/)).toBeTruthy();
  });

  /** The ungrouped wording is the same sentence, and drifted the same way. */
  it('names the shape in the ungrouped case too', () => {
    setup({ type: 'chart', group: [], chart: { kind: 'donut' } });
    openChart();
    expect(screen.getByText(/^The slices come from .* this view has none yet/)).toBeTruthy();
  });
});

describe('sort page (M16.26)', () => {
  const twoKeys = {
    sort: [
      { field: 'status', dir: 'asc' as const },
      { field: 'due', dir: 'desc' as const },
    ],
  };

  it('a grip promotes a key from the keyboard', () => {
    const { nextPresentation } = setup(twoKeys);
    fireEvent.click(screen.getByTestId('view-settings-sort'));
    fireEvent.keyDown(screen.getByLabelText(/^Reorder Due/), { key: 'ArrowUp' });
    expect(nextPresentation().sort.map((s) => s.field)).toEqual(['due', 'status']);
  });

  /**
   * This page enforced NO cap while the toolbar's chain builder passed
   * `max={4}`, so the same view accepted a fifth key here and refused it
   * there.
   */
  it('caps the chain at the same number of keys the toolbar does', () => {
    setup({
      sort: Array.from({ length: MAX_SORT_KEYS }, (_, i) => ({
        field: `f${i}`,
        dir: 'asc' as const,
      })),
    });
    fireEvent.click(screen.getByTestId('view-settings-sort'));
    expect(screen.queryByText('Add a sort…')).toBeNull();
    expect(screen.getByText(new RegExp(`${MAX_SORT_KEYS} keys is the maximum`))).toBeTruthy();
  });
});
