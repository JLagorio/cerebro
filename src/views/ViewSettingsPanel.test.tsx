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

function setup(presentation: Partial<Presentation> = {}) {
  const onChange = vi.fn();
  render(
    <ViewSettingsPanel
      list={listWith(presentation)}
      viewId="grid"
      fields={fields}
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
