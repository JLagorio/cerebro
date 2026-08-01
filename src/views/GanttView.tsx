import { useMemo, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { toIsoDate } from '@/engine/dates';
import { buildRows, type RenderRow } from '@/engine/rows';
import {
  axisSpan,
  axisTicks,
  axisWidth,
  barGeometry,
  dependenciesOf,
  isSlipping,
  resolveDateField,
  spanBounds,
  spanOf,
  unscheduled,
  type Span,
  type Zoom,
} from '@/engine/schedule';
import { typeStyle } from '@/engine/typeCatalog';
import type { ColumnDef } from '@/engine/columns';
import type { Entry, Presentation, Schema } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { ROW_H, TimeAxisHeader, TimeGridLines, TodayLine, ZoomControl } from '@/views/TimeAxis';

/** Width of the work-breakdown gutter. */
const NAME_W = 300;
const INDENT = 16;

export interface GanttViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  fields: ColumnDef[];
  allEntries?: Entry[];
  scope?: string;
  today?: string;
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
  onZoomChange,
}: GanttViewProps) {
  const dateField = resolveDateField(presentation, fields);
  const [localZoom, setLocalZoom] = useState<Zoom>(presentation.zoom ?? 'month');
  const zoom = presentation.zoom ?? localZoom;
  const collapsedMap = useUiStore((s) => s.collapsed[scope]);
  const toggle = useUiStore((s) => s.toggleCollapsed);
  const openPath = useOpenPath('in-place');

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
  const slipping = edges.filter((e) => e.slipping).length;

  const setZoom = (next: Zoom) => {
    setLocalZoom(next);
    onZoomChange?.(next);
  };

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
      <div className="flex flex-none items-center gap-2 border-b border-[var(--n-200)] px-5 py-2">
        <ZoomControl zoom={zoom} onChange={setZoom} />
        <span className="flex-1" />
        {/* The one number a schedule owes you. Absent when the view has no
            dependency field — zero slips and no edges are different facts. */}
        {presentation.dependencyField !== undefined && (
          <span
            data-testid="gantt-slips"
            className={[
              'text-[11.5px]',
              slipping > 0 ? 'font-medium text-[var(--danger-500)]' : 'text-[var(--n-500)]',
            ].join(' ')}
          >
            {slipping > 0
              ? `${slipping} dependency ${slipping === 1 ? 'conflict' : 'conflicts'}`
              : 'No dependency conflicts'}
          </span>
        )}
        {undated.length > 0 && (
          <span className="text-[11.5px] text-[var(--n-500)]">{undated.length} without a date</span>
        )}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="flex" style={{ width: NAME_W + width, minWidth: '100%' }}>
          {/* Work breakdown gutter */}
          <div className="sticky left-0 z-30 flex-none bg-[var(--n-0)]" style={{ width: NAME_W }}>
            <div className="flex h-8 items-center border-b border-r border-[var(--n-200)] bg-[var(--n-25)] px-3 text-[11.5px] font-semibold text-[var(--n-600)]">
              Name
            </div>
            {rows.map((row) =>
              row.kind === 'band' ? (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => toggle(scope, row.key)}
                  className="flex h-7 w-full items-center gap-2 border-b border-r border-[var(--n-100)] bg-[var(--n-25)] text-left"
                  style={{ paddingLeft: 12 + row.node.depth * INDENT }}
                >
                  <Icon
                    name={collapsedMap?.[row.key] === true ? 'chevron-right' : 'chevron-down'}
                    size={12}
                    color="var(--n-400)"
                  />
                  <span className="truncate text-[12px] font-semibold text-[var(--n-800)]">
                    {row.node.label}
                  </span>
                </button>
              ) : (
                <div
                  key={row.key}
                  data-testid="gantt-name"
                  data-depth={row.depth}
                  className="flex items-center gap-1.5 border-b border-r border-[var(--n-100)] pr-2"
                  style={{ height: ROW_H, paddingLeft: 10 + row.depth * INDENT }}
                >
                  {row.childCount > 0 ? (
                    <button
                      type="button"
                      aria-expanded={collapsedMap?.[row.key] !== true}
                      aria-label={`${collapsedMap?.[row.key] === true ? 'Expand' : 'Collapse'} ${row.entry.title}`}
                      onClick={() => toggle(scope, row.key)}
                      className="flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--n-400)] hover:bg-[var(--n-100)]"
                    >
                      <Icon
                        name={collapsedMap?.[row.key] === true ? 'chevron-right' : 'chevron-down'}
                        size={12}
                      />
                    </button>
                  ) : (
                    <span className="h-4 w-4 flex-none" />
                  )}
                  <Icon
                    name={typeStyle(row.entry.type, schema).icon}
                    size={12}
                    color={typeStyle(row.entry.type, schema).color ?? 'var(--n-400)'}
                  />
                  <button
                    type="button"
                    onClick={() => openPath(row.entry.path)}
                    className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[12.5px] text-[var(--n-900)] hover:underline"
                  >
                    {row.entry.title}
                  </button>
                </div>
              ),
            )}
          </div>

          {/* Schedule */}
          <div className="relative flex-none" style={{ width }}>
            <TimeAxisHeader ticks={ticks} axis={axis} zoom={zoom} />
            <div className="relative">
              <TimeGridLines ticks={ticks} zoom={zoom} />
              <TodayLine axis={axis} zoom={zoom} today={today} />
              <DependencyArrows edges={edges} rows={rows} axis={axis} zoom={zoom} />
              {rows.map((row) => {
                if (row.kind === 'band') {
                  return (
                    <div
                      key={row.key}
                      className="border-b border-[var(--n-100)] bg-[var(--n-25)]"
                      style={{ height: 28 }}
                    />
                  );
                }
                const span = spanOf(row.entry, dateField);
                const isParent = row.childCount > 0;
                return (
                  <div
                    key={row.key}
                    data-testid="gantt-row"
                    data-path={row.entry.path}
                    className="relative border-b border-[var(--n-100)]"
                    style={{ height: ROW_H }}
                  >
                    {span !== null && (
                      <button
                        type="button"
                        data-testid="gantt-bar"
                        data-path={row.entry.path}
                        onClick={() => openPath(row.entry.path)}
                        title={`${row.entry.title} · ${span.start}${span.end === span.start ? '' : ` → ${span.end}`}`}
                        // A row with children is a summary: drawn as a thin
                        // spine so it reads as the roll-up of what is under it
                        // rather than as another task competing with them.
                        className={[
                          'absolute rounded-[4px] border',
                          isParent
                            ? 'top-3 border-[var(--n-600)] bg-[var(--n-600)]'
                            : 'top-1.5 border-[var(--cortex-500)] bg-[var(--cortex-400)]',
                        ].join(' ')}
                        style={{
                          ...barGeometry(span, axis, zoom),
                          height: isParent ? 5 : ROW_H - 12,
                        }}
                      />
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
          <EmptyState
            icon="chart-gantt"
            title="No records yet"
            description="Dated records appear here as scheduled bars."
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
}: {
  edges: Edge[];
  rows: RenderRow[];
  axis: Span;
  zoom: Zoom;
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
        // Elbow out, down, then in — with a minimum stub so a back-to-back
        // pair still shows a visible connector rather than a dot.
        const mid = Math.max(x1 + 8, x2 - 8);
        return (
          <g key={edge.key} data-slipping={edge.slipping}>
            <path
              d={`M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`}
              fill="none"
              stroke={color}
              strokeWidth={edge.slipping ? 1.5 : 1}
            />
            <path d={`M ${x2} ${y2} l -4 -3 v 6 z`} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}
