import React, { useEffect, useMemo } from 'react';
import type { ColumnDef } from '@/engine/columns';
import type { Zoom } from '@/engine/schedule';
import type { ColumnSpec, Entry, Presentation, Schema } from '@/engine/types';
import { BoardView } from '@/views/BoardView';
import { CalendarView } from '@/views/CalendarView';
import { ChartView } from '@/views/ChartView';
import { DashboardView } from '@/views/DashboardView';
import { GalleryView } from '@/views/GalleryView';
import { GanttView } from '@/views/GanttView';
import { ListView } from '@/views/ListView';
import { TableView } from '@/views/TableView';
import { TimelineView } from '@/views/TimelineView';
import { WhiteboardView, type WhiteboardHost } from '@/views/WhiteboardView';
import { buildRows, entryRows } from '@/engine/rows';
import { hasBlocks, isCanvas } from '@/views/viewKinds';
import { useUiStore } from '@/stores/uiStore';

/**
 * The canvas: renders whichever view kind a presentation names (M10).
 *
 * This switch existed three times — CollectionPage, ProjectPage, and TypePage
 * each had their own copy — and they had already diverged: only CollectionPage
 * could render `split`, only two of them passed `onCreate`, and adding a view
 * kind meant remembering all three. Every surface that shows records now shows
 * them the same way, and a new view kind is one case here.
 */
export interface ViewCanvasProps {
  /** Filtered and sorted by the caller. */
  entries: Entry[];
  /** The whole vault, for resolving nested children outside the query. */
  allEntries: Entry[];
  presentation: Presentation;
  schema: Schema;
  fields: ColumnDef[];
  /** Collapse-state namespace — `list:<id>`, `project:<path>`, `type:<name>`. */
  scope: string;
  /** Project context enables the list's quick-add row. */
  project?: Entry | null;
  /** Type new records get. */
  createType?: string;
  /**
   * True when the view has filters, so empty states can say why.
   *
   * REQUIRED, and required on every per-kind view below for the same reason
   * (M16.35). It used to be optional everywhere, and the `board` arm simply
   * forgot to forward it: the prop was permanently `undefined`, so a board
   * whose filters matched nothing said "No items yet — Create an item to see
   * it here as a card." That reads as "this collection is empty" and sends
   * people looking for the records instead of for the filter chips directly
   * above. An optional prop that every arm is supposed to pass is a prop the
   * compiler cannot help with; a required one cannot be dropped again.
   */
  filtered: boolean;
  onCreate?: (title: string, band: { groupBy: string; groupValue: string }) => Promise<boolean>;
  /** Create dated to a calendar day. */
  onCreateOn?: (title: string, day: string) => Promise<boolean>;
  onColumnsChange?: (next: ColumnSpec[]) => void;
  /** M11: persists presentation-level layout state (the table's name width). */
  onPresentationChange?: (next: Presentation) => void;
  onOrderBy?: (field: string) => void;
  /** Persists an axis zoom change to the view file. */
  onZoomChange?: (zoom: Zoom) => void;
  /** M12.4b: adds a starter filter rule for a field to the open view. */
  onFilterField?: (field: string) => void;
  /** Overridable "today" for deterministic tests. */
  today?: string;
  /**
   * This canvas is a dashboard BLOCK, not the page (M16.28).
   *
   * The only thing it changes is the detail-panel sibling registration: four
   * blocks each announcing "these are the records on screen" would fight over
   * one global, and the last one mounted would win. The page-level canvas
   * keeps owning that; a block renders its rows and stays quiet.
   */
  embedded?: boolean;
  /**
   * Where a whiteboard tab creates and finds its canvas file (M29.45). Only
   * the page-level hosts pass it (M29.48); a dashboard block does not, and
   * the whiteboard arm renders its "lives on a list" face instead.
   */
  whiteboardHost?: WhiteboardHost;
}

