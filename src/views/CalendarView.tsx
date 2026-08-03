import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { addDays, toIsoDate } from '@/engine/dates';
import {
  addMonths,
  dayOffset,
  isSameMonth,
  monthGrid,
  monthLabel,
  onDay,
  packWeek,
  rescheduleValue,
  resolveDateField,
  shiftSpan,
  spanOf,
  unscheduled,
  visibleDays,
  weekGrid,
  weekLabel,
  weekStartIndex,
  weekdayLabels,
} from '@/engine/schedule';
import { typeStyle } from '@/engine/typeCatalog';
import type { ColumnDef } from '@/engine/columns';
import type { Scheduled } from '@/engine/schedule';
import type { Entry, Presentation, Schema } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { useTimeDrag } from '@/views/useTimeDrag';

/** Single-day chips beyond this in one cell collapse into a "+N more" row. */
const MAX_CHIPS = 3;
/** Height of one continuous-bar lane, in px. */
const LANE_H = 18;
/** Bar lanes a week will draw before the rest fall into the day overflow. */
const MAX_LANES = 3;
/** Minimum cell height, per span. A week has one row to fill, a month six. */
const CELL_H = { month: 92, week: 420 };

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
 * Calendar (M10): the month grid, and — since M16.23 — the week grid.
 *
 * A record appears on every day its span covers, so a two-week range reads as a
 * band across the weeks rather than as a single chip on its start date — which
 * is the whole reason a `daterange` is a distinct kind.
 *
 * Dragging a chip or a bar to another day WRITES the date property. Before
 * M16.23 the only way to move something by a day was to open it and retype a
 * date, which is the gesture a calendar exists to replace.
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
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);

  // A local override beats the stored setting, rather than the stored setting
  // beating the control. The timeline's `presentation.zoom ?? local` shape
  // means the in-view control goes dead the moment the value is persisted;
  // this calendar has no way to persist at all (ViewCanvas hands it no
  // presentation writer), so that shape would have made the toggle one-way.
  const [spanOverride, setSpanOverride] = useState<'month' | 'week' | null>(null);
  const span = spanOverride ?? presentation.calendarSpan ?? 'month';
  const weekStart = weekStartIndex(presentation);
  const showWeekends = presentation.showWeekends !== false;

  const weeks = useMemo(() => {
    if (span === 'week') return [weekGrid(anchor, weekStart)];
    const days = monthGrid(anchor, weekStart);
    return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
  }, [span, anchor, weekStart]);
  const columns = useMemo(() => weekdayLabels(weekStart, showWeekends), [weekStart, showWeekends]);

  const dated = useMemo(
    () => entries.filter((e) => spanOf(e, dateField) !== null),
    [entries, dateField],
  );
  const undated = useMemo(() => unscheduled(entries, dateField), [entries, dateField]);
  const [showUndated, setShowUndated] = useState(false);

  // The day the pointer went down on, so a drop can be read as a delta from it
  // rather than as "wherever the record's own start happens to be".
  const grabDay = useRef<string | null>(null);
  const drag = useTimeDrag({
    rowDays: 7,
    disabled: dateField === null,
    onCommit: (path, edge, days) => {
      if (dateField === null) return;
      const entry = dated.find((e) => e.path === path);
      const current = entry === undefined ? null : spanOf(entry, dateField);
      if (entry === undefined || current === null) return;
      // The calendar only ever MOVES. Resizing needs an edge you can aim at,
      // and a grid cell's edge is already the week's edge.
      if (edge !== 'move') return;
      const kind = dateKindOf(entry, dateField, schema);
      void patchFrontmatter(entry.path, {
        [dateField]: rescheduleValue(entry.properties[dateField], kind, shiftSpan(current, days)),
      });
    },
  });

  /** Each dated entry with its span resolved once, with the drag previewed. */
  const spans: Scheduled[] = useMemo(() => {
    const active = drag.drag;
    return dated.flatMap((entry) => {
      const resolved = spanOf(entry, dateField);
      if (resolved === null) return [];
      const preview =
        active !== null && active.id === entry.path ? shiftSpan(resolved, active.days) : resolved;
      return [{ entry, span: preview }];
    });
  }, [dated, dateField, drag.drag]);

  /** Move the grid by one screenful of whatever it is showing. */
  const step = (direction: -1 | 1) =>
    setAnchor(span === 'week' ? addDays(anchor, direction * 7) : addMonths(anchor, direction));
  const onScreen =
    span === 'week' ? weekGrid(anchor, weekStart).includes(today) : isSameMonth(anchor, today);

  // No date property anywhere on this collection's type — the view cannot be
  // made to work by paging months, so say what would fix it.
  if (dateField === null) {
    return (
      <div
        className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
        data-testid="calendar-view"
      >
        <EmptyState
          icon="calendar-days"
          title="Nothing here carries a date"
          description="A calendar places records by a date or date-range property. Add one to this type, or pick a different view."
        />
      </div>
    );
  }

  /** Spread onto anything draggable, remembering which day it was grabbed on. */
  const grabProps = (path: string, day: string) => {
    const handle = drag.handleProps(path);
    return {
      ...handle,
      onPointerDown: (e: ReactPointerEvent) => {
        grabDay.current = day;
        handle.onPointerDown(e);
      },
    };
  };

  const openUnlessDragged = (path: string) => () => {
    if (drag.consumeClick()) return;
    openPath(path);
  };

  return (
    <div
      data-testid="calendar-view"
      data-date-field={dateField}
      data-span={span}
      data-week-start={weekStart === 1 ? 'monday' : 'sunday'}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex flex-none items-center gap-2 border-b border-[var(--n-200)] px-5 py-2">
        <IconButton
          icon="chevron-left"
          label={span === 'week' ? 'Previous week' : 'Previous month'}
          onClick={() => step(-1)}
        />
        <IconButton
          icon="chevron-right"
          label={span === 'week' ? 'Next week' : 'Next month'}
          onClick={() => step(1)}
        />
        <span
          data-testid="calendar-month"
          className="ml-1 text-[13px] font-semibold text-[var(--n-900)]"
        >
          {span === 'week' ? weekLabel(weekGrid(anchor, weekStart)) : monthLabel(anchor)}
        </span>
        {!onScreen && (
          <button
            type="button"
            onClick={() => setAnchor(today)}
            className="rounded-md border border-[var(--n-200)] bg-transparent px-2 py-0.5 text-[11.5px] text-[var(--n-600)] hover:border-[var(--n-400)]"
          >
            Today
          </button>
        )}
        <span className="flex-1" />
        <SegmentedControl
          size="sm"
          ariaLabel="Calendar span"
          options={[
            { value: 'month', label: 'Month', testId: 'calendar-span-month' },
            { value: 'week', label: 'Week', testId: 'calendar-span-week' },
          ]}
          value={span}
          onChange={(v) => setSpanOverride(v as 'month' | 'week')}
        />
        {/* Honest about coverage: a calendar that silently omits a third of
            the collection looks complete and is not. */}
        {undated.length > 0 && (
          // A count that resists clicking is worse than no indicator: the app
          // names exactly what is missing from the grid and then offers no way
          // to reach it.
          <button
            type="button"
            data-testid="calendar-undated-toggle"
            aria-expanded={showUndated}
            onClick={() => setShowUndated(!showUndated)}
            className={[
              'rounded-md border px-2 py-0.5 text-[11.5px]',
              showUndated
                ? 'border-[var(--cortex-500)] bg-[var(--cortex-50)] text-[var(--cortex-600)]'
                : 'border-[var(--n-200)] bg-transparent text-[var(--n-500)] hover:border-[var(--n-400)] hover:text-[var(--n-800)]',
            ].join(' ')}
          >
            {undated.length} without a date
          </button>
        )}
      </div>

      <div
        className="grid flex-none border-b border-[var(--n-200)]"
        style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
      >
        {columns.map((label) => (
          <div
            key={label}
            className="px-2 py-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--n-500)]"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {weeks.map((week) => {
          const visible = visibleDays(week, showWeekends);
          const segments = packWeek(spans, week, visible);
          const drawn = segments.filter((s) => s.lane < MAX_LANES);
          const spilled = segments.filter((s) => s.lane >= MAX_LANES);
          const lanes = Math.min(
            segments.reduce((max, s) => Math.max(max, s.lane + 1), 0),
            MAX_LANES,
          );
          return (
            <div
              key={week[0]}
              className="relative grid"
              style={{ gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))` }}
            >
              {visible.map((day, col) => {
                const inMonth = span === 'week' || isSameMonth(day, anchor);
                // The cell stack is single-day items ONLY, plus whatever
                // spilled past the lane cap — a bar is not repeated as a chip.
                const singles = spans
                  .filter((s) => s.span.start === s.span.end && s.span.start === day)
                  .map((s) => s.entry);
                const overflowed = spilled
                  .filter((s) => s.startCol <= col && s.endCol >= col)
                  .map((s) => s.entry);
                const stack = [...singles, ...overflowed];
                const showAll = expanded === day;
                const shown = showAll ? stack : stack.slice(0, MAX_CHIPS);
                return (
                  <div
                    key={day}
                    data-testid="calendar-day"
                    data-day={day}
                    data-count={onDay(dated, dateField, day).length}
                    // Where a release would land. `pointerover` and not
                    // `pointerenter`: React derives enter from over/out at the
                    // root, so a dispatched `pointerenter` reaches no handler.
                    onPointerOver={() => {
                      if (grabDay.current === null) return;
                      drag.hover(dayOffset({ start: grabDay.current, end: grabDay.current }, day));
                    }}
                    className={[
                      'group/day flex min-w-0 flex-col gap-0.5 border-b border-r border-[var(--n-100)] p-1',
                      inMonth ? '' : 'bg-[var(--n-25)]',
                      drag.drag !== null ? 'hover:bg-[var(--cortex-50)]' : '',
                    ].join(' ')}
                    style={{ minHeight: CELL_H[span] }}
                  >
                    <div className="flex flex-none items-center gap-1">
                      <span
                        className={[
                          'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px]',
                          day === today
                            ? 'bg-[var(--cortex-500)] font-semibold text-[var(--n-0)]'
                            : inMonth
                              ? 'text-[var(--n-700)]'
                              : 'text-[var(--n-400)]',
                        ].join(' ')}
                      >
                        {Number(day.slice(8, 10))}
                      </span>
                      <span className="flex-1" />
                      {onCreateOn !== undefined && <DayAdd day={day} onCreate={onCreateOn} />}
                    </div>
                    {/* Reserved lane space. Every cell in the week reserves the
                        same height, so the bars painted over the row land in
                        the gap rather than on top of a chip. */}
                    <div aria-hidden className="flex-none" style={{ height: lanes * LANE_H }} />
                    {shown.map((entry) => {
                      const style = typeStyle(entry.type, schema);
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          data-testid="calendar-chip"
                          data-path={entry.path}
                          {...grabProps(entry.path, day)}
                          onClick={openUnlessDragged(entry.path)}
                          title={entry.title}
                          aria-label={`${entry.title} on ${day}. Arrow keys move it.`}
                          className={[
                            'flex min-w-0 touch-none select-none items-center gap-1 rounded border-0 bg-[var(--n-50)] px-1 py-px text-left text-[11.5px] text-[var(--n-800)] hover:bg-[var(--n-100)]',
                            drag.drag?.id === entry.path
                              ? 'opacity-60 ring-1 ring-[var(--cortex-500)]'
                              : '',
                          ].join(' ')}
                        >
                          <Icon name={style.icon} size={10} color={style.color ?? 'var(--n-400)'} />
                          <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                        </button>
                      );
                    })}
                    {stack.length > shown.length && (
                      <button
                        type="button"
                        onClick={() => setExpanded(day)}
                        className="rounded border-0 bg-transparent px-1 text-left text-[11px] text-[var(--n-500)] hover:text-[var(--n-800)]"
                      >
                        {`+${stack.length - shown.length} more`}
                      </button>
                    )}
                    {showAll && stack.length > MAX_CHIPS && (
                      <button
                        type="button"
                        onClick={() => setExpanded(null)}
                        className="rounded border-0 bg-transparent px-1 text-left text-[11px] text-[var(--n-500)] hover:text-[var(--n-800)]"
                      >
                        Show less
                      </button>
                    )}
                  </div>
                );
              })}
              {/* One bar per span per week row, drawn over the reserved lanes.
                  Square ends mean "this continues" — rounded ends are the real
                  start and the real finish. */}
              <div
                className="pointer-events-none absolute inset-x-0"
                // 4px cell padding + the 18px day-number row + the 2px gap.
                style={{ top: 24 }}
                data-testid="calendar-lanes"
              >
                {drawn.map((seg) => {
                  const style = typeStyle(seg.entry.type, schema);
                  return (
                    <button
                      key={`${seg.entry.path}:${week[0]}`}
                      type="button"
                      data-testid="calendar-bar"
                      data-path={seg.entry.path}
                      {...grabProps(seg.entry.path, visible[seg.startCol])}
                      onClick={openUnlessDragged(seg.entry.path)}
                      title={`${seg.entry.title} · ${seg.span.start} → ${seg.span.end}`}
                      aria-label={`${seg.entry.title}, ${seg.span.start} to ${seg.span.end}. Arrow keys move it.`}
                      className={[
                        'pointer-events-auto absolute flex touch-none select-none items-center gap-1 overflow-hidden border border-[var(--cortex-500)] bg-[var(--cortex-50)] px-1 text-left text-[11.5px] text-[var(--n-900)] hover:bg-[var(--cortex-100)]',
                        seg.continuesLeft ? 'border-l-0' : 'rounded-l-[5px]',
                        seg.continuesRight ? 'border-r-0' : 'rounded-r-[5px]',
                        drag.drag?.id === seg.entry.path ? 'opacity-70' : '',
                      ].join(' ')}
                      style={{
                        left: `calc(${(seg.startCol / visible.length) * 100}% + 3px)`,
                        width: `calc(${((seg.endCol - seg.startCol + 1) / visible.length) * 100}% - 6px)`,
                        top: seg.lane * LANE_H,
                        height: LANE_H - 3,
                      }}
                    >
                      {seg.continuesLeft && (
                        <Icon name="chevron-left" size={10} color="var(--cortex-600)" />
                      )}
                      {!seg.continuesLeft && (
                        <Icon name={style.icon} size={10} color={style.color ?? 'var(--n-400)'} />
                      )}
                      <span className="min-w-0 flex-1 truncate">{seg.entry.title}</span>
                      {seg.continuesRight && (
                        <Icon name="chevron-right" size={10} color="var(--cortex-600)" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {showUndated && undated.length > 0 && (
        <div
          data-testid="calendar-undated"
          className="max-h-[180px] flex-none overflow-y-auto border-t border-[var(--n-200)] bg-[var(--n-25)] px-5 py-2"
        >
          <div className="pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
            Without a date
          </div>
          {undated.map((entry) => (
            <button
              key={entry.path}
              type="button"
              data-path={entry.path}
              onClick={() => openPath(entry.path)}
              className="flex w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-1 text-left text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-100)]"
            >
              <Icon
                name={typeStyle(entry.type, schema).icon}
                size={11}
                color={typeStyle(entry.type, schema).color ?? 'var(--n-400)'}
              />
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Which shape a reschedule writes back into.
 *
 * The declared kind decides, because the schema is what the next read
 * validates against. An UNDECLARED field keeps whatever shape is already on
 * disk instead of being normalised to a scalar — a hand-written `{start, end}`
 * that nothing declares is still a range, and flattening it on a drag would
 * delete the end date as a side effect of moving the record by a day.
 */
export function dateKindOf(entry: Entry, field: string, schema: Schema): 'date' | 'daterange' {
  const declared = schema.resolveField(entry, field).def?.kind;
  if (declared === 'date' || declared === 'daterange') return declared;
  const raw: unknown = entry.properties[field];
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? 'daterange' : 'date';
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
