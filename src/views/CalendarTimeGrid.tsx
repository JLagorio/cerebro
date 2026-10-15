import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { exceptionStamp, type CalendarItem } from '@/engine/recurrence';
import { useOpenPath } from '@/app/useOpenPath';
import { ownsEscape, useLayer } from '@/components/ui/layers';
import { useTimeDrag } from '@/views/useTimeDrag';
import { useVaultStore } from '@/stores/vaultStore';
import { canReschedule, dateKindOf, dayOffset, retimeValue } from '@/engine/schedule';
import { Icon } from '@/components/ui/Icon';
import {
  addDays,
  formatDate,
  formatTime,
  fromIsoDate,
  localTimezone,
  type TimeDisplayFormat,
} from '@/engine/dates';
import {
  clockOf,
  movePoint,
  moveTimed,
  packDay,
  resizeTimed,
  type Placement,
  type TimeSlot,
} from '@/engine/timeGrid';
import { typeStyle } from '@/engine/typeCatalog';
import type { Entry, Schema } from '@/engine/types';

/** Height of one hour row, in px. */
export const HOUR_PX = 48;
/** Width of the hour-label gutter, in px; the views above the grid indent by it. */
export const HOURS_GUTTER_PX = 56;
const PX_PER_MINUTE = HOUR_PX / 60;
/** A block or point is never shorter than this, so its title stays legible. */
const MIN_ITEM_PX = 18;
/** The hour the grid opens at. */
const OPEN_HOUR = 7;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A record placed in the hours: a timed block or a point chip. */
export interface TimeGridItem {
  entry: Entry;
  calendar?: CalendarItem;
  placement: Extract<Placement, { kind: 'timed' | 'point' }>;
}

export interface CalendarTimeGridProps {
  onOccurrence?: (item: CalendarItem, anchor: HTMLElement) => void;
  /** The visible days, one column each. */
  days: string[];
  items: TimeGridItem[];
  today: string;
  /** Pins the now line for tests; omitted, it follows the clock each minute. */
  now?: Date;
  /** The date property's clock (12h or 24h) for labels. */
  timeFormat: TimeDisplayFormat;
  schema?: Schema;
  dateField?: string | null;
  onCreateOn?: (title: string, day: string, slot?: TimeSlot) => Promise<boolean>;
}

/** The zone the hours are shown in, for the corner above the gutter. */
export function ZoneCorner() {
  const zone = useMemo(() => localTimezone(), []);
  return (
    <div
      data-testid="calendar-zone"
      title={zone.zone}
      className="flex flex-none items-end justify-end truncate px-1 pb-1 text-2xs text-n-400"
      style={{ width: HOURS_GUTTER_PX }}
    >
      {zone.short}
    </div>
  );
}

/**
 * The hours of a Week or Day calendar (M61.8–9).
 *
 * A gutter of 24 hour rows, one column per day, timed records as blocks and
 * open-ended ones as point chips, side by side where they overlap
 * (`packDay`), and a now line in today's column. Every item opens its record
 * as a page; floating times move and resize by half hours. Empty hours select
 * a slot for a new record. Exact instants stay fixed in their local display.
 *
 * The grid opens at 07:00 once, and never moves after that: paging days or
 * weeks keeps the reader where they scrolled to, which is Macro's rule.
 */
