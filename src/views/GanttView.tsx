import { useMemo, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { EmptyState } from '@/components/ui/EmptyState';
import { Switch } from '@/components/ui/Switch';
import { resolveColumns } from '@/engine/columns';
import { toIsoDate } from '@/engine/dates';
import { buildRows, type RenderRow } from '@/engine/rows';
import {
  axisSpan,
  axisTicks,
  axisWidth,
  barGeometry,
  dateKindOf,
  dayOffset,
  dependenciesOf,
  isSlipping,
  resolveDateField,
  spanBounds,
  spanOf,
  unscheduled,
  DEFAULT_ZOOM,
  PX_PER_DAY,
  type Span,
  type Zoom,
} from '@/engine/schedule';
import type { ColumnDef } from '@/engine/columns';
import type { Entry, Presentation, Schema } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import {
  BAND_H,
  ROW_H,
  ResizeGrips,
  TimeAxisHeader,
  TimeGridLines,
  TimeTable,
  TodayLine,
  ZoomControl,
  useZoomAnchor,
} from '@/views/TimeAxis';
import { useScheduleDrag } from '@/views/useScheduleDrag';

/** Width of the work-breakdown gutter when the view has not been told one. */
const NAME_W = 300;

export interface GanttViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  fields: ColumnDef[];
  allEntries?: Entry[];
  scope?: string;
  today?: string;
  /**
   * True when the view has filters, so the empty state can say why (M16.35).
   *
   * Required for the reason BoardView's is: the board declared this prop,
   * branched on it, and never received it, because an optional prop dropped by
   * a caller is a prop nothing complains about.
   */
  filtered: boolean;
  onZoomChange?: (zoom: Zoom) => void;
}

/** A resolved dependency edge, in row-index space. */
interface Edge {
  fromRow: number;
  toRow: number;
  from: Span;
  to: Span;
  slipping: boolean;
  key: string;
}

/**
 * Gantt (M10): the scheduling view.
 *
 * What separates it from Timeline is the question it answers. A timeline shows
 * when things happen; a Gantt shows whether the plan is *consistent* — a work
 * breakdown down the left, and arrows for the "this waits on that" claims the
 * data makes, drawn red where the predecessor does not actually finish first.
 *
 * The breakdown is the grouping chain's relation levels, the same nesting a
 * table gets. There is no separate hierarchy configuration, because there is no
 * separate hierarchy concept.
 */
