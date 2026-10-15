import { kindFacts } from '@/engine/fieldKindTable';
import { expandForCalendar, exceptionStamp, type CalendarItem } from '@/engine/recurrence';
import { OccurrenceMenu } from './OccurrenceMenu';
import type { MouseEvent } from 'react';
import type { TimeSlot } from '@/engine/timeGrid';
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { addDays, DEFAULT_TIME_FORMAT, fromIsoDate, toIsoDate } from '@/engine/dates';
import {
  addMonths,
  canReschedule,
  dateKindOf,
  dayLabel,
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
import { placementOf, type Placement } from '@/engine/timeGrid';
import { typeStyle } from '@/engine/typeCatalog';
import type { ColumnDef } from '@/engine/columns';
import type { Scheduled } from '@/engine/schedule';
import type { Entry, Presentation, Schema } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import {
  CalendarTimeGrid,
  HOURS_GUTTER_PX,
  ZoneCorner,
  type TimeGridItem,
} from '@/views/CalendarTimeGrid';
import { useTimeDrag } from '@/views/useTimeDrag';

/** Single-day chips beyond this in one cell collapse into a "+N more" row. */
const MAX_CHIPS = 3;
/** Height of one continuous-bar lane, in px. */
const LANE_H = 18;
/** Bar lanes a week will draw before the rest fall into the day overflow. */
const MAX_LANES = 3;
/**
 * Minimum cell height, per span. A month's six rows share the screen; Week
 * and Day keep one short all-day row above the hours.
 */
const CELL_H = { month: 92, week: 56, day: 56 };
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type CalendarSpan = NonNullable<Presentation['calendarSpan']>;

export interface CalendarViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** Column universe — supplies the field kinds the date field is inferred from. */
  fields: ColumnDef[];
  /** Overridable for tests; defaults to the real today. */
  today?: string;
  /** Pins the hours grid's now line for tests; omitted, it follows the clock. */
  now?: Date;
  /** Create a record dated to the clicked day. */
  onCreateOn?: (title: string, day: string, slot?: TimeSlot) => Promise<boolean>;
}

