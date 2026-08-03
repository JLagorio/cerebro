// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Calendar } from '@/components/ui/Calendar';

afterEach(cleanup);

/**
 * March 2026 starts on a Sunday, so the grid is exactly Mar 1 – Apr 11: every
 * leading neighbour is an April date, which makes "did the month turn?"
 * unambiguous in the assertions below.
 */
function Harness({
  start = '2026-03-10',
  onMonthChange,
  onPick = vi.fn(),
}: {
  start?: string | null;
  onMonthChange?: (m: string) => void;
  onPick?: (d: string) => void;
}) {
  // Controlled the way every real caller is (the DatePicker owns `month`), so
  // a move that crosses a month edge actually re-renders a different grid.
  const [month, setMonth] = useState('2026-03');
  return (
    <Calendar
      month={month}
      onMonthChange={(m) => {
        onMonthChange?.(m);
        setMonth(m);
      }}
      start={start}
      onPick={onPick}
    />
  );
}

const days = () => screen.getAllByTestId('calendar-day');
const cell = (date: string) => days().find((d) => d.dataset.date === date);
const focusedDate = () => (document.activeElement as HTMLElement | null)?.dataset.date;
const tabbable = () =>
  days()
    .filter((d) => d.tabIndex === 0)
    .map((d) => d.dataset.date);

/**
 * The 42 days were 42 consecutive tab stops with no arrow keys at all
 * (M16.34): crossing one month from the keyboard cost more presses than there
 * are controls in the entire picker, and Tab is the wrong verb for moving
 * inside a two-dimensional grid regardless.
 */
describe('Calendar keyboard navigation (M16.34)', () => {
  it('is one tab stop: only the focused day is tabbable', () => {
    render(<Harness />);
    expect(days()).toHaveLength(42);
    expect(tabbable()).toEqual(['2026-03-10']);
  });

  it('falls back to the 1st when the selected day is not in this grid', () => {
    render(<Harness start={null} />);
    expect(tabbable()).toEqual(['2026-03-01']);
  });

  it('arrows move the focused day, and the tab stop rides along', () => {
    render(<Harness />);
    fireEvent.keyDown(cell('2026-03-10')!, { key: 'ArrowRight' });
    expect(focusedDate()).toBe('2026-03-11');
    expect(tabbable()).toEqual(['2026-03-11']);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(focusedDate()).toBe('2026-03-10');
  });

  it('up and down move a whole week', () => {
    render(<Harness />);
    fireEvent.keyDown(cell('2026-03-10')!, { key: 'ArrowDown' });
    expect(focusedDate()).toBe('2026-03-17');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(focusedDate()).toBe('2026-03-10');
  });

  it('Home and End go to the bounds of the week on screen', () => {
    render(<Harness />);
    fireEvent.keyDown(cell('2026-03-10')!, { key: 'End' });
    expect(focusedDate()).toBe('2026-03-14');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(focusedDate()).toBe('2026-03-08');
  });

  it('arrowing off the far edge turns the page and keeps the focus', () => {
    const onMonthChange = vi.fn();
    render(<Harness start="2026-03-01" onMonthChange={onMonthChange} />);
    fireEvent.keyDown(cell('2026-03-01')!, { key: 'ArrowLeft' });
    expect(onMonthChange).toHaveBeenCalledWith('2026-02');
    expect(focusedDate()).toBe('2026-02-28');
  });

  /**
   * The trailing April days ARE in March's grid, so a page turn that only
   * moved the highlight would leave the header on March with the focus sitting
   * on a neighbour — the one case a naive "change month if off-grid" gets
   * wrong.
   */
  it('PageDown turns the month even though the day it lands on is visible', () => {
    const onMonthChange = vi.fn();
    render(<Harness onMonthChange={onMonthChange} />);
    fireEvent.keyDown(cell('2026-03-10')!, { key: 'PageDown' });
    expect(onMonthChange).toHaveBeenCalledWith('2026-04');
    expect(focusedDate()).toBe('2026-04-10');
    fireEvent.keyDown(document.activeElement!, { key: 'PageUp' });
    expect(onMonthChange).toHaveBeenLastCalledWith('2026-03');
    expect(focusedDate()).toBe('2026-03-10');
  });

  it('clamps a page turn to the shortest month rather than rolling over', () => {
    render(<Harness start="2026-03-31" />);
    fireEvent.keyDown(cell('2026-03-31')!, { key: 'PageUp' });
    expect(focusedDate()).toBe('2026-02-28');
  });

  it('leaves keys it does not own alone', () => {
    render(<Harness />);
    const before = document.activeElement;
    fireEvent.keyDown(cell('2026-03-10')!, { key: 'a' });
    expect(document.activeElement).toBe(before);
    expect(tabbable()).toEqual(['2026-03-10']);
  });

  it('picking still works, and the tab stop follows the pointer', () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(cell('2026-03-19')!);
    expect(onPick).toHaveBeenCalledWith('2026-03-19');
    expect(tabbable()).toEqual(['2026-03-19']);
  });

  it('names the whole date so a screen reader knows which month it is in', () => {
    render(<Harness />);
    expect(cell('2026-04-02')!.getAttribute('aria-label')).toBe('April 2, 2026');
  });
});
