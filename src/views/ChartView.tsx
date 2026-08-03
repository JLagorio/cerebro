import { PICKABLE_OPTION_COLORS, resolveOptionColor } from '@/lib/swatch';
import { EmptyState } from '@/components/ui/EmptyState';
import { computeChart, niceCeiling } from '@/engine/chart';
import type { ChartData, ChartSlice } from '@/engine/chart';
import type { ChartKind, Presentation, Schema, Entry } from '@/engine/types';

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
}

const W = 640;
const H = 320;
const PAD = { top: 16, right: 16, bottom: 52, left: 56 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const TICKS = 4;

/**
 * A band's colour: its own when it declares one, otherwise the next hue in the
 * option palette.
 *
 * The palette fallback matters — grouping by a text property gives every band
 * `color: null`, and a chart drawn in one colour cannot be read at all. The
 * no-value bucket stays neutral on purpose: "no status" is an absence, and
 * giving it a hue makes it look like one more status.
 */
export function sliceColor(slice: ChartSlice, index: number): string {
  if (slice.key === '__none__') return 'var(--n-300)';
  if (!slice.ghost && slice.color !== null) {
    const swatch = resolveOptionColor(slice.color);
    // `default` is what an unrecognised colour resolves to; taking its
    // neutral grey would draw several bands identically.
    if (swatch.name !== 'default') return swatch.solid;
  }
  return `var(--opt-${PICKABLE_OPTION_COLORS[index % PICKABLE_OPTION_COLORS.length]})`;
}

/** Tick labels, trimmed — a 4-way split of 25 is 6.25, not 6.25000000001. */
const tick = (n: number) => String(Number(n.toFixed(2)));

/** X labels sit in a band a few dozen pixels wide; the full text is on the
 * `<title>`, which is the SVG tooltip. */
function clip(label: string, band: number): string {
  const max = Math.max(4, Math.floor(band / 7));
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

function Axes({ top, label }: { top: number; label: string }) {
  return (
    <g>
      {Array.from({ length: TICKS + 1 }, (_, i) => {
        const value = (top * (TICKS - i)) / TICKS;
        const y = PAD.top + (PLOT_H * i) / TICKS;
        return (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={y}
              y2={y}
              stroke={i === TICKS ? 'var(--n-300)' : 'var(--n-200)'}
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y + 3.5}
              textAnchor="end"
              fontSize={10}
              fill="var(--n-400)"
              fontFamily="var(--font-mono)"
            >
              {tick(value)}
            </text>
          </g>
        );
      })}
      <text x={PAD.left - 8} y={PAD.top - 6} textAnchor="end" fontSize={10} fill="var(--n-500)">
        {label}
      </text>
    </g>
  );
}

function XLabels({ slices, band }: { slices: ChartSlice[]; band: number }) {
  return (
    <g>
      {slices.map((s, i) => (
        <text
          key={s.key || s.label}
          x={PAD.left + band * i + band / 2}
          y={PAD.top + PLOT_H + 16}
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

function BarChart({ data }: { data: ChartData }) {
  const top = niceCeiling(data.max);
  const band = PLOT_W / data.slices.length;
  const width = Math.min(56, band * 0.62);
  return (
    <>
      <Axes top={top} label={data.measure} />
      {data.slices.map((s, i) => {
        const height = (s.value / top) * PLOT_H;
        return (
          <g key={s.key || s.label}>
            <rect
              data-testid="chart-bar"
              data-label={s.label}
              data-value={s.value}
              x={PAD.left + band * i + (band - width) / 2}
              // A zero-height rect is invisible; 1px says "measured, and it
              // is zero" rather than "no band here".
              y={PAD.top + PLOT_H - Math.max(height, s.value > 0 ? 1 : 0)}
              width={width}
              height={Math.max(height, s.value > 0 ? 1 : 0)}
              rx={3}
              fill={sliceColor(s, i)}
            >
              <title>{`${s.label}: ${s.display}`}</title>
            </rect>
            {band > 34 && (
              <text
                x={PAD.left + band * i + band / 2}
                y={PAD.top + PLOT_H - height - 5}
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
      <XLabels slices={data.slices} band={band} />
    </>
  );
}

function LineChart({ data }: { data: ChartData }) {
  const top = niceCeiling(data.max);
  const band = PLOT_W / data.slices.length;
  const at = (s: ChartSlice, i: number) => ({
    x: PAD.left + band * i + band / 2,
    y: PAD.top + PLOT_H - (s.value / top) * PLOT_H,
  });
  const points = data.slices.map((s, i) => at(s, i));
  return (
    <>
      <Axes top={top} label={data.measure} />
      <polyline
        data-testid="chart-line"
        points={points.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="var(--cortex-500)"
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
          stroke="var(--cortex-500)"
          strokeWidth={2}
        >
          <title>{`${s.label}: ${s.display}`}</title>
        </circle>
      ))}
      <XLabels slices={data.slices} band={band} />
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

function DonutChart({ data }: { data: ChartData }) {
  const c = DONUT.size / 2;
  const circumference = 2 * Math.PI * DONUT.r;
  const segments = arcs(data, circumference);
  return (
    <div className="flex flex-wrap items-center gap-6">
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
          {segments.map(({ slice: s, start, length }, i) =>
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
                stroke={sliceColor(s, i)}
                strokeWidth={DONUT.stroke}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-start}
              >
                <title>{`${s.label}: ${s.display}`}</title>
              </circle>
            ),
          )}
        </g>
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
      </svg>
      <ul className="m-0 flex min-w-0 list-none flex-col gap-1.5 p-0">
        {data.slices.map((s, i) => (
          <li
            key={s.key || s.label}
            data-testid="chart-legend-item"
            className="flex items-center gap-2 text-[12px] text-n-700"
          >
            <span
              className="box-border h-2.5 w-2.5 flex-none rounded-full"
              style={{ background: sliceColor(s, i) }}
            />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="[font-family:var(--font-mono)] text-[11px] text-n-500">
              {s.display}
            </span>
          </li>
        ))}
      </ul>
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
};

export function ChartView({ entries, presentation, schema, filtered }: ChartViewProps) {
  const data = computeChart(entries, presentation, schema);
  const kind: ChartKind = presentation.chart?.kind ?? 'bar';

  return (
    <div
      data-testid="chart-view"
      data-chart-kind={kind}
      data-chart-measure={data.measure}
      className="box-border min-h-0 min-w-0 flex-1 overflow-auto bg-n-25 px-5 py-4"
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
        </div>
      ) : (
        <figure className="m-0 rounded-[12px] border border-n-200 bg-n-0 p-4">
          <figcaption className="pb-3 text-[12.5px] font-semibold text-n-800">
            {data.measure}
            <span className="pl-1.5 font-normal text-n-500">by {data.axis}</span>
          </figcaption>
          {kind === 'donut' ? (
            data.total <= 0 ? (
              // A donut of nothing is a full grey ring that reads as one
              // enormous slice.
              <p className="m-0 py-6 text-center text-[12px] text-n-500">
                Every band measures zero, so there is no ring to draw.
              </p>
            ) : (
              <DonutChart data={data} />
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
              {kind === 'line' ? <LineChart data={data} /> : <BarChart data={data} />}
            </svg>
          )}
        </figure>
      )}
    </div>
  );
}
