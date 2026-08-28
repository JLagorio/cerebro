import React from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { columnUniverse } from '@/engine/columns';
import { dashboardNumber, widgetEntries } from '@/engine/dashboard';
import { resolveSurface } from '@/engine/surface';
import { resolveView } from '@/engine/views';
import { ViewCanvas } from '@/views/ViewCanvas';
import { hasBlocks, viewKind } from '@/views/viewKinds';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { ROW_HEIGHT_DEFAULT } from '@/engine/types';
import type { DashboardSpec, DashboardWidget, Entry, Presentation, Schema } from '@/engine/types';

/**
 * Dashboard (M16.28; rows of widgets since M44.4) — each widget a saved view
 * or a single number, with four own-scope kinds arriving in M44.4 Task 4.
 *
 * The two block kinds read different data ON PURPOSE, and that is the whole
 * design:
 *
 * - A NUMBER measures this dashboard's own rows, so the view's filters scope
 *   it. A number that ignored them would be a constant.
 * - A VIEW embeds a saved view from anywhere in the vault, resolved through
 *   `resolveSurface` — the same function the List page calls. That is what a
 *   dashboard is for: several sources on one screen. It stores a REFERENCE,
 *   never a copy, so editing the List updates every dashboard showing it, and
 *   a deleted List produces one honest missing-block tile rather than a stale
 *   duplicate of a query that no longer exists.
 *
 * A block cannot embed another dashboard. `hasBlocks` is the guard, asked of
 * the kind rather than compared against the string here, so a second
 * block-composed layout is caught by the same check on the day it exists.
 */

export interface DashboardViewProps {
  /** The dashboard view's own rows — filtered and sorted by the caller. */
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** Persists a structural or filter edit back to the view file. Absent (an
   * embedded/read-only host) means no Edit affordances render at all — Task 5
   * gates every editing control on this being defined. */
  onPresentationChange?: (next: Presentation) => void;
}

function WidgetShell({
  widget,
  title,
  subtitle,
  testId,
  children,
}: {
  widget: DashboardWidget;
  title: string;
  subtitle?: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={`widget-${widget.id}`}
      style={{ flexGrow: widget.w ?? 1, flexBasis: 0, minWidth: 280 }}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-n-200 bg-n-0"
    >
      <header className="flex flex-none items-baseline gap-2 border-b border-n-100 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-n-800">{title}</span>
        {subtitle !== undefined && subtitle !== '' && (
          <span className="flex-none text-2xs text-n-400">{subtitle}</span>
        )}
      </header>
      <div data-testid={testId} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </section>
  );
}

/** A block that cannot draw says what is missing and where it pointed — a
 * blank tile is indistinguishable from a block that is still loading. */
function BrokenBlock({
  widget,
  title,
  icon,
  message,
}: {
  widget: DashboardWidget;
  title: string;
  icon: string;
  message: string;
}) {
  return (
    <WidgetShell widget={widget} title={title} testId="dashboard-block">
      <p className="m-0 flex items-start gap-2 px-3 py-4 text-xs leading-[17px] text-n-500">
        <Icon name={icon} size={14} color="var(--n-400)" />
        {message}
      </p>
    </WidgetShell>
  );
}

function NumberBlock({
  widget,
  entries,
  spec,
  schema,
}: {
  widget: Extract<DashboardWidget, { kind: 'number' }>;
  entries: Entry[];
  spec: DashboardSpec;
  schema: Schema;
}) {
  const measured = dashboardNumber(widgetEntries(entries, spec, widget, schema), widget, schema);
  return (
    <WidgetShell
      widget={widget}
      title={measured.label}
      subtitle={`${measured.count} ${measured.count === 1 ? 'record' : 'records'}`}
      testId="dashboard-block"
    >
      <div
        data-testid="dashboard-number"
        data-value={measured.value}
        data-blocked={measured.blocked ?? ''}
        className="flex flex-col items-start gap-1 px-3 py-4"
      >
        <span className="text-3xl font-semibold leading-none tracking-[var(--track-tight)] text-n-900">
          {measured.display}
        </span>
        {measured.blocked !== null && (
          <span className="text-xs leading-[16px] text-n-500">
            {measured.blocked === 'no-value-field'
              ? 'Choose a number property for this block in view settings.'
              : 'No record in view holds a number for that property.'}
          </span>
        )}
      </div>
    </WidgetShell>
  );
}

