import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CalendarTimeGrid, HOUR_PX, type TimeGridItem } from '@/views/CalendarTimeGrid';
import { makeEntry } from '@/test/factories';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { Entry } from '@/engine/types';

const WEEK = [
  '2026-07-26',
  '2026-07-27',
  '2026-07-28',
  '2026-07-29',
  '2026-07-30',
  '2026-07-31',
  '2026-08-01',
];

const record = (slug: string): Entry =>
  makeEntry({ path: `records/work-items/${slug}.md`, title: slug, type: 'Work item' });

const block = (slug: string, day: string, start: number, end: number): TimeGridItem => ({
  entry: record(slug),
  placement: { kind: 'timed', day, start, end, fixed: false },
});

const point = (slug: string, day: string, at: number, fixed = false): TimeGridItem => ({
  entry: record(slug),
  placement: { kind: 'point', day, at, fixed },
});

function grid(items: TimeGridItem[], days = WEEK, now = new Date(2026, 6, 28, 12, 0)) {
  return render(
    <CalendarTimeGrid days={days} items={items} today="2026-07-28" now={now} timeFormat="12" />,
  );
}

const byPath = (testId: string, slug: string) =>
  screen
    .getAllByTestId(testId)
    .find((el) => el.getAttribute('data-path') === `records/work-items/${slug}.md`) as HTMLElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CalendarTimeGrid geometry (M61.8)', () => {
  it('sits a 10:00 → 11:00 block at 480px, 48px tall, in its day', () => {
    grid([block('standup', '2026-07-28', 600, 660)]);
    const el = byPath('calendar-block', 'standup');
    expect(el.style.top).toBe('480px');
    expect(el.style.height).toBe('48px');
    expect(el.getAttribute('data-day')).toBe('2026-07-28');
    expect(el.getAttribute('data-start')).toBe('600');
    expect(el.getAttribute('data-end')).toBe('660');
    expect(el.closest('[data-testid="calendar-hours-day"]')?.getAttribute('data-day')).toBe(
      '2026-07-28',
    );
    expect(screen.getAllByTestId('calendar-hours-day')).toHaveLength(7);
  });

  it('never draws a block shorter than 18px', () => {
    grid([block('blip', '2026-07-28', 600, 605)]);
    expect(byPath('calendar-block', 'blip').style.height).toBe('18px');
  });

  it('splits overlapping blocks into halves', () => {
    grid([block('a', '2026-07-28', 600, 660), block('b', '2026-07-28', 630, 690)]);
    expect(byPath('calendar-block', 'a').style.width).toBe('calc(50% - 4px)');
    expect(byPath('calendar-block', 'b').style.width).toBe('calc(50% - 4px)');
    expect(byPath('calendar-block', 'b').style.left).toBe('calc(50% + 2px)');
  });

  it('draws a point chip at its minute', () => {
    grid([point('ping', '2026-07-28', 555)]);
    const el = byPath('calendar-point', 'ping');
    expect(el.getAttribute('data-at')).toBe('555');
    expect(el.style.top).toBe(`${555 * 0.8}px`);
    expect(el.style.height).toBe('18px');
  });

  it('labels an item with its day and hours, and says when it is shown in your time', () => {
    grid([block('standup', '2026-07-28', 600, 660), point('call', '2026-07-29', 1320, true)]);
    expect(byPath('calendar-block', 'standup').getAttribute('aria-label')).toBe(
      'standup, Tue Jul 28, 10:00 AM to 11:00 AM',
    );
    expect(byPath('calendar-point', 'call').getAttribute('aria-label')).toBe(
      'call, Wed Jul 29, 10:00 PM, shown in your time',
    );
  });

  it('puts the now line at the current minute in today’s column only', () => {
    grid([], WEEK, new Date(2026, 6, 28, 13, 45));
    const lines = screen.getAllByTestId('calendar-now');
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute('data-minute')).toBe('825');
    expect(lines[0].closest('[data-testid="calendar-hours-day"]')?.getAttribute('data-day')).toBe(
      '2026-07-28',
    );
  });

  it('draws no now line when today is off-screen', () => {
    grid([], ['2026-08-03', '2026-08-04']);
    expect(screen.queryByTestId('calendar-now')).toBeNull();
  });
});

/**
 * The opening scroll. jsdom lays nothing out, so clientHeight is stubbed on
 * the prototype; scrollTop is a plain stored number there.
 */
describe('CalendarTimeGrid opening scroll (M61.8)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  });

  it('opens at 07:00', () => {
    grid([]);
    expect(screen.getByTestId('calendar-hours').scrollTop).toBe(7 * HOUR_PX);
    expect(screen.getByTestId('calendar-hours').scrollTop).toBe(336);
  });

  it('keeps the reader’s scroll after they scroll, and after paging', () => {
    const { rerender } = grid([]);
    const scroller = screen.getByTestId('calendar-hours');
    scroller.scrollTop = 900;
    fireEvent.scroll(scroller);
    rerender(
      <CalendarTimeGrid
        days={WEEK.map((d) => d.replace('2026-07', '2026-08'))}
        items={[]}
        today="2026-07-28"
        now={new Date(2026, 6, 28, 12, 0)}
        timeFormat="12"
      />,
    );
    expect(screen.getByTestId('calendar-hours')).toBe(scroller);
    expect(scroller.scrollTop).toBe(900);
  });
});

describe('CalendarTimeGrid is read-only (M61.8)', () => {
  it('opens the record on a click', () => {
    const openDetail = vi.fn();
    useUiStore.setState({ openDetail });
    const item = block('standup', '2026-07-28', 600, 660);
    useVaultStore.setState({ entries: [item.entry] });
    grid([item]);
    fireEvent.click(byPath('calendar-block', 'standup'));
    expect(openDetail).toHaveBeenCalledWith('records/work-items/standup.md');
  });

  it('writes nothing on a pointer drag', () => {
    const patchFrontmatter = vi.fn(async () => true);
    useVaultStore.setState({ patchFrontmatter });
    grid([block('standup', '2026-07-28', 600, 660)]);
    const el = byPath('calendar-block', 'standup');
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 300 });
    fireEvent.pointerOver(screen.getAllByTestId('calendar-hours-day')[4]);
    fireEvent.pointerUp(window, { clientX: 200, clientY: 300 });
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });
});