export function CalendarTimeGrid({
  days,
  items,
  today,
  now,
  timeFormat,
  schema,
  dateField = null,
  onCreateOn,
  onOccurrence,
}: CalendarTimeGridProps) {
  const openPath = useOpenPath('in-place');
  const scroller = useRef<HTMLDivElement | null>(null);
  const opened = useRef(false);
  const clock = timeFormat === '24' ? '24' : '12';
  const patchFrontmatter = useVaultStore((state) => state.patchFrontmatter);
  const [newSlot, setNewSlot] = useState<(TimeSlot & { day: string }) | null>(null);
  const drag = useTimeDrag({
    pxPerMinute: PX_PER_MINUTE,
    snapMinutes: 30,
    dayLocked: days.length === 1,
    disabled: dateField === null,
    onSelect: onCreateOn === undefined ? undefined : (day, slot) => setNewSlot({ day, ...slot }),
    onCommit: (path, edge, dayDelta, minutes) => {
      if (dateField === null || schema === undefined) return;
      const item = items.find((candidate) => candidate.entry.path === path);
      if (
        item === undefined ||
        item.placement.fixed ||
        !canReschedule(item.entry, dateField, schema) ||
        (item.calendar !== undefined && item.calendar.repeat !== 'none')
      )
        return;
      const { entry, placement } = item;
      if (placement.kind === 'point' && edge !== 'move') return;
      const day = edge === 'move' ? addDays(placement.day, dayDelta) : placement.day;
      const slot =
        placement.kind === 'point'
          ? { at: movePoint(placement.at, minutes) }
          : edge === 'move'
            ? moveTimed(placement, minutes)
            : resizeTimed(placement, edge, minutes);
      void patchFrontmatter(path, {
        [dateField]: retimeValue(
          entry.properties[dateField],
          dateKindOf(entry, dateField, schema),
          day,
          slot,
        ),
      });
    },
  });
  const shownItems = items.map((item): TimeGridItem => {
    const active = drag.drag;
    const p = item.placement;
    if (
      active?.id !== item.entry.path ||
      p.fixed ||
      !canReschedule(item.entry, dateField, schema) ||
      (item.calendar !== undefined && item.calendar.repeat !== 'none') ||
      (p.kind === 'point' && active.edge !== 'move')
    )
      return item;
    const day = active.edge === 'move' ? addDays(p.day, active.days) : p.day;
    const placement =
      p.kind === 'point'
        ? { ...p, day, at: movePoint(p.at, active.minutes) }
        : {
            ...p,
            day,
            ...(active.edge === 'move'
              ? moveTimed(p, active.minutes)
              : resizeTimed(p, active.edge, active.minutes)),
          };
    return { ...item, placement };
  });

  // The opening scroll, once a height exists to scroll within: a calendar
  // mounted in a collapsed tab or an embed that has not laid out yet has a
  // clientHeight of 0, and a scrollTop set then is lost.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const open = (): boolean => {
      if (opened.current) return true;
      if (el.clientHeight <= 0) return false;
      el.scrollTop = OPEN_HOUR * HOUR_PX;
      opened.current = true;
      return true;
    };
    if (open() || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (open()) observer.disconnect();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [ticked, setTicked] = useState(() => new Date());
  useEffect(() => {
    if (now !== undefined) return;
    const id = window.setInterval(() => setTicked(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [now]);
  const moment = now ?? ticked;
  const nowMinute = moment.getHours() * 60 + moment.getMinutes();

  const byDay = useMemo(() => {
    const out = new Map<string, TimeGridItem[]>();
    for (const item of shownItems) {
      const list = out.get(item.placement.day) ?? [];
      list.push(item);
      out.set(item.placement.day, list);
    }
    return out;
  }, [shownItems]);

  const label = (item: TimeGridItem): string => {
    const p = item.placement;
    // "Tue Jul 28": the year is the heading's business.
    const day = formatDate(p.day, 'short', today).slice(0, -6);
    const weekday = WEEKDAYS[fromIsoDate(p.day).getDay()];
    const when =
      p.kind === 'timed'
        ? `${formatTime(clockOf(p.start), clock)} to ${formatTime(clockOf(p.end), clock)}`
        : formatTime(clockOf(p.at), clock);
    return `${item.entry.title}, ${weekday} ${day}, ${when}${p.fixed ? ', shown in your time' : ''}${item.calendar?.repeat === 'occurrence' ? ', repeats' : item.calendar?.repeat === 'unknown' ? ', Repeat rule not understood' : ''}`;
  };

  return (
    <div
      ref={scroller}
      data-testid="calendar-hours"
      className="min-h-0 flex-1 overflow-y-auto"
      style={{ maxHeight: '70vh' }}
    >
      <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
        <div aria-hidden className="relative flex-none" style={{ width: HOURS_GUTTER_PX }}>
          {Array.from({ length: 23 }, (_, i) => i + 1).map((hour) => (
            <div
              key={hour}
              className="absolute right-1.5 text-2xs leading-none text-n-400"
              style={{ top: hour * HOUR_PX - 5 }}
            >
              {clock === '12'
                ? formatTime(clockOf(hour * 60), clock).replace(':00', '')
                : formatTime(clockOf(hour * 60), clock)}
            </div>
          ))}
        </div>
        <div
          className="grid min-w-0 flex-1"
          style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
        >
          {days.map((day) => {
            const dayItems = byDay.get(day) ?? [];
            const slots = packDay(
              dayItems.map(({ entry, placement: p, calendar }) => ({
                key: calendar?.key ?? entry.path,
                start: p.kind === 'timed' ? p.start : p.at,
                end: p.kind === 'timed' ? p.end : p.at,
              })),
            );
            return (
              <div
                key={day}
                data-testid="calendar-hours-day"
                data-day={day}
                {...drag.slotProps(day)}
                onPointerEnter={() => {
                  const origin = items.find((item) => item.entry.path === drag.drag?.id)?.placement
                    .day;
                  if (origin !== undefined)
                    drag.hover(dayOffset({ start: origin, end: origin }, day));
                }}
                onClick={() => {
                  drag.consumeClick();
                }}
                className="relative border-l border-n-100"
              >
                {Array.from({ length: 23 }, (_, i) => i + 1).map((hour) => (
                  <div
                    key={hour}
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 border-t border-n-100"
                    style={{ top: hour * HOUR_PX }}
                  />
                ))}
                {dayItems.map((item) => {
                  const { entry, placement: p } = item;
                  const repeated = item.calendar !== undefined && item.calendar.repeat !== 'none';
                  const slot = slots.get(item.calendar?.key ?? entry.path) ?? { col: 0, cols: 1 };
                  const style = schema === undefined ? null : typeStyle(entry.type, schema);
                  const start = p.kind === 'timed' ? p.start : p.at;
                  const height =
                    p.kind === 'timed'
                      ? Math.max((p.end - p.start) * PX_PER_MINUTE, MIN_ITEM_PX)
                      : MIN_ITEM_PX;
                  const geometry = {
                    top: start * PX_PER_MINUTE,
                    height,
                    left: `calc(${(slot.col / slot.cols) * 100}% + 2px)`,
                    width: `calc(${100 / slot.cols}% - 4px)`,
                  };
                  const timed = p.kind === 'timed';
                  return (
                    <button
                      key={item.calendar?.key ?? entry.path}
                      type="button"
                      data-testid={timed ? 'calendar-block' : 'calendar-point'}
                      data-path={entry.path}
                      data-occurrence={
                        item.calendar?.repeat === 'occurrence' && item.calendar.value !== null
                          ? exceptionStamp(item.calendar.value)
                          : undefined
                      }
                      data-repeat={
                        item.calendar?.repeat === 'unknown' ? 'not-understood' : undefined
                      }
                      data-day={day}
                      {...(timed
                        ? { 'data-start': p.start, 'data-end': p.end }
                        : { 'data-at': p.at })}
                      {...(!repeated && !p.fixed && canReschedule(entry, dateField, schema)
                        ? drag.handleProps(entry.path)
                        : {})}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (drag.consumeClick()) return;
                        if (item.calendar?.repeat === 'occurrence' && onOccurrence !== undefined)
                          onOccurrence(item.calendar, event.currentTarget);
                        else openPath(entry.path);
                      }}
                      title={entry.title}
                      aria-label={label(item)}
                      className={[
                        'absolute flex min-w-0 select-none gap-1 overflow-hidden px-1 text-left text-xs text-n-900',
                        timed
                          ? 'items-start rounded-sm border border-cortex-500 bg-cortex-50 py-px hover:bg-cortex-100'
                          : 'items-center rounded-xs border-0 bg-n-50 hover:bg-n-100',
                      ].join(' ')}
                      style={geometry}
                    >
                      {style !== null && (
                        <Icon
                          name={
                            item.calendar?.repeat === 'occurrence'
                              ? 'repeat'
                              : item.calendar?.repeat === 'unknown'
                                ? 'circle-alert'
                                : style.icon
                          }
                          size={10}
                          color={style.color ?? 'var(--n-400)'}
                        />
                      )}
                      <span className="pointer-events-none min-w-0 flex-1 truncate">
                        {entry.title}
                      </span>
                      {timed &&
                        !repeated &&
                        !p.fixed &&
                        canReschedule(entry, dateField, schema) &&
                        (['start', 'end'] as const).map((edge) => (
                          <span
                            key={edge}
                            data-testid={`calendar-block-grip-${edge}`}
                            data-calendar-handle
                            aria-hidden
                            {...drag.handleProps(entry.path, edge)}
                            className={`absolute inset-x-0 z-10 h-[6px] cursor-ns-resize ${edge === 'start' ? 'top-0' : 'bottom-0'}`}
                          />
                        ))}
                    </button>
                  );
                })}
                {drag.selection?.day === day && (
                  <div
                    data-testid="calendar-slot-preview"
                    className="pointer-events-none absolute inset-x-0 border border-cortex-500 bg-cortex-100/60"
                    style={{
                      top: drag.selection.start * PX_PER_MINUTE,
                      height: (drag.selection.end - drag.selection.start) * PX_PER_MINUTE,
                    }}
                  />
                )}
                {newSlot?.day === day && onCreateOn !== undefined && (
                  <NewSlot
                    slot={newSlot}
                    onCancel={() => setNewSlot(null)}
                    onCreate={async (title) => {
                      const ok = await onCreateOn(title, day, {
                        start: newSlot.start,
                        end: newSlot.end,
                      });
                      if (ok) setNewSlot(null);
                      return ok;
                    }}
                  />
                )}
                {day === today && (
                  <div
                    data-testid="calendar-now"
                    data-minute={nowMinute}
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-danger-500"
                    style={{ top: nowMinute * PX_PER_MINUTE }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function NewSlot({
  slot,
  onCancel,
  onCreate,
}: {
  slot: TimeSlot;
  onCancel: () => void;
  onCreate: (title: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const layer = useLayer({ contains: (node) => root.current?.contains(node) ?? false });
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !ownsEscape(layer)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [layer, onCancel]);
  const submit = async () => {
    if (busy.current || title.trim() === '') return;
    busy.current = true;
    setSaving(true);
    try {
      await onCreate(title.trim());
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  return (
    <div
      ref={root}
      data-testid="calendar-new-slot"
      className="absolute inset-x-0 z-20 rounded-sm border border-cortex-500 bg-cortex-50 p-1"
      style={{
        top: slot.start * PX_PER_MINUTE,
        minHeight: Math.max(30, (slot.end - slot.start) * PX_PER_MINUTE),
      }}
    >
      <input
        autoFocus
        aria-label="New record title"
        placeholder="Title — Enter to create"
        value={title}
        disabled={saving}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            void submit();
          }
        }}
        className="w-full border-0 bg-transparent text-xs text-n-900 outline-none"
      />
    </div>
  );
}