/**
 * Calendar (M10): Month, Week (M16.23) and Day (M61.8).
 *
 * Month is the date overview: a grid of days, records on every day they
 * cover. Week and Day draw the HOURS (M61.8): one all-day row on top for
 * records with no time of day, then `CalendarTimeGrid`, where a timed record
 * is a block at its hours and an open-ended one a point chip.
 *
 * A record appears on every day its span covers and every day its repeat rule names, so a two-week range reads as a
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
  now,
  onCreateOn: createOnDate,
}: CalendarViewProps) {
  const dateField = resolveDateField(presentation, fields);
  const dateKind = fields.find((field) => field.name === dateField)?.kind;
  const onCreateOn =
    dateField === 'createdAt' ||
    dateField === 'modifiedAt' ||
    (dateKind !== undefined && kindFacts(dateKind).computed)
      ? undefined
      : createOnDate;
  const [anchor, setAnchor] = useState(today);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [occurrence, setOccurrence] = useState<{ item: CalendarItem; anchor: HTMLElement } | null>(
    null,
  );
  const openPath = useOpenPath('in-place');
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);

  // A local override beats the stored setting, rather than the stored setting
  // beating the control. The timeline's `presentation.zoom ?? local` shape
  // means the in-view control goes dead the moment the value is persisted;
  // this calendar has no way to persist at all (ViewCanvas hands it no
  // presentation writer), so that shape would have made the toggle one-way.
  const [spanOverride, setSpanOverride] = useState<CalendarSpan | null>(null);
  const span = spanOverride ?? presentation.calendarSpan ?? 'month';
  const hours = span !== 'month';
  const weekStart = weekStartIndex(presentation);
  const showWeekends = presentation.showWeekends !== false;

  const weeks = useMemo(() => {
    if (span === 'day') return [[anchor]];
    if (span === 'week') return [weekGrid(anchor, weekStart)];
    const days = monthGrid(anchor, weekStart);
    return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
  }, [span, anchor, weekStart]);
  // A Day is the day asked for, weekend or not: hiding weekends narrows a
  // week, and a Saturday opened on its own would otherwise draw nothing.
  const visibleOf = (week: string[]) => (span === 'day' ? week : visibleDays(week, showWeekends));
  const columns = useMemo(
    () =>
      span === 'day'
        ? [WEEKDAY_SHORT[fromIsoDate(anchor).getDay()]]
        : weekdayLabels(weekStart, showWeekends),
    [span, anchor, weekStart, showWeekends],
  );

  const calendarItems = useMemo(
    () =>
      expandForCalendar(entries, dateField, schema, {
        start: weeks[0][0],
        end: weeks.at(-1)!.at(-1)!,
      }),
    [entries, dateField, schema, weeks],
  );
  const itemFor = useMemo(
    () => new Map(calendarItems.map((item) => [item.entry, item])),
    [calendarItems],
  );
  const dated = useMemo(
    () => calendarItems.filter((item) => item.value !== null).map((item) => item.entry),
    [calendarItems],
  );
  const keyFor = (entry: Entry) => itemFor.get(entry)?.key ?? entry.path;
  const repeating = (entry: Entry) => itemFor.get(entry)?.repeat !== 'none';
  const marks = (entry: Entry) => {
    const item = itemFor.get(entry);
    return {
      'data-occurrence':
        item?.repeat === 'occurrence' && item.value !== null
          ? exceptionStamp(item.value)
          : undefined,
      'data-repeat': item?.repeat === 'unknown' ? 'not-understood' : undefined,
    };
  };
  const repeatLabel = (entry: Entry) =>
    itemFor.get(entry)?.repeat === 'occurrence'
      ? ', repeats'
      : itemFor.get(entry)?.repeat === 'unknown'
        ? ', Repeat rule not understood'
        : canReschedule(entry, dateField, schema)
          ? '. Arrow keys move it.'
          : '';
  const itemIcon = (entry: Entry, normal: string) =>
    itemFor.get(entry)?.repeat === 'occurrence'
      ? 'repeat'
      : itemFor.get(entry)?.repeat === 'unknown'
        ? 'circle-alert'
        : normal;
  const undated = useMemo(
    () => unscheduled(entries, dateField, schema),
    [entries, dateField, schema],
  );
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
      const current = entry === undefined ? null : spanOf(entry, dateField, schema);
      if (
        entry === undefined ||
        current === null ||
        repeating(entry) ||
        !canReschedule(entry, dateField, schema)
      )
        return;
      // The month grid and all-day row only MOVE. Resizing needs an edge you can aim at,
      // and a grid cell's edge is already the week's edge.
      if (edge !== 'move') return;
      const kind = dateKindOf(entry, dateField, schema);
      void patchFrontmatter(entry.path, {
        [dateField]: rescheduleValue(entry.properties[dateField], kind, shiftSpan(current, days)),
      });
    },
  });

  /** Where each dated entry sits once Week and Day draw the hours. */
  const placements = useMemo(() => {
    const out = new Map<Entry, Placement>();
    for (const entry of dated) {
      const placed = placementOf(entry, dateField, schema);
      if (placed !== null) out.set(entry, placed);
    }
    return out;
  }, [dated, dateField, schema]);

  /** Each dated entry with its span resolved once, with the drag previewed.
   * In Week and Day only the all-day ones: the rest are in the hours. */
  const spans: Scheduled[] = useMemo(() => {
    const active = drag.drag;
    return dated.flatMap((entry) => {
      const resolved = spanOf(entry, dateField, schema);
      if (resolved === null) return [];
      if (hours && placements.get(entry)?.kind !== 'allDay') return [];
      const preview =
        active !== null && active.id === entry.path ? shiftSpan(resolved, active.days) : resolved;
      return [{ entry, span: preview }];
    });
  }, [dated, dateField, drag.drag, hours, placements, schema]);

  /** The timed and point records of the visible days, for the hours grid. */
  const timedItems: TimeGridItem[] = useMemo(() => {
    if (!hours) return [];
    const shown = new Set(
      weeks.flatMap((week) => (span === 'day' ? week : visibleDays(week, showWeekends))),
    );
    return dated.flatMap((entry) => {
      const placement = placements.get(entry);
      if (placement === undefined || placement.kind === 'allDay') return [];
      return shown.has(placement.day) ? [{ entry, placement, calendar: itemFor.get(entry) }] : [];
    });
  }, [hours, weeks, dated, placements, span, showWeekends, itemFor]);
  const timeFormat = fields.find((f) => f.name === dateField)?.timeFormat ?? DEFAULT_TIME_FORMAT;

  /** Move the grid by one screenful of whatever it is showing. */
  const step = (direction: -1 | 1) =>
    setAnchor(
      span === 'day'
        ? addDays(anchor, direction)
        : span === 'week'
          ? addDays(anchor, direction * 7)
          : addMonths(anchor, direction),
    );
  const onScreen =
    span === 'day'
      ? anchor === today
      : span === 'week'
        ? weekGrid(anchor, weekStart).includes(today)
        : isSameMonth(anchor, today);
  const unit = span === 'day' ? 'day' : span === 'week' ? 'week' : 'month';

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
  const grabProps = (entry: Entry, day: string) => {
    if (repeating(entry) || !canReschedule(entry, dateField, schema)) return {};
    const handle = drag.handleProps(entry.path);
    return {
      ...handle,
      onPointerDown: (e: ReactPointerEvent) => {
        grabDay.current = day;
        handle.onPointerDown(e);
      },
    };
  };

  const openUnlessDragged = (entry: Entry) => (event: MouseEvent<HTMLButtonElement>) => {
    if (drag.consumeClick()) return;
    const item = itemFor.get(entry);
    if (item?.repeat === 'occurrence') setOccurrence({ item, anchor: event.currentTarget });
    else openPath(entry.path);
  };

  /** One week row of day cells and bars: every Month row, and the all-day
   * row above the hours in Week and Day. */
  const weekRow = (week: string[]) => {
    const visible = visibleOf(week);
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
          const inMonth = hours || isSameMonth(day, anchor);
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
              data-count={onDay(dated, dateField, day, schema).length}
              // Where a release would land. `pointerover` and not
              // `pointerenter`: React derives enter from over/out at the
              // root, so a dispatched `pointerenter` reaches no handler.
              onPointerOver={() => {
                if (grabDay.current === null) return;
                drag.hover(dayOffset({ start: grabDay.current, end: grabDay.current }, day));
              }}
              className={[
                'group/day flex min-w-0 flex-col gap-0.5 border-b border-r border-n-100 p-1',
                inMonth ? '' : 'bg-n-25',
                drag.drag !== null ? 'hover:bg-cortex-50' : '',
              ].join(' ')}
              style={{ minHeight: CELL_H[span] }}
            >
              <div className="flex flex-none items-center gap-1">
                <span
                  className={[
                    'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-2xs',
                    day === today
                      ? 'bg-cortex-500 font-semibold text-n-0'
                      : inMonth
                        ? 'text-n-700'
                        : 'text-n-400',
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
                    key={keyFor(entry)}
                    type="button"
                    data-testid="calendar-chip"
                    data-path={entry.path}
                    {...marks(entry)}
                    {...grabProps(entry, day)}
                    onClick={openUnlessDragged(entry)}
                    title={entry.title}
                    aria-label={`${entry.title} on ${day}${repeatLabel(entry)}`}
                    className={[
                      'flex min-w-0 touch-none select-none items-center gap-1 rounded-xs border-0 bg-n-50 px-1 py-px text-left text-xs text-n-800 hover:bg-n-100',
                      drag.drag?.id === entry.path ? 'opacity-60 ring-1 ring-cortex-500' : '',
                    ].join(' ')}
                  >
                    <Icon
                      name={itemIcon(entry, style.icon)}
                      size={10}
                      color={style.color ?? 'var(--n-400)'}
                    />
                    <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                  </button>
                );
              })}
              {stack.length > shown.length && (
                <button
                  type="button"
                  onClick={() => setExpanded(day)}
                  className="rounded-xs border-0 bg-transparent px-1 text-left text-2xs text-n-500 hover:text-n-800"
                >
                  {`+${stack.length - shown.length} more`}
                </button>
              )}
              {showAll && stack.length > MAX_CHIPS && (
                <button
                  type="button"
                  onClick={() => setExpanded(null)}
                  className="rounded-xs border-0 bg-transparent px-1 text-left text-2xs text-n-500 hover:text-n-800"
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
                key={`${keyFor(seg.entry)}:${week[0]}`}
                type="button"
                data-testid="calendar-bar"
                data-path={seg.entry.path}
                {...marks(seg.entry)}
                {...grabProps(seg.entry, visible[seg.startCol])}
                onClick={openUnlessDragged(seg.entry)}
                title={`${seg.entry.title} · ${seg.span.start} → ${seg.span.end}`}
                aria-label={`${seg.entry.title}, ${seg.span.start} to ${seg.span.end}${repeatLabel(seg.entry)}`}
                className={[
                  'pointer-events-auto absolute flex touch-none select-none items-center gap-1 overflow-hidden border border-cortex-500 bg-cortex-50 px-1 text-left text-xs text-n-900 hover:bg-cortex-100',
                  seg.continuesLeft ? 'border-l-0' : 'rounded-l-sm',
                  seg.continuesRight ? 'border-r-0' : 'rounded-r-sm',
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
                  <Icon
                    name={itemIcon(seg.entry, style.icon)}
                    size={10}
                    color={style.color ?? 'var(--n-400)'}
                  />
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
  };

  return (
    <div
      data-testid="calendar-view"
      data-date-field={dateField}
      data-span={span}
      data-week-start={weekStart === 1 ? 'monday' : 'sunday'}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex flex-none items-center gap-2 border-b border-n-200 px-5 py-2">
        <IconButton icon="chevron-left" label={`Previous ${unit}`} onClick={() => step(-1)} />
        <IconButton icon="chevron-right" label={`Next ${unit}`} onClick={() => step(1)} />
        <span data-testid="calendar-month" className="ml-1 text-sm font-semibold text-n-900">
          {span === 'day'
            ? dayLabel(anchor)
            : span === 'week'
              ? weekLabel(weekGrid(anchor, weekStart))
              : monthLabel(anchor)}
        </span>
        {!onScreen && (
          <button
            type="button"
            onClick={() => setAnchor(today)}
            className="rounded-md border border-n-200 bg-transparent px-2 py-0.5 text-xs text-n-600 hover:border-n-400"
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
            { value: 'day', label: 'Day', testId: 'calendar-span-day' },
          ]}
          value={span}
          onChange={(v) => setSpanOverride(v as CalendarSpan)}
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
              'rounded-md border px-2 py-0.5 text-xs',
              showUndated
                ? 'border-cortex-500 bg-cortex-50 text-cortex-600'
                : 'border-n-200 bg-transparent text-n-500 hover:border-n-400 hover:text-n-800',
            ].join(' ')}
          >
            {undated.length} without a date
          </button>
        )}
      </div>

      <div className="flex flex-none border-b border-n-200">
        {/* The hours' gutter starts here, so the columns line up with it. */}
        {hours && <ZoneCorner />}
        <div
          className="grid min-w-0 flex-1"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
        >
          {columns.map((label) => (
            <div
              key={label}
              className="px-2 py-1 text-2xs font-medium uppercase tracking-[0.04em] text-n-500"
            >
              {label}
            </div>
          ))}
        </div>
      </div>

      {hours ? (
        <>
          <div data-testid="calendar-all-day" className="flex flex-none border-b border-n-200">
            <div
              aria-hidden
              className="flex-none px-1 pt-1 text-right text-2xs text-n-400"
              style={{ width: HOURS_GUTTER_PX }}
            >
              all-day
            </div>
            <div className="min-w-0 flex-1">{weeks.map(weekRow)}</div>
          </div>
          <CalendarTimeGrid
            days={weeks.flatMap((week) => visibleOf(week))}
            items={timedItems}
            onOccurrence={(item, anchor) => setOccurrence({ item, anchor })}
            dateField={dateField}
            onCreateOn={onCreateOn}
            today={today}
            timeFormat={timeFormat}
            schema={schema}
            {...(now !== undefined ? { now } : {})}
          />
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">{weeks.map(weekRow)}</div>
      )}
      {occurrence !== null && (
        <OccurrenceMenu
          item={occurrence.item}
          anchor={occurrence.anchor}
          onClose={() => setOccurrence(null)}
        />
      )}
      {showUndated && undated.length > 0 && (
        <div
          data-testid="calendar-undated"
          className="max-h-[180px] flex-none overflow-y-auto border-t border-n-200 bg-n-25 px-5 py-2"
        >
          <div className="pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
            Without a date
          </div>
          {undated.map((entry) => (
            <button
              key={entry.path}
              type="button"
              data-path={entry.path}
              onClick={() => openPath(entry.path)}
              className="flex w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-1 text-left text-sm text-n-800 hover:bg-n-100"
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
 * Create on a day. Reveals on cell hover — or on its own focus — rather than
 * sitting in every cell: forty-two always-visible plus signs is noise, and the
 * affordance is only meaningful for the cell you are in.
 */
function DayAdd({
  day,
  onCreate,
}: {
  day: string;
  onCreate: (title: string, day: string, slot?: TimeSlot) => Promise<boolean>;
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
        // Reveal-on-hover-OR-FOCUS, the shape PropertyRow.ROW_ACTION and
        // OptionListEditor already settled on. `hidden group-hover/day:flex`
        // was display:none until a pointer arrived, which takes the button out
        // of the tab order AND out of the accessibility tree — and this is the
        // only affordance in the whole calendar that creates a record on a
        // chosen day, so without a mouse there was no way to do it at all.
        // Opacity keeps the 4x4 slot reserved, so a day does not reflow when
        // the plus appears.
        className="flex h-4 w-4 flex-none items-center justify-center rounded-xs border-0 bg-transparent p-0 text-n-400 opacity-0 hover:bg-n-100 hover:text-n-800 focus-visible:opacity-100 group-hover/day:opacity-100"
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
      className="h-4 w-full min-w-0 border-none bg-transparent text-xs text-n-900 outline-none"
    />
  );
}
