import { useMemo, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { toIsoDate } from '@/engine/dates';
import {
  addMonths,
  isSameMonth,
  monthGrid,
  monthLabel,
  onDay,
  resolveDateField,
  spanOf,
  unscheduled,
  weekdayLabels,
} from '@/engine/schedule';
import { typeStyle } from '@/engine/typeCatalog';
import type { ColumnDef } from '@/engine/columns';
import type { Entry, Presentation, Schema } from '@/engine/types';

/** Chips beyond this in one day cell collapse into a "+N more" row. */
const MAX_CHIPS = 3;

export interface CalendarViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** Column universe — supplies the field kinds the date field is inferred from. */
  fields: ColumnDef[];
  /** Overridable for tests; defaults to the real today. */
  today?: string;
  /** Create a record dated to the clicked day. */
  onCreateOn?: (title: string, day: string) => Promise<boolean>;
}

/**
 * Calendar (M10): the month grid.
 *
 * A record appears on every day its span covers, so a two-week range reads as a
 * band across the weeks rather than as a single chip on its start date — which
 * is the whole reason a `daterange` is a distinct kind.
 */
export function CalendarView({
  entries,
  presentation,
  schema,
  fields,
  today = toIsoDate(new Date()),
  onCreateOn,
}: CalendarViewProps) {
  const dateField = resolveDateField(presentation, fields);
  const [anchor, setAnchor] = useState(today);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openPath = useOpenPath('in-place');

  const days = useMemo(() => monthGrid(anchor), [anchor]);
  const dated = useMemo(
    () => entries.filter((e) => spanOf(e, dateField) !== null),
    [entries, dateField],
  );
  const undatedCount = useMemo(
    () => unscheduled(entries, dateField).length,
    [entries, dateField],
  );

  // No date property anywhere on this collection's type — the view cannot be
  // made to work by paging months, so say what would fix it.
  if (dateField === null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center" data-testid="calendar-view">
        <EmptyState
          icon="calendar-days"
          title="Nothing here carries a date"
          description="A calendar places records by a date or date-range property. Add one to this type, or pick a different view."
        />
      </div>
    );
  }

  return (
    <div
      data-testid="calendar-view"
      data-date-field={dateField}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex flex-none items-center gap-2 border-b border-[var(--n-200)] px-5 py-2">
        <IconButton
          icon="chevron-left"
          label="Previous month"
          onClick={() => setAnchor(addMonths(anchor, -1))}
        />
        <IconButton
          icon="chevron-right"
          label="Next month"
          onClick={() => setAnchor(addMonths(anchor, 1))}
        />
        <span
          data-testid="calendar-month"
          className="ml-1 text-[13px] font-semibold text-[var(--n-900)]"
        >
          {monthLabel(anchor)}
        </span>
        {!isSameMonth(anchor, today) && (
          <button
            type="button"
            onClick={() => setAnchor(today)}
            className="rounded-md border border-[var(--n-200)] bg-transparent px-2 py-0.5 text-[11.5px] text-[var(--n-600)] hover:border-[var(--n-400)]"
          >
            Today
          </button>
        )}
        <span className="flex-1" />
        {/* Honest about coverage: a calendar that silently omits a third of
            the collection looks complete and is not. */}
        {undatedCount > 0 && (
          <span className="text-[11.5px] text-[var(--n-500)]">
            {undatedCount} without a date
          </span>
        )}
      </div>

      <div className="grid flex-none grid-cols-7 border-b border-[var(--n-200)]">
        {weekdayLabels().map((label) => (
          <div
            key={label}
            className="px-2 py-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--n-500)]"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 overflow-auto">
        {days.map((day) => {
          const inMonth = isSameMonth(day, anchor);
          const records = onDay(dated, dateField, day);
          const showAll = expanded === day;
          const visible = showAll ? records : records.slice(0, MAX_CHIPS);
          return (
            <div
              key={day}
              data-testid="calendar-day"
              data-day={day}
              data-count={records.length}
              className={[
                'group/day flex min-h-[92px] min-w-0 flex-col gap-0.5 border-b border-r border-[var(--n-100)] p-1',
                inMonth ? '' : 'bg-[var(--n-25)]',
              ].join(' ')}
            >
              <div className="flex flex-none items-center gap-1">
                <span
                  className={[
                    'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px]',
                    day === today
                      ? 'bg-[var(--cortex-500)] font-semibold text-white'
                      : inMonth
                        ? 'text-[var(--n-700)]'
                        : 'text-[var(--n-400)]',
                  ].join(' ')}
                >
                  {Number(day.slice(8, 10))}
                </span>
                <span className="flex-1" />
                {onCreateOn !== undefined && (
                  <DayAdd day={day} onCreate={onCreateOn} />
                )}
              </div>
              {visible.map((entry) => {
                const style = typeStyle(entry.type, schema);
                return (
                  <button
                    key={entry.path}
                    type="button"
                    data-testid="calendar-chip"
                    data-path={entry.path}
                    onClick={() => openPath(entry.path)}
                    title={entry.title}
                    className="flex min-w-0 items-center gap-1 rounded border-0 bg-[var(--n-50)] px-1 py-px text-left text-[11.5px] text-[var(--n-800)] hover:bg-[var(--n-100)]"
                  >
                    <Icon name={style.icon} size={10} color={style.color ?? 'var(--n-400)'} />
                    <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                  </button>
                );
              })}
              {records.length > MAX_CHIPS && (
                <button
                  type="button"
                  onClick={() => setExpanded(showAll ? null : day)}
                  className="rounded border-0 bg-transparent px-1 text-left text-[11px] text-[var(--n-500)] hover:text-[var(--n-800)]"
                >
                  {showAll ? 'Show less' : `+${records.length - MAX_CHIPS} more`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Create on a day. Reveals on cell hover rather than sitting in every cell:
 * forty-two always-visible plus signs is noise, and the affordance is only
 * meaningful for the cell the pointer is in.
 */
function DayAdd({
  day,
  onCreate,
}: {
  day: string;
  onCreate: (title: string, day: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={`New record on ${day}`}
        onClick={() => setEditing(true)}
        className="hidden h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-800)] group-hover/day:flex"
      >
        <Icon name="plus" size={11} />
      </button>
    );
  }

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    const ok = await onCreate(title, day);
    setSubmitting(false);
    if (ok) {
      setTitle('');
      setEditing(false);
    }
  };

  return (
    <input
      autoFocus
      value={title}
      aria-label={`New record on ${day}`}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void submit();
        if (e.key === 'Escape') {
          setTitle('');
          setEditing(false);
        }
      }}
      placeholder="Title"
      className="h-4 w-full min-w-0 border-none bg-transparent text-[11.5px] text-[var(--n-900)] outline-none"
    />
  );
}
