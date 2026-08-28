import { useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, Ref, RefObject } from 'react';
import { PICKABLE_OPTION_COLORS, resolveOptionColor } from '@/lib/swatch';
import { EmptyState } from '@/components/ui/EmptyState';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { MenuItem, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { seedView } from '@/app/viewActions';
import { useOpenPath } from '@/app/useOpenPath';
import { useUiStore } from '@/stores/uiStore';
import { copyChartPng, copyChartSvg, saveChartPng, saveChartSvg } from '@/views/chartExport';
import { computeChart, niceCeiling } from '@/engine/chart';
import { bandKind, bandValueFor, NO_VALUE_KEY } from '@/engine/grouping';
import { filterOpsFor } from '@/engine/viewFilters';
import type { ChartData, ChartRosterItem, ChartSlice, ChartSlicePart } from '@/engine/chart';
import type {
  ChartHeight,
  ChartKind,
  ChartSpec,
  Entry,
  FieldKind,
  FilterGroup,
  FilterRule,
  Presentation,
  Schema,
  ViewDefinition,
} from '@/engine/types';

/**
 * Chart (M16.27) — bar, line, donut or one big number (M44.2) over an
 * aggregation of the same rows every other layout shows.
 *
 * The SVG is written here rather than pulled in. A charting library would be a
 * runtime dependency, a bundle, and a CSP surface for three shapes the browser
 * already draws — and this app renders its own UI everywhere else.
 *
 * Colours come from the token layer, never from a hardcoded palette: a band
 * that declares an option colour draws in it, and one that declares none takes
 * the next `--opt-*` hue in Notion's order. Everything else — gridlines, axis,
 * labels — is a neutral token, so the chart follows the theme instead of
 * fighting it.
 */

export interface ChartViewProps {
  /** Filtered and sorted by the caller. */
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** True when the view has filters, so the empty state can say why. Required,
   * not optional — see BoardViewProps.filtered (M16.35). */
  filtered: boolean;
  /** Persists a legend toggle into the view's chart spec (M44.3). Absent —
   * an embedded dashboard chart — the legend renders static. */
  onChartChange?: (next: ChartSpec) => void;
  /** The open tab's filter group, which a drilldown's saved view must keep —
   * the band rule NARROWS what the chart shows, and the chart shows the
   * filtered set (M44.3). */
  viewFilters?: FilterGroup | null;
  /** Appends a drilldown-minted view to the host's tab roster and opens it
   * (M44.3). Absent — an embedded dashboard chart — the drilldown still lists
   * and opens records, but offers no Save. */
  onSaveView?: (view: ViewDefinition) => void;
}

const W = 640;
const PAD = { top: 16, right: 16, bottom: 52, left: 56 };
const PLOT_W = W - PAD.left - PAD.right;
const TICKS = 4;

const HEIGHT_PX: Record<ChartHeight, number> = { s: 220, m: 320, l: 440, xl: 560 };

/** Vertical geometry, from the spec's height preset. 'm' is the pre-M44.2 320. */
function plotDims(chart: ChartSpec | undefined): { H: number; PLOT_H: number } {
  const H = HEIGHT_PX[chart?.height ?? 'm'];
  return { H, PLOT_H: H - PAD.top - PAD.bottom };
}

/** The palette's base hue: the swatch the word names, or the first pickable
 * hue when it resolves to `default` — neutral grey draws every band alike. */
function paletteBase(palette: string): string {
  const swatch = resolveOptionColor(palette);
  return swatch.name !== 'default' ? swatch.solid : `var(--opt-${PICKABLE_OPTION_COLORS[0]})`;
}

/**
 * A band's colour: its own when it declares one, otherwise the next hue in the
 * option palette.
 *
 * The palette fallback matters — grouping by a text property gives every band
 * `color: null`, and a chart drawn in one colour cannot be read at all. The
 * no-value bucket stays neutral on purpose: "no status" is an absence, and
 * giving it a hue makes it look like one more status.
 */
export function sliceColor(
  // Structural on purpose: a slice, a stacked part, and a legend roster item
  // (which carries no `ghost`) all colour through the one rule (M44.3).
  slice: { key: string; color: string | null; ghost?: boolean },
  index: number,
  opts?: { palette?: string; share?: number },
): string {
  if (opts?.palette !== undefined) {
    const base = paletteBase(opts.palette);
    if (opts.share === undefined) return base;
    // 35%–100% of the hue against the app surface: the smallest band stays visible.
    const pct = Math.round(35 + 65 * Math.max(0, Math.min(1, opts.share)));
    return `color-mix(in srgb, ${base} ${pct}%, var(--surface-app))`;
  }
  if (slice.key === '__none__') return 'var(--n-300)';
  if (!slice.ghost && slice.color !== null) {
    const swatch = resolveOptionColor(slice.color);
    // `default` is what an unrecognised colour resolves to; taking its
    // neutral grey would draw several bands identically.
    if (swatch.name !== 'default') return swatch.solid;
  }
  return `var(--opt-${PICKABLE_OPTION_COLORS[index % PICKABLE_OPTION_COLORS.length]})`;
}

/** The options bag every sliceColor call site threads: the spec's palette,
 * and — under colorByValue — this band's share of the biggest one. */
function colorOpts(
  chart: ChartSpec | undefined,
  data: ChartData,
  s: ChartSlice,
): { palette?: string; share?: number } {
  return {
    palette: chart?.palette,
    share: chart?.colorByValue === true && data.max > 0 ? s.value / data.max : undefined,
  };
}

/** The line's path: straight segments, or a Catmull-Rom curve through the
 * same points when `smooth` — two points have no curvature to smooth. */
function linePath(pts: { x: number; y: number }[], smooth: boolean): string {
  if (pts.length === 0) return '';
  if (!smooth || pts.length < 3)
    return (
      `M${pts[0].x},${pts[0].y}` +
      pts
        .slice(1)
        .map((p) => ` L${p.x},${p.y}`)
        .join('')
    );
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    d += ` C${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6},${p2.y - (p3.y - p1.y) / 6} ${p2.x},${p2.y}`;
  }
  return d;
}

