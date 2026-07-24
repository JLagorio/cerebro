// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Presentation } from '@/engine/types';
import { orderToValue, slugifyViewId, valueToOrder, ViewToolbar } from './ViewToolbar';

const presentation: Presentation = {
  type: 'list',
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
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
      <ViewToolbar presentation={presentation} onChange={onChange} onSaveView={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Board'));
    expect(onChange).toHaveBeenCalledWith({ ...presentation, type: 'board' });
  });

  it('changing group-by to none reports groupBy null', () => {
    const onChange = vi.fn();
    render(
      <ViewToolbar presentation={presentation} onChange={onChange} onSaveView={vi.fn()} />,
    );
    const groupSelect = screen.getByDisplayValue('Group: status');
    fireEvent.change(groupSelect, { target: { value: 'none' } });
    expect(onChange).toHaveBeenCalledWith({ ...presentation, groupBy: null });
  });

  it('save view dialog collects a name and calls onSaveView', () => {
    const onSaveView = vi.fn();
    render(
      <ViewToolbar presentation={presentation} onChange={vi.fn()} onSaveView={onSaveView} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    fireEvent.change(screen.getByPlaceholderText('View name'), {
      target: { value: 'My board' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSaveView).toHaveBeenCalledWith('My board');
  });
});