export function ViewCanvas({
  entries,
  allEntries,
  presentation,
  schema,
  fields,
  scope,
  project = null,
  createType,
  filtered,
  onCreate,
  onCreateOn,
  onColumnsChange,
  onPresentationChange,
  onOrderBy,
  onZoomChange,
  onFilterField,
  today,
  embedded = false,
  whiteboardHost,
}: ViewCanvasProps): React.ReactElement {
  // M16.11: the detail panel steps through the records THIS canvas is
  // showing, in the order it shows them. One registration for every kind.
  //
  // `entries` is filtered and sorted but NOT grouped or nested, and reading
  // it directly numbered a record "6 of 45" while it sat third on screen.
  // `buildRows` is the same pure function the table, list, timeline and gantt
  // each call to lay themselves out, so this is the display order rather than
  // an approximation of it.
  const setDetailSiblings = useUiStore((s) => s.setDetailSiblings);
  const key = useMemo(
    () =>
      entryRows(buildRows({ entries, group: presentation.group, schema, allEntries }))
        .map((r) => r.entry.path)
        .join('\n'),
    [entries, presentation.group, schema, allEntries],
  );
  // A dashboard shows no records of ITS OWN — each block shows a different
  // set — so "the records on screen" has no single answer and the panel gets
  // none rather than a plausible wrong one (M16.28).
  //
  // A canvas is the same claim for a different reason (M29.46 review): the
  // rows the page computed are the pool "Add record" OFFERS, not what is
  // drawn. Registering them made a chip click read "3 of 45" and stepped
  // next/prev through records that are nowhere on the canvas. What IS drawn
  // is decided by the .mmd's click lines, which this component cannot see.
  const composed = hasBlocks(presentation.type) || isCanvas(presentation.type);
  useEffect(() => {
    if (embedded) return;
    setDetailSiblings(key === '' || composed ? [] : key.split('\n'));
  }, [key, setDetailSiblings, embedded, composed]);

  // The return type is the exhaustiveness check (M16.3). Without it, and with
  // no `default` below and no `noImplicitReturns` in tsconfig, adding a
  // ViewType member compiled clean and rendered `undefined` at runtime.
  switch (presentation.type) {
    case 'table':
      return (
        <TableView
          entries={entries}
          allEntries={allEntries}
          presentation={presentation}
          schema={schema}
          fields={fields}
          scope={scope}
          onCreate={onCreate}
          filtered={filtered}
          onColumnsChange={onColumnsChange}
          onPresentationChange={onPresentationChange}
          onOrderBy={onOrderBy}
          // M12.4b: the header menu's property operations act on the single
          // type behind the table — the same one quick-add creates into.
          sourceType={createType ?? null}
          onFilterField={onFilterField}
        />
      );
    case 'board':
      return (
        <BoardView
          entries={entries}
          presentation={presentation}
          schema={schema}
          scope={scope}
          filtered={filtered}
          onCreate={onCreate}
        />
      );
    // Calendar and dashboard take no `filtered`, and that is a statement
    // rather than an omission: a calendar draws its month grid whether or not
    // anything lands in it, so it has no records empty state to caption, and a
    // dashboard's blocks each answer the question for their own query below.
    case 'calendar':
      return (
        <CalendarView
          entries={entries}
          presentation={presentation}
          schema={schema}
          fields={fields}
          onCreateOn={onCreateOn}
          {...(today !== undefined ? { today } : {})}
        />
      );
    case 'gantt':
      return (
        <GanttView
          entries={entries}
          allEntries={allEntries}
          presentation={presentation}
          schema={schema}
          fields={fields}
          scope={scope}
          filtered={filtered}
          onZoomChange={onZoomChange}
          {...(today !== undefined ? { today } : {})}
        />
      );
    case 'timeline':
      return (
        <TimelineView
          entries={entries}
          allEntries={allEntries}
          presentation={presentation}
          schema={schema}
          fields={fields}
          scope={scope}
          filtered={filtered}
          onZoomChange={onZoomChange}
          {...(today !== undefined ? { today } : {})}
        />
      );
    case 'dashboard':
      return <DashboardView entries={entries} presentation={presentation} schema={schema} />;
    case 'chart':
      return (
        <ChartView
          entries={entries}
          presentation={presentation}
          schema={schema}
          filtered={filtered}
          // The legend's writer, derived from the presentation writer the
          // pages already pass (M44.3). A dashboard's embedded canvas passes
          // no onPresentationChange, so its chart legend stays static.
          onChartChange={
            onPresentationChange === undefined
              ? undefined
              : (chart) => onPresentationChange({ ...presentation, chart })
          }
        />
      );
    case 'gallery':
      return (
        <GalleryView
          entries={entries}
          presentation={presentation}
          schema={schema}
          scope={scope}
          filtered={filtered}
        />
      );
    case 'list':
      return (
        <ListView
          entries={entries}
          allEntries={allEntries}
          presentation={presentation}
          schema={schema}
          project={project}
          scope={scope}
          createType={createType}
          // M15: the list layout gets the same create + empty-state contract
          // the table has. It was gated on `project`, which no ViewCanvas call
          // site passes, so a List-layout tab could not create at all.
          onCreate={onCreate}
          filtered={filtered}
        />
      );
    case 'whiteboard':
      return (
        <WhiteboardView
          entries={entries}
          presentation={presentation}
          schema={schema}
          host={whiteboardHost ?? null}
          onPresentationChange={onPresentationChange}
        />
      );
  }
}
