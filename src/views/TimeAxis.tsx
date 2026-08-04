import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Icon } from '@/components/ui/Icon';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { humanize } from '@/engine/schema';
import {
  axisWidth,
  dateAtCentre,
  dayOffset,
  scrollToCentre,
  PX_PER_DAY,
  ZOOM_LABELS,
  type AxisTick,
  type Span,
  type Zoom,
} from '@/engine/schedule';
import { typeStyle } from '@/engine/typeCatalog';
import type { ColumnDef } from '@/engine/columns';
import type { RenderRow } from '@/engine/rows';
import type { Schema } from '@/engine/types';
import type { TimeDrag } from '@/views/useTimeDrag';

/**
 * The horizontal date axis shared by Timeline and Gantt (M10), and — since
 * M16.24 — the table half beside it.
 *
 * Both views place bars against the same ruler; only what occupies the rows
 * differs (swimlanes of records vs a nested work breakdown with dependency
 * arrows). Sharing the axis is what keeps a bar at the same x in both.
 */

export const ROW_H = 30;
/** A grouping band's row height. Both halves must agree or the rows shear. */
export const BAND_H = 28;
/** Header strip height, above both halves. */
export const HEAD_H = 32;

export function TimeAxisHeader({
  ticks,
  axis,
  zoom,
  today,
}: {
  ticks: AxisTick[];
  axis: Span;
  zoom: Zoom;
  /** Draws the labelled Today marker when the date is on the axis. */
  today?: string;
}) {
  const onAxis = today !== undefined && today >= axis.start && today <= axis.end;
  return (
    <div
      role="row"
      className="sticky top-0 z-20 flex h-8 border-b border-n-200 bg-n-25"
      style={{ width: axisWidth(axis, zoom) }}
    >
      {ticks.map((tick) => (
        <div
          key={tick.iso}
          role="columnheader"
          data-testid="axis-tick"
          data-major={tick.major}
          className={[
            'flex flex-none items-center overflow-hidden whitespace-nowrap px-1 text-2xs',
            tick.major
              ? 'border-l border-n-300 font-semibold text-n-700'
              : 'border-l border-n-100 text-n-500',
          ].join(' ')}
          style={{ width: tick.days * PX_PER_DAY[zoom] }}
        >
          {tick.label}
        </div>
      ))}
      {/* The now marker used to be an unlabelled red vertical, identical to a
          slipped-dependency riser — so the one line you must not misread was
          the one you could not identify. Labelled here, and drawn in cortex so
          red stays exclusively for violations. */}
      {onAxis && (
        <span
          data-testid="today-label"
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-full bg-cortex-500 px-1.5 py-px text-2xs font-semibold text-n-0"
          style={{ left: dayOffset(axis, today) * PX_PER_DAY[zoom], top: 4 }}
        >
          Today
        </span>
      )}
    </div>
  );
}

/** Vertical rules behind the bars, aligned to the header's ticks. */
export function TimeGridLines({ ticks, zoom }: { ticks: AxisTick[]; zoom: Zoom }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex">
      {ticks.map((tick) => (
        <div
          key={tick.iso}
          className={['flex-none border-l', tick.major ? 'border-n-200' : 'border-n-100'].join(' ')}
          style={{ width: tick.days * PX_PER_DAY[zoom] }}
        />
      ))}
    </div>
  );
}

/**
 * The now marker. Rendered only when today is actually on the axis — a line
 * pinned to the edge because "now" is off-screen reads as a real date boundary.
 */
export function TodayLine({ axis, zoom, today }: { axis: Span; zoom: Zoom; today: string }) {
  if (today < axis.start || today > axis.end) return null;
  return (
    <div
      aria-hidden
      data-testid="today-line"
      className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-cortex-500 opacity-70"
      style={{ left: dayOffset(axis, today) * PX_PER_DAY[zoom] }}
    />
  );
}

export function ZoomControl({ zoom, onChange }: { zoom: Zoom; onChange: (zoom: Zoom) => void }) {
  return (
    <SegmentedControl
      size="sm"
      ariaLabel="Time scale"
      options={ZOOM_LABELS.map((z) => ({
        value: z.value,
        label: z.label,
        testId: `zoom-${z.value}`,
      }))}
      value={zoom}
      onChange={(v) => onChange(v as Zoom)}
    />
  );
}

