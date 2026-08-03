// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@/engine/columns';
import type { FilterGroup, FilterRule } from '@/engine/types';
import { FilterChips, countRules } from './FilterChips';

afterEach(cleanup);

const fields: ColumnDef[] = [
  {
    name: 'status',
    kind: 'select',
    options: [
      { id: 'doing', label: 'Doing', color: null },
      { id: 'done', label: 'Done', color: null },
    ],
  },
  { name: 'due', kind: 'date' },
];

const twoRules: FilterGroup = {
  all: [
    { field: 'status', op: 'equals', value: 'doing' },
    { field: 'due', op: 'before', value: '2026-09-01' },
  ],
};

/**
 * The chip bar was per-AXIS, not per-rule (`ViewToolbar.tsx:246-339`): one
 * `Filter 3` pill whose only affordance was to open the whole builder. You
 * could not see WHICH three conditions a view carried, and you could not drop
 * one without hunting for it inside the popover — so an inherited view was
 * filtered in ways it took a click to discover.
 */
describe('FilterChips shows one chip per rule (M16.25)', () => {
  it('states each rule in words', () => {
    render(<FilterChips filters={twoRules} fields={fields} onChange={vi.fn()} />);
    expect(screen.getByTestId('filter-chip-0').textContent).toContain('Status is doing');
    expect(screen.getByTestId('filter-chip-1').textContent).toContain('Due is before 2026-09-01');
  });

  it('removes exactly the rule whose X was pressed', () => {
    const onChange = vi.fn();
    render(<FilterChips filters={twoRules} fields={fields} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Remove filter: Status is doing'));
    const next = onChange.mock.calls[0][0] as FilterGroup;
    expect((next as { all: FilterRule[] }).all).toEqual([
      { field: 'due', op: 'before', value: '2026-09-01' },
    ]);
  });

  /**
   * Removing the last rule must leave `null`, not `{ all: [] }` — the view
   * would otherwise persist an empty group and keep reporting itself as
   * filtered in the header and in every empty state.
   */
  it('the last rule removed leaves no filters at all', () => {
    const onChange = vi.fn();
    render(
      <FilterChips
        filters={{ all: [{ field: 'status', op: 'is_empty' }] }}
        fields={fields}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Remove filter: Status is empty'));
    expect(onChange.mock.calls[0][0]).toBeNull();
  });

  it('a chip opens that one rule for editing', () => {
    render(<FilterChips filters={twoRules} fields={fields} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('filter-chip-1'));
    expect(screen.getAllByTestId('filter-rule')).toHaveLength(1);
    expect(screen.getByLabelText('Filter property')).toBeTruthy();
  });

  it('adding a filter seeds a rule that excludes nothing', () => {
    const onChange = vi.fn();
    render(<FilterChips filters={null} fields={fields} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('filter-add'));
    const next = onChange.mock.calls[0][0] as { all: FilterRule[] };
    expect(next.all[0].op).toBe('is_not_empty');
  });

  /**
   * With one condition, "and" and "or" mean the same thing. A control whose
   * two states are indistinguishable teaches that it does nothing.
   */
  it('the and/or toggle appears only once there are two conditions to join', () => {
    const { unmount } = render(
      <FilterChips
        filters={{ all: [{ field: 'status', op: 'is_empty' }] }}
        fields={fields}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('filter-conjunction')).toBeNull();
    unmount();
    render(<FilterChips filters={twoRules} fields={fields} onChange={vi.fn()} />);
    expect(screen.getByTestId('filter-conjunction')).toBeTruthy();
  });

  it('the and/or toggle flips the group without dropping its rules', () => {
    const onChange = vi.fn();
    render(<FilterChips filters={twoRules} fields={fields} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('filter-conjunction'));
    const next = onChange.mock.calls[0][0] as FilterGroup;
    expect('any' in next).toBe(true);
    expect(countRules(next)).toBe(2);
  });

  /**
   * Nested AND/OR groups are the one place this app is ahead of Notion, which
   * allows one level. A chip bar that could only render leaves would have made
   * them invisible — and therefore uneditable — from the toolbar.
   */
  it('a nested group is one chip that counts its conditions', () => {
    render(
      <FilterChips
        filters={{
          all: [
            { field: 'status', op: 'is_empty' },
            {
              any: [
                { field: 'due', op: 'is_empty' },
                { field: 'due', op: 'after', value: 'x' },
              ],
            },
          ],
        }}
        fields={fields}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('filter-chip-1').textContent).toContain('2 conditions');
  });
});

/**
 * `Popover` PORTALS to `document.body`, and the outer surface's outside-press
 * check is `surfaceRef.contains(target)` — so a portalled child is not a
 * descendant of the surface that opened it. Pressing a day in the date picker
 * closed the rule editor it was opened from, unmounting the picker mid-gesture
 * and discarding the click. Verified against the real components, because the
 * bug lived in the composition rather than in either one.
 */
describe('a value picker opened from a chip does not dismiss the chip (M16.25)', () => {
  const dateField: ColumnDef[] = [{ name: 'due', kind: 'date' }];

  it('survives a press inside the date picker', () => {
    render(
      <FilterChips
        filters={{ all: [{ field: 'due', op: 'before', value: '2026-08-01' }] }}
        fields={dateField}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('filter-chip-0'));
    fireEvent.click(screen.getByLabelText('Filter value'));
    const picker = document.querySelector('[aria-label="Filter date"]');
    expect(picker).toBeTruthy();
    fireEvent.pointerDown(picker as Element);
    expect(screen.getAllByTestId('filter-rule')).toHaveLength(1);
  });

  it('survives a press inside the option checklist', () => {
    render(
      <FilterChips
        filters={{ all: [{ field: 'status', op: 'any_of', value: ['doing'] }] }}
        fields={fields}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('filter-chip-0'));
    fireEvent.click(screen.getByLabelText('Filter values'));
    const list = document.querySelector('[role="menu"][aria-label="Filter values"]');
    expect(list).toBeTruthy();
    fireEvent.pointerDown(list as Element);
    expect(screen.getAllByTestId('filter-rule')).toHaveLength(1);
  });

  /** The inner surface still dismisses on its own — it is a real layer, not
   * an inline blob that only the outer close can get rid of. */
  it('a press outside the picker but inside the chip closes only the picker', () => {
    render(
      <FilterChips
        filters={{ all: [{ field: 'due', op: 'before', value: '2026-08-01' }] }}
        fields={dateField}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('filter-chip-0'));
    fireEvent.click(screen.getByLabelText('Filter value'));
    fireEvent.pointerDown(screen.getByLabelText('Filter operator'));
    expect(document.querySelector('[aria-label="Filter date"]')).toBeNull();
    expect(screen.getAllByTestId('filter-rule')).toHaveLength(1);
  });
});
