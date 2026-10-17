import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CalendarTimeGrid, HOUR_PX, type TimeGridItem } from '@/views/CalendarTimeGrid';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
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
    expect(openDetail).toHaveBeenCalledWith(
      'records/work-items/standup.md',
      useNavStore.getState().active,
    );
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

describe('CalendarTimeGrid editing (M61.9)', () => {
  function editable(
    kind: 'date' | 'daterange' = 'daterange',
    fixed = false,
    onCreateOn?: (
      title: string,
      day: string,
      slot?: { start: number; end: number },
    ) => Promise<boolean>,
  ) {
    const entry = record('standup');
    entry.properties.window =
      kind === 'date'
        ? '2026-07-28 10:00'
        : ({ start: '2026-07-28 10:00', end: '2026-07-28 11:00' } as never);
    const doc = makeEntry({
      path: 'types/work-item.md',
      type: 'Type',
      title: 'Work item',
      properties: { fields: { window: { kind } } } as never,
    });
    const schema = buildSchema([doc, entry]);
    const patch = vi.fn(async () => true);
    useVaultStore.setState({ entries: [doc, entry], patchFrontmatter: patch });
    const placement: TimeGridItem['placement'] =
      kind === 'date'
        ? { kind: 'point', day: '2026-07-28', at: 600, fixed }
        : { kind: 'timed', day: '2026-07-28', start: 600, end: 660, fixed };
    render(
      <CalendarTimeGrid
        days={WEEK}
        items={[{ entry, placement }]}
        today="2026-07-28"
        timeFormat="24"
        schema={schema}
        dateField="window"
        onCreateOn={onCreateOn}
      />,
    );
    return {
      patch,
      entry,
      el: screen.getByTestId(kind === 'date' ? 'calendar-point' : 'calendar-block'),
    };
  }
  const pointer = (type: string, y: number) =>
    new MouseEvent(type, { bubbles: true, button: 0, clientY: y, clientX: 10 });
  const drag = (element: HTMLElement, dy: number, release = true) => {
    fireEvent(element, pointer('pointerdown', 500));
    fireEvent(window, pointer('pointermove', 500 + dy));
    if (release) fireEvent(window, pointer('pointerup', 500 + dy));
  };
  it('moves both endpoints by half an hour', () => {
    const { patch, entry, el } = editable();
    drag(el, 24);
    expect(patch).toHaveBeenCalledWith(entry.path, {
      window: { start: '2026-07-28 10:30', end: '2026-07-28 11:30' },
    });
  });
  it.each(['start', 'end'] as const)('resizes only its %s grip', (edge) => {
    const { patch, entry } = editable();
    drag(screen.getByTestId(`calendar-block-grip-${edge}`), 24);
    expect(patch).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledWith(entry.path, {
      window: {
        start: edge === 'start' ? '2026-07-28 10:30' : '2026-07-28 10:00',
        end: edge === 'end' ? '2026-07-28 11:30' : '2026-07-28 11:00',
      },
    });
  });
  it('moves into the hovered day in Week and previews the new placement', () => {
    const { patch, entry, el } = editable();
    drag(el, 24, false);
    fireEvent.pointerEnter(screen.getAllByTestId('calendar-hours-day')[3]);
    expect(screen.getByTestId('calendar-block').getAttribute('data-day')).toBe('2026-07-29');
    fireEvent(window, pointer('pointerup', 524));
    expect(patch).toHaveBeenCalledWith(entry.path, {
      window: { start: '2026-07-29 10:30', end: '2026-07-29 11:30' },
    });
  });
  it('abandons a live move on Escape and does not open the record after a committed drag', () => {
    const { patch, el } = editable();
    drag(el, 48, false);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent(window, pointer('pointerup', 548));
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByTestId('calendar-block').getAttribute('data-start')).toBe('600');
    useUiStore.setState({ detailPath: null });
    drag(el, 24);
    fireEvent.click(el);
    expect(useUiStore.getState().detailPath).toBeNull();
  });
  it('moves and resizes with keys, while a point only moves and stays scalar', () => {
    const { patch, entry, el } = editable('date');
    expect(screen.queryByTestId('calendar-block-grip-end')).toBeNull();
    fireEvent.keyDown(el, { key: 'ArrowDown', shiftKey: true });
    expect(patch).not.toHaveBeenCalled();
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    expect(patch).toHaveBeenCalledWith(entry.path, { window: '2026-07-28 10:30' });
  });
  it('does not offer handles or write when an instant is dragged or keyed', () => {
    const { patch, el } = editable('daterange', true);
    expect(screen.queryByTestId('calendar-block-grip-start')).toBeNull();
    drag(el, 48);
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    expect(patch).not.toHaveBeenCalled();
  });
  it('creates from selected hours and Escape abandons only the title input', async () => {
    const create = vi.fn(async () => true);
    const { patch } = editable('daterange', false, create);
    const day = screen.getAllByTestId('calendar-hours-day')[3];
    fireEvent(day, pointer('pointerdown', 672));
    fireEvent(window, pointer('pointermove', 696));
    fireEvent(window, pointer('pointerup', 696));
    expect(screen.getByTestId('calendar-new-slot')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'New record title' }), {
      target: { value: 'Review' },
    });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('Review', '2026-07-29', { start: 840, end: 900 }),
    );
    await waitFor(() => expect(screen.queryByTestId('calendar-new-slot')).toBeNull());
    fireEvent(day, pointer('pointerdown', 672));
    fireEvent(window, pointer('pointerup', 672));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByTestId('calendar-new-slot')).toBeNull();
    expect(create).toHaveBeenCalledOnce();
    expect(patch).not.toHaveBeenCalled();
  });
});

it('shows an occurrence without grips or keyboard writers and opens its menu', () => {
  const entry = record('weekly');
  const item = block('weekly', '2026-07-28', 540, 555);
  const calendar = {
    key: 'weekly@20260728T090000',
    entry,
    series: entry,
    value: {
      start: '2026-07-28',
      end: '2026-07-28',
      startTime: '09:00',
      endTime: '09:15',
      format: 'full' as const,
      timeFormat: '12' as const,
      remind: null,
    },
    repeat: 'occurrence' as const,
    rule: null,
  };
  const onOccurrence = vi.fn();
  const patch = vi.fn();
  useVaultStore.setState({ patchFrontmatter: patch });
  render(
    <CalendarTimeGrid
      items={[{ ...item, calendar }]}
      days={WEEK}
      today="2026-07-28"
      timeFormat="12"
      dateField="when"
      onOccurrence={onOccurrence}
    />,
  );
  const button = screen.getByTestId('calendar-block');
  expect(button.getAttribute('data-occurrence')).toBe('20260728T090000');
  expect(button.getAttribute('aria-label')).toContain('repeats');
  expect(screen.queryByTestId('calendar-block-grip-end')).toBeNull();
  fireEvent.keyDown(button, { key: 'ArrowDown' });
  expect(patch).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(onOccurrence).toHaveBeenCalledWith(calendar, button);
});
