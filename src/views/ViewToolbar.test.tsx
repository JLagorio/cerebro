// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/engine/schema';
import type { Presentation } from '@/engine/types';
import { orderToValue, slugifyViewId, valueToOrder, ViewToolbar } from './ViewToolbar';

const emptySchema = () => buildSchema([]);

const presentation: Presentation = {
  type: 'list',
  group: [{ field: 'status' }],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'key' }, { field: 'status' }, { field: 'priority' }, { field: 'assignee' }, { field: 'due' }, { field: 'estimate' }],
};

describe('slugifyViewId', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyViewId('My urgent work')).toBe('my-urgent-work');
  });
  it('strips leading and trailing separators', () => {
    expect(slugifyViewId('  Board: Q3! ')).toBe('board-q3');
  });
});

describe('order encoding', () => {
  it('round-trips known orderings', () => {
    expect(orderToValue({ field: 'due', dir: 'asc' })).toBe('due:asc');
    expect(valueToOrder('due:asc')).toEqual({ field: 'due', dir: 'asc' });
    expect(valueToOrder('modifiedAt:desc')).toEqual({ field: 'modifiedAt', dir: 'desc' });
  });
  it('falls back to modified desc for unknown orderings', () => {
    expect(orderToValue({ field: 'status', dir: 'desc' })).toBe('modifiedAt:desc');
  });
});

describe('ViewToolbar', () => {
  afterEach(cleanup);

  it('switching the segmented control reports a board presentation', () => {
    const onChange = vi.fn();
    render(
      <ViewToolbar presentation={presentation} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Board'));
    expect(onChange).toHaveBeenCalledWith({ ...presentation, type: 'board' });
  });

  // M9.1: group and sort are ordered chains, so their control is a popover
  // with a row per level rather than a single-slot dropdown.
  it('removing the only grouping level reports a flat chain', () => {
    const onChange = vi.fn();
    render(<ViewToolbar presentation={presentation} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('group-chain'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove level 1' }));
    expect(onChange).toHaveBeenCalledWith({ ...presentation, group: [] });
  });

  it('flipping a sort level direction keeps the field', () => {
    const onChange = vi.fn();
    render(<ViewToolbar presentation={presentation} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('sort-chain'));
    fireEvent.click(screen.getByRole('button', { name: /Level 1 direction/ }));
    expect(onChange).toHaveBeenCalledWith({
      ...presentation,
      sort: [{ field: 'modifiedAt', dir: 'asc' }],
    });
  });

  // The defect this segment fixes: a saved tree view showed nothing selected
  // here, and clicking any other segment persisted you out of the hierarchy
  // with no way back except the settings dialog.
  it('offers the hierarchy layout', () => {
    const onChange = vi.fn();
    render(<ViewToolbar presentation={presentation} onChange={onChange} />);
    fireEvent.click(screen.getByText('Hierarchy'));
    expect(onChange).toHaveBeenCalledWith({ ...presentation, type: 'tree' });
  });

  // M9.7: there is no separate nesting control. Grouping by a property bands
  // records; grouping by a relation nests them — one chain, one question.
  it('has one grouping control, not a group control and a nesting control', () => {
    render(
      <ViewToolbar
        presentation={{ ...presentation, type: 'tree' }}
        onChange={vi.fn()}
        schema={emptySchema()}
      />,
    );
    expect(screen.getByTestId('group-chain')).toBeTruthy();
    expect(screen.queryByTestId('hierarchy-chain')).toBeNull();
  });

  it('a relation level reads as nesting in the summary', () => {
    render(
      <ViewToolbar
        presentation={{
          ...presentation,
          group: [
            {
              field: 'objective',
              descend: { direction: 'reverse', type: 'Key result', field: 'objective' },
            },
          ],
        }}
        onChange={vi.fn()}
        schema={emptySchema()}
      />,
    );
    expect(screen.getByTestId('group-chain').textContent).toContain('Nest');
  });

  // Task 8: the Save-view button moved to the project tab row ("New view");
  // the toolbar is presentation controls only.
  it('has no save-view affordance', () => {
    render(<ViewToolbar presentation={presentation} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Save view' })).toBeNull();
  });
});
