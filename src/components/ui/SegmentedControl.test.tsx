import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

afterEach(cleanup);

const OPTIONS = [
  { value: 'table', label: 'Table' },
  { value: 'board', label: 'Board' },
  { value: 'calendar', label: 'Calendar' },
];

describe('SegmentedControl', () => {
  // It declared role="tablist" over three plain <button>s: an ARIA tab list
  // containing zero tabs, announcing as empty with no selected state.
  it('renders real tabs with a selected state', () => {
    render(<SegmentedControl options={OPTIONS} value="board" ariaLabel="View mode" />);
    const list = screen.getByRole('tablist', { name: 'View mode' });
    expect(list).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs.every((t) => t.getAttribute('type') === 'button')).toBe(true);
  });

  it('is one tab stop: only the selected option is tabbable', () => {
    render(<SegmentedControl options={OPTIONS} value="calendar" />);
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('falls back to the first option as the tab stop when value matches nothing', () => {
    render(<SegmentedControl options={OPTIONS} value="nope" />);
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves with arrow keys and wraps', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={OPTIONS} value="board" onChange={onChange} />);
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('calendar');
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('table');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('table');
    fireEvent.keyDown(list, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('calendar');
  });

  it('wraps past the last option', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={OPTIONS} value="calendar" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('table');
  });

  it('still fires onChange from a click', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={OPTIONS} value="table" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Board' }));
    expect(onChange).toHaveBeenCalledWith('board');
  });
});
