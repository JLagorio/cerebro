import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarView } from '@/views/CalendarView';
import { columnUniverse } from '@/engine/columns';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { Entry, Presentation } from '@/engine/types';

const TODAY = '2026-08-12';

const presentation: Presentation = {
  type: 'calendar',
  group: [],
  sort: [],
  columns: [],
  dateField: 'window',
};

/** A Type doc declaring one daterange property, plus the records under it. */
function vault(records: Entry[]): Entry[] {
  return [
    makeEntry({
      path: 'types/campaign.md',
      title: 'Campaign',
      type: 'Type',
      properties: {
        icon: 'megaphone',
        fields: { window: { kind: 'daterange' } },
      } as unknown as Entry['properties'],
    }),
    ...records,
  ];
}

function setup(
  records: Entry[],
  patch: Partial<Presentation> = {},
  onCreateOn?: (title: string, day: string) => Promise<boolean>,
) {
  const entries = vault(records);
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.type === 'Campaign');
  useVaultStore.setState({ entries });
  render(
    <CalendarView
      entries={items}
      presentation={{ ...presentation, ...patch }}
      schema={schema}
      fields={columnUniverse({ type: 'Campaign', project: null }, items, schema)}
      today={TODAY}
      {...(onCreateOn !== undefined ? { onCreateOn } : {})}
    />,
  );
}

/** The day cells, in the order they are drawn. */
const dayCells = () => screen.getAllByTestId('calendar-day');
const dayCell = (iso: string) =>
  dayCells().find((el) => el.getAttribute('data-day') === iso) as HTMLElement;

const spanning = (slug: string, start: string, end: string) =>
  makeEntry({
    path: `records/campaigns/${slug}.md`,
    title: slug,
    type: 'Campaign',
    properties: { window: { start, end } } as unknown as Entry['properties'],
  });

afterEach(cleanup);

/**
 * The month grid (M15 fix).
 *
 * Every entry used to be re-rendered as its own chip in EVERY day its span
 * covered, so a two-week item was drawn fourteen times and all 42 cells showed
 * the same three truncated titles plus a "+N more". A month grid exists to
 * answer "what is happening when", and that made it unanswerable.
 */
describe('CalendarView continuous spans', () => {
  it('draws a multi-day span as one bar per week, not a chip per day', () => {
    // Aug 3 (Mon) → Aug 7 (Fri) sits inside a single week row.
    setup([spanning('launch', '2026-08-03', '2026-08-07')]);
    expect(screen.getAllByTestId('calendar-bar')).toHaveLength(1);
    // And it is NOT repeated as a per-day chip.
    expect(screen.queryAllByTestId('calendar-chip')).toHaveLength(0);
  });

  it('splits a span that crosses a week boundary into one bar per week row', () => {
    // Aug 3 → Aug 18 covers three week rows of the August grid.
    setup([spanning('long-haul', '2026-08-03', '2026-08-18')]);
    expect(screen.getAllByTestId('calendar-bar')).toHaveLength(3);
  });

  it('still keeps 42 day cells', () => {
    setup([spanning('launch', '2026-08-03', '2026-08-07')]);
    expect(screen.getAllByTestId('calendar-day')).toHaveLength(42);
  });

  it('renders a single-day record as a chip in its own cell only', () => {
    setup([spanning('standup', '2026-08-05', '2026-08-05')]);
    const chips = screen.getAllByTestId('calendar-chip');
    expect(chips).toHaveLength(1);
    expect(screen.queryAllByTestId('calendar-bar')).toHaveLength(0);
  });

  it('packs overlapping spans into separate lanes rather than stacking them', () => {
    setup([
      spanning('alpha', '2026-08-03', '2026-08-07'),
      spanning('beta', '2026-08-04', '2026-08-06'),
    ]);
    const bars = screen.getAllByTestId('calendar-bar');
    expect(bars).toHaveLength(2);
    // Different lanes means different vertical offsets.
    const tops = bars.map((b) => (b as HTMLElement).style.top);
    expect(new Set(tops).size).toBe(2);
  });
});

/**
 * The grid settings (M16.23). `monthGrid` accepted a `weekStart` from the day
 * it was written and both call sites passed nothing, so a Monday-start
 * calendar was unreachable; a week view and a weekend toggle did not exist.
 */
