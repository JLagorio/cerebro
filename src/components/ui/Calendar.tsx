import { Icon } from '@/components/ui/Icon';
import { addDays, toIsoDate } from '@/engine/dates';

const WEEKDAY_HEADER = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
 * Base month-grid calendar (M2.x): the single calendar used by every date
 * surface — the DatePicker composes it, future views (timelines, boards)
 * reuse it. Pure presentational; all state lives with the caller.
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
  const lo = start !== null && end !== null ? (start < end ? start : end) : start;
  const hi = start !== null && end !== null ? (start < end ? end : start) : end;

  return (
    <div data-testid="calendar" className="select-none">
      <div className="flex items-center gap-1 px-1 pb-1.5">
        <span className="text-[13px] font-semibold text-[var(--n-900)]">
          {MONTH_SHORT[m - 1]} {y}
        </span>
        <span className="flex-1" />
        {onToday !== undefined && (
          <button
            type="button"
            onClick={onToday}
            className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]"
          >
            {todayLabel}
          </button>
        )}
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => onMonthChange(shiftMonth(month, -1))}
          className="flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-[var(--n-500)] hover:bg-[var(--n-50)]"
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => onMonthChange(shiftMonth(month, 1))}
          className="flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-[var(--n-500)] hover:bg-[var(--n-50)]"
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7">
        {WEEKDAY_HEADER.map((wd) => (
          <span
            key={wd}
            className="flex h-7 items-center justify-center text-[11.5px] text-[var(--n-400)]"
          >
            {wd}
          </span>
        ))}
        {grid.map(({ date, inMonth }) => {
          const isEndpoint = date === lo || date === hi;
          const inRange =
            lo !== null && hi !== null && date > lo && date < hi;
          const dayNum = Number(date.slice(8));
          return (
            <button
              key={date}
              type="button"
              data-testid="calendar-day"
              data-date={date}
              aria-pressed={isEndpoint}
              onClick={() => onPick(date)}
              className={[
                'flex h-8 w-full items-center justify-center border-0 text-[13px]',
                isEndpoint
                  ? 'rounded-lg bg-[var(--cortex-500)] font-medium text-[var(--n-0)]'
                  : inRange
                    ? 'rounded-none bg-[var(--cortex-100)] text-[var(--n-800)]'
                    : `rounded-lg bg-transparent hover:bg-[var(--n-50)] ${
                        inMonth ? 'text-[var(--n-800)]' : 'text-[var(--n-300)]'
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
