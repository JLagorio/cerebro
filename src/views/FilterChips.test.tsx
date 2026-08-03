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
  // "Doing", not "doing", and "Sep 1, 2026", not "2026-09-01": M16.29 made the
  // chip read the option's LABEL and the field's date format. Stating the rule
  // in words is the whole job of a chip, and neither a slug nor a storage
  // spelling is one.
  it('states each rule in words', () => {
    render(<FilterChips filters={twoRules} fields={fields} onChange={vi.fn()} />);
    expect(screen.getByTestId('filter-chip-0').textContent).toContain('Status is Doing');
    expect(screen.getByTestId('filter-chip-1').textContent).toContain('Due is before Sep 1, 2026');
  });

  it('removes exactly the rule whose X was pressed', () => {
    const onChange = vi.fn();
    render(<FilterChips filters={twoRules} fields={fields} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Remove filter: Status is Doing'));
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
 * M16.29, reproduced live on the demo vault's "At risk" list: the top-level
 * chip "Priority is any of" opened a proper multi-select showing Urgent /
 * High, while the `2 conditions` group beside it rendered its two Status
 * conditions as plain text inputs holding the raw ids `progress` and `review`.
 *
 * It read as a nesting bug and is not one — both paths render the same
 * `FilterRuleRow` from the same `fields` array. The difference was the KIND:
 * `priority` is a `select` that declares its own `options:`, while `status`
 * declares none, because a status field's option set is the TYPE's
 * `statuses:`. The seam is where view context enters the chip bar, so the
 * resolution happens there, once, for every row below it.
 */
describe('a status condition gets the same picker at any depth (M16.29)', () => {
  // Exactly the demo vault's shape: `status` carries no options of its own.
  const atRisk: ColumnDef[] = [
    {
      name: 'priority',
      kind: 'select',
      options: [
        { id: 'urgent', label: 'Urgent', color: '#DE3B4E' },
        { id: 'high', label: 'High', color: '#DE8F0A' },
      ],
    },
    { name: 'status', kind: 'status' },
  ];
  const statuses = [
    { id: 'progress', label: 'In progress', color: '#DE8F0A', group: 'active' as const },
    { id: 'review', label: 'Review', color: '#38BDF8', group: 'active' as const },
  ];
  const nested: FilterGroup = {
    all: [
      { field: 'priority', op: 'any_of', value: ['urgent', 'high'] },
      {
        any: [
          { field: 'status', op: 'equals', value: 'progress' },
          { field: 'status', op: 'equals', value: 'review' },
        ],
      },
    ],
  };

  /** The picker is a listbox trigger whose text is the LABEL; the text box it
   * replaced had no text content at all, only a raw-id `value`. */
  const valueControls = () => screen.getAllByLabelText('Filter value');

  it('renders a picker showing the option label inside a nested group', () => {
    render(<FilterChips filters={nested} fields={atRisk} statuses={statuses} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('filter-chip-1'));
    const [first, second] = valueControls();
    expect(first.getAttribute('aria-haspopup')).toBe('listbox');
    expect(first.textContent).toContain('In progress');
    expect(second.textContent).toContain('Review');
  });

  it('renders the identical control at the top level', () => {
    render(
      <FilterChips
        filters={{ all: [{ field: 'status', op: 'equals', value: 'review' }] }}
        fields={atRisk}
        statuses={statuses}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('filter-chip-0'));
    expect(valueControls()[0].getAttribute('aria-haspopup')).toBe('listbox');
    expect(valueControls()[0].textContent).toContain('Review');
  });

  /** The chip said "Status is progress" — the slug, in the one place meant to
   * state the rule in words. */
  it('states the rule with option labels, not slugs', () => {
    render(<FilterChips filters={nested} fields={atRisk} statuses={statuses} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('filter-chip-1'));
    const rows = screen.getAllByTestId('filter-rule');
    expect(rows).toHaveLength(2);
    render(
      <FilterChips
        filters={{ all: [{ field: 'status', op: 'equals', value: 'progress' }] }}
        fields={atRisk}
        statuses={statuses}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('filter-chip-0')[1].textContent).toContain(
      'Status is In progress',
    );
  });

  it('names the chosen options on a multi-value chip', () => {
    render(<FilterChips filters={nested} fields={atRisk} statuses={statuses} onChange={vi.fn()} />);
    expect(screen.getByTestId('filter-chip-0').textContent).toContain(
      'Priority is any of Urgent, High',
    );
  });

  /** A view with no source type has no one status set; the text box stays,
   * rather than a picker offering another type's statuses. */
  it('falls back to the text box when no status set is available', () => {
    render(
      <FilterChips
        filters={{ all: [{ field: 'status', op: 'equals', value: 'progress' }] }}
        fields={atRisk}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('filter-chip-0'));
    expect(screen.getByLabelText('Filter value').getAttribute('aria-haspopup')).toBeNull();
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

/**
 * Escape closes ONE surface (M16.34).
 *
 * A live pass found that inside a nested group, one Escape closed both the
 * value listbox and the group popover holding it — while the top-level chip,
 * whose structure looks identical, behaved correctly. The layer stack exists
 * precisely so a keystroke cannot reach past the surface on top of it.
 */
describe('Escape unwinds one layer at a time', () => {
  const fields: ColumnDef[] = [
    { name: 'status', kind: 'status' },
    { name: 'priority', kind: 'select', options: [{ id: 'high', label: 'High', color: null }] },
  ];
  const statuses = [
    { id: 'progress', label: 'In progress', color: '#DE8F0A', group: 'active' as const },
  ];
  const nested: FilterGroup = {
    all: [
      { field: 'priority', op: 'any_of', value: ['high'] },
      { any: [{ field: 'status', op: 'equals', value: 'progress' }] },
    ],
  };

  const escape = () =>
    fireEvent.keyDown(window, { key: 'Escape', bubbles: true, cancelable: true });

  it('leaves a nested group open when its value picker takes the key', () => {
    render(<FilterChips filters={nested} fields={fields} statuses={statuses} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('filter-chip-1'));
    expect(screen.getByRole('dialog', { name: 'Edit filter' })).toBeTruthy();

    fireEvent.click(screen.getAllByLabelText('Filter value')[0]);
    expect(screen.getByRole('listbox')).toBeTruthy();

    escape();
    expect(screen.queryByRole('listbox')).toBeNull();
    // The group must survive: it is the layer underneath, not the one on top.
    expect(screen.queryByRole('dialog', { name: 'Edit filter' })).toBeTruthy();
  });

  it('does the same at the top level', () => {
    const flat: FilterGroup = { all: [{ field: 'status', op: 'equals', value: 'progress' }] };
    render(<FilterChips filters={flat} fields={fields} statuses={statuses} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('filter-chip-0'));
    fireEvent.click(screen.getAllByLabelText('Filter value')[0]);
    expect(screen.getByRole('listbox')).toBeTruthy();

    escape();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Edit filter' })).toBeTruthy();
  });
});
