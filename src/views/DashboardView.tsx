import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { MenuBack, MenuItem, MenuLabel, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { measureLabel } from '@/engine/chart';
import { columnUniverse } from '@/engine/columns';
import {
  addWidget,
  DASHBOARD_FULL,
  dashboardNumber,
  duplicateWidget,
  moveToEnd,
  moveToOwnRow,
  moveWidget,
  moveWithinRow,
  removeWidget,
  updateWidget,
  widgetCount,
  widgetEntries,
} from '@/engine/dashboard';
import { GROUPABLE_KINDS, NUMERIC_KINDS } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import { resolveSurface } from '@/engine/surface';
import { filterFieldDefs, filterStatusSet } from '@/engine/viewFilters';
import { nextDashboardWidgetId, resolveView } from '@/engine/views';
import { BoardView } from '@/views/BoardView';
import { ChartView } from '@/views/ChartView';
import { FilterBuilder } from '@/views/FilterBuilder';
import { countRules } from '@/views/FilterChips';
import { TableView } from '@/views/TableView';
import { TimelineView } from '@/views/TimelineView';
import { ViewCanvas } from '@/views/ViewCanvas';
import { hasBlocks, viewKind } from '@/views/viewKinds';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { MAX_DASHBOARD_WIDGETS, MAX_ROW_WIDGETS, ROW_HEIGHT_DEFAULT } from '@/engine/types';
import type { DragEndEvent } from '@dnd-kit/core';
import type { ContextMenuItem } from '@/components/ui/ContextMenu';
import type { DashboardEdit } from '@/engine/dashboard';
import type {
  DashboardSpec,
  DashboardWidget,
  Entry,
  FieldDef,
  ListSource,
  Presentation,
  Schema,
} from '@/engine/types';

/**
 * Dashboard (M16.28; rows of widgets since M44.4) — each widget a saved view,
 * a single number, or one of the four own-scope layouts (table, board,
 * timeline, chart).
 *
 * The widget kinds read two different data flows ON PURPOSE, and that is the
 * whole design:
 *
 * - A VIEW embeds a saved view from anywhere in the vault, resolved through
 *   `resolveSurface` — the same function the List page calls. That is what a
 *   dashboard is for: several sources on one screen. It stores a REFERENCE,
 *   never a copy, so editing the List updates every dashboard showing it, and
 *   a deleted List produces one honest missing-block tile rather than a stale
 *   duplicate of a query that no longer exists. The dashboard's two filter
 *   layers (Global, then the widget's own) apply OVER the saved view's rows —
 *   so the Global popover's "every widget's rows pass it" is literally true,
 *   view embeds included.
 * - EVERY OTHER KIND reads this dashboard's own rows through `widgetEntries`,
 *   so the view's filters, the Global filter, and the widget's own filter all
 *   scope it. A number that ignored them would be a constant; the own-scope
 *   layouts render the existing view components DIRECTLY over that scoped set
 *   with a locally composed presentation — never through `resolveSurface`,
 *   which stays the view-embed's path.
 *
 * A block cannot embed another dashboard. `hasBlocks` is the guard, asked of
 * the kind rather than compared against the string here, so a second
 * block-composed layout is caught by the same check on the day it exists.
 */

/** The dashboard never learns its List's source — only its rows arrive — so
 * the own-scope widgets' column universe is the union of the types PRESENT in
 * the scoped rows: `columnUniverse`'s own typeless-List fallback. */
const OWN_SCOPE_SOURCE: ListSource = { type: null, project: null };

type OwnScopeWidget = Extract<DashboardWidget, { kind: 'table' | 'board' | 'timeline' | 'chart' }>;

/** The widget header's COMPUTED default name per kind — never the stored
 * override; callers display `widget.title ?? defaultWidgetTitle(widget)` and
 * the rename input needs both halves separately. The chart's is its measure,
 * the same words ChartView itself uses. (`view` and `number` widgets compute
 * theirs from the embedded List and the aggregation label respectively.) */
function defaultWidgetTitle(widget: OwnScopeWidget): string {
  switch (widget.kind) {
    case 'table':
      return 'Table';
    case 'board':
      return 'Board';
    case 'timeline':
      return 'Timeline';
    case 'chart':
      return measureLabel(widget.chart);
  }
}

/** Whether an own-scope widget's rows are narrower than the surface's — what
 * the embedded view's empty state reads to say WHY nothing is here. */
function widgetFiltered(spec: DashboardSpec, widget: DashboardWidget): boolean {
  return spec.global !== undefined || widget.filter !== undefined;
}

/** Row-of-widget-ids matrices ONLY — row ids stay out on purpose: `moveToEnd`
 * mints a fresh row id even when the widget was already alone at the end, and
 * an identical layout under a new row id is still an identity drop. */
function sameStructure(a: DashboardSpec, b: DashboardSpec): boolean {
  return (
    a.rows.length === b.rows.length &&
    a.rows.every(
      (r, i) =>
        r.widgets.length === b.rows[i].widgets.length &&
        r.widgets.every((w, j) => w.id === b.rows[i].widgets[j].id),
    )
  );
}

/** Resolves a `slot:<rowId>:<index>` target into a `moveWidget` call. */
function moveToSlot(spec: DashboardSpec, id: string, over: string): DashboardEdit {
  // Greedy up to the LAST colon: a hand-edited row id may itself carry one.
  const m = over.match(/^slot:(.+):(\d+)$/);
  if (m === null) return { ok: true, spec }; // malformed target — identity, no commit
  const rowId = m[1];
  let slot = Number(m[2]);
  // Slot indices count the row WITH the dragged widget still in place, but
  // moveWidget removes first and inserts second — so a same-row drop past the
  // widget's own position is one slot ahead of where the gap sat on screen.
  const from = spec.rows.find((r) => r.id === rowId)?.widgets.findIndex((w) => w.id === id) ?? -1;
  if (from !== -1 && from < slot) slot -= 1;
  return moveWidget(spec, id, rowId, slot);
}

/**
 * Drop resolution, pure and exported for direct testing — the BoardView
 * `handleDragEnd` pattern. Slot ids are `slot:<rowId>:<index>` (0 through
 * widgets.length) plus one `slot:new-row` after the last row — globally
 * unique by construction, because dnd-kit's droppable registry is a Map and
 * a duplicate id silently kills a target. Anything else under the pointer
 * (a widget, nothing at all) is not a target. A cap refusal toasts the pure
 * editor's own sentence; an identity drop commits nothing.
 */
export function handleWidgetDragEnd(
  event: DragEndEvent,
  args: {
    spec: DashboardSpec;
    commit: (next: DashboardSpec) => void;
    toast: (msg: string) => void;
  },
): void {
  const over = event.over === null ? null : String(event.over.id);
  if (over === null || !over.startsWith('slot:')) return;
  const id = String(event.active.id);
  const edit = over === 'slot:new-row' ? moveToEnd(args.spec, id) : moveToSlot(args.spec, id, over);
  if (!edit.ok) {
    args.toast(edit.reason);
    return;
  }
  if (sameStructure(edit.spec, args.spec)) return;
  args.commit(edit.spec);
}

/** A droppable insertion point (Edit mode only). Invisible until a drag
 * hovers it — then it paints itself as the insertion line, the repo's own
 * inset-line style rather than a DragOverlay. */
function WidgetSlot({ id, wide = false }: { id: string; wide?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-testid="dashboard-slot"
      data-slot={id}
      className={[
        wide ? 'h-1.5 w-full flex-none rounded' : 'w-1.5 flex-none self-stretch rounded',
        isOver ? 'bg-cortex-500' : 'bg-transparent',
      ].join(' ')}
    />
  );
}

export interface DashboardViewProps {
  /** The dashboard view's own rows — filtered and sorted by the caller. */
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** Persists a structural or filter edit back to the view file. Absent (an
   * embedded/read-only host) means no Edit affordances render at all. */
  onPresentationChange?: (next: Presentation) => void;
}

/**
 * What the editing chrome inside a `WidgetShell` needs from the dashboard:
 * the current spec to run the pure editors against, the commit that toasts a
 * refusal, and the one-widget-at-a-time rename state. A context rather than
 * six threaded prop sets — every widget component renders the same shell, and
 * the provider's `null` when Edit is off is what makes the chrome disappear.
 */
interface DashboardEditApi {
  spec: DashboardSpec;
  schema: Schema;
  entries: Entry[];
  commit: (edit: DashboardEdit) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
}

const EditContext = createContext<DashboardEditApi | null>(null);

/** The ViewTabs rename idiom, minus one rule (see WidgetShell): commit on
 * blur/Enter; Escape is a separate CANCEL signal, because here an empty
 * commit means "clear the override" and Escape must never mean that. */
function RenameWidget({
  name,
  placeholder,
  onCommit,
  onCancel,
}: {
  name: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(name);
  return (
    <input
      autoFocus
      aria-label="Widget title"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="h-6 min-w-0 flex-1 rounded-md border border-cortex-500 px-1.5 text-sm text-n-900 shadow-[0_0_0_3px_var(--cortex-100)] outline-none"
    />
  );
}

/**
 * The per-widget ellipsis menu (Edit mode only). Every structural item runs a
 * pure editor from engine/dashboard.ts and hands the result to `commit`, so a
 * cap refusal here speaks the same sentence a drag or an add would. Filter…
 * and Band by… open their own anchored surfaces after the menu closes.
 */
function WidgetMenuButton({
  widget,
  title,
  edit,
  filterFields,
}: {
  widget: DashboardWidget;
  title: string;
  edit: DashboardEditApi;
  /** A roster override for widgets whose rows are NOT the dashboard's own —
   * the view embed passes its List's universe, since a filter authored from
   * the wrong roster would be unread YAML. Absent = own-scope universe. */
  filterFields?: FieldDef[];
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [surface, setSurface] = useState<'filter' | 'band' | null>(null);

  // The widget's own filter must NOT narrow the universe it is edited with —
  // a filter matching nothing would otherwise erase the very fields needed to
  // fix it. The Global layer stays: those are the rows this widget can see.
  const fields = useMemo(
    () =>
      columnUniverse(
        OWN_SCOPE_SOURCE,
        widgetEntries(edit.entries, edit.spec, { ...widget, filter: undefined }, edit.schema),
        edit.schema,
        [],
      ),
    [edit.entries, edit.spec, edit.schema, widget],
  );
  const groupable = fields.filter((f) => GROUPABLE_KINDS.has(f.kind));
  const filterDefs =
    filterFields ?? filterFieldDefs(fields, filterStatusSet(edit.schema, OWN_SCOPE_SOURCE.type));
  // What the board bands by when no override is stored — named in the roster
  // so "back to default" is a choice, not a mystery.
  const defaultBand = fields.find((f) => f.kind === 'status')?.name;

  const items: ContextMenuItem[] = [
    { icon: 'pencil', label: 'Rename…', onSelect: () => edit.setRenamingId(widget.id) },
    { icon: 'list-filter', label: 'Filter…', onSelect: () => setSurface('filter') },
    ...(widget.kind === 'board'
      ? [{ icon: 'columns-3', label: 'Band by…', onSelect: () => setSurface('band') }]
      : []),
    {
      icon: 'copy',
      label: 'Duplicate',
      onSelect: () => edit.commit(duplicateWidget(edit.spec, widget.id)),
    },
    {
      icon: 'arrow-left',
      label: 'Move left',
      onSelect: () => edit.commit(moveWithinRow(edit.spec, widget.id, -1)),
    },
    {
      icon: 'arrow-right',
      label: 'Move right',
      onSelect: () => edit.commit(moveWithinRow(edit.spec, widget.id, 1)),
    },
    {
      icon: 'rows-3',
      label: 'Move to own row',
      onSelect: () => edit.commit(moveToOwnRow(edit.spec, widget.id)),
    },
    {
      icon: 'trash-2',
      label: 'Delete',
      danger: true,
      onSelect: () => edit.commit(removeWidget(edit.spec, widget.id)),
    },
  ];

  return (
    <>
      <button
        ref={ref}
        type="button"
        data-testid="widget-menu"
        aria-label={`Widget menu: ${title}`}
        onClick={() => {
          const r = ref.current?.getBoundingClientRect();
          setMenuAt({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 });
        }}
        className="flex h-6 w-6 flex-none items-center justify-center rounded-md border-0 bg-transparent text-n-500 hover:bg-n-100 hover:text-n-800"
      >
        <Icon name="ellipsis" size={14} />
      </button>
      {menuAt !== null && (
        <ContextMenu x={menuAt.x} y={menuAt.y} items={items} onClose={() => setMenuAt(null)} />
      )}
      {surface === 'filter' && (
        <Popover
          anchorRef={ref}
          onClose={() => setSurface(null)}
          role="dialog"
          ariaLabel={`Filter: ${title}`}
        >
          <div className="w-[560px] max-w-[calc(100vw-32px)] rounded-lg border border-n-200 bg-n-0 p-2.5 shadow-[var(--shadow-lg)]">
            <div className="px-0.5 pb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
              Filter this widget
            </div>
            <FilterBuilder
              filters={widget.filter ?? null}
              fields={filterDefs}
              // `undefined` DELETES the key through updateWidget — an emptied
              // filter leaves the YAML, matching the Global chip's rule.
              onChange={(g) =>
                edit.commit(updateWidget(edit.spec, widget.id, { filter: g ?? undefined }))
              }
            />
          </div>
        </Popover>
      )}
      {surface === 'band' && (
        <Popover
          anchorRef={ref}
          onClose={() => setSurface(null)}
          role="menu"
          ariaLabel={`Band by: ${title}`}
        >
          <MenuSurface width={200}>
            <MenuLabel>Band by</MenuLabel>
            {/* The way back: clearing the override returns the board to its
                resolved default rather than leaving `group:` stuck forever. */}
            <MenuItem
              label={defaultBand !== undefined ? `Default (${humanize(defaultBand)})` : 'Default'}
              checked={widget.kind === 'board' && widget.group === undefined}
              onSelect={() => {
                setSurface(null);
                edit.commit(updateWidget(edit.spec, widget.id, { group: undefined }));
              }}
            />
            {groupable.map((f) => (
              <MenuItem
                key={f.name}
                label={humanize(f.name)}
                checked={widget.kind === 'board' && widget.group === f.name}
                onSelect={() => {
                  setSurface(null);
                  edit.commit(updateWidget(edit.spec, widget.id, { group: f.name }));
                }}
              />
            ))}
            {groupable.length === 0 && (
              <p className="m-0 px-2 py-1 text-2xs leading-[15px] text-n-400">
                No property in these rows can band a board.
              </p>
            )}
          </MenuSurface>
        </Popover>
      )}
    </>
  );
}

function WidgetShell({
  widget,
  title,
  defaultTitle = title,
  subtitle,
  testId,
  filterFields,
  children,
}: {
  widget: DashboardWidget;
  title: string;
  /** The computed per-kind name — the rename input's placeholder, and what
   * the header returns to when an override is cleared. Defaults to `title`
   * for the shells whose display name IS the computed one. */
  defaultTitle?: string;
  subtitle?: string;
  testId: string;
  /** See WidgetMenuButton — the view embed's roster override. */
  filterFields?: FieldDef[];
  children: React.ReactNode;
}) {
  const edit = useContext(EditContext);
  const hasCustom = widget.title !== undefined && widget.title !== '';
  // Registered even outside Edit mode (a hook cannot be conditional) but
  // disabled then — and dnd-kit's default context makes the hook a no-op when
  // no DndContext is mounted, so a read-only host pays nothing. The GRIP is
  // the draggable node, not the whole tile: its small rect tracks the pointer
  // into the thin slot strips, and the menu button and rename input keep
  // their clicks — the listeners never touch them.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: widget.id,
    disabled: edit === null,
  });
  return (
    <section
      data-testid={`widget-${widget.id}`}
      style={{
        flexGrow: widget.w ?? 1,
        flexBasis: 0,
        minWidth: 280,
        // The source dims in place; no DragOverlay (BoardView precedent).
        opacity: isDragging ? 0.6 : undefined,
      }}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-n-200 bg-n-0"
    >
      <header className="flex flex-none items-center gap-2 border-b border-n-100 px-3 py-2">
        {edit !== null && (
          <span
            ref={setNodeRef}
            data-testid="widget-grip"
            {...attributes}
            {...listeners}
            aria-label={`Drag ${title}`}
            className="flex h-6 w-4 flex-none cursor-grab touch-none items-center justify-center rounded text-n-400 hover:bg-n-100 hover:text-n-700"
          >
            <Icon name="grip-vertical" size={12} />
          </span>
        )}
        {edit !== null && edit.renamingId === widget.id ? (
          <RenameWidget
            name={title}
            placeholder={defaultTitle}
            onCancel={() => edit.setRenamingId(null)}
            onCommit={(name) => {
              edit.setRenamingId(null);
              // Deviates from ViewTabs' empty=cancel, deliberately: there an
              // empty commit would leave a view with no name at all, while
              // here it CLEARS the override and the computed default still
              // shows — so empty is the way back, and Escape is the cancel.
              if (name === '') {
                if (hasCustom)
                  edit.commit(updateWidget(edit.spec, widget.id, { title: undefined }));
                return;
              }
              if (name !== title) {
                edit.commit(updateWidget(edit.spec, widget.id, { title: name }));
              }
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-n-800">{title}</span>
        )}
        {subtitle !== undefined && subtitle !== '' && (
          <span className="flex-none text-2xs text-n-400">{subtitle}</span>
        )}
        {edit !== null && (
          <WidgetMenuButton widget={widget} title={title} edit={edit} filterFields={filterFields} />
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
  defaultTitle,
  icon,
  message,
}: {
  widget: DashboardWidget;
  title: string;
  defaultTitle?: string;
  icon: string;
  message: string;
}) {
  return (
    <WidgetShell widget={widget} title={title} defaultTitle={defaultTitle} testId="dashboard-block">
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
  // Measured sans the override so `measured.label` is always the COMPUTED
  // name — the display prefers `widget.title`, the rename input needs both.
  const measured = dashboardNumber(
    widgetEntries(entries, spec, widget, schema),
    { ...widget, title: undefined },
    schema,
  );
  return (
    <WidgetShell
      widget={widget}
      title={widget.title ?? measured.label}
      defaultTitle={measured.label}
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

interface OwnScopeProps<K extends OwnScopeWidget['kind']> {
  widget: Extract<DashboardWidget, { kind: K }>;
  entries: Entry[];
  spec: DashboardSpec;
  schema: Schema;
}

function TableWidget({
  widget,
  entries,
  spec,
  schema,
  sort,
}: OwnScopeProps<'table'> & { sort: Presentation['sort'] }) {
  const scoped = widgetEntries(entries, spec, widget, schema);
  const fields = columnUniverse(OWN_SCOPE_SOURCE, scoped, schema, []);
  return (
    <WidgetShell
      widget={widget}
      title={widget.title ?? defaultWidgetTitle(widget)}
      defaultTitle={defaultWidgetTitle(widget)}
      testId="dashboard-block"
    >
      <TableView
        entries={scoped}
        presentation={{ type: 'table', group: [], sort, columns: [] }}
        schema={schema}
        fields={fields}
        filtered={widgetFiltered(spec, widget)}
      />
    </WidgetShell>
  );
}

function BoardWidget({ widget, entries, spec, schema }: OwnScopeProps<'board'>) {
  const scoped = widgetEntries(entries, spec, widget, schema);
  const fields = columnUniverse(OWN_SCOPE_SOURCE, scoped, schema, []);
  // The stored band, else the first status-kind field of the scoped rows —
  // the same question `hasStatusField` asks for the seed paths. Neither
  // resolving is a CONFIGURATION gap, not an empty collection, so the tile
  // must ask for a band rather than claim there is no data.
  const band = widget.group ?? fields.find((f) => f.kind === 'status')?.name;
  if (band === undefined) {
    return (
      <BrokenBlock
        widget={widget}
        title={widget.title ?? defaultWidgetTitle(widget)}
        icon="square-kanban"
        message="Toggle Edit and pick Band by… in the widget menu."
      />
    );
  }
  return (
    <WidgetShell
      widget={widget}
      title={widget.title ?? defaultWidgetTitle(widget)}
      defaultTitle={defaultWidgetTitle(widget)}
      testId="dashboard-block"
    >
      <BoardView
        entries={scoped}
        presentation={{ type: 'board', group: [{ field: band }], sort: [], columns: [] }}
        schema={schema}
        filtered={widgetFiltered(spec, widget)}
        scope={`dashboard:${widget.id}`}
      />
    </WidgetShell>
  );
}

function TimelineWidget({ widget, entries, spec, schema }: OwnScopeProps<'timeline'>) {
  const scoped = widgetEntries(entries, spec, widget, schema);
  const fields = columnUniverse(OWN_SCOPE_SOURCE, scoped, schema, []);
  return (
    <WidgetShell
      widget={widget}
      title={widget.title ?? defaultWidgetTitle(widget)}
      defaultTitle={defaultWidgetTitle(widget)}
      testId="dashboard-block"
    >
      <TimelineView
        entries={scoped}
        presentation={{ type: 'timeline', group: [], sort: [], columns: [] }}
        schema={schema}
        fields={fields}
        filtered={widgetFiltered(spec, widget)}
        scope={`dashboard:${widget.id}`}
      />
    </WidgetShell>
  );
}

function ChartWidget({ widget, entries, spec, schema }: OwnScopeProps<'chart'>) {
  const scoped = widgetEntries(entries, spec, widget, schema);
  return (
    <WidgetShell
      widget={widget}
      title={widget.title ?? defaultWidgetTitle(widget)}
      defaultTitle={defaultWidgetTitle(widget)}
      testId="dashboard-block"
    >
      {/* No `onChartChange`/`onSaveView`: an embedded chart is static by
          decision. The chart's own typed empty states answer misconfiguration
          — a group-less widget gets its no-group refusal, not a new one. */}
      <ChartView
        entries={scoped}
        presentation={{
          type: 'chart',
          group: widget.group !== undefined ? [{ field: widget.group }] : [],
          sort: [],
          columns: [],
          ...(widget.chart !== undefined ? { chart: widget.chart } : {}),
        }}
        schema={schema}
        filtered={widgetFiltered(spec, widget)}
      />
    </WidgetShell>
  );
}

function ViewBlock({
  widget,
  spec,
}: {
  widget: Extract<DashboardWidget, { kind: 'view' }>;
  spec: DashboardSpec;
}) {
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
        defaultTitle={widget.list}
        icon="unlink"
        message={`This block points at a list called “${widget.list}” that is no longer in the vault.`}
      />
    );
  }

  const active = resolveView(list.definition, widget.view);
  const defaultTitle = `${list.definition.name} · ${active.name}`;
  const title = widget.title ?? defaultTitle;

  if (hasBlocks(active.presentation.type)) {
    return (
      <BrokenBlock
        widget={widget}
        title={title}
        defaultTitle={defaultTitle}
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
  // The dashboard's two layers apply over the embed too: the Global filter
  // and the widget's own, on top of the saved view's already-filtered rows —
  // so the Global popover's "every widget's rows pass it" is literally true.
  const scoped = widgetEntries(surface.entries, spec, widget, schema);
  // The Filter… roster comes from the EMBED's universe (its List's source and
  // rows, pre-widget-filter) — a rule authored from the dashboard's own
  // roster would be unread YAML against these entries. The embed knows its
  // source type, so status fields get their real option set.
  const filterFields = filterFieldDefs(
    fields,
    filterStatusSet(schema, list.definition.source.type),
  );

  return (
    <WidgetShell
      widget={widget}
      title={title}
      defaultTitle={defaultTitle}
      subtitle={viewKind(active.presentation.type).label}
      testId="dashboard-block"
      filterFields={filterFields}
    >
      {/* The row owns the height now — this wrapper only bounds the scroll,
          it no longer sets one: the layouts all expand to fill a page, and a
          page-tall table inside a tile is not a dashboard. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ViewCanvas
          embedded
          entries={scoped}
          allEntries={vault}
          presentation={surface.presentation}
          schema={schema}
          fields={fields}
          scope={`dashboard:${widget.id}`}
          createType={list.definition.source.type ?? undefined}
          filtered={active.filters !== null || widgetFiltered(spec, widget)}
        />
      </div>
    </WidgetShell>
  );
}

/** A widget before its id — what the add popover's presets mint. Distributed
 * over the union so each preset stays the member it names. */
type WidgetSeed = DashboardWidget extends infer W
  ? W extends DashboardWidget
    ? Omit<W, 'id'>
    : never
  : never;

/**
 * The add-widget popover: MenuLabel groups over one widget vocabulary. The
 * metric presets are NOT kinds — Count/Sum/Average mint configured `number`
 * widgets, and Horizontal bar is a `chart` whose spec says so. At capacity
 * every item disables and the inline note quotes the editors' own refusal
 * sentence, so the popover and the toast can never disagree on the rule.
 */
function AddWidgetMenu({
  spec,
  entries,
  schema,
  commit,
  anchorRef,
  onClose,
}: {
  spec: DashboardSpec;
  entries: Entry[];
  schema: Schema;
  commit: (edit: DashboardEdit) => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const lists = useVaultStore((s) => s.views);
  const [step, setStep] = useState<'root' | 'saved-view' | 'sum' | 'avg'>('root');
  const full = widgetCount(spec) >= MAX_DASHBOARD_WIDGETS;
  const fields = useMemo(
    () => columnUniverse(OWN_SCOPE_SOURCE, entries, schema, []),
    [entries, schema],
  );
  const numeric = fields.filter((f) => NUMERIC_KINDS.has(f.kind));

  const mint = (seed: WidgetSeed) => {
    // Scanning bottom-up: the widget joins the LOWEST row that still has
    // room — which can be a row above a full last one — else a fresh
    // trailing row.
    const target =
      [...spec.rows].reverse().find((r) => r.widgets.length < MAX_ROW_WIDGETS)?.id ?? 'new-row';
    // The cast restores what the distributive Omit proves: any seed member
    // plus an id is exactly the union member it came from.
    const widget = { ...seed, id: nextDashboardWidgetId(spec) } as DashboardWidget;
    commit(addWidget(spec, target, widget));
    onClose();
  };

  return (
    <Popover
      anchorRef={anchorRef}
      onClose={onClose}
      onEscape={step === 'root' ? onClose : () => setStep('root')}
      role="menu"
      ariaLabel="Add widget"
    >
      <MenuSurface width={236}>
        {step === 'root' && (
          <>
            <MenuLabel>Charts</MenuLabel>
            <MenuItem
              icon="chart-column"
              label="Bar chart"
              disabled={full}
              onSelect={() => mint({ kind: 'chart', chart: { kind: 'bar' } })}
            />
            <MenuItem
              icon="chart-bar"
              label="Horizontal bar"
              disabled={full}
              onSelect={() => mint({ kind: 'chart', chart: { kind: 'bar', horizontal: true } })}
            />
            <MenuItem
              icon="chart-line"
              label="Line chart"
              disabled={full}
              onSelect={() => mint({ kind: 'chart', chart: { kind: 'line' } })}
            />
            <MenuItem
              icon="chart-pie"
              label="Donut"
              disabled={full}
              onSelect={() => mint({ kind: 'chart', chart: { kind: 'donut' } })}
            />
            <MenuLabel>Views</MenuLabel>
            <MenuItem
              icon="table-2"
              label="Table"
              disabled={full}
              onSelect={() => mint({ kind: 'table' })}
            />
            <MenuItem
              icon="columns-3"
              label="Board"
              disabled={full}
              onSelect={() => mint({ kind: 'board' })}
            />
            <MenuItem
              icon="chart-no-axes-gantt"
              label="Timeline"
              disabled={full}
              onSelect={() => mint({ kind: 'timeline' })}
            />
            <MenuItem
              icon="bookmark"
              label="Saved view…"
              submenu
              disabled={full}
              onSelect={() => setStep('saved-view')}
            />
            <MenuLabel>Metrics</MenuLabel>
            <MenuItem
              icon="hash"
              label="Count of records"
              disabled={full}
              onSelect={() => mint({ kind: 'number', agg: 'count' })}
            />
            <MenuItem
              icon="sigma"
              label="Sum of…"
              submenu
              disabled={full}
              onSelect={() => setStep('sum')}
            />
            <MenuItem
              icon="divide"
              label="Average of…"
              submenu
              disabled={full}
              onSelect={() => setStep('avg')}
            />
            {full && (
              <p className="m-0 mt-1.5 border-t border-n-100 px-2 pt-2 text-2xs leading-[15px] text-n-400">
                {DASHBOARD_FULL}
              </p>
            )}
          </>
        )}
        {step === 'saved-view' && (
          <>
            <MenuBack title="Saved view" onBack={() => setStep('root')} />
            {lists.map((l) => (
              <MenuItem
                key={`${l.collection ?? ''}::${l.id}`}
                icon="table-2"
                label={l.definition.name}
                onSelect={() =>
                  mint({
                    kind: 'view',
                    list: l.id,
                    ...(l.collection !== null ? { collection: l.collection } : {}),
                  })
                }
              />
            ))}
            {lists.length === 0 && (
              <p className="m-0 px-2 py-1 text-2xs leading-[15px] text-n-400">
                There are no saved lists in the vault to embed yet.
              </p>
            )}
          </>
        )}
        {(step === 'sum' || step === 'avg') && (
          <>
            <MenuBack
              title={step === 'sum' ? 'Sum of' : 'Average of'}
              onBack={() => setStep('root')}
            />
            {numeric.map((f) => (
              <MenuItem
                key={f.name}
                icon="hash"
                label={humanize(f.name)}
                onSelect={() =>
                  mint({ kind: 'number', agg: step === 'sum' ? 'sum' : 'avg', value: f.name })
                }
              />
            ))}
            {numeric.length === 0 && (
              <p className="m-0 px-2 py-1 text-2xs leading-[15px] text-n-400">
                This view has no number property to add up.
              </p>
            )}
          </>
        )}
      </MenuSurface>
    </Popover>
  );
}

/** Stable fallback for a presentation with no dashboard yet — a fresh object
 * here would churn every memo and context consumer downstream per render. */
const EMPTY_SPEC: DashboardSpec = { rows: [] };

export function DashboardView({
  entries,
  presentation,
  schema,
  onPresentationChange,
}: DashboardViewProps) {
  const spec: DashboardSpec = presentation.dashboard ?? EMPTY_SPEC;
  const toast = useUiStore((s) => s.toast);

  // A lens, not a place: local, resets on remount, persisted nowhere.
  const [editing, setEditing] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [globalOpen, setGlobalOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const globalRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  const canEdit = onPresentationChange !== undefined;
  const live = editing && canEdit;

  // BoardView's exact sensors: distance-4 keeps the grip's press from eating
  // ordinary clicks; Space picks up and drops, arrows move, Escape cancels.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

  const write = useCallback(
    (next: DashboardSpec) => onPresentationChange?.({ ...presentation, dashboard: next }),
    [onPresentationChange, presentation],
  );
  /** One door for every structural edit: an ok writes, a refusal speaks. */
  const commit = useCallback(
    (edit: DashboardEdit) => {
      if (!edit.ok) {
        toast(edit.reason);
        return;
      }
      write(edit.spec);
    },
    [toast, write],
  );

  const globalDefs = useMemo(
    () =>
      filterFieldDefs(
        columnUniverse(OWN_SCOPE_SOURCE, entries, schema, []),
        // Typeless by construction (OWN_SCOPE_SOURCE), so today this merges
        // nothing — but the seam is where a future typed scope would enter.
        filterStatusSet(schema, OWN_SCOPE_SOURCE.type),
      ),
    [entries, schema],
  );

  // Memoized so the context identity only moves when an input does — without
  // it every render re-rendered every shell's chrome for nothing.
  const api = useMemo<DashboardEditApi>(
    () => ({ spec, schema, entries, commit, renamingId, setRenamingId }),
    [spec, schema, entries, commit, renamingId],
  );

  return (
    <EditContext.Provider value={live ? api : null}>
      <div
        data-testid="dashboard-view"
        data-blocks={spec.rows.reduce((n, r) => n + r.widgets.length, 0)}
        className="box-border min-h-0 min-w-0 flex-1 overflow-auto bg-n-25 px-5 py-4"
      >
        {canEdit && (
          <div className="mb-3 flex items-center justify-end gap-1.5">
            {editing && (
              <button
                ref={addRef}
                type="button"
                data-testid="add-widget"
                aria-expanded={adding}
                onClick={() => setAdding((v) => !v)}
                className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-dashed border-n-300 bg-transparent px-2 text-xs text-n-500 hover:border-n-400 hover:text-n-800"
              >
                <Icon name="plus" size={12} />
                Add widget
              </button>
            )}
            <button
              ref={globalRef}
              type="button"
              data-testid="dashboard-global-filter"
              aria-expanded={globalOpen}
              onClick={() => setGlobalOpen((v) => !v)}
              className={[
                'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs',
                spec.global !== undefined
                  ? 'border-cortex-300 bg-cortex-50 text-cortex-700 hover:bg-cortex-100'
                  : 'border-transparent bg-transparent text-n-500 hover:bg-n-50 hover:text-n-800',
              ].join(' ')}
            >
              <Icon name="list-filter" size={12} />
              Global filter
              {spec.global !== undefined ? ` · ${countRules(spec.global)}` : ''}
            </button>
            <button
              type="button"
              data-testid="dashboard-edit-toggle"
              aria-label={editing ? 'Done editing' : 'Edit widgets'}
              aria-pressed={editing}
              onClick={() => {
                setEditing((v) => !v);
                setRenamingId(null);
                setAdding(false);
              }}
              className={[
                'flex h-7 w-7 items-center justify-center rounded-md border-0',
                editing
                  ? 'bg-[var(--surface-selected)] text-cortex-600'
                  : 'bg-transparent text-n-500 hover:bg-n-50 hover:text-n-800',
              ].join(' ')}
            >
              <Icon name={editing ? 'check' : 'pencil'} size={13} />
            </button>
            {adding && (
              <AddWidgetMenu
                spec={spec}
                entries={entries}
                schema={schema}
                commit={commit}
                anchorRef={addRef}
                onClose={() => setAdding(false)}
              />
            )}
            {globalOpen && (
              <Popover
                anchorRef={globalRef}
                onClose={() => setGlobalOpen(false)}
                role="dialog"
                ariaLabel="Global filter"
              >
                <div className="w-[560px] max-w-[calc(100vw-32px)] rounded-lg border border-n-200 bg-n-0 p-2.5 shadow-[var(--shadow-lg)]">
                  <div className="px-0.5 pb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                    Global filter — every widget&rsquo;s rows pass it
                  </div>
                  <FilterBuilder
                    filters={spec.global ?? null}
                    fields={globalDefs}
                    onChange={(g) => {
                      // An emptied group DELETES the key (FilterChips' null
                      // rule): `global:` lingering in the YAML would be a
                      // filter nobody wrote.
                      if (g === null) {
                        const { global: _drop, ...rest } = spec;
                        write(rest);
                      } else {
                        write({ ...spec, global: g });
                      }
                    }}
                  />
                </div>
              </Popover>
            )}
          </div>
        )}
        {spec.rows.length === 0 ? (
          <EmptyState
            icon="layout-dashboard"
            title="No widgets yet"
            // A read-only host has no Edit corner — promising one would send
            // the reader hunting for a control that does not exist.
            description={
              canEdit ? 'Add a widget to start — toggle Edit in the corner.' : 'Nothing here yet.'
            }
          />
        ) : (
          // The DndContext stands whether or not Edit is on — a conditional
          // wrapper would remount every widget on the Edit toggle. With Edit
          // off there is nothing to drag (grips absent, draggables disabled)
          // and nothing to hit (slots unrendered), so it is inert chrome.
          <DndContext
            sensors={sensors}
            onDragEnd={(event) => handleWidgetDragEnd(event, { spec, commit: write, toast })}
          >
            <div className="flex flex-col gap-3">
              {spec.rows.map((row) => (
                // One over-wide row scrolls alone inside its own wrapper —
                // wide content never drags the whole dashboard sideways
                // (AGENTS.md). The height stays on the inner flex row, which
                // keeps the `dashboard-row` testid; the wrapper only scrolls.
                // dnd-kit measures droppable rects at drag START, so
                // scrolling this wrapper MID-drag leaves the row's slot rects
                // stale until the next drag — accepted; the alternative is
                // continuous re-measure for a gesture most rows never need.
                <div key={row.id} className="min-w-0 overflow-x-auto">
                  <div
                    data-testid="dashboard-row"
                    className="flex gap-3"
                    style={{ height: row.h ?? ROW_HEIGHT_DEFAULT }}
                  >
                    {live && <WidgetSlot id={`slot:${row.id}:0`} />}
                    {row.widgets.map((widget, i) => (
                      <React.Fragment key={widget.id}>
                        {widget.kind === 'number' ? (
                          <NumberBlock
                            widget={widget}
                            entries={entries}
                            spec={spec}
                            schema={schema}
                          />
                        ) : widget.kind === 'view' ? (
                          <ViewBlock widget={widget} spec={spec} />
                        ) : widget.kind === 'table' ? (
                          <TableWidget
                            widget={widget}
                            entries={entries}
                            spec={spec}
                            schema={schema}
                            sort={presentation.sort}
                          />
                        ) : widget.kind === 'board' ? (
                          <BoardWidget
                            widget={widget}
                            entries={entries}
                            spec={spec}
                            schema={schema}
                          />
                        ) : widget.kind === 'timeline' ? (
                          <TimelineWidget
                            widget={widget}
                            entries={entries}
                            spec={spec}
                            schema={schema}
                          />
                        ) : (
                          <ChartWidget
                            widget={widget}
                            entries={entries}
                            spec={spec}
                            schema={schema}
                          />
                        )}
                        {live && <WidgetSlot id={`slot:${row.id}:${i + 1}`} />}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ))}
              {live && <WidgetSlot id="slot:new-row" wide />}
            </div>
          </DndContext>
        )}
      </div>
    </EditContext.Provider>
  );
}
