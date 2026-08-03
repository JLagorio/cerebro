import { useMemo, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { resolveColumns } from '@/engine/columns';
import { toIsoDate } from '@/engine/dates';
import { buildRows } from '@/engine/rows';
import {
  axisSpan,
  axisTicks,
  axisWidth,
  barGeometry,
  dateKindOf,
  resolveDateField,
  spanBounds,
  spanOf,
  unscheduled,
  DEFAULT_ZOOM,
  type Span,
  type Zoom,
} from '@/engine/schedule';
import { typeStyle } from '@/engine/typeCatalog';
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
import { viewKind } from '@/views/viewKinds';

/** Name-column width when the view has not been told one. */
const NAME_W = 280;

export interface TimelineViewProps {
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
  /** Persists a zoom change to the view's YAML. Omit for read-only surfaces. */
  onZoomChange?: (zoom: Zoom) => void;
}

/**
 * Timeline (M10): records as bars on a horizontal date axis.
 *
 * Distinct from Gantt, which answers a scheduling question — what blocks what,
 * what has slipped. A timeline answers a simpler one: when do these things
 * happen relative to each other. So it has no dependency arrows; each bar
 * carries its own label and the grouping chain's band levels become swimlanes.
 *
 * It DOES now get a table half (M16.24). "No name gutter by design" only ever
 * argued against the gantt's work breakdown; it did not argue that a timeline
 * should be unable to show a status beside a bar, which is what it meant in
 * practice. Off by default here, on by default in the gantt.
 */
export function TimelineView({
  entries,
  presentation,
  schema,
  fields,
  allEntries = entries,
  scope = 'timeline',
  today = toIsoDate(new Date()),
  filtered,
  onZoomChange,
}: TimelineViewProps) {
  const dateField = resolveDateField(presentation, fields);
  // The override wins over the stored value, not the other way round. With
  // `presentation.zoom ?? local` the in-view control was inert the moment a
  // zoom was persisted on a surface that passes no `onZoomChange`.
  const [zoomOverride, setZoomOverride] = useState<Zoom | null>(null);
  const zoom = zoomOverride ?? presentation.zoom ?? DEFAULT_ZOOM;
  const collapsedMap = useUiStore((s) => s.collapsed[scope]);
  const toggle = useUiStore((s) => s.toggleCollapsed);
  const openPath = useOpenPath('in-place');
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);

  const [showTable, setShowTable] = useState(presentation.showTable === true);
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
      }),
    [entries, presentation.group, schema, allEntries, collapsedMap],
  );

  const axis: Span = useMemo(() => {
    const spans = entries.map((e) => spanOf(e, dateField)).filter((s): s is Span => s !== null);
    return axisSpan(spanBounds(spans), zoom, today);
  }, [entries, dateField, zoom, today]);

  const ticks = useMemo(() => axisTicks(axis, zoom), [axis, zoom]);
  const undated = useMemo(() => unscheduled(entries, dateField), [entries, dateField]);
  // Undated records used to render as full-height rows containing nothing —
  // this view has no name gutter, so they were literally invisible dead space
  // and the only signal was a count that did not explain the gaps. They are
  // skipped from the chart and listed under it instead.
  const [showUndated, setShowUndated] = useState(false);

  const { scrollerRef, capture } = useZoomAnchor(axis, zoom, tableWidth);
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
        data-testid="timeline-view"
      >
        <EmptyState
          icon={viewKind('timeline').icon}
          title="Nothing here carries a date"
          description="A timeline places records by a date or date-range property. Add one to this type, or pick a different view."
        />
      </div>
    );
  }

  const width = axisWidth(axis, zoom);

  return (
    <div
      data-testid="timeline-view"
      data-date-field={dateField}
      data-zoom={zoom}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex flex-none items-center gap-3 border-b border-n-200 px-5 py-2">
        <ZoomControl zoom={zoom} onChange={setZoom} />
        <Switch checked={showTable} onChange={setShowTable} label="Show table" />
        <span className="flex-1" />
        {undated.length > 0 && (
          <button
            type="button"
            data-testid="timeline-undated-toggle"
            aria-expanded={showUndated}
            onClick={() => setShowUndated(!showUndated)}
            className="rounded-md border border-n-200 bg-transparent px-2 py-0.5 text-xs text-n-500 hover:border-n-400 hover:text-n-800"
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
          <div className="relative flex-none" style={{ width }}>
            <TimeAxisHeader ticks={ticks} axis={axis} zoom={zoom} today={today} />
            <div className="relative">
              <TimeGridLines ticks={ticks} zoom={zoom} />
              <TodayLine axis={axis} zoom={zoom} today={today} />
              {rows.map((row) => {
                if (row.kind === 'add') return null;
                if (row.kind === 'band') {
                  const collapsed = collapsedMap?.[row.key] === true;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      data-testid="timeline-band"
                      data-depth={row.node.depth}
                      onClick={() => toggle(scope, row.key)}
                      className="relative z-10 flex w-full items-center border-b border-n-100 bg-n-25 text-left"
                      style={{ width: '100%', height: BAND_H }}
                    >
                      {/* Full-width band cannot be sticky itself (no room to
                          shift); the label cluster sticks instead. */}
                      <span
                        className="sticky left-0 flex items-center gap-2"
                        style={{ paddingLeft: 12 + row.node.depth * 16 }}
                      >
                        <Icon
                          name={collapsed ? 'chevron-right' : 'chevron-down'}
                          size={12}
                          color="var(--n-400)"
                        />
                        <span className="text-xs font-semibold text-n-800">{row.node.label}</span>
                        <span className="[font-family:var(--font-mono)] text-2xs text-n-400">
                          {row.node.count}
                        </span>
                      </span>
                    </button>
                  );
                }

                const stored = spanOf(row.entry, dateField);
                if (stored === null) {
                  // With a table half the row EXISTS on the left, so the chart
                  // side must keep its slot or the two halves shear apart.
                  return showTable ? (
                    <div
                      key={row.key}
                      className="border-b border-n-100"
                      style={{ height: ROW_H }}
                    />
                  ) : null;
                }
                const span = drag.preview(row.key, stored);
                const style = typeStyle(row.entry.type, schema);
                const geo = barGeometry(span, axis, zoom);
                return (
                  <div
                    key={row.key}
                    data-testid="timeline-row"
                    data-path={row.entry.path}
                    className="relative border-b border-n-100 hover:bg-n-25"
                    style={{ height: ROW_H }}
                  >
                    <button
                      type="button"
                      data-testid="timeline-bar"
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
                      className="absolute top-1 flex touch-none select-none items-center gap-1 overflow-hidden rounded-sm border border-cortex-500 bg-cortex-50 px-1.5 text-left text-xs text-n-900 hover:bg-cortex-100"
                      style={{ ...geo, height: ROW_H - 9 }}
                    >
                      <Icon name={style.icon} size={10} color={style.color ?? 'var(--n-500)'} />
                      <span className="truncate">{row.entry.title}</span>
                    </button>
                    {dateKindOf(row.entry, dateField, schema) === 'daterange' && (
                      <ResizeGrips
                        id={row.key}
                        title={row.entry.title}
                        left={geo.left}
                        width={geo.width}
                        top={4}
                        height={ROW_H - 9}
                        drag={drag.handle}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {showUndated && undated.length > 0 && (
        <div
          data-testid="timeline-undated"
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

      {entries.length === 0 && (
        <div className="flex-none px-3 py-8">
          {/* A timeline emptied by its own filters is not an empty project
              (M16.35) — same statement the gantt makes, for the same reason. */}
          <EmptyState
            icon={viewKind('timeline').icon}
            title={filtered ? 'Nothing matches these filters' : 'No records yet'}
            description={
              filtered
                ? 'Adjust the filters in view settings to widen the query.'
                : 'Dated records appear here as bars.'
            }
          />
        </div>
      )}
    </div>
  );
}