function ViewBlock({ widget }: { widget: Extract<DashboardWidget, { kind: 'view' }> }) {
  const vault = useVaultStore((s) => s.entries);
  const lists = useVaultStore((s) => s.views);
  const schema = useSchema();
  const collection = widget.collection ?? null;
  // Ids are unique per FOLDER, not per vault, so the collection is part of
  // the key — the same rule resolveSurface and ListPage follow.
  const list = lists.find((l) => l.id === widget.list && l.collection === collection) ?? null;

  if (list === null) {
    return (
      <BrokenBlock
        widget={widget}
        title={widget.title ?? widget.list}
        icon="unlink"
        message={`This block points at a list called “${widget.list}” that is no longer in the vault.`}
      />
    );
  }

  const active = resolveView(list.definition, widget.view);
  const title = widget.title ?? `${list.definition.name} · ${active.name}`;

  if (hasBlocks(active.presentation.type)) {
    return (
      <BrokenBlock
        widget={widget}
        title={title}
        icon="circle-slash"
        message="A dashboard cannot show another dashboard — pick one of its own views instead."
      />
    );
  }

  const surface = resolveSurface(
    { kind: 'list', id: widget.list, collection, view: widget.view },
    vault,
    schema,
    lists,
  );
  const fields = columnUniverse(
    list.definition.source,
    surface.entries,
    schema,
    active.presentation.group,
  );

  return (
    <WidgetShell
      widget={widget}
      title={title}
      subtitle={viewKind(active.presentation.type).label}
      testId="dashboard-block"
    >
      {/* The row owns the height now — this wrapper only bounds the scroll,
          it no longer sets one: the layouts all expand to fill a page, and a
          page-tall table inside a tile is not a dashboard. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ViewCanvas
          embedded
          entries={surface.entries}
          allEntries={vault}
          presentation={surface.presentation}
          schema={schema}
          fields={fields}
          scope={`dashboard:${widget.id}`}
          createType={list.definition.source.type ?? undefined}
          filtered={active.filters !== null}
        />
      </div>
    </WidgetShell>
  );
}

// `onPresentationChange` isn't read yet — Task 5 gates every Edit affordance
// on it being defined. Declared on the props now so ViewCanvas can forward it
// and callers can pass it without a compile error, per M44.4 Task 3.
export function DashboardView({ entries, presentation, schema }: DashboardViewProps) {
  const spec: DashboardSpec = presentation.dashboard ?? { rows: [] };

  return (
    <div
      data-testid="dashboard-view"
      data-blocks={spec.rows.reduce((n, r) => n + r.widgets.length, 0)}
      className="box-border min-h-0 min-w-0 flex-1 overflow-auto bg-n-25 px-5 py-4"
    >
      {spec.rows.length === 0 ? (
        <EmptyState
          icon="layout-dashboard"
          title="No blocks yet"
          description="Add a widget to start — toggle Edit in the corner."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {spec.rows.map((row) => (
            <div
              key={row.id}
              data-testid="dashboard-row"
              className="flex min-w-0 gap-3"
              style={{ height: row.h ?? ROW_HEIGHT_DEFAULT }}
            >
              {row.widgets.map((widget) =>
                widget.kind === 'number' ? (
                  <NumberBlock
                    key={widget.id}
                    widget={widget}
                    entries={entries}
                    spec={spec}
                    schema={schema}
                  />
                ) : widget.kind === 'view' ? (
                  <ViewBlock key={widget.id} widget={widget} />
                ) : // The four own-scope kinds (table/board/timeline/chart) render in
                // M44.4 Task 4; until then a rows-native file simply shows fewer
                // tiles, and nothing saved before M44.4 can hold one.
                null,
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
