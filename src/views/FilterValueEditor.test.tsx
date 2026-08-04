// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FieldDef } from '@/engine/types';
import { FilterValueEditor } from './FilterValueEditor';

afterEach(cleanup);

/**
 * The value half of a filter rule. It had no test file of its own, which is
 * how M16.29's two findings — a status field with no picker, and a date
 * rendered in a format nobody chose — both reached a live browser.
 */

const select: FieldDef = {
  name: 'priority',
  kind: 'select',
  options: [
    { id: 'urgent', label: 'Urgent', color: '#DE3B4E' },
    { id: 'high', label: 'High', color: '#DE8F0A' },
  ],
};

describe('FilterValueEditor picks its control from the kind and the arity (M16.25)', () => {
  it('shows nothing for an operator that takes no value', () => {
    const { container } = render(
      <FilterValueEditor
        def={select}
        kind="select"
        op="is_empty"
        value={undefined}
        onChange={vi.fn()}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows two bounds for is_between', () => {
    render(
      <FilterValueEditor
        def={undefined}
        kind="number"
        op="is_between"
        value={[1, 5]}
        onChange={vi.fn()}
      />,
    );
    expect((screen.getByLabelText('Filter value, from') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('Filter value, to') as HTMLInputElement).value).toBe('5');
  });

  it('offers a checklist of the declared options for is any of', () => {
    const onChange = vi.fn();
    render(
      <FilterValueEditor
        def={select}
        kind="select"
        op="any_of"
        value={['urgent']}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Filter values'));
    fireEvent.click(screen.getByRole('menuitem', { name: /High/ }));
    expect(onChange).toHaveBeenCalledWith(['urgent', 'high']);
  });

  /** A number typed into a text box round-trips through YAML as `5`, not
   * `"5"` — the spelling a human reading the file expects. */
  it('stores a numeric value as a number', () => {
    const onChange = vi.fn();
    render(
      <FilterValueEditor def={undefined} kind="number" op="gt" value="" onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith(7);
  });
});

/**
 * M16.29: a `status` field declares no `options:` of its own — its option set
 * is the TYPE's `statuses:`. With nothing on the def, the choice branch fell
 * through to the text box, so filtering a board by status meant knowing the
 * slug and typing it.
 *
 * The editor is unchanged: the fix hands it a def that carries the options,
 * resolved once where view context enters the filter bar. This asserts the
 * contract that fix relies on.
 */
describe('a status field filters through the same picker as a select (M16.29)', () => {
  const status: FieldDef = {
    name: 'status',
    kind: 'status',
    options: [
      { id: 'progress', label: 'In progress', color: '#DE8F0A' },
      { id: 'review', label: 'Review', color: '#38BDF8' },
    ],
  };

  it('names the option rather than showing its id', () => {
    render(
      <FilterValueEditor
        def={status}
        kind="status"
        op="equals"
        value="progress"
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByLabelText('Filter value');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.textContent).toContain('In progress');
  });

  it('writes the id, whatever the label says', () => {
    const onChange = vi.fn();
    render(
      <FilterValueEditor
        def={status}
        kind="status"
        op="equals"
        value="progress"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Filter value'));
    fireEvent.click(screen.getByRole('option', { name: /Review/ }));
    expect(onChange).toHaveBeenCalledWith('review');
  });
});

/**
 * M16.29: `due` has a persisted `dateFormat: dmy` and the grid honoured it
 * (`18/08/2026`), but the filter did not. The value box read `2026-08-03`
 * and the picker inside it read `Aug 3, 2026` — the box was calling
 * `formatDate(date, 'short', …)` with the format hardcoded, directly under a
 * row announcing "Date format: Full date".
 */
describe('a date filter speaks the field’s date format (M16.29)', () => {
  const due: FieldDef = { name: 'due', kind: 'date', dateFormat: 'dmy' };

  const openPicker = (def: FieldDef) => {
    render(
      <FilterValueEditor def={def} kind="date" op="before" value="2026-08-03" onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByLabelText('Filter value'));
  };

  it('labels the closed value box in the field’s format', () => {
    render(
      <FilterValueEditor def={due} kind="date" op="before" value="2026-08-03" onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('Filter value').textContent).toContain('03/08/2026');
  });

  it('shows the same spelling inside the picker', () => {
    openPicker(due);
    expect(screen.getByTestId('date-box-start').textContent).toBe('03/08/2026');
  });

  it('falls back to short for a field that configured nothing', () => {
    openPicker({ name: 'due', kind: 'date' });
    expect(screen.getByTestId('date-box-start').textContent).toBe('Aug 3, 2026');
  });

  /**
   * Date format is a PROPERTY setting: it is written to the type note, and
   * the filter has no type note to write to. The verifier changed it here and
   * confirmed `types/work-item.md` was untouched — a control that does
   * nothing teaches that the surface does nothing.
   */
  it('does not offer the property-level display settings', () => {
    openPicker(due);
    expect(screen.queryByText('Date format')).toBeNull();
    expect(screen.queryByText('Time format')).toBeNull();
  });

  /**
   * "Include time" stays, and this is the check that says why: unlike the
   * format rows it changes the RULE, adding a time to the bound so the
   * comparison happens at that granularity (M16.14). Hiding it alongside the
   * inert controls would have deleted a working capability.
   */
  it('keeps Include time, which writes a time into the bound', () => {
    const onChange = vi.fn();
    render(
      <FilterValueEditor
        def={due}
        kind="date"
        op="before"
        value="2026-08-03"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Filter value'));
    fireEvent.click(screen.getByLabelText('Include time'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(String(onChange.mock.calls[0][0])).toMatch(/^2026-08-03 \d{2}:00$/);
  });
});