/**
 * Keep the date you were reading under the middle of the viewport when the
 * scale changes.
 *
 * Zoom used to leave `scrollLeft` untouched, and the same pixel offset means a
 * different date at every scale — so coming out of Quarter dropped you years
 * from what you were looking at, on a view whose whole job is orientation in
 * time. Call `capture()` immediately before the zoom state changes; the
 * restore runs before paint, so nothing is drawn at the wrong offset first.
 */
export function useZoomAnchor(
  axis: Span,
  zoom: Zoom,
  gutter: number,
): { scrollerRef: RefObject<HTMLDivElement | null>; capture: () => void } {
  // The hook owns the ref rather than taking one: writing `scrollLeft` on an
  // element reached through a hook ARGUMENT is a props mutation as far as the
  // react-hooks/immutability rule is concerned, and it is right that it is.
  const scroller = useRef<HTMLDivElement | null>(null);
  const pending = useRef<string | null>(null);
  // The axis itself changes with the zoom (padding is scaled), so the restore
  // has to read the NEW axis — which is what it sees, running after render.
  const latest = useRef({ axis, zoom, gutter });
  latest.current = { axis, zoom, gutter };

  useLayoutEffect(() => {
    const iso = pending.current;
    pending.current = null;
    const el = scroller.current;
    // jsdom reports every width as 0; so does a view that has not laid out
    // yet. Scrolling to a centre of zero would pin the axis to its first day.
    if (iso === null || el === null || el.clientWidth === 0) return;
    el.scrollLeft = scrollToCentre(
      latest.current.axis,
      latest.current.zoom,
      iso,
      el.clientWidth,
      latest.current.gutter,
    );
  }, [zoom]);

  return {
    scrollerRef: scroller,
    capture: () => {
      const el = scroller.current;
      if (el === null || el.clientWidth === 0) return;
      const { axis: a, zoom: z, gutter: g } = latest.current;
      pending.current = dateAtCentre(a, z, el.scrollLeft, el.clientWidth, g);
    },
  };
}

export interface TimeTableColumn {
  def: ColumnDef;
  width: number;
}

/**
 * The table half beside the axis (M16.24).
 *
 * Gantt had one and Timeline did not, "by design" — but the design argument
 * only ever covered the NAME gutter, and neither could show a property. The
 * gutter was also a private module constant (`NAME_W = 300`): not state, not a
 * prop, not persisted, so it could not be shown, hidden or resized. It is one
 * component now, so a row is the same height and the same shape in both, which
 * is the only reason the two halves stay aligned as rows collapse.
 */