describe('CalendarView grid settings', () => {
  it('draws one week of seven days in week span, not six', () => {
    setup([spanning('launch', '2026-08-10', '2026-08-11')], { calendarSpan: 'week' });
    expect(dayCells()).toHaveLength(7);
    // Aug 12 2026 is a Wednesday; a Sunday-start week runs Aug 9 → 15.
    expect(dayCells()[0].getAttribute('data-day')).toBe('2026-08-09');
    expect(screen.getByTestId('calendar-month').textContent).toBe('Aug 9 – 15, 2026');
  });

  it('switches span from the header without touching settings', async () => {
    const user = userEvent.setup();
    setup([]);
    expect(dayCells()).toHaveLength(42);
    await user.click(screen.getByTestId('calendar-span-week'));
    expect(dayCells()).toHaveLength(7);
  });

  it('starts the grid on Monday when the view says so', () => {
    setup([], { weekStart: 'monday' });
    // Aug 1 2026 is a Saturday, so a Monday-start August grid leads with Jul 27.
    expect(dayCells()[0].getAttribute('data-day')).toBe('2026-07-27');
    expect(screen.getAllByText('Mon')[0]).toBeTruthy();
  });

  it('drops the weekend columns entirely rather than narrowing them', () => {
    setup([], { showWeekends: false });
    expect(dayCells()).toHaveLength(30); // six rows of five
    expect(screen.queryByText('Sat')).toBeNull();
    expect(screen.queryByText('Sun')).toBeNull();
    for (const cell of dayCells()) {
      const day = new Date(`${cell.getAttribute('data-day')}T12:00:00`).getDay();
      expect(day === 0 || day === 6).toBe(false);
    }
  });

  it('keeps a bar that only clips the visible weekdays on the days it covers', () => {
    // Sat Aug 15 → Tue Aug 18. The pre-M16.23 layout resolved a column with
    // days.indexOf(span.start) and fell back to 0 on -1, so this bar started
    // on Monday of the WRONG week.
    setup([spanning('weekend-run', '2026-08-15', '2026-08-18')], { showWeekends: false });
    const bars = screen.getAllByTestId('calendar-bar');
    expect(bars).toHaveLength(1);
    // Mon 17 and Tue 18 of five weekday columns — not one column, and not
    // seven columns' worth of a grid that no longer has seven.
    expect(bars[0].style.left).toBe('calc(0% + 3px)');
    expect(bars[0].style.width).toBe('calc(40% - 6px)');
  });

  it('drops a bar that lives entirely on the hidden days', () => {
    setup([spanning('weekend', '2026-08-15', '2026-08-16')], { showWeekends: false });
    expect(screen.queryAllByTestId('calendar-bar')).toHaveLength(0);
  });
});

/**
 * Dragging (M16.23). All three time views had zero drag handlers: every chip
 * was a click-only button, so moving something by one day meant opening the
 * record and retyping a date.
 *
 * jsdom implements no PointerEvent and no layout, so these drive the handlers
 * and let the day cell under the pointer report itself — no rectangle is
 * measured anywhere, which is the only way a drag test here can mean anything.
 */