export function GanttView({
  entries,
  presentation,
  schema,
  fields,
  allEntries = entries,
  scope = 'gantt',
  today = toIsoDate(new Date()),
  filtered,
  onZoomChange,
}: GanttViewProps) {
  const dateField = resolveDateField(presentation, fields);
  // One default, and the override wins over the stored value. This opened at
  // `month` while TimelineView opened at `week` and the settings panel showed
  // `week` for both — so an unconfigured gantt was on a scale its own Zoom
  // control denied. And `presentation.zoom ?? local` left the control inert on
  // any surface that passes no `onZoomChange`.
  const [zoomOverride, setZoomOverride] = useState<Zoom | null>(null);
  const zoom = zoomOverride ?? presentation.zoom ?? DEFAULT_ZOOM;
  const collapsedMap = useUiStore((s) => s.collapsed[scope]);
  const toggle = useUiStore((s) => s.toggleCollapsed);
  const openPath = useOpenPath('in-place');
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);

  // The gutter was `const NAME_W = 300` — not state, not a prop, not
  // persisted, so the one half of the view that carries the record names could
  // not be shown, hidden or resized (M16.24).
  const [showTable, setShowTable] = useState(presentation.showTable !== false);
  const [nameWidth, setNameWidth] = useState(presentation.titleWidth ?? NAME_W);
  const columns = useMemo(
    () => resolveColumns(presentation.columns, fields).map((c) => ({ def: c.def, width: c.width })),
    [presentation.columns, fields],
  );
  const tableWidth = showTable ? nameWidth + columns.reduce((sum, c) => sum + c.width, 0) : 0;

  const rows = useMemo(
    () =>
      buildRows({
        entries,
        group: presentation.group,
        schema,
        allEntries,
        isCollapsed: (key) => collapsedMap?.[key] === true,
      }).filter((r) => r.kind !== 'add'),
    [entries, presentation.group, schema, allEntries, collapsedMap],
  );

  const axis: Span = useMemo(() => {
    // The axis covers every row on screen, including nested children the
    // source query never selected — otherwise a descendant's bar falls off the
    // end of the ruler its own parent defined.
    const spans = rows
      .flatMap((r) => (r.kind === 'row' ? [spanOf(r.entry, dateField)] : []))
      .filter((s): s is Span => s !== null);
    return axisSpan(spanBounds(spans), zoom, today);
  }, [rows, dateField, zoom, today]);

  const ticks = useMemo(() => axisTicks(axis, zoom), [axis, zoom]);

  // Dependency edges, resolved to the rows actually rendered. An edge whose
  // predecessor is filtered out or collapsed away is dropped rather than drawn
  // to an arbitrary position.
  const edges = useMemo(
    () => resolveEdges(rows, presentation.dependencyField, dateField, allEntries),
    [rows, presentation.dependencyField, dateField, allEntries],
  );

  const undated = useMemo(() => unscheduled(entries, dateField), [entries, dateField]);
  const slips = useMemo(() => edges.filter((e) => e.slipping), [edges]);
  // The counts used to be spans styled like links that did nothing — red
  // medium-weight text that resists clicking is worse than no indicator. Both
  // are controls now: the conflict count walks the slipping edges, the undated
  // count reveals the rows that have no bar to point at.
  const [focusedSlip, setFocusedSlip] = useState(-1);
  const [showUndated, setShowUndated] = useState(false);

  const { scrollerRef, capture } = useZoomAnchor(axis, zoom, tableWidth);

  const stepSlip = () => {
    if (slips.length === 0) return;
    const next = (focusedSlip + 1) % slips.length;
    setFocusedSlip(next);
    scrollerRef.current
      ?.querySelector(`[data-row-index="${slips[next].toRow}"]`)
      ?.scrollIntoView({ block: 'center', inline: 'center' });
  };

  const setZoom = (next: Zoom) => {
    capture();
    setZoomOverride(next);
    onZoomChange?.(next);
  };

  const drag = useScheduleDrag({ rows, dateField, schema, zoom, patchFrontmatter });

  if (dateField === null) {
    return (
      <div
        className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
        data-testid="gantt-view"
      >
        <EmptyState
          icon="chart-gantt"
          title="Nothing here carries a date"
          description="A Gantt schedules records by a date or date-range property. Add one to this type, or pick a different view."
        />
      </div>
    );
  }

  const width = axisWidth(axis, zoom);

  return (
    <div
      data-testid="gantt-view"
      data-date-field={dateField}
      data-zoom={zoom}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex flex-none items-center gap-3 border-b border-n-200 px-5 py-2">
        <ZoomControl zoom={zoom} onChange={setZoom} />
        <Switch checked={showTable} onChange={setShowTable} label="Show table" />
        <span className="flex-1" />
        {/* The one number a schedule owes you. Absent when the view has no
            dependency field — zero slips and no edges are different facts. */}
        {presentation.dependencyField !== undefined &&
          (slips.length > 0 ? (
            <button
              type="button"
              data-testid="gantt-slips"
              title="Go to the next slipping dependency"
              onClick={stepSlip}
              className="rounded-md border border-danger-500 bg-transparent px-2 py-0.5 text-[11.5px] font-medium text-danger-500 hover:bg-danger-50"
            >
              {slips.length} dependency {slips.length === 1 ? 'conflict' : 'conflicts'}
              {focusedSlip >= 0 && ` · ${focusedSlip + 1}/${slips.length}`}
            </button>
          ) : (
            <span data-testid="gantt-slips" className="text-[11.5px] text-n-500">
              No dependency conflicts
            </span>
          ))}
        {undated.length > 0 && (
          <button
            type="button"
            data-testid="gantt-undated-toggle"
            aria-expanded={showUndated}
            onClick={() => setShowUndated(!showUndated)}
            className={[
              'rounded-md border px-2 py-0.5 text-[11.5px]',
              showUndated
                ? 'border-cortex-500 bg-cortex-50 text-cortex-600'
                : 'border-n-200 bg-transparent text-n-500 hover:border-n-400 hover:text-n-800',
            ].join(' ')}
          >
            {undated.length} without a date
          </button>
        )}
      </div>

      <div ref={scrollerRef} className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="flex" style={{ width: tableWidth + width, minWidth: '100%' }}>
          {showTable && (
            <TimeTable
              rows={rows}
              schema={schema}
              columns={columns}
              nameWidth={nameWidth}
              isCollapsed={(key) => collapsedMap?.[key] === true}
              onToggle={(key) => toggle(scope, key)}
              onOpen={openPath}
              onResize={setNameWidth}
            />
          )}

          {/* Schedule */}
          <div className="relative flex-none" style={{ width }}>
            <TimeAxisHeader ticks={ticks} axis={axis} zoom={zoom} today={today} />
            <div className="relative">
              <TimeGridLines ticks={ticks} zoom={zoom} />
              <TodayLine axis={axis} zoom={zoom} today={today} />
              <DependencyArrows
                edges={edges}
                rows={rows}
                axis={axis}
                zoom={zoom}
                focusedKey={focusedSlip >= 0 ? (slips[focusedSlip]?.key ?? null) : null}
              />
              {rows.map((row, rowIndex) => {
                if (row.kind === 'band') {
                  return (
                    <div
                      key={row.key}
                      className="border-b border-n-100 bg-n-25"
                      style={{ height: BAND_H }}
                    />
                  );
                }
                const stored = spanOf(row.entry, dateField);
                const span = stored === null ? null : drag.preview(row.key, stored);
                const isParent = row.childCount > 0;
                const geo = span === null ? null : barGeometry(span, axis, zoom);
                return (
                  <div
                    key={row.key}
                    data-testid="gantt-row"
                    data-path={row.entry.path}
                    data-row-index={rowIndex}
                    className="relative border-b border-n-100"
                    style={{ height: ROW_H }}
                  >
                    {span === null && showUndated && (
                      // A row with no dates is not a blank lane: it is a row
                      // that cannot be scheduled from the surface built for
                      // scheduling. Give it a target at today's position.
                      <button
                        type="button"
                        data-testid="gantt-ghost"
                        data-path={row.entry.path}
                        onClick={() => openPath(row.entry.path)}
                        title={`${row.entry.title} · no ${dateField} — open to set one`}
                        className="absolute top-1.5 rounded-xs border border-dashed border-n-400 bg-transparent text-[10.5px] text-n-500 hover:border-cortex-500 hover:text-cortex-600"
                        style={{
                          left: Math.max(0, dayOffset(axis, today)) * PX_PER_DAY[zoom],
                          width: 96,
                          height: ROW_H - 12,
                        }}
                      >
                        Set dates
                      </button>
                    )}
                    {span !== null && geo !== null && (
                      <>
                        <button
                          type="button"
                          data-testid="gantt-bar"
                          data-path={row.entry.path}
                          data-start={span.start}
                          data-end={span.end}
                          {...drag.handle.handleProps(row.key)}
                          onClick={() => {
                            if (drag.handle.consumeClick()) return;
                            openPath(row.entry.path);
                          }}
                          title={`${row.entry.title} · ${span.start}${span.end === span.start ? '' : ` → ${span.end}`}`}
                          aria-label={`${row.entry.title}, ${span.start} to ${span.end}. Arrow keys move it; hold Shift to change its end.`}
                          // A row with children is a summary: drawn as a thin
                          // spine so it reads as the roll-up of what is under it
                          // rather than as another task competing with them.
                          className={[
                            'absolute touch-none select-none rounded-xs border',
                            isParent
                              ? 'top-3 border-n-600 bg-n-600'
                              : 'top-1.5 border-cortex-500 bg-cortex-400',
                          ].join(' ')}
                          style={{ ...geo, height: isParent ? 5 : ROW_H - 12 }}
                        />
                        {dateKindOf(row.entry, dateField, schema) === 'daterange' && (
                          <ResizeGrips
                            id={row.key}
                            title={row.entry.title}
                            left={geo.left}
                            width={geo.width}
                            top={isParent ? 12 : 6}
                            height={isParent ? 5 : ROW_H - 12}
                            drag={drag.handle}
                          />
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {entries.length === 0 && (
        <div className="flex-none px-3 py-8">
          {/* A schedule emptied by its own filters is not an empty project
              (M16.35) — the table, list, board and gallery all say which one
              this is, and the two time views were the last that did not. */}
          <EmptyState
            icon="chart-gantt"
            title={filtered ? 'Nothing matches these filters' : 'No records yet'}
            description={
              filtered
                ? 'Adjust the filters in view settings to widen the query.'
                : 'Dated records appear here as scheduled bars.'
            }
          />
        </div>
      )}
    </div>
  );
}

/**
 * Dependency edges between rows that are BOTH on screen.
 *
 * Keyed by row index rather than by path because the same record can appear
 * under two parents in a nested breakdown; an edge belongs to a position, not
 * just to a record.
 */
export function resolveEdges(
  rows: RenderRow[],
  dependencyField: string | undefined,
  dateField: string | null,
  allEntries: Entry[],
): Edge[] {
  if (dependencyField === undefined || dependencyField === '' || dateField === null) return [];

  // First occurrence wins: an arrow to one of two copies is enough to read the
  // constraint, and drawing it to both implies two different dependencies.
  const rowOf = new Map<string, number>();
  rows.forEach((row, i) => {
    if (row.kind === 'row' && !rowOf.has(row.entry.path)) rowOf.set(row.entry.path, i);
  });

  const edges: Edge[] = [];
  rows.forEach((row, toRow) => {
    if (row.kind !== 'row') return;
    const to = spanOf(row.entry, dateField);
    if (to === null) return;
    for (const predecessor of dependenciesOf(row.entry, dependencyField, allEntries)) {
      const fromRow = rowOf.get(predecessor.path);
      if (fromRow === undefined) continue;
      const from = spanOf(predecessor, dateField);
      if (from === null) continue;
      edges.push({
        fromRow,
        toRow,
        from,
        to,
        slipping: isSlipping(from, to),
        key: `${predecessor.path}->${row.key}`,
      });
    }
  });
  return edges;
}

/**
 * The arrows themselves: an L-shaped elbow from the end of the predecessor's
 * bar to the start of the successor's. Red when the constraint is violated,
 * which is the only reason to draw them at all.
 */
function DependencyArrows({
  edges,
  rows,
  axis,
  zoom,
  focusedKey = null,
}: {
  edges: Edge[];
  rows: RenderRow[];
  axis: Span;
  zoom: Zoom;
  /** The edge the conflict counter is currently pointing at. */
  focusedKey?: string | null;
}) {
  if (edges.length === 0) return null;

  // Row tops, accumulated in render order — bands are shorter than rows.
  const tops: number[] = [];
  let y = 0;
  for (const row of rows) {
    tops.push(y);
    y += row.kind === 'band' ? 28 : ROW_H;
  }

  return (
    <svg
      aria-hidden
      data-testid="gantt-arrows"
      className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
    >
      {edges.map((edge) => {
        const fromGeo = barGeometry(edge.from, axis, zoom);
        const toGeo = barGeometry(edge.to, axis, zoom);
        const x1 = fromGeo.left + fromGeo.width;
        const y1 = tops[edge.fromRow] + ROW_H / 2;
        const x2 = toGeo.left;
        const y2 = tops[edge.toRow] + ROW_H / 2;
        const color = edge.slipping ? 'var(--danger-500)' : 'var(--n-400)';
        const focused = focusedKey !== null && focusedKey === edge.key;
        // Elbow out, down, then in — with a minimum stub so a back-to-back
        // pair still shows a visible connector rather than a dot.
        const mid = Math.max(x1 + 8, x2 - 8);
        const weight = edge.slipping ? 1.5 : 1;
        return (
          <g
            key={edge.key}
            data-slipping={edge.slipping}
            data-focused={focused ? 'true' : undefined}
          >
            {/* The endpoints are solid; the long middle riser is faded and
                dashed. A full-height solid vertical read as a chart-wide rule
                — indistinguishable from the today marker at a glance. */}
            <path
              d={`M ${x1} ${y1} H ${mid}`}
              fill="none"
              stroke={color}
              strokeWidth={focused ? weight + 1 : weight}
            />
            <path
              d={`M ${mid} ${y1} V ${y2}`}
              fill="none"
              stroke={color}
              strokeWidth={focused ? weight + 1 : weight}
              strokeDasharray="3 3"
              opacity={focused ? 0.9 : 0.4}
            />
            <path
              d={`M ${mid} ${y2} H ${x2}`}
              fill="none"
              stroke={color}
              strokeWidth={focused ? weight + 1 : weight}
            />
            <path d={`M ${x2} ${y2} l -4 -3 v 6 z`} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}