export function TimeTable({
  rows,
  schema,
  columns,
  nameWidth,
  nameLabel = 'Name',
  isCollapsed,
  onToggle,
  onOpen,
  onResize,
}: {
  rows: RenderRow[];
  schema: Schema;
  /** The view's visible properties, beside the name. */
  columns: TimeTableColumn[];
  nameWidth: number;
  nameLabel?: string;
  isCollapsed: (key: string) => boolean;
  onToggle: (key: string) => void;
  onOpen: (path: string) => void;
  onResize: (width: number) => void;
}) {
  const total = nameWidth + columns.reduce((sum, c) => sum + c.width, 0);
  return (
    <div
      data-testid="time-table"
      className="sticky left-0 z-30 flex-none bg-n-0"
      style={{ width: total }}
    >
      <div className="flex border-b border-n-200 bg-n-25" style={{ height: HEAD_H }}>
        <div
          className="relative flex flex-none items-center border-r border-n-200 px-3 text-xs font-semibold text-n-600"
          style={{ width: nameWidth }}
        >
          {nameLabel}
          <ResizeHandle
            label="Table width"
            side="right"
            width={nameWidth}
            min={140}
            max={640}
            onResize={onResize}
          />
        </div>
        {columns.map((c) => (
          <div
            key={c.def.name}
            className="flex flex-none items-center overflow-hidden truncate border-r border-n-200 px-2 text-xs font-semibold text-n-600"
            style={{ width: c.width }}
          >
            {humanize(c.def.name)}
          </div>
        ))}
      </div>
      {rows.map((row) => {
        if (row.kind === 'add') return null;
        if (row.kind === 'band') {
          return (
            <button
              key={row.key}
              type="button"
              data-testid="time-table-band"
              onClick={() => onToggle(row.key)}
              className="flex w-full items-center gap-2 border-b border-r border-n-100 bg-n-25 text-left"
              style={{ height: BAND_H, paddingLeft: 12 + row.node.depth * INDENT }}
            >
              <Icon
                name={isCollapsed(row.key) ? 'chevron-right' : 'chevron-down'}
                size={12}
                color="var(--n-400)"
              />
              <span className="truncate text-xs font-semibold text-n-800">{row.node.label}</span>
              <span className="[font-family:var(--font-mono)] text-2xs text-n-400">
                {row.node.count}
              </span>
            </button>
          );
        }
        const style = typeStyle(row.entry.type, schema);
        return (
          <div key={row.key} className="flex" style={{ height: ROW_H }}>
            <div
              data-testid="time-table-name"
              data-depth={row.depth}
              className="flex flex-none items-center gap-1.5 overflow-hidden border-b border-r border-n-100 pr-2"
              style={{ width: nameWidth, paddingLeft: 10 + row.depth * INDENT }}
            >
              {row.childCount > 0 ? (
                <button
                  type="button"
                  aria-expanded={!isCollapsed(row.key)}
                  aria-label={`${isCollapsed(row.key) ? 'Expand' : 'Collapse'} ${row.entry.title}`}
                  onClick={() => onToggle(row.key)}
                  className="flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-n-400 hover:bg-n-100"
                >
                  <Icon name={isCollapsed(row.key) ? 'chevron-right' : 'chevron-down'} size={12} />
                </button>
              ) : (
                <span className="h-4 w-4 flex-none" />
              )}
              <Icon name={style.icon} size={12} color={style.color ?? 'var(--n-400)'} />
              <button
                type="button"
                onClick={() => onOpen(row.entry.path)}
                className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-sm text-n-900 hover:underline"
              >
                {row.entry.title}
              </button>
            </div>
            {columns.map((c) => {
              // Read-only on purpose: the table LAYOUT is where a value is
              // edited, and an editor here would need the row height a date
              // popover wants inside a 30px schedule row.
              const display = schema.resolveField(row.entry, c.def.name).display;
              return (
                <div
                  key={c.def.name}
                  data-testid="time-table-cell"
                  className="flex flex-none items-center overflow-hidden border-b border-r border-n-100 px-2"
                  style={{ width: c.width }}
                >
                  <span className="truncate whitespace-nowrap text-sm text-n-600">
                    {display === '' ? '—' : display}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Indent per nesting level, matching the group-band step. */
const INDENT = 16;

/**
 * The two edge handles that change a bar's start and end (M16.24).
 *
 * Siblings of the bar rather than children of it: the bar is a `<button>` that
 * opens the record, and a button inside a button is not valid HTML and not
 * reachable by the keyboard in the order it looks like it should be. Each grip
 * is its own button, so Tab reaches it and arrows move that one endpoint.
 */
export function ResizeGrips({
  id,
  title,
  left,
  width,
  top,
  height,
  drag,
}: {
  id: string;
  title: string;
  left: number;
  width: number;
  top: number;
  height: number;
  drag: TimeDrag;
}) {
  const grip = (edge: 'start' | 'end') => (
    <button
      key={edge}
      type="button"
      data-testid={`bar-grip-${edge}`}
      data-path={id}
      aria-label={`Change ${edge === 'start' ? 'start' : 'end'} date of ${title}`}
      {...drag.handleProps(id, edge)}
      className={[
        'absolute z-10 cursor-col-resize touch-none rounded-xs border-0 bg-transparent p-0',
        'opacity-0 hover:bg-cortex-600 focus-visible:opacity-100 hover:opacity-100',
      ].join(' ')}
      style={{
        // Straddles the edge so it is grabbable from either side of a thin bar.
        left: (edge === 'start' ? left : left + width) - GRIP_W / 2,
        width: GRIP_W,
        top,
        height,
      }}
    />
  );
  return (
    <>
      {grip('start')}
      {grip('end')}
    </>
  );
}

const GRIP_W = 8;
