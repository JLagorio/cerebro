import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FilterBuilder } from '@/views/FilterBuilder';
import { evaluateFilters } from '@/engine/viewFilters';
import { buildSchema } from '@/engine/schema';
import { fixtureVault } from '@/test/factories';
import type { FieldDef, FilterGroup } from '@/engine/types';

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
