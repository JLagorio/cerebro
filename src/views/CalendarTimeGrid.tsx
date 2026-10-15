import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Icon } from '@/components/ui/Icon';
import {
  formatDate,
  formatTime,
  fromIsoDate,
  localTimezone,
  type TimeDisplayFormat,
} from '@/engine/dates';
import { clockOf, packDay, type Placement } from '@/engine/timeGrid';
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
  placement: Extract<Placement, { kind: 'timed' | 'point' }>;
}

export interface CalendarTimeGridProps {
  /** The visible days, one column each. */
  days: string[];
  items: TimeGridItem[];
  today: string;
  /** Pins the now line for tests; omitted, it follows the clock each minute. */
  now?: Date;
  /** The date property's clock (12h or 24h) for labels. */
  timeFormat: TimeDisplayFormat;
  schema?: Schema;
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
 * The hours of a Week or Day calendar (M61.8), read-only.
 *
 * A gutter of 24 hour rows, one column per day, timed records as blocks and
 * open-ended ones as point chips, side by side where they overlap
 * (`packDay`), and a now line in today's column. Every item opens its record
 * as a page; nothing here drags or writes (editing by the minute is M61.9).
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
}: CalendarTimeGridProps) {
  const openPath = useOpenPath('in-place');
  const scroller = useRef<HTMLDivElement | null>(null);
  const opened = useRef(false);
  const clock = timeFormat === '24' ? '24' : '12';

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
    for (const item of items) {
      const list = out.get(item.placement.day) ?? [];
      list.push(item);
      out.set(item.placement.day, list);
    }
    return out;
  }, [items]);

  const label = (item: TimeGridItem): string => {
    const p = item.placement;
    // "Tue Jul 28": the year is the heading's business.
    const day = formatDate(p.day, 'short', today).slice(0, -6);
    const weekday = WEEKDAYS[fromIsoDate(p.day).getDay()];
    const when =
      p.kind === 'timed'
        ? `${formatTime(clockOf(p.start), clock)} to ${formatTime(clockOf(p.end), clock)}`
        : formatTime(clockOf(p.at), clock);
    return `${item.entry.title}, ${weekday} ${day}, ${when}${p.fixed ? ', shown in your time' : ''}`;
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
              dayItems.map(({ entry, placement: p }) => ({
                key: entry.path,
                start: p.kind === 'timed' ? p.start : p.at,
                end: p.kind === 'timed' ? p.end : p.at,
              })),
            );
            return (
              <div
                key={day}
                data-testid="calendar-hours-day"
                data-day={day}
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
                  const slot = slots.get(entry.path) ?? { col: 0, cols: 1 };
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
                      key={entry.path}
                      type="button"
                      data-testid={timed ? 'calendar-block' : 'calendar-point'}
                      data-path={entry.path}
                      data-day={day}
                      {...(timed
                        ? { 'data-start': p.start, 'data-end': p.end }
                        : { 'data-at': p.at })}
                      onClick={() => openPath(entry.path)}
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
                        <Icon name={style.icon} size={10} color={style.color ?? 'var(--n-400)'} />
                      )}
                      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                    </button>
                  );
                })}
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
