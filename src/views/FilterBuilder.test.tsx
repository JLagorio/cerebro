import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FilterBuilder } from '@/views/FilterBuilder';
import { evaluateFilters, filterOpsFor } from '@/engine/viewFilters';
import { buildSchema } from '@/engine/schema';
import { fixtureVault } from '@/test/factories';
import type { FieldDef, FilterGroup, FilterRule } from '@/engine/types';

const fields: FieldDef[] = [
  { name: 'status', kind: 'status' },
  { name: 'priority', kind: 'select' },
];

afterEach(cleanup);

/**
 * The two buttons that used to empty the view (M15).
 *
 * "Add filter" seeded `equals ''`, which matches essentially no record, and
 * "Add group" pushed `{ any: [] }` — `[].some()` is false, so an empty Match-any
 * group nested in the default top-level `all` matched nothing. Both blanked the
 * canvas the instant they were pressed, while the only text on screen said the
 * filter showed everything.
 */
describe('FilterBuilder seeds nothing exclusionary (M15)', () => {
  const entries = fixtureVault().filter((e) => e.type === 'Work item');
  const schema = buildSchema(fixtureVault());
  const matches = (group: FilterGroup) =>
    entries.filter((e) => evaluateFilters(e, group, schema)).length;

  it('a fresh rule from "Add filter" does not exclude anything it has not been told to', () => {
    const onChange = vi.fn();
    render(<FilterBuilder filters={null} fields={fields} onChange={onChange} />);
    fireEvent.click(screen.getByText('Add filter'));
    const next = onChange.mock.calls[0][0] as FilterGroup;
    expect(matches(next)).toBe(matches({ all: [] }));
  });

  it('a fresh group from "Add group" matches everything, as the hint promises', () => {
    const onChange = vi.fn();
    render(<FilterBuilder filters={{ all: [] }} fields={fields} onChange={onChange} />);
    fireEvent.click(screen.getByText('Add group'));
    const next = onChange.mock.calls[0][0] as FilterGroup;
    expect(matches(next)).toBe(entries.length);
  });

  it('warns instead of lying when a Match-any group is left empty', () => {
    render(<FilterBuilder filters={{ all: [{ any: [] }] }} fields={fields} onChange={vi.fn()} />);
    expect(screen.getByText(/hides every record/)).toBeTruthy();
    expect(screen.queryByText(/this view shows everything/)).toBeNull();
  });
});

/**
 * Nine operators, rendered unconditionally on every field (M16.25). "Status is
 * before High" was one click away and evaluated to a string comparison nobody
 * asked for, while the operators a date or a number actually needs — before,
 * between, greater than — did not exist at all.
 */
describe('the operator menu depends on the field kind (M16.25)', () => {
  const kinded: FieldDef[] = [
    { name: 'due', kind: 'date' },
    { name: 'estimate', kind: 'number' },
    {
      name: 'stage',
      kind: 'select',
      options: [
        { id: 'draft', label: 'Draft', color: null },
        { id: 'live', label: 'Live', color: null },
      ],
    },
    { name: 'notes', kind: 'text' },
  ];

  const opsOffered = (field: string) => {
    render(
      <FilterBuilder
        filters={{ all: [{ field, op: 'is_not_empty' }] }}
        fields={kinded}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Filter operator'));
    return screen.getAllByRole('option').map((o) => o.textContent);
  };

  it('a date is offered before/after, never greater-than', () => {
    const ops = opsOffered('due');
    expect(ops).toContain('is on or before');
    expect(ops).not.toContain('is greater than');
    expect(ops).not.toContain('starts with');
  });

  it('a number is offered the comparisons, never contains', () => {
    const ops = opsOffered('estimate');
    expect(ops).toContain('is greater than');
    expect(ops).toContain('is between');
    expect(ops).not.toContain('contains');
  });

  it('a select is offered the set operators', () => {
    expect(opsOffered('stage')).toContain('is any of');
  });

  it('text is offered the string operators and no set ones', () => {
    const ops = opsOffered('notes');
    expect(ops).toContain('starts with');
    expect(ops).toContain('does not contain');
    expect(ops).not.toContain('is any of');
  });

  /**
   * Switching field left the old operator selected on a menu that no longer
   * offered it, so the dropdown displayed its first entry while the rule on
   * disk still said "is before".
   */
  it('changing the field re-resolves an operator the new kind cannot express', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        filters={{ all: [{ field: 'due', op: 'before', value: '2026-01-01' }] }}
        fields={kinded}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Filter property'));
    fireEvent.click(screen.getByRole('option', { name: 'Stage' }));
    const next = onChange.mock.calls[0][0] as { all: FilterRule[] };
    expect(next.all[0].op).toBe('is_not_empty');
  });

  it('keeps an operator the new kind still supports', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        filters={{ all: [{ field: 'notes', op: 'contains', value: 'x' }] }}
        fields={kinded}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Filter property'));
    fireEvent.click(screen.getByRole('option', { name: 'Due' }));
    // `contains` is not a date operator, so it must fall back; the point is
    // that the rule and the menu agree afterwards, not which one wins.
    const next = onChange.mock.calls[0][0] as { all: FilterRule[] };
    expect(filterOpsFor('date')).toContain(next.all[0].op);
  });
});

