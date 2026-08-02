import { useMemo, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { toIsoDate } from '@/engine/dates';
import { buildRows } from '@/engine/rows';
import {
  axisSpan,
  axisTicks,
  axisWidth,
  barGeometry,
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

export interface TimelineViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  fields: ColumnDef[];
  allEntries?: Entry[];
  scope?: string;
  today?: string;
  /** Persists a zoom change to the view's YAML. Omit for read-only surfaces. */
  onZoomChange?: (zoom: Zoom) => void;
}

/**
 * Timeline (M10): records as bars on a horizontal date axis.
 *
 * Distinct from Gantt, which answers a scheduling question — what blocks what,
 * what has slipped. A timeline answers a simpler one: when do these things
 * happen relative to each other. So it has no name gutter and no dependency
 * arrows; each bar carries its own label and the grouping chain's band levels
 * become swimlanes.
 */
export function TimelineView({
  entries,
  presentation,
  schema,
  fields,
  allEntries = entries,
  scope = 'timeline',
  today = toIsoDate(new Date()),
  onZoomChange,
}: TimelineViewProps) {
  const dateField = resolveDateField(presentation, fields);
  const [localZoom, setLocalZoom] = useState<Zoom>(presentation.zoom ?? 'week');
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

  const setZoom = (next: Zoom) => {
    setLocalZoom(next);
    onZoomChange?.(next);
  };

  if (dateField === null) {
    return (
      <div
        className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
        data-testid="timeline-view"
      >
        <EmptyState
          icon="chart-gantt"
          title="Nothing here carries a date"
          description="A timeline places records by a date or date-range property. Add one to this type, or pick a different view."
        />
      </div>
    );
  }

  return (
    <div
      data-testid="timeline-view"
      data-date-field={dateField}
      data-zoom={zoom}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex flex-none items-center gap-2 border-b border-[var(--n-200)] px-5 py-2">
        <ZoomControl zoom={zoom} onChange={setZoom} />
        <span className="flex-1" />
        {undated.length > 0 && (
          <button
            type="button"
            data-testid="timeline-undated-toggle"
            aria-expanded={showUndated}
            onClick={() => setShowUndated(!showUndated)}
            className="rounded-md border border-[var(--n-200)] bg-transparent px-2 py-0.5 text-[11.5px] text-[var(--n-500)] hover:border-[var(--n-400)] hover:text-[var(--n-800)]"
          >
            {undated.length} without a date
          </button>
        )}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: axisWidth(axis, zoom), minWidth: '100%' }}>
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
                    className="relative z-10 flex h-7 w-full items-center border-b border-[var(--n-100)] bg-[var(--n-25)] text-left"
                    style={{ width: '100%' }}
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
                      <span className="text-[12px] font-semibold text-[var(--n-800)]">
                        {row.node.label}
                      </span>
                      <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
                        {row.node.count}
                      </span>
                    </span>
                  </button>
                );
              }

              const span = spanOf(row.entry, dateField);
              if (span === null) return null;
              const style = typeStyle(row.entry.type, schema);
              return (
                <div
                  key={row.key}
                  data-testid="timeline-row"
                  data-path={row.entry.path}
                  className="relative border-b border-[var(--n-100)] hover:bg-[var(--n-25)]"
                  style={{ height: ROW_H }}
                >
                  <button
                    type="button"
                    data-testid="timeline-bar"
                    data-path={row.entry.path}
                    onClick={() => openPath(row.entry.path)}
                    title={`${row.entry.title} · ${span.start}${span.end === span.start ? '' : ` → ${span.end}`}`}
                    className="absolute top-1 flex items-center gap-1 overflow-hidden rounded-[5px] border border-[var(--cortex-500)] bg-[var(--cortex-50)] px-1.5 text-left text-[11.5px] text-[var(--n-900)] hover:bg-[var(--cortex-100)]"
                    style={{
                      ...barGeometry(span, axis, zoom),
                      height: ROW_H - 9,
                    }}
                  >
                    <Icon name={style.icon} size={10} color={style.color ?? 'var(--n-500)'} />
                    <span className="truncate">{row.entry.title}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {showUndated && undated.length > 0 && (
        <div
          data-testid="timeline-undated"
          className="max-h-[180px] flex-none overflow-y-auto border-t border-[var(--n-200)] bg-[var(--n-25)] px-5 py-2"
        >
          <div className="pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
            Without a date
          </div>
          {undated.map((entry) => (
            <button
              key={entry.path}
              type="button"
              data-path={entry.path}
              onClick={() => openPath(entry.path)}
              className="flex w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-1 text-left text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-100)]"
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
          <EmptyState
            icon="chart-gantt"
            title="No records yet"
            description="Dated records appear here as bars."
          />
        </div>
      )}
    </div>
  );
}