describe('CalendarView drag to reschedule', () => {
  const patched = () => {
    const patchFrontmatter = vi.fn(async () => true);
    useVaultStore.setState({ patchFrontmatter });
    return patchFrontmatter;
  };

  it('writes the date property when a chip is dropped on another day', () => {
    const write = patched();
    setup([spanning('standup', '2026-08-05', '2026-08-05')]);

    fireEvent.pointerDown(screen.getByTestId('calendar-chip'), { button: 0 });
    fireEvent.pointerOver(dayCell('2026-08-07'));
    fireEvent.pointerUp(window);

    expect(write).toHaveBeenCalledWith('records/campaigns/standup.md', {
      window: { start: '2026-08-07', end: '2026-08-07' },
    });
  });

  it('moves a multi-day bar without changing how long it runs', () => {
    const write = patched();
    setup([spanning('launch', '2026-08-03', '2026-08-07')]);

    fireEvent.pointerDown(screen.getByTestId('calendar-bar'), { button: 0 });
    fireEvent.pointerOver(dayCell('2026-08-05'));
    fireEvent.pointerUp(window);

    expect(write).toHaveBeenCalledWith('records/campaigns/launch.md', {
      window: { start: '2026-08-05', end: '2026-08-09' },
    });
  });

  it('writes nothing when the drop lands back on the day it started', () => {
    const write = patched();
    setup([spanning('standup', '2026-08-05', '2026-08-05')]);

    fireEvent.pointerDown(screen.getByTestId('calendar-chip'), { button: 0 });
    fireEvent.pointerOver(dayCell('2026-08-05'));
    fireEvent.pointerUp(window);

    expect(write).not.toHaveBeenCalled();
  });

  it('abandons the gesture on Escape', () => {
    const write = patched();
    setup([spanning('standup', '2026-08-05', '2026-08-05')]);

    fireEvent.pointerDown(screen.getByTestId('calendar-chip'), { button: 0 });
    fireEvent.pointerOver(dayCell('2026-08-07'));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window);

    expect(write).not.toHaveBeenCalled();
  });

  it('does not also open the record it just moved', () => {
    // pointerup at the end of a drag still fires click on the element the
    // gesture began on, so without suppression every successful drag opened
    // the record behind the panel it had just rescheduled.
    const write = patched();
    const openDetail = vi.fn();
    useUiStore.setState({ openDetail });
    setup([spanning('standup', '2026-08-05', '2026-08-05')]);
    const chip = screen.getByTestId('calendar-chip');

    fireEvent.pointerDown(chip, { button: 0 });
    fireEvent.pointerOver(dayCell('2026-08-07'));
    fireEvent.pointerUp(window);
    fireEvent.click(chip);

    expect(write).toHaveBeenCalled();
    expect(openDetail).not.toHaveBeenCalled();
  });

  it('still opens the record on a plain click', () => {
    patched();
    const openDetail = vi.fn();
    useUiStore.setState({ openDetail });
    setup([spanning('standup', '2026-08-05', '2026-08-05')]);

    fireEvent.click(screen.getByTestId('calendar-chip'));
    expect(openDetail).toHaveBeenCalledWith('records/campaigns/standup.md');
  });

  it('moves by a day with the arrow keys, and by a week vertically', async () => {
    const user = userEvent.setup();
    const write = patched();
    setup([spanning('standup', '2026-08-05', '2026-08-05')]);
    screen.getByTestId('calendar-chip').focus();

    await user.keyboard('{ArrowRight}');
    expect(write).toHaveBeenLastCalledWith('records/campaigns/standup.md', {
      window: { start: '2026-08-06', end: '2026-08-06' },
    });

    await user.keyboard('{ArrowDown}');
    expect(write).toHaveBeenLastCalledWith('records/campaigns/standup.md', {
      window: { start: '2026-08-12', end: '2026-08-12' },
    });
  });
});

/**
 * Creating on a day, from the keyboard (M16.35).
 *
 * The plus was `hidden … group-hover/day:flex`. `display: none` removes an
 * element from the tab order AND from the accessibility tree, so the one
 * affordance in the entire calendar that creates a record on a chosen day
 * could not be reached, focused or announced without a pointer. The sanctioned
 * shape — already applied twice in this repo, see `PropertyRow.ROW_ACTION` and
 * OptionListEditor — is opacity, which keeps the element real and reserves its
 * slot so the day does not reflow when it appears.
 *
 * jsdom loads no stylesheet, so a `hidden` class here would still be focusable
 * in this test. The class list is therefore asserted directly: it is the thing
 * that was wrong, and it is the only place a browser learns the difference.
 */
describe('CalendarView day-add is keyboard-reachable (M16.35)', () => {
  const addButton = (iso: string) =>
    screen.getByRole('button', { name: `New record on ${iso}` }) as HTMLButtonElement;

  it('reveals on focus as well as hover, and never sets display:none', () => {
    setup([], {}, async () => true);
    const add = addButton('2026-08-05');

    expect(add.className).not.toContain('hidden');
    expect(add.className).toContain('opacity-0');
    expect(add.className).toContain('group-hover/day:opacity-100');
    expect(add.className).toContain('focus-visible:opacity-100');
    // The slot stays reserved, so the day's contents do not shift when the
    // plus fades in.
    expect(add.className).toContain('h-4');
    expect(add.className).toContain('w-4');
    expect(add.className).toContain('flex-none');
  });

  it('takes focus and opens the inline title field on Enter', async () => {
    const user = userEvent.setup();
    const onCreateOn = vi.fn(async () => true);
    setup([], {}, onCreateOn);

    const add = addButton('2026-08-05');
    add.focus();
    expect(document.activeElement).toBe(add);

    await user.keyboard('{Enter}');
    const field = screen.getByLabelText('New record on 2026-08-05') as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');

    await user.keyboard('Retro{Enter}');
    expect(onCreateOn).toHaveBeenCalledWith('Retro', '2026-08-05');
  });
});
