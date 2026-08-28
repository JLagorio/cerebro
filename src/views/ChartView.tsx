import { PICKABLE_OPTION_COLORS, resolveOptionColor } from '@/lib/swatch';
import { EmptyState } from '@/components/ui/EmptyState';
import { computeChart, niceCeiling } from '@/engine/chart';
import type { ChartData, ChartRosterItem, ChartSlice, ChartSlicePart } from '@/engine/chart';
import type {
  ChartHeight,
  ChartKind,
  ChartSpec,
  Presentation,
  Schema,
  Entry,
} from '@/engine/types';

/**
 * Chart (M16.27) — bar, line or donut over an aggregation of the same rows
 * every other layout shows.
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

/** X labels sit in a band a few dozen pixels wide; the full text is on the
 * `<title>`, which is the SVG tooltip. */
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
  // An avg chart under groupBy: each segment is its sub-band's average and
  // the bar is their SUM. The caption reads "Average of X", so this clause
  // names the deviation (M44.3) — and a donut ignores groupBy, so it must
  // not claim the stacking either.
  if (chart?.agg === 'avg' && chart.groupBy !== undefined && kind !== 'donut')
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
          <title>{`${s.label}: ${s.display}`}</title>
          {clip(s.label, band)}
        </text>
      ))}
    </g>
  );
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
}: {
  data: ChartData;
  chart: ChartSpec | undefined;
  plotH: number;
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
                  >
                    <title>{`${s.label} · ${part.label}: ${part.display}`}</title>
                  </rect>
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
              >
                <title>{`${s.label}: ${s.display}`}</title>
              </rect>
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
}: {
  data: ChartData;
  chart: ChartSpec | undefined;
  h: number;
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
                  >
                    <title>{`${s.label} · ${part.label}: ${part.display}`}</title>
                  </rect>
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
              >
                <title>{`${s.label}: ${s.display}`}</title>
              </rect>
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
}: {
  data: ChartData;
  chart: ChartSpec | undefined;
  plotH: number;
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
                  >
                    <title>{`${p.s.label} · ${p.part.label}: ${p.part.display}`}</title>
                  </circle>
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
        >
          <title>{`${s.label}: ${s.display}`}</title>
        </circle>
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

function DonutChart({ data, chart }: { data: ChartData; chart: ChartSpec | undefined }) {
  const c = DONUT.size / 2;
  const circumference = 2 * Math.PI * DONUT.r;
  const segments = arcs(data, circumference);
  return (
    <svg
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
            >
              <title>{`${s.label}: ${s.display}`}</title>
            </circle>
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
    description:
      'A chart’s X axis is the view’s grouping. Pick a property under Group in view settings.',
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

export function ChartView({
  entries,
  presentation,
  schema,
  filtered,
  onChartChange,
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
        <figure className="m-0 rounded-xl border border-n-200 bg-n-0 p-4">
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
              <DonutChart data={data} chart={chart} />
            )
          ) : (
            <svg
              viewBox={`0 0 ${W} ${H}`}
              // Scales with the panel, keeps its proportions, and never forces
              // the canvas to scroll sideways.
              className="h-auto w-full max-w-[900px]"
              role="img"
              aria-label={`${data.measure} by ${data.axis}`}
            >
              {horizontal ? (
                <HBarChart data={data} chart={chart} h={H} />
              ) : kind === 'line' ? (
                <LineChart data={data} chart={chart} plotH={PLOT_H} />
              ) : (
                <BarChart data={data} chart={chart} plotH={PLOT_H} />
              )}
            </svg>
          )}
          {showLegend && (
            <Legend data={data} chart={chart} kind={kind} onChartChange={onChartChange} />
          )}
        </figure>
      )}
    </div>
  );
}
