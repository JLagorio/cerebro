import { SegmentedControl } from '@/components/ui/SegmentedControl';
import {
  axisWidth,
  dayOffset,
  PX_PER_DAY,
  ZOOM_LABELS,
  type AxisTick,
  type Span,
  type Zoom,
} from '@/engine/schedule';

/**
 * The horizontal date axis shared by Timeline and Gantt (M10).
 *
 * Both views place bars against the same ruler; only what occupies the rows
 * differs (swimlanes of records vs a nested work breakdown with dependency
 * arrows). Sharing the axis is what keeps a bar at the same x in both.
 */

export const ROW_H = 30;

export function TimeAxisHeader({
  ticks,
  axis,
  zoom,
}: {
  ticks: AxisTick[];
  axis: Span;
  zoom: Zoom;
}) {
  return (
    <div
      role="row"
      className="sticky top-0 z-20 flex h-8 border-b border-[var(--n-200)] bg-[var(--n-25)]"
      style={{ width: axisWidth(axis, zoom) }}
    >
      {ticks.map((tick) => (
        <div
          key={tick.iso}
          role="columnheader"
          data-testid="axis-tick"
          data-major={tick.major}
          className={[
            'flex flex-none items-center overflow-hidden whitespace-nowrap px-1 text-[11px]',
            tick.major
              ? 'border-l border-[var(--n-300)] font-semibold text-[var(--n-700)]'
              : 'border-l border-[var(--n-100)] text-[var(--n-500)]',
          ].join(' ')}
          style={{ width: tick.days * PX_PER_DAY[zoom] }}
        >
          {tick.label}
        </div>
      ))}
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
          className={[
            'flex-none border-l',
            tick.major ? 'border-[var(--n-200)]' : 'border-[var(--n-100)]',
          ].join(' ')}
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
      className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-[var(--danger-500)] opacity-70"
      style={{ left: dayOffset(axis, today) * PX_PER_DAY[zoom] }}
    />
  );
}

export function ZoomControl({ zoom, onChange }: { zoom: Zoom; onChange: (zoom: Zoom) => void }) {
  return (
    <SegmentedControl
      size="sm"
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
