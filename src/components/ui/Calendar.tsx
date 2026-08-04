import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { addDays, formatDate, toIsoDate } from '@/engine/dates';

const WEEKDAY_HEADER = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export interface CalendarProps {
  /** Visible month, 'YYYY-MM'. */
  month: string;
  onMonthChange: (month: string) => void;
  /** Range endpoints (ISO dates); a single date is start with no end. */
  start?: string | null;
  end?: string | null;
  onPick: (date: string) => void;
  /** Header quick-jump label ('Today', or 'Now' when time is shown). */
  todayLabel?: string;
  onToday?: () => void;
}

/** 'YYYY-MM' for the month `delta` months away. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** The 6-week day grid shown for a month (leading/trailing neighbors included). */
export function monthGrid(month: string): { date: string; inMonth: boolean }[] {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  let cursor = toIsoDate(first);
  cursor = addDays(cursor, -first.getDay()); // back to Sunday
  const out: { date: string; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    out.push({ date: cursor, inMonth: cursor.slice(0, 7) === month });
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * The same day-of-month `delta` months away, clamped to the shortest month
 * ('2026-03-31' back one month is the 28th, not a rolled-over April 3rd).
 */
function shiftDateByMonth(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const lastOfTarget = new Date(y, m + delta, 0).getDate();
  return toIsoDate(new Date(y, m - 1 + delta, Math.min(d, lastOfTarget)));
}

/**
 * Base month-grid calendar (M2.x): the single calendar used by every date
 * surface — the DatePicker composes it, future views (timelines, boards)
 * reuse it. Pure presentational; all state lives with the caller.
 *
 * The one piece of state it does own is which day the keyboard is standing on
 * (M16.34). The grid is 42 buttons: as 42 tab stops it took a keyboard user
 * more presses to cross one month than there are controls in the whole picker,
 * and Tab is the wrong verb for moving inside a two-dimensional grid anyway.
 * So it is a roving tabindex — one tab stop, arrows move between the days.
 */
export function Calendar({
  month,
  onMonthChange,
  start = null,
  end = null,
  onPick,
  todayLabel = 'Today',
  onToday,
}: CalendarProps) {
  const [y, m] = month.split('-').map(Number);
  const grid = monthGrid(month);
  const dates = grid.map((g) => g.date);
  const lo = start !== null && end !== null ? (start < end ? start : end) : start;
  const hi = start !== null && end !== null ? (start < end ? end : start) : end;

  const gridRef = useRef<HTMLDivElement>(null);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  // Where the tab stop sits before anything is pressed: the selected day if it
  // is on screen, else the 1st — which is always in the grid. Anything the
  // month scrolled away from is not a tab stop you could reach.
  const anchor = start !== null && dates.includes(start) ? start : `${month}-01`;
  const focused = focusDate !== null && dates.includes(focusDate) ? focusDate : anchor;

  const focusDay = (date: string) =>
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)?.focus();

  // Focus rides the moved day so a screen reader follows it, but only after a
  // key press: focusing on mount would steal focus from whatever opened the
  // calendar. Deferred to an effect because a move that crosses a month edge
  // renders a grid the target day is not in yet.
  const pendingFocus = useRef(false);
  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    focusDay(focused);
  }, [focused]);

  const move = (next: string, changeMonth = !dates.includes(next)) => {
    if (next === focused && !changeMonth) {
      focusDay(next);
      return;
    }
    pendingFocus.current = true;
    setFocusDate(next);
    if (changeMonth) onMonthChange(next.slice(0, 7));
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    // Week bounds are the row on screen, which starts on Sunday because the
    // grid does — reading them off the grid keeps the two from disagreeing.
    const rowStart = Math.floor(dates.indexOf(focused) / 7) * 7;
    switch (e.key) {
      case 'ArrowLeft':
        move(addDays(focused, -1));
        break;
      case 'ArrowRight':
        move(addDays(focused, 1));
        break;
      case 'ArrowUp':
        move(addDays(focused, -7));
        break;
      case 'ArrowDown':
        move(addDays(focused, 7));
        break;
      case 'Home':
        move(dates[rowStart]);
        break;
      case 'End':
        move(dates[rowStart + 6]);
        break;
      // Page keys always turn the page, even when the day they land on is one
      // of the neighbours already visible in this month's grid.
      case 'PageUp':
      case 'PageDown': {
        const next = shiftDateByMonth(focused, e.key === 'PageUp' ? -1 : 1);
        move(next, next.slice(0, 7) !== month);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div data-testid="calendar" className="select-none">
      <div className="flex items-center gap-1 px-1 pb-1.5">
        <span className="text-sm font-semibold text-n-900">
          {MONTH_SHORT[m - 1]} {y}
        </span>
        <span className="flex-1" />
        {onToday !== undefined && (
          <button
            type="button"
            onClick={onToday}
            className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
          >
            {todayLabel}
          </button>
        )}
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => onMonthChange(shiftMonth(month, -1))}
          className="flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-n-500 hover:bg-n-50"
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => onMonthChange(shiftMonth(month, 1))}
          className="flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-n-500 hover:bg-n-50"
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>
      {/* No `role="grid"`: the days are laid out by CSS grid with no row
          elements to carry `role="row"`, and a grid missing its rows announces
          worse than the plain group of buttons this is. The roving tabindex is
          what a keyboard needed; the roles would be a lie. */}
      <div ref={gridRef} className="grid grid-cols-7" onKeyDown={onGridKeyDown}>
        {WEEKDAY_HEADER.map((wd) => (
          <span
            key={wd}
            className="flex h-7 items-center justify-center text-xs text-[var(--text-meta)]"
          >
            {wd}
          </span>
        ))}
        {grid.map(({ date, inMonth }) => {
          const isEndpoint = date === lo || date === hi;
          const inRange = lo !== null && hi !== null && date > lo && date < hi;
          const dayNum = Number(date.slice(8));
          return (
            <button
              key={date}
              type="button"
              data-testid="calendar-day"
              data-date={date}
              aria-pressed={isEndpoint}
              // "14" alone tells a screen-reader user nothing about which
              // month they just arrowed into.
              aria-label={formatDate(date, 'full', date)}
              tabIndex={date === focused ? 0 : -1}
              onClick={() => {
                // The tab stop follows the pointer too, so tabbing back in
                // lands where you last were rather than on the 1st.
                setFocusDate(date);
                onPick(date);
              }}
              className={[
                'flex h-8 w-full items-center justify-center border-0 text-sm',
                isEndpoint
                  ? 'rounded-lg bg-cortex-500 font-medium text-n-0'
                  : inRange
                    ? 'rounded-none bg-cortex-100 text-n-800'
                    : `rounded-lg bg-transparent hover:bg-n-50 ${
                        inMonth ? 'text-n-800' : 'text-n-300'
                      }`,
              ].join(' ')}
            >
              {dayNum}
            </button>
          );
        })}
      </div>
    </div>
  );
}