/** Tick labels, trimmed — a 4-way split of 25 is 6.25, not 6.25000000001. */
const tick = (n: number) => String(Number(n.toFixed(2)));

/** X labels sit in a band a few dozen pixels wide; the full text is in the
 * DOM tooltip that hovering the band's shape shows (M44.3). */
function clip(label: string, band: number): string {
  const max = Math.max(4, Math.floor(band / 7));
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

/** The caption's trailing clauses — only DEVIATIONS are worth a word.
 * `kind` matters here too: computeChart ignores `cumulative` for a donut (a
 * ring of running totals would lie), so the caption must not claim one
 * either — a hand-edited `kind: donut` + `cumulative: true` is reachable via
 * the vault even though the panel never produces that combination. */
function captionNotes(chart: ChartSpec | undefined, kind: ChartKind): string[] {
  const notes: string[] = [];
  if (chart?.cumulative === true && kind !== 'donut') notes.push('cumulative');
  // An avg BAR under groupBy: each segment is its sub-band's average and the
  // bar's height is their SUM. The caption reads "Average of X", so this
  // clause names the deviation (M44.3). Bars only — a multi-series LINE
  // draws each series' own averages and stacks nothing, so the summed value
  // appears nowhere, and a donut ignores groupBy entirely.
  if (chart?.agg === 'avg' && chart.groupBy !== undefined && kind === 'bar')
    notes.push('stacked averages');
  if (chart?.sort === 'value-desc') notes.push('biggest first');
  if (chart?.sort === 'value-asc') notes.push('smallest first');
  if (chart?.sort === 'label') notes.push('A to Z');
  if (chart?.omitZero === true) notes.push('zeroes omitted');
  return notes;
}

function Axes({
  top,
  label,
  plotH,
  hideGrid,
  hideAxis,
}: {
  top: number;
  label: string;
  plotH: number;
  hideGrid: boolean;
  hideAxis: boolean;
}) {
  return (
    <g>
      {Array.from({ length: TICKS + 1 }, (_, i) => {
        // The base line survives both toggles — a chart with no ground under
        // its bars reads broken, not minimal.
        const base = i === TICKS;
        const value = (top * (TICKS - i)) / TICKS;
        const y = PAD.top + (plotH * i) / TICKS;
        return (
          <g key={i}>
            {(base || !hideGrid) && (
              <line
                data-testid={base ? undefined : 'chart-grid-line'}
                x1={PAD.left}
                x2={PAD.left + PLOT_W}
                y1={y}
                y2={y}
                stroke={base ? 'var(--n-300)' : 'var(--n-200)'}
                strokeWidth={1}
              />
            )}
            {!hideAxis && (
              <text
                data-testid="chart-tick"
                x={PAD.left - 8}
                y={y + 3.5}
                textAnchor="end"
                fontSize={10}
                fill="var(--n-400)"
                fontFamily="var(--font-mono)"
              >
                {tick(value)}
              </text>
            )}
          </g>
        );
      })}
      {!hideAxis && (
        <text x={PAD.left - 8} y={PAD.top - 6} textAnchor="end" fontSize={10} fill="var(--n-500)">
          {label}
        </text>
      )}
    </g>
  );
}

function XLabels({ slices, band, plotH }: { slices: ChartSlice[]; band: number; plotH: number }) {
  return (
    <g>
      {slices.map((s, i) => (
        <text
          key={s.key || s.label}
          x={PAD.left + band * i + band / 2}
          y={PAD.top + plotH + 16}
          textAnchor="middle"
          fontSize={10.5}
          fill="var(--n-500)"
        >
          {clip(s.label, band)}
        </text>
      ))}
    </g>
  );
}

/** Pointer wiring every band shape shares (M44.3): enter and move report the
 * band under the pointer, leave clears it, and CLICK opens the drilldown. A
 * stacked segment HOVERS as its whole BAND — the tooltip's per-series rows
 * disambiguate, and the card holding still while the pointer crosses segments
 * beats it flickering per stripe — but CLICKS as its own sub-band: a click is
 * an aimed act, and the segment is what was aimed at. */
interface SliceEvents {
  onHover: (slice: ChartSlice, e: ReactMouseEvent) => void;
  onLeave: () => void;
  onOpen: (slice: ChartSlice, part?: ChartSlicePart) => void;
}

/** The handler attributes, spread onto each shape. Segments pass their part. */
function shapeAttrs(events: SliceEvents, slice: ChartSlice, part?: ChartSlicePart) {
  return {
    onMouseEnter: (e: ReactMouseEvent) => events.onHover(slice, e),
    onMouseMove: (e: ReactMouseEvent) => events.onHover(slice, e),
    onMouseLeave: events.onLeave,
    onClick: () => events.onOpen(slice, part),
    className: 'cursor-pointer',
  };
}

/** Where each stacked segment starts, laid out before render — the same
 * accumulator-outside-`.map()` shape as `arcs` below, for the same lint
 * reason. Parts arrive visible-only and in series order from the engine. */
function stackLayout(parts: ChartSlicePart[]): { part: ChartSlicePart; start: number }[] {
  let offset = 0;
  return parts.map((part) => {
    const start = offset;
    offset += part.value;
    return { part, start };
  });
}

function BarChart({
  data,
  chart,
  plotH,
  events,
}: {
  data: ChartData;
  chart: ChartSpec | undefined;
  plotH: number;
  events: SliceEvents;
}) {
  const top = niceCeiling(data.max);
  const band = PLOT_W / data.slices.length;
  const width = Math.min(56, band * 0.62);
  return (
    <>
      <Axes
        top={top}
        label={data.measure}
        plotH={plotH}
        hideGrid={chart?.hideGrid === true}
        hideAxis={chart?.hideAxis === true}
      />
      {data.slices.map((s, i) => {
        const height = (s.value / top) * plotH;
        const x = PAD.left + band * i + (band - width) / 2;
        return (
          <g key={s.key || s.label}>
            {s.parts !== undefined && s.parts.length > 0 ? (
              // Under groupBy the segments ARE the bar: they stack to exactly
              // the band value, so no whole-band rect sits underneath.
              stackLayout(s.parts).map(({ part, start }) =>
                // Two skips live in this `<= 0`. A measured-ZERO segment is
                // fine to drop: inside a stack it has no geometry to claim —
                // unlike the whole-bar 1px rule, where an empty axis slot
                // would read as "no band here". A NEGATIVE part is a real
                // limitation: a stack cannot draw one honestly, so it is
                // discarded rather than drawn as a lie.
                part.value <= 0 ? null : (
                  <rect
                    key={part.key || part.label}
                    data-testid="chart-bar-segment"
                    data-label={s.label}
                    data-series={part.label}
                    data-value={part.value}
                    x={x}
                    y={PAD.top + plotH - ((start + part.value) / top) * plotH}
                    width={width}
                    height={(part.value / top) * plotH}
                    fill={sliceColor(part, part.hue, colorOpts(chart, data, s))}
                    {...shapeAttrs(events, s, part)}
                  />
                ),
              )
            ) : (
              <rect
                data-testid="chart-bar"
                data-label={s.label}
                data-value={s.value}
                x={x}
                // A zero-height rect is invisible; 1px says "measured, and it
                // is zero" rather than "no band here".
                y={PAD.top + plotH - Math.max(height, s.value > 0 ? 1 : 0)}
                width={width}
                height={Math.max(height, s.value > 0 ? 1 : 0)}
                rx={3}
                fill={sliceColor(s, s.hue, colorOpts(chart, data, s))}
                {...shapeAttrs(events, s)}
              />
            )}
            {chart?.hideLabels !== true && band > 34 && (
              <text
                x={PAD.left + band * i + band / 2}
                y={PAD.top + plotH - height - 5}
                textAnchor="middle"
                fontSize={10}
                fill="var(--n-500)"
                fontFamily="var(--font-mono)"
              >
                {s.display}
              </text>
            )}
          </g>
        );
      })}
      {chart?.hideAxis !== true && <XLabels slices={data.slices} band={band} plotH={plotH} />}
    </>
  );
}

const HPAD = { top: 16, right: 44, bottom: 16, left: 120 };

/** Horizontal bars: categories run down the page, values run along x. Used
 * when `chart.horizontal` is set — the same slices a vertical BarChart would
 * draw, laid out sideways so long labels get room to breathe. */
function HBarChart({
  data,
  chart,
  h,
  events,
}: {
  data: ChartData;
  chart: ChartSpec | undefined;
  h: number;
  events: SliceEvents;
}) {
  const plotW = W - HPAD.left - HPAD.right;
  const plotH = h - HPAD.top - HPAD.bottom;
  const top = niceCeiling(data.max);
  const band = plotH / data.slices.length;
  const barH = Math.min(28, band * 0.62);
  return (
    <>
      {data.slices.map((s, i) => {
        // `top` is `niceCeiling(data.max)`, which clamps to >= 1 for any
        // finite input — never 0, so there is no zero-division case here.
        const width = (s.value / top) * plotW;
        const y = HPAD.top + band * i + (band - barH) / 2;
        // A maxed bar leaves a wide value label no room before the viewBox
        // edge (~6.6px per character at fontSize 11) — draw it inside the bar
        // end instead of letting it clip past 640.
        const fits = HPAD.left + width + 6 + s.display.length * 6.6 <= W - 8;
        return (
          <g key={s.key || s.label}>
            <text
              x={HPAD.left - 8}
              y={y + barH / 2}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={11}
              fill="var(--n-500)"
            >
              {clip(s.label, HPAD.left)}
            </text>
            {s.parts !== undefined && s.parts.length > 0 ? (
              // The vertical chart's rule, laid sideways: segments stack
              // along x and no whole-band rect sits underneath. The `<= 0`
              // skip is BarChart's — zero has no geometry to claim inside a
              // stack, negative cannot be drawn honestly — see the full
              // argument on the vertical segments.
              stackLayout(s.parts).map(({ part, start }) =>
                part.value <= 0 ? null : (
                  <rect
                    key={part.key || part.label}
                    data-testid="chart-bar-segment"
                    data-label={s.label}
                    data-series={part.label}
                    data-value={part.value}
                    x={HPAD.left + (start / top) * plotW}
                    y={y}
                    width={(part.value / top) * plotW}
                    height={barH}
                    fill={sliceColor(part, part.hue, colorOpts(chart, data, s))}
                    {...shapeAttrs(events, s, part)}
                  />
                ),
              )
            ) : (
              <rect
                data-testid="chart-bar"
                data-label={s.label}
                data-value={s.value}
                x={HPAD.left}
                y={y}
                width={s.value > 0 ? Math.max(1, width) : width}
                height={barH}
                rx={3}
                fill={sliceColor(s, s.hue, colorOpts(chart, data, s))}
                {...shapeAttrs(events, s)}
              />
            )}
            {chart?.hideLabels !== true && (
              <text
                x={fits ? HPAD.left + width + 6 : HPAD.left + width - 6}
                y={y + barH / 2}
                textAnchor={fits ? 'start' : 'end'}
                dominantBaseline="central"
                fontSize={11}
                fill={fits ? 'var(--n-500)' : 'var(--n-0)'}
              >
                {s.display}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

/** One drawn point of one series' line: its geometry plus the band and part
 * that put it there, for the point's data attributes and title. */
type SeriesPoint = { x: number; y: number; s: ChartSlice; part: ChartSlicePart };

function LineChart({
  data,
  chart,
  plotH,
  events,
}: {
  data: ChartData;
  chart: ChartSpec | undefined;
  plotH: number;
  events: SliceEvents;
}) {
  const top = niceCeiling(data.max);
  const band = PLOT_W / data.slices.length;
  const at = (s: ChartSlice, i: number) => ({
    x: PAD.left + band * i + band / 2,
    y: PAD.top + plotH - (s.value / top) * plotH,
  });
  // The multi-series pivot (M44.3): one path per VISIBLE series, points read
  // from each band's matching part. Two rules govern a band that lacks the
  // series: under plain rendering it gets NO point and the path BREAKS — one
  // subpath per run of consecutive present bands, because a straight
  // connector across the missing band would be an interpolated value nobody
  // measured — and under cumulative the engine's synthesized plateau parts
  // carry every begun series into every band, so the lines are continuous.
  // `area` stays single-series only: overlapping washes at one opacity read
  // as mud, not as data.
  if (data.series.length > 0) {
    // The Y extent is the tallest DRAWN value. `data.max` is the band's
    // stack sum, but a line draws part values — against a stack ceiling no
    // series could ever reach the top of its own chart.
    const seriesTop = niceCeiling(
      data.slices.reduce((m, s) => (s.parts ?? []).reduce((mm, p) => Math.max(mm, p.value), m), 0),
    );
    return (
      <>
        <Axes
          top={seriesTop}
          label={data.measure}
          plotH={plotH}
          hideGrid={chart?.hideGrid === true}
          hideAxis={chart?.hideAxis === true}
        />
        {data.series
          .filter((item) => !item.hidden)
          .map((item) => {
            // Runs of consecutive present bands — each becomes its own
            // `M…` subpath, so a missing band stays a visible gap.
            const runs: SeriesPoint[][] = [];
            let current: SeriesPoint[] = [];
            for (let i = 0; i < data.slices.length; i++) {
              const s = data.slices[i];
              const part = s.parts?.find((p) => p.key === item.key);
              if (part === undefined) {
                if (current.length > 0) runs.push(current);
                current = [];
                continue;
              }
              current.push({
                x: PAD.left + band * i + band / 2,
                y: PAD.top + plotH - (part.value / seriesTop) * plotH,
                s,
                part,
              });
            }
            if (current.length > 0) runs.push(current);
            const pts = runs.flat();
            if (pts.length === 0) return null;
            const seriesStroke = sliceColor(item, item.hue, { palette: chart?.palette });
            return (
              <g key={item.key || item.label}>
                <path
                  data-testid="chart-line"
                  data-series={item.label}
                  d={runs.map((run) => linePath(run, chart?.smooth === true)).join(' ')}
                  fill="none"
                  stroke={seriesStroke}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {pts.map((p) => (
                  <circle
                    key={p.s.key || p.s.label}
                    data-testid="chart-point"
                    data-series={item.label}
                    data-label={p.s.label}
                    data-value={p.part.value}
                    cx={p.x}
                    cy={p.y}
                    r={3.5}
                    fill="var(--n-0)"
                    stroke={seriesStroke}
                    strokeWidth={2}
                    {...shapeAttrs(events, p.s, p.part)}
                  />
                ))}
              </g>
            );
          })}
        {chart?.hideAxis !== true && <XLabels slices={data.slices} band={band} plotH={plotH} />}
      </>
    );
  }
  const points = data.slices.map((s, i) => at(s, i));
  // One line, one hue: the palette when the spec declares one, cortex
  // otherwise. Per-band colours would claim the line is several series.
  const stroke = chart?.palette !== undefined ? paletteBase(chart.palette) : 'var(--cortex-500)';
  return (
    <>
      <Axes
        top={top}
        label={data.measure}
        plotH={plotH}
        hideGrid={chart?.hideGrid === true}
        hideAxis={chart?.hideAxis === true}
      />
      {chart?.area === true && points.length > 1 && (
        <path
          data-testid="chart-area"
          d={`${linePath(points, chart?.smooth === true)} L${points.at(-1)!.x},${PAD.top + plotH} L${points[0].x},${PAD.top + plotH} Z`}
          fill={stroke}
          fillOpacity={0.12}
        />
      )}
      <path
        data-testid="chart-line"
        d={linePath(points, chart?.smooth === true)}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {data.slices.map((s, i) => (
        <circle
          key={s.key || s.label}
          data-testid="chart-point"
          data-label={s.label}
          data-value={s.value}
          cx={points[i].x}
          cy={points[i].y}
          r={3.5}
          fill="var(--n-0)"
          stroke={
            chart?.palette !== undefined ? sliceColor(s, s.hue, colorOpts(chart, data, s)) : stroke
          }
          strokeWidth={2}
          {...shapeAttrs(events, s)}
        />
      ))}
      {chart?.hideAxis !== true && <XLabels slices={data.slices} band={band} plotH={plotH} />}
    </>
  );
}

const DONUT = { size: 240, r: 92, stroke: 34 };

/**
 * Where each arc starts and how long it is, laid out before render.
 *
 * A running total inside `.map()` is the obvious way to write this and the
 * lint rule refuses it, correctly: the accumulator survives the render it was
 * declared in, so a re-render resumes from wherever the last one stopped.
 */
function arcs(data: ChartData, circumference: number) {
  let offset = 0;
  return data.slices.map((slice) => {
    const length = (slice.value / data.total) * circumference;
    const start = offset;
    offset += length;
    return { slice, start, length };
  });
}

function DonutChart({
  data,
  chart,
  events,
  svgRef,
}: {
  data: ChartData;
  chart: ChartSpec | undefined;
  events: SliceEvents;
  /** The export menu's aim: the donut draws its OWN svg root (M44.3). */
  svgRef?: Ref<SVGSVGElement>;
}) {
  const c = DONUT.size / 2;
  const circumference = 2 * Math.PI * DONUT.r;
  const segments = arcs(data, circumference);
  return (
    <svg
      ref={svgRef}
      width={DONUT.size}
      height={DONUT.size}
      viewBox={`0 0 ${DONUT.size} ${DONUT.size}`}
      role="img"
      aria-label={`${data.measure} by ${data.axis}`}
      className="flex-none"
    >
      <circle
        cx={c}
        cy={c}
        r={DONUT.r}
        fill="none"
        stroke="var(--n-100)"
        strokeWidth={DONUT.stroke}
      />
      {/* -90° so the first slice starts at twelve o'clock, which is where a
          reader starts. */}
      <g transform={`rotate(-90 ${c} ${c})`}>
        {segments.map(({ slice: s, start, length }) =>
          // A zero-value band contributes no arc: `stroke-dasharray: 0 …`
          // still paints a linecap-width hairline at twelve o'clock.
          s.value <= 0 ? null : (
            <circle
              key={s.key || s.label}
              data-testid="chart-arc"
              data-label={s.label}
              data-value={s.value}
              cx={c}
              cy={c}
              r={DONUT.r}
              fill="none"
              stroke={sliceColor(s, s.hue, colorOpts(chart, data, s))}
              strokeWidth={DONUT.stroke}
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-start}
              {...shapeAttrs(events, s)}
            />
          ),
        )}
      </g>
      {chart?.hideDonutCenter !== true && (
        <g data-testid="chart-donut-total">
          <text
            x={c}
            y={c - 2}
            textAnchor="middle"
            fontSize={26}
            fontWeight={600}
            fill="var(--n-900)"
          >
            {tick(data.total)}
          </text>
          <text x={c} y={c + 18} textAnchor="middle" fontSize={11} fill="var(--n-500)">
            {data.measure}
          </text>
        </g>
      )}
    </svg>
  );
}

/** One legend for every kind, under the chart — and, when the host supplies
 * `onChartChange`, the chart's switchboard (M44.3): rows render from the
 * ROSTERS, hidden entries included, and each toggles its key in
 * `hidden`/`hiddenG`. A hidden row keeps its swatch but shows its label only
 * — its display value is stale by definition — struck through, so the way
 * back stays visible. Without the writer (an embedded dashboard chart) the
 * rows stay static spans.
 *
 * A no-palette SINGLE-series line draws in LineChart's one uniform
 * `var(--cortex-500)` stroke, so its band swatches show that — per-band
 * option hues would be swatches matching nothing actually drawn. With
 * multiple series the per-series strokes ARE what is drawn, so the mono rule
 * does not apply; a palette line already colours through `sliceColor`. */
function Legend({
  data,
  chart,
  kind,
  onChartChange,
}: {
  data: ChartData;
  chart: ChartSpec | undefined;
  kind: ChartKind;
  onChartChange?: (next: ChartSpec) => void;
}) {
  const lineMono = kind === 'line' && chart?.palette === undefined && data.series.length === 0;
  const toggle = (prop: 'hidden' | 'hiddenG', key: string) => {
    if (onChartChange === undefined) return;
    // Build the next array from the CURRENT spec; an emptied array leaves
    // the spec entirely — no `hidden: []` residue in the view file.
    const current = (prop === 'hidden' ? chart?.hidden : chart?.hiddenG) ?? [];
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    const spec: ChartSpec = { ...chart };
    if (next.length === 0) delete spec[prop];
    else spec[prop] = next;
    onChartChange(spec);
  };
  const row = (
    item: ChartRosterItem,
    prop: 'hidden' | 'hiddenG',
    testid: string,
    swatch: string,
    display: string | undefined,
  ) => {
    const tone = item.hidden ? 'text-n-400 line-through' : 'text-n-600';
    const body = (
      <>
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: swatch }} />
        {item.label}
        {display !== undefined && (
          <span className="[font-family:var(--font-mono)] text-2xs text-n-500">{display}</span>
        )}
      </>
    );
    return (
      <li
        key={item.key || item.label}
        data-testid={testid}
        className={`flex items-center gap-1.5 text-xs ${tone}`}
      >
        {onChartChange === undefined ? (
          body
        ) : (
          // line-through does not propagate into an atomic inline box, so the
          // button repeats the tone classes rather than inheriting them.
          <button
            type="button"
            aria-pressed={!item.hidden}
            onClick={() => toggle(prop, item.key)}
            className={`flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-xs ${tone}`}
          >
            {body}
          </button>
        )}
      </li>
    );
  };
  return (
    <>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 pt-3">
        {data.bands.map((item) => {
          // The visible slice carries the display value and the colorByValue
          // share; a hidden band has neither, and claims neither.
          const slice = data.slices.find((s) => s.key === item.key);
          const swatch = lineMono
            ? 'var(--cortex-500)'
            : sliceColor(
                item,
                item.hue,
                slice !== undefined ? colorOpts(chart, data, slice) : { palette: chart?.palette },
              );
          return row(item, 'hidden', 'chart-legend-item', swatch, slice?.display);
        })}
      </ul>
      {data.series.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 pt-1.5">
          {data.series.map((item) =>
            // A series has no one total to print — its values live per band —
            // so its row is label-only, visible or not.
            row(
              item,
              'hiddenG',
              'chart-legend-series',
              sliceColor(item, item.hue, { palette: chart?.palette }),
              undefined,
            ),
          )}
        </ul>
      )}
    </>
  );
}

/**
 * The hover card (M44.3) — the chart's only tooltip, replacing the SVG-native
 * `<title>` children the shapes used to carry.
 *
 * Three honesty rules govern its rows. Share is a percentage of the VISIBLE
 * total — what the reader sees is the whole it is a share of. Under
 * cumulative there is NO Share row: a band's `value` there IS the running
 * total, so a share of it is a lie, and the row count speaks instead. And the
 * records line always uses `count` — the band's true rows — never `value`,
 * which cumulative mutates.
 */
const MONO = '[font-family:var(--font-mono)] text-n-500';

function ChartTooltip({
  slice: s,
  x,
  y,
  data,
  chart,
  running,
  figure,
}: {
  slice: ChartSlice;
  x: number;
  y: number;
  data: ChartData;
  chart: ChartSpec | undefined;
  /** True when the drawn values are running totals (cumulative, non-donut). */
  running: boolean;
  figure: RefObject<HTMLElement | null>;
}) {
  // Clamped into the figure box with the card's REAL rendered size — the
  // card grows a row per series, so an assumed height escapes the bottom
  // edge exactly when a tall stack is hovered near it. The layout effect
  // runs after every render (each hover updates x/y, and the hovered band
  // changes what the card holds), reads offsetWidth/offsetHeight, and writes
  // the clamped position straight onto the element — before paint, so the
  // unclamped style prop below never shows.
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (el === null) return;
    const box = figure.current?.getBoundingClientRect();
    el.style.left = `${Math.max(0, Math.min(x + 12, (box?.width ?? W) - el.offsetWidth))}px`;
    el.style.top = `${Math.max(0, Math.min(y + 12, (box?.height ?? 0) - el.offsetHeight))}px`;
  });
  const share = !running && data.total > 0 ? Math.round((s.value / data.total) * 100) : null;
  return (
    <div
      ref={cardRef}
      data-testid="chart-tooltip"
      className="pointer-events-none absolute z-10 min-w-32 rounded-lg border border-n-200 bg-n-0 px-2.5 py-1.5 text-xs shadow-[var(--shadow-lg)]"
      style={{ left: x + 12, top: y + 12 }}
    >
      <div className="font-semibold text-n-800">{s.label}</div>
      {s.parts !== undefined && s.parts.length > 0 && (
        <div className="flex flex-col gap-0.5 pt-1">
          {s.parts.map((part) => (
            <div key={part.key || part.label} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 flex-none rounded-sm"
                style={{ background: sliceColor(part, part.hue, colorOpts(chart, data, s)) }}
              />
              <span className="max-w-[240px] flex-1 truncate text-n-600">{part.label}</span>
              <span className={MONO}>{part.display}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1 flex flex-col gap-0.5 border-t border-n-100 pt-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-n-600">Total</span>
          <span className={MONO}>{s.display}</span>
        </div>
        {share !== null && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-n-600">Share</span>
            <span className={MONO}>{share}%</span>
          </div>
        )}
        <div className="text-n-500">
          {s.count} {s.count === 1 ? 'record' : 'records'}
        </div>
      </div>
    </div>
  );
}

/**
 * The figure's way out (M44.3): four affordances over the mermaid export
 * pipeline, aimed at whichever svg root this chart drew — the axis kinds'
 * shared one, or the donut's own. The host renders it only where an svg
 * exists: never for `number` (nothing drawn to leave), never for a blocked
 * state, never for the zero-total donut that draws prose instead of a ring.
 * The figure supplies the resolver probe's home and the ground the export
 * keeps, so a dark-theme chart leaves dark.
 */
function ExportMenu({
  svgRef,
  figureRef,
  name,
}: {
  svgRef: RefObject<SVGSVGElement | null>;
  figureRef: RefObject<HTMLElement | null>;
  /** The default filename stem — the caption's own sentence. */
  name: string;
}) {
  const toast = useUiStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // The lightbox's toast law (M29.5): a cancelled save resolves null and
  // gets NO toast — not a failure, not a success either. The copies resolve
  // undefined, which is `!== null`, so they always toast.
  const act = (
    success: string,
    failure: string,
    run: (el: SVGSVGElement, host: HTMLElement) => Promise<unknown>,
  ) => {
    setOpen(false);
    const el = svgRef.current;
    const host = figureRef.current;
    if (el === null || host === null) return;
    void run(el, host)
      .then((result) => {
        if (result !== null) toast(success);
      })
      .catch(() => toast(failure));
  };
  return (
    // stopPropagation: the figure is full of shapes whose click drills; a
    // menu interaction must never fall through into one.
    <div
      data-testid="chart-export"
      className="absolute right-2.5 top-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      <IconButton
        ref={btnRef}
        icon="download"
        label="Export chart"
        size="sm"
        onClick={() => setOpen(true)}
      />
      {open && (
        <Popover
          onClose={() => setOpen(false)}
          anchorRef={btnRef}
          role="menu"
          ariaLabel="Export chart"
        >
          <MenuSurface width={168}>
            <MenuItem
              label="Copy SVG"
              onSelect={() => act('SVG copied', 'Copy SVG failed', copyChartSvg)}
            />
            <MenuItem
              label="Copy PNG"
              onSelect={() => act('PNG copied', 'Copy PNG failed', copyChartPng)}
            />
            <MenuItem
              label="Save PNG…"
              onSelect={() =>
                act('PNG saved', 'Save PNG failed', (el, host) =>
                  saveChartPng(el, host, `${name}.png`),
                )
              }
            />
            <MenuItem
              label="Save SVG…"
              onSelect={() =>
                act('SVG saved', 'Save SVG failed', (el, host) =>
                  saveChartSvg(el, host, `${name}.svg`),
                )
              }
            />
          </MenuSurface>
        </Popover>
      )}
    </div>
  );
}

/** What an unchartable view says, and which control fixes it. Never a blank
 * box: "there is nothing here" and "you have not said what to chart" look
 * identical when both render as white space. */
const BLOCKED: Record<
  NonNullable<ChartData['blocked']>,
  { icon: string; title: string; description: string }
> = {
  'no-group': {
    icon: 'chart-column',
    title: 'Nothing to chart yet',
    description: 'Pick an X axis in chart settings, or group the view.',
  },
  'no-rows': {
    icon: 'chart-column',
    title: 'No records to chart',
    description: 'Widen the filters in view settings, or add a record.',
  },
  'no-value-field': {
    icon: 'sigma',
    title: 'Nothing to add up',
    description: 'Sum and average need a number property. Choose one under Chart in view settings.',
  },
  'no-numbers': {
    icon: 'sigma',
    title: 'That property holds no numbers',
    description:
      'Every record in view is missing it, or holds something that is not a number — so a chart of zeroes would be a claim about the data that is not true.',
  },
  'all-hidden': {
    icon: 'chart-column',
    title: 'Everything is hidden',
    description: 'Every band or series is switched off in the legend — click one to bring it back.',
  },
};

const ROOT_CLASSES = 'box-border min-h-0 min-w-0 flex-1 overflow-auto bg-n-25 px-5 py-4';

/** How many records the drilldown lists before the remainder line takes over. */
const DRILL_CAP = 9;

/**
 * The one filter rule that restates "this record sits in `key`'s band of
 * `field`" — the drilldown's Save-as-view subject (M44.3). `null` means no
 * operator can say it, and the Save button renders disabled rather than
 * minting a view whose filters silently mean something else.
 *
 * The choices lean on the same M20.1 pair the board's create path uses:
 * `bandKind` resolves the field the way grouping resolved it, and
 * `bandValueFor` says what value the band stands for — deviating where a
 * FILTER matches what the scanner READS rather than what a write would put
 * on disk. The whole multi family — multiselect, person, relation — files
 * under membership, because `filterOpsFor` gives that family no `equals` at
 * all: `any_of [key]` is the op it has, and the right one. The key IS the
 * comparable value: person/relation bands key by the bare wikilink stem,
 * which is exactly what `evaluateFilters` reads out of the scanner's
 * bracket-stripped `entry.relationships` (never `bandValueFor`'s `[[…]]`
 * write-form). `contains` would be wrong for all three — substring matching
 * catches 'darkred' in a 'red' band.
 */
function bandRule(field: string, key: string, kind: FieldKind | undefined): FilterRule | null {
  // "No <field>" is a band a filter CAN name, whatever the kind — `is_empty`
  // is in every family's op set, undeclared fields included.
  if (key === NO_VALUE_KEY) return { field, op: 'is_empty', value: '' };
  // An undeclared field has no family, so no operator can be TRUSTED to
  // restate the band: the quiet-refusal path.
  if (kind === undefined) return null;
  const ops = filterOpsFor(kind);
  if (kind === 'multiselect' || kind === 'person' || kind === 'relation') {
    // Membership never LOSES a drilled record — the one direction a saved
    // view must not err in. A multi-value record bands by its FIRST value
    // (first implies member), and a single-target relation's stem is its
    // membership; the rule may additionally catch a record holding the value
    // later in its list, which is over-inclusion, not loss.
    return ops.includes('any_of') ? { field, op: 'any_of', value: [key] } : null;
  }
  const value = bandValueFor(key, kind);
  if (value === undefined || value === null) return null;
  return ops.includes('equals') ? { field, op: 'equals', value } : null;
}

/**
 * The drilldown (M44.3): what a clicked band holds, one Dialog.
 *
 * Records open through `useOpenPath` — the app's one routing law, the same
 * call every other view canvas makes — so the list is always live and the
 * dialog always earns its click. Save is the HOST-gated half: without
 * `onSaveView` (an embedded dashboard chart) there is no name input, no
 * footer, no dead affordance. The minted view is seeded through the SAME
 * `seedView` chain the tab bar uses — with an empty `taken`, because the
 * chart cannot see its sibling tabs; the host re-keys the id against the
 * roster it appends to (addView already does; TypePage mirrors it).
 */
function DrilldownDialog({
  slice,
  part,
  data,
  chart,
  presentation,
  entries,
  schema,
  viewFilters,
  onSaveView,
  onClose,
}: {
  slice: ChartSlice;
  part: ChartSlicePart | undefined;
  data: ChartData;
  chart: ChartSpec | undefined;
  presentation: Presentation;
  entries: Entry[];
  schema: Schema;
  viewFilters: FilterGroup | null | undefined;
  onSaveView: ((view: ViewDefinition) => void) | undefined;
  onClose: () => void;
}) {
  const openPath = useOpenPath('in-place');
  // A segment drills its own sub-band; a whole shape drills the band.
  const rows = part === undefined ? slice.entries : part.entries;
  const title = part === undefined ? slice.label : `${slice.label} · ${part.label}`;
  const [name, setName] = useState(`${data.axis}: ${title}`);

  // The click as filter rules — the band's, plus the series' for a segment.
  const rules: (FilterRule | null)[] = [
    bandRule(data.axisField, slice.key, bandKind(entries, data.axisField, schema)),
  ];
  if (part !== undefined) {
    const groupBy = chart?.groupBy ?? '';
    rules.push(bandRule(groupBy, part.key, bandKind(entries, groupBy, schema)));
  }
  const expressible = rules.every((r): r is FilterRule => r !== null);

  const save = () => {
    if (onSaveView === undefined || !expressible) return;
    // The tab's own filters travel WHOLE, the band rule(s) appended — the
    // chart drew the filtered set, so the saved view must keep saying so.
    // The same spread ListPage's onFilterField uses: an `all` group merges
    // flat, anything else nests.
    const merged: FilterGroup = {
      all: [
        ...(viewFilters === null || viewFilters === undefined
          ? []
          : 'all' in viewFilters
            ? viewFilters.all
            : [viewFilters]),
        ...(rules as FilterRule[]),
      ],
    };
    onSaveView(seedView(name, 'list', [], presentation, merged));
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      width={480}
      {...(onSaveView !== undefined
        ? {
            primaryAction: { label: 'Save as view', onClick: save, disabled: !expressible },
            secondaryAction: { label: 'Cancel', onClick: onClose },
            // The disabled state says why, in place — a quiet refusal.
            ...(expressible
              ? {}
              : { footerNote: 'No filter can express this band, so the view cannot be saved.' }),
          }
        : {})}
    >
      <div data-testid="chart-drilldown" className="flex flex-col">
        {rows.length === 0 && (
          // A cumulative plateau segment: the run persisting, not rows.
          <p className="m-0 py-1 text-sm text-n-500">No records land in this band.</p>
        )}
        {rows.slice(0, DRILL_CAP).map((e) => (
          <button
            key={e.path}
            type="button"
            data-testid="drilldown-record"
            onClick={() => {
              openPath(e.path);
              onClose();
            }}
            className="flex cursor-pointer items-baseline justify-between gap-3 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-sm text-n-800 hover:bg-n-50"
          >
            <span className="min-w-0 truncate">{e.title}</span>
            <span className="flex-none [font-family:var(--font-mono)] text-2xs text-n-400">
              {e.path}
            </span>
          </button>
        ))}
        {rows.length > DRILL_CAP && (
          <p className="m-0 px-2 pt-1 text-xs text-n-500">…and {rows.length - DRILL_CAP} more</p>
        )}
        {onSaveView !== undefined && (
          <div className="pt-3">
            <Input
              ariaLabel="View name"
              testId="drilldown-view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              width="100%"
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function ChartView({
  entries,
  presentation,
  schema,
  filtered,
  onChartChange,
  viewFilters,
  onSaveView,
}: ChartViewProps) {
  const data = computeChart(entries, presentation, schema);
  const chart = presentation.chart;
  const kind: ChartKind = chart?.kind ?? 'bar';
  const { H, PLOT_H } = plotDims(chart);
  const horizontal = kind === 'bar' && chart?.horizontal === true;
  // The donut defaults its legend on — the ring has no other labels; the
  // axis kinds default off and can opt in.
  const showLegend = chart?.legend ?? kind === 'donut';
  const notes = captionNotes(chart, kind);

  // The band under the pointer and where the pointer is, figure-relative.
  const figureRef = useRef<HTMLElement>(null);
  // Whichever svg root this render draws — the export menu's aim (M44.3).
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<{ slice: ChartSlice; x: number; y: number } | null>(null);
  // The band a click drilled into — the dialog's subject (M44.3).
  const [drill, setDrill] = useState<{
    slice: ChartSlice;
    part: ChartSlicePart | undefined;
  } | null>(null);
  const events: SliceEvents = {
    onHover: (slice, e) => {
      const box = figureRef.current?.getBoundingClientRect();
      setHovered({ slice, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) });
    },
    onLeave: () => setHovered(null),
    onOpen: (slice, part) => {
      // The scrim swallows mouseleave, so the hover card is cleared here or
      // it survives underneath the dialog.
      setHovered(null);
      setDrill({ slice, part });
    },
  };

  return (
    <div
      data-testid="chart-view"
      data-chart-kind={kind}
      data-chart-measure={data.measure}
      className={ROOT_CLASSES}
    >
      {data.blocked !== null ? (
        <div data-testid="chart-empty" data-reason={data.blocked}>
          <EmptyState
            icon={BLOCKED[data.blocked].icon}
            title={
              data.blocked === 'no-rows' && filtered === true
                ? 'Nothing matches these filters'
                : BLOCKED[data.blocked].title
            }
            description={BLOCKED[data.blocked].description}
          />
          {/* all-hidden carries its rosters, and the legend is the only way
              back — it renders whatever `chart.legend` says (M44.3). */}
          {data.blocked === 'all-hidden' && (
            <Legend data={data} chart={chart} kind={kind} onChartChange={onChartChange} />
          )}
        </div>
      ) : kind === 'number' ? (
        // A number chart totals every visible row into one stat — there is no
        // axis to caption, so it skips the figcaption every other kind gets.
        <figure className="m-0 rounded-xl border border-n-200 bg-n-0 p-4">
          <div data-testid="chart-number" className="flex flex-col items-start gap-1 px-2 py-6">
            <span className="text-[40px] font-semibold leading-none text-n-900">
              {data.totalDisplay}
            </span>
            <span className="text-sm text-n-500">{data.measure}</span>
          </div>
        </figure>
      ) : (
        <figure ref={figureRef} className="relative m-0 rounded-xl border border-n-200 bg-n-0 p-4">
          <figcaption data-testid="chart-caption" className="pb-3 text-sm font-semibold text-n-800">
            {data.measure}
            <span className="pl-1.5 font-normal text-n-500">by {data.axis}</span>
            {notes.length > 0 && (
              <span className="pl-1.5 font-normal text-n-400">· {notes.join(' · ')}</span>
            )}
          </figcaption>
          {kind === 'donut' ? (
            data.total <= 0 ? (
              // A donut of nothing is a full grey ring that reads as one
              // enormous slice.
              <p className="m-0 py-6 text-center text-xs text-n-500">
                Every band measures zero, so there is no ring to draw.
              </p>
            ) : (
              <DonutChart data={data} chart={chart} events={events} svgRef={svgRef} />
            )
          ) : (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              // Scales with the panel, keeps its proportions, and never forces
              // the canvas to scroll sideways.
              className="h-auto w-full max-w-[900px]"
              role="img"
              aria-label={`${data.measure} by ${data.axis}`}
            >
              {horizontal ? (
                <HBarChart data={data} chart={chart} h={H} events={events} />
              ) : kind === 'line' ? (
                <LineChart data={data} chart={chart} plotH={PLOT_H} events={events} />
              ) : (
                <BarChart data={data} chart={chart} plotH={PLOT_H} events={events} />
              )}
            </svg>
          )}
          {showLegend && (
            <Legend data={data} chart={chart} kind={kind} onChartChange={onChartChange} />
          )}
          {/* After the chart svg in the DOM on purpose — absolute placement
              puts it in the corner either way, and the chart svg staying the
              figure's first svg keeps `querySelector('svg')` honest. The
              zero-total donut draws prose, not an svg, so it gets no menu. */}
          {!(kind === 'donut' && data.total <= 0) && (
            <ExportMenu
              svgRef={svgRef}
              figureRef={figureRef}
              name={`${data.measure} by ${data.axis}`}
            />
          )}
          {hovered !== null && (
            <ChartTooltip
              slice={hovered.slice}
              x={hovered.x}
              y={hovered.y}
              data={data}
              chart={chart}
              // computeChart ignores `cumulative` for a donut, so the tooltip
              // must not treat the donut's plain values as running totals.
              running={chart?.cumulative === true && kind !== 'donut'}
              figure={figureRef}
            />
          )}
        </figure>
      )}
      {drill !== null && (
        <DrilldownDialog
          slice={drill.slice}
          part={drill.part}
          data={data}
          chart={chart}
          presentation={presentation}
          entries={entries}
          schema={schema}
          viewFilters={viewFilters}
          onSaveView={onSaveView}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
