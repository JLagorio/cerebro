import React from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { columnUniverse } from '@/engine/columns';
import { dashboardNumber } from '@/engine/dashboard';
import { resolveSurface } from '@/engine/surface';
import { resolveView } from '@/engine/views';
import { ViewCanvas } from '@/views/ViewCanvas';
import { hasBlocks, viewKind } from '@/views/viewKinds';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import type { DashboardBlock, Entry, Presentation, Schema } from '@/engine/types';

/**
 * Dashboard (M16.28) — a grid of blocks, each a saved view or a single number.
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
}

function BlockShell({
  title,
  subtitle,
  wide,
  testId,
  children,
}: {
  title: string;
  subtitle?: string;
  wide: boolean;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      data-wide={wide ? 'true' : 'false'}
      style={wide ? { gridColumn: '1 / -1' } : undefined}
      className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-n-200 bg-n-0"
    >
      <header className="flex flex-none items-baseline gap-2 border-b border-n-100 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-n-800">
          {title}
        </span>
        {subtitle !== undefined && subtitle !== '' && (
          <span className="flex-none text-2xs text-n-400">{subtitle}</span>
        )}
      </header>
      {children}
    </section>
  );
}

/** A block that cannot draw says what is missing and where it pointed — a
 * blank tile is indistinguishable from a block that is still loading. */
function BrokenBlock({
  title,
  wide,
  icon,
  message,
}: {
  title: string;
  wide: boolean;
  icon: string;
  message: string;
}) {
  return (
    <BlockShell title={title} wide={wide} testId="dashboard-block">
      <p className="m-0 flex items-start gap-2 px-3 py-4 text-xs leading-[17px] text-n-500">
        <Icon name={icon} size={14} color="var(--n-400)" />
        {message}
      </p>
    </BlockShell>
  );
}

function NumberBlock({
  block,
  entries,
  schema,
}: {
  block: Extract<DashboardBlock, { kind: 'number' }>;
  entries: Entry[];
  schema: Schema;
}) {
  const measured = dashboardNumber(entries, block, schema);
  return (
    <BlockShell
      title={measured.label}
      subtitle={`${measured.count} ${measured.count === 1 ? 'record' : 'records'}`}
      wide={block.wide === true}
      testId="dashboard-block"
    >
      <div
        data-testid="dashboard-number"
        data-value={measured.value}
        data-blocked={measured.blocked ?? ''}
        className="flex flex-col items-start gap-1 px-3 py-4"
      >
        <span className="text-[30px] font-semibold leading-none tracking-[var(--track-tight)] text-n-900">
          {measured.display}
        </span>
        {measured.blocked !== null && (
          <span className="text-[11.5px] leading-[16px] text-n-500">
            {measured.blocked === 'no-value-field'
              ? 'Choose a number property for this block in view settings.'
              : 'No record in view holds a number for that property.'}
          </span>
        )}
      </div>
    </BlockShell>
  );
}

function ViewBlock({ block }: { block: Extract<DashboardBlock, { kind: 'view' }> }) {
  const vault = useVaultStore((s) => s.entries);
  const lists = useVaultStore((s) => s.views);
  const schema = useSchema();
  const collection = block.collection ?? null;
  // Ids are unique per FOLDER, not per vault, so the collection is part of
  // the key — the same rule resolveSurface and ListPage follow.
  const list = lists.find((l) => l.id === block.list && l.collection === collection) ?? null;

  if (list === null) {
    return (
      <BrokenBlock
        title={block.title ?? block.list}
        wide={block.wide === true}
        icon="unlink"
        message={`This block points at a list called “${block.list}” that is no longer in the vault.`}
      />
    );
  }

  const active = resolveView(list.definition, block.view);
  const title = block.title ?? `${list.definition.name} · ${active.name}`;

  if (hasBlocks(active.presentation.type)) {
    return (
      <BrokenBlock
        title={title}
        wide={block.wide === true}
        icon="circle-slash"
        message="A dashboard cannot show another dashboard — pick one of its own views instead."
      />
    );
  }

  const surface = resolveSurface(
    { kind: 'list', id: block.list, collection, view: block.view },
    vault,
    schema,
    lists,
  );
  const fields = columnUniverse(list.definition.source, surface.entries, schema);

  return (
    <BlockShell
      title={title}
      subtitle={viewKind(active.presentation.type).label}
      wide={block.wide === true}
      testId="dashboard-block"
    >
      {/* Bounded, and its own scroll container: the layouts all expand to fill
          a page, and a page-tall table inside a tile is not a dashboard. */}
      <div className="flex h-[300px] min-h-0 flex-col overflow-hidden">
        <ViewCanvas
          embedded
          entries={surface.entries}
          allEntries={vault}
          presentation={surface.presentation}
          schema={schema}
          fields={fields}
          scope={`dashboard:${block.id}`}
          createType={list.definition.source.type ?? undefined}
          filtered={active.filters !== null}
        />
      </div>
    </BlockShell>
  );
}

export function DashboardView({ entries, presentation, schema }: DashboardViewProps) {
  const blocks = presentation.dashboard?.blocks ?? [];

  return (
    <div
      data-testid="dashboard-view"
      data-blocks={blocks.length}
      className="box-border min-h-0 min-w-0 flex-1 overflow-auto bg-n-25 px-5 py-4"
    >
      {blocks.length === 0 ? (
        <EmptyState
          icon="layout-dashboard"
          title="No blocks yet"
          description="Add a saved view or a number under Blocks in view settings."
        />
      ) : (
        // auto-fit rather than a breakpoint: the canvas shares its width with
        // a detail panel that opens and closes, so the column count has to
        // follow the container, not the window.
        <div
          className="grid items-start gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}
        >
          {blocks.map((block) =>
            block.kind === 'number' ? (
              <NumberBlock key={block.id} block={block} entries={entries} schema={schema} />
            ) : (
              <ViewBlock key={block.id} block={block} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