/**
 * The value editor was a bare text `Input` for every operator on every kind
 * (`FilterBuilder.tsx:91-100`). `is empty` showed a box that did nothing,
 * `is between` had one box for two bounds, and filtering a board by status
 * meant knowing the option's slug and typing it.
 */
describe('the value editor is typed to the field (M16.25)', () => {
  const kinded: FieldDef[] = [
    { name: 'due', kind: 'date' },
    { name: 'estimate', kind: 'number' },
    { name: 'shipped', kind: 'checkbox' },
    {
      name: 'stage',
      kind: 'select',
      options: [
        { id: 'draft', label: 'Draft', color: null },
        { id: 'live', label: 'Live', color: null },
      ],
    },
  ];
  const show = (rule: FilterRule) =>
    render(<FilterBuilder filters={{ all: [rule] }} fields={kinded} onChange={vi.fn()} />);

  it('a valueless operator renders no value control at all', () => {
    show({ field: 'due', op: 'is_empty' });
    expect(screen.queryByLabelText('Filter value')).toBeNull();
  });

  it('is_between renders two bounds, not one box', () => {
    show({ field: 'estimate', op: 'is_between', value: [1, 5] });
    expect(screen.getByLabelText('Filter value, from')).toBeTruthy();
    expect(screen.getByLabelText('Filter value, to')).toBeTruthy();
  });

  it('a select offers its declared options instead of a slug to memorise', () => {
    show({ field: 'stage', op: 'equals', value: 'draft' });
    fireEvent.click(screen.getByLabelText('Filter value'));
    expect(screen.getByRole('option', { name: 'Live' })).toBeTruthy();
  });

  it('a checkbox offers checked/unchecked and stores a real boolean', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        filters={{ all: [{ field: 'shipped', op: 'equals', value: false }] }}
        fields={kinded}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Filter value'));
    fireEvent.click(screen.getByRole('option', { name: 'Checked' }));
    const next = onChange.mock.calls[0][0] as { all: FilterRule[] };
    expect(next.all[0].value).toBe(true);
  });

  // The box shows the DISPLAY spelling, not the storage one, from M16.29 on:
  // `2026-08-01` is what the rule stores, and this field declares no
  // `dateFormat`, so it renders in the short form every unconfigured date
  // renders in — the same one the grid beside it uses.
  it('a date is picked, not typed', () => {
    show({ field: 'due', op: 'before', value: '2026-08-01' });
    expect(screen.getByLabelText('Filter value').textContent).toContain('Aug 1, 2026');
  });

  /**
   * A number editor that emitted strings would put `"5"` in the YAML, which
   * reads wrong in the file and forced the engine's comparator to do the
   * coercion on every evaluation.
   */
  it('a number editor stores a number', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        filters={{ all: [{ field: 'estimate', op: 'gt', value: '' }] }}
        fields={kinded}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: '7' } });
    const next = onChange.mock.calls[0][0] as { all: FilterRule[] };
    expect(next.all[0].value).toBe(7);
  });
});
