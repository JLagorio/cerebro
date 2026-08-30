import React, { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Tooltip } from '@/components/ui/Tooltip';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import type { ColumnDef } from '@/engine/columns';
import { allColumnsWrap, moveColumnTo, toggleColumn, wrapAllColumns } from '@/engine/columns';
import { GROUPABLE_KINDS, MEDIA_KINDS, NUMERIC_KINDS, ORDERABLE_KINDS } from '@/engine/properties';
import { useSortableList } from '@/hooks/useSortableList';
import {
  chainTypes,
  descentOptions,
  descentValue,
  parseDescentValue,
} from '@/engine/hierarchyOptions';
import { kindMeta } from '@/engine/properties';
import { DEFAULT_ZOOM, ZOOM_LABELS } from '@/engine/schedule';
import { humanize } from '@/engine/schema';
import { PropertyEditor } from '@/views/PropertyEditor';
import { measureLabel } from '@/engine/chart';
import {
  CARD_PREVIEWS,
  CARD_SIZES,
  CHART_AGGS,
  CHART_HEIGHTS,
  CHART_KINDS,
  CHART_SORTS,
  ROW_HEIGHTS,
  bandLevels,
  nestLevels,
} from '@/engine/types';
import type {
  CardPreview,
  CardSize,
  ChartAgg,
  ChartHeight,
  ChartKind,
  ChartSort,
  ChartSpec,
  ChipStyle,
  ColumnSpec,
  DashboardSpec,
  FieldDef,
  GallerySpec,
  GroupSpec,
  Presentation,
  RowHeight,
  Schema,
  SortSpec,
  ListDefinition,
  ViewDefinition,
} from '@/engine/types';
import { widgetCount } from '@/engine/dashboard';
import { MAX_GROUP_DEPTH, MAX_NEST_DEPTH, MAX_SORT_KEYS, moveSortKey } from '@/engine/views';
import { FilterBuilder } from '@/views/FilterBuilder';
import { PICKABLE_OPTION_COLORS } from '@/lib/swatch';
import {
  VIEW_KINDS,
  axesFor,
  hasDependencies,
  hasGroupColumns,
  isCanvas,
  isDayGrid,
  isTabular,
  isZoomable,
  hasBlocks,
  isCharted,
  needsDate,
  showsCards,
  showsChips,
  showsCovers,
  showsPreview,
} from '@/views/viewKinds';

/**
 * The view's whole configuration in one place (M9.7).
 *
 * Modelled on Notion's View settings: a stack of named rows that each open a
 * sub-page, rather than a row of popovers strung across a toolbar. Once a
 * view carries layout, columns, filters, sorting and grouping, "everything
 * about this view" is itself a place, and it deserves one.
 */

type Page =
  | 'root'
  | 'layout'
  | 'properties'
  | 'filter'
  | 'sort'
  | 'group'
  | 'limit'
  | 'rows'
  | 'axis'
  | 'cards'
  | 'chart'
  | 'blocks'
  | 'list'
  | 'newProperty'
  | 'field';

// Layout capabilities are declared on the kind now (M16.3). These were two
// plain Set<string> plus two hardcoded p.type comparisons, so a new kind
// compiled clean and then silently had no Axis page and no chip section.

const CARD_SIZE_LABEL: Record<CardSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

const CARD_PREVIEW_LABEL: Record<CardPreview, string> = {
  none: 'None',
  content: 'Page content',
};

const ROW_HEIGHT_LABEL: Record<RowHeight, string> = {
  compact: 'Compact',
  default: 'Default',
  tall: 'Tall',
};

const CHART_KIND_LABEL: Record<ChartKind, string> = {
  bar: 'Bar',
  line: 'Line',
  donut: 'Donut',
  number: 'Number',
};

/** What one band of a chart is CALLED, per kind — the word the Chart page's
 * footnote uses. `Record<ChartKind, …>` so a fourth kind cannot be drawn
 * without being named (M16.29). */
const CHART_PARTS: Record<ChartKind, string> = {
  bar: 'bars',
  line: 'points',
  donut: 'slices',
  number: 'totals',
};

const CHART_AGG_LABEL: Record<ChartAgg, string> = {
  count: 'Count of records',
  sum: 'Sum',
  avg: 'Average',
};

const CHART_SORT_LABEL: Record<ChartSort, string> = {
  'value-desc': 'Biggest first',
  'value-asc': 'Smallest first',
  label: 'A to Z',
};

const META_SORTS = [
  { value: 'modifiedAt', label: 'Last modified' },
  { value: 'createdAt', label: 'Created' },
  { value: 'title', label: 'Title' },
];

export interface ViewSettingsPanelProps {
  /** The whole List — this panel edits both the open view and the List itself. */
  list: ListDefinition;
  /** Which view tab is being configured. */
  viewId: string;
  onChange: (next: ListDefinition) => void;
  onClose: () => void;
  fields: ColumnDef[];
  schema: Schema;
  /** Deletes the whole List. */
  onDeleteList?: () => void;
  /** Deletes just this tab; absent when it is the only one. */
  onDeleteView?: () => void;
  /** M9.2: create a property on the source type. M12.4: relations carry
   * their config (target/limit/reciprocal). */
  onAddProperty?: (
    name: string,
    kind: FieldDef['kind'],
    relation?: { target: string; limit?: 1; reciprocalName?: string },
  ) => void;
  /** M12.8: 'type' = the panel configures a Type's saved views — there is no
   * List behind it, so the "This list" section is absent. */
  surface?: 'list' | 'type';
}

const CHIP_STYLES: { value: ChipStyle; label: string; hint: string }[] = [
  { value: 'plain', label: 'Plain chips', hint: 'The record’s title, and nothing else.' },
  {
    value: 'type-icon',
    label: 'Type icons',
    hint: 'Each chip carries the icon of the type it points at.',
  },
];

export function ViewSettingsPanel({
  list,
  viewId,
  onChange,
  onClose,
  fields,
  schema,
  onDeleteList,
  onDeleteView,
  onAddProperty,
  surface = 'list',
}: ViewSettingsPanelProps) {
  const [page, setPage] = useState<Page>('root');
  // The property the 'field' page is editing (M12.8).
  const [editingField, setEditingField] = useState<string | null>(null);
  const view = list.views.find((v) => v.id === viewId) ?? list.views[0];
  const p = view.presentation;

  /**
   * Name fields are BUFFERED, not controlled off the store (M15).
   *
   * They used to persist on every keystroke: onChange → updateList → writeList
   * → saveList + a full vault rescan, with no optimistic local value. The
   * rescan's stale result then reset the input, so typing "Roadmap" quickly
   * produced "R" or "Rp" and the app stuttered through a rename. Commit on
   * blur and Enter — the pattern RenameTab already uses.
   */
  const [viewName, setViewName] = useState(view.name);
  const [listName, setListName] = useState(list.name);
  // Re-seed when the panel switches to another tab or another List; a rename
  // made elsewhere should still show up here.
  useEffect(() => setViewName(view.name), [view.id, view.name]);
  useEffect(() => setListName(list.name), [list.name]);

  /** Write back one field of the open VIEW, leaving its siblings alone. */
  const setView = (next: Partial<ViewDefinition>) =>
    onChange({
      ...list,
      views: list.views.map((v) => (v.id === view.id ? { ...v, ...next } : v)),
    });

  const setPresentation = (presentation: Presentation) => setView({ presentation });

  const bands = bandLevels(p.group);
  const nesting = nestLevels(p.group);
  const visible = p.columns.filter((c) => c.hidden !== true).length;
  const layoutName = VIEW_KINDS.find((l) => l.value === p.type)?.label ?? 'Table';
  const chipStyle: ChipStyle = p.chips ?? 'plain';

  return (
    // M12.8: a floating menu beside its trigger, not a docked aside — nothing
    // configuration-shaped lives in a side panel anymore.
    <div
      data-testid="view-settings-panel"
      role="dialog"
      aria-label="View settings"
      className="flex max-h-[min(70vh,640px)] w-[320px] flex-col overflow-hidden rounded-xl border border-n-200 bg-n-0 shadow-[var(--shadow-lg)]"
    >
      <header className="flex flex-none items-center gap-1.5 border-b border-n-200 px-3 py-2.5">
        {page !== 'root' && (
          <IconButton icon="arrow-left" label="Back" size="sm" onClick={() => setPage('root')} />
        )}
        <span className="flex-1 truncate text-sm font-semibold text-n-900">
          {page === 'root' ? view.name : titleFor(page)}
        </span>
        <IconButton icon="x" label="Close view settings" size="sm" onClick={onClose} />
      </header>

      {/* Keyed by page so each drill-in slides in like the menus it now
          lives among (M12.8). */}
      <div key={page} className="cb-panel-in min-h-0 flex-1 overflow-y-auto p-2">
        {page === 'root' && (
          <>
            <div className="px-1 pb-2">
              {/* M11: this names the VIEW, not the List. Two tabs of one
                  database need two names, and the List's own name is edited
                  where the List is — one row down, under "This list". */}
              <Input
                ariaLabel="View name"
                placeholder="View name"
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
                onBlur={() => {
                  const next = viewName.trim();
                  if (next === '' || next === view.name) setViewName(view.name);
                  else setView({ name: next });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setViewName(view.name);
                }}
                width="100%"
              />
            </div>
            <Row
              icon="table-2"
              label="Layout"
              value={layoutName}
              onClick={() => setPage('layout')}
            />
            {/* M29.46: absent on a canvas. Visible columns is the one row up
                here that draws NOTHING on a whiteboard — the canvas is a .mmd
                file, not a record layout, so every column toggle would be a
                control that changes nothing (the calendar's M16.3 bug, this
                time arriving through an ungated row rather than a wrong
                capability). Filter, Sort and Load limit stay: they decide
                which records the canvas can place (M29.47). */}
            {!isCanvas(p.type) && (
              <Row
                icon="eye"
                label="Properties"
                value={String(visible)}
                onClick={() => setPage('properties')}
              />
            )}
            <Row
              icon="list-filter"
              label="Filter"
              value={view.filters === null ? '' : 'On'}
              onClick={() => setPage('filter')}
            />
            <Row
              icon="arrow-up-down"
              label="Sort"
              value={p.sort.length === 0 ? '' : String(p.sort.length)}
              onClick={() => setPage('sort')}
            />
            {/* M9.7: one row. Grouping by a property bands; grouping by a
                relation nests. They were two rows answering one question.
                M12.8: absent on the calendar — days are its grouping.
                M16.3: which is now `groupable` on the kind, so this row and
                the tab row's Group icon read the same declaration instead of
                each hardcoding the calendar. */}
            {axesFor(p.type).group && (
              <Row
                icon="rows-3"
                label="Group"
                value={
                  p.group.length === 0
                    ? ''
                    : nesting.length === 0
                      ? String(bands.length)
                      : `${bands.length} + ${nesting.length} nested`
                }
                onClick={() => setPage('group')}
              />
            )}
            {/* M16.29: row height and "Wrap all columns" are settings for the
                whole table, and both could only be reached from the NAME
                column's header menu — not here, where every other whole-view
                setting is, and not from any other column's menu. */}
            {isTabular(p.type) && (
              <Row
                icon="rows-2"
                label="Rows"
                value={ROW_HEIGHT_LABEL[p.rowHeight ?? 'default']}
                onClick={() => setPage('rows')}
              />
            )}
            {/* M16.26: Notion loads 25 and offers more; every view of ours
                rendered `entries` in full, so a type with 4,000 records laid
                out 4,000 rows before the first paint. */}
            <Row
              icon="list-end"
              label="Load limit"
              value={p.limit === undefined ? 'All' : String(p.limit)}
              onClick={() => setPage('limit')}
            />
            {/* M12.8: tailoring per layout — the dated views expose the axis
                they draw on, which the table has no use for. */}
            {needsDate(p.type) && (
              <Row
                icon="calendar"
                label="Date axis"
                value={p.dateField === undefined ? 'Auto' : humanize(p.dateField)}
                onClick={() => setPage('axis')}
              />
            )}

            {/* M16.22: the card settings — size, and whatever else the layout
                can actually draw on a card. Declared on the kind (`cards`), so
                a future card layout gets this page by saying so rather than by
                being added to a string set. M16.29: and the page's own rows are
                gated the same way, because `cards` was too coarse for all of
                them. */}
            {showsCards(p.type) && (
              <Row
                icon="layout-grid"
                label="Cards"
                value={CARD_SIZE_LABEL[p.cardSize ?? 'medium']}
                onClick={() => setPage('cards')}
              />
            )}

            {/* The chart's shape, measure and axis (M16.27; since M44.3 the X
                axis can be set on this page too — the Group row above stays
                its default source). */}
            {isCharted(p.type) && (
              <Row
                icon="chart-column"
                label="Chart"
                value={measureLabel(p.chart)}
                onClick={() => setPage('chart')}
              />
            )}

            {/* M16.28: the dashboard's widgets (rows of them since M44.4). */}
            {hasBlocks(p.type) && (
              <Row
                icon="layout-dashboard"
                label="Blocks"
                value={String(widgetCount(p.dashboard ?? { rows: [] }))}
                onClick={() => setPage('blocks')}
              />
            )}

            {/* M11: how related records draw, per view. A dense table wants
                bare chips; a mixed one wants to see which type each points at. */}
            {showsChips(p.type) && (
              <div className="mt-2 border-t border-n-100 pt-2">
                <div className="px-2 pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                  Related records
                </div>
                <div className="flex flex-col gap-0.5">
                  {CHIP_STYLES.map((style) => (
                    <button
                      key={style.value}
                      type="button"
                      data-testid={`chip-style-${style.value}`}
                      aria-pressed={chipStyle === style.value}
                      onClick={() => setPresentation({ ...p, chips: style.value })}
                      className={[
                        'flex items-start gap-2 rounded-md border-0 px-2 py-1.5 text-left text-sm',
                        chipStyle === style.value
                          ? 'bg-cortex-50 text-cortex-700'
                          : 'bg-transparent text-n-700 hover:bg-n-50',
                      ].join(' ')}
                    >
                      <Icon
                        name={style.value === 'plain' ? 'tag' : 'shapes'}
                        size={13}
                        color={chipStyle === style.value ? 'var(--cortex-600)' : 'var(--n-500)'}
                      />
                      <span className="min-w-0 flex-1">
                        {style.label}
                        <span className="mt-px block text-2xs leading-[15px] text-n-400">
                          {style.hint}
                        </span>
                      </span>
                      {chipStyle === style.value && <Icon name="check" size={12} />}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-2 border-t border-n-100 pt-2">
              {surface === 'list' && (
                <>
                  <div className="px-2 pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                    This list
                  </div>
                  <Row
                    icon="database"
                    label={list.source.type ?? 'Everything'}
                    value={`${list.views.length} ${list.views.length === 1 ? 'view' : 'views'}`}
                    onClick={() => setPage('list')}
                  />
                </>
              )}
              {onDeleteView !== undefined && (
                <button
                  type="button"
                  onClick={onDeleteView}
                  className="mt-1 flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-sm text-n-600 hover:bg-n-50"
                >
                  <Icon name="trash-2" size={13} />
                  Delete this view
                </button>
              )}
              {onDeleteList !== undefined && (
                <button
                  type="button"
                  onClick={onDeleteList}
                  className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-sm text-danger-600 hover:bg-danger-50"
                >
                  <Icon name="trash-2" size={13} />
                  {surface === 'type' ? 'Delete database' : 'Delete list'}
                </button>
              )}
            </div>
          </>
        )}

        {page === 'list' && (
          <div className="flex flex-col gap-2 px-1">
            <div>
              <span className="mb-1 block text-xs font-medium text-n-600">List name</span>
              <Input
                ariaLabel="List name"
                placeholder="List name"
                value={listName}
                onChange={(e) => setListName(e.target.value)}
                onBlur={() => {
                  const next = listName.trim();
                  if (next === '' || next === list.name) setListName(list.name);
                  else onChange({ ...list, name: next });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setListName(list.name);
                }}
                width="100%"
              />
            </div>
            <p className="m-0 text-xs leading-[16px] text-n-500">
              Records come from{' '}
              <span className="font-medium text-n-800">
                {list.source.type ?? 'everything in the vault'}
              </span>
              . The source is what the list IS — changing it would invalidate every view's columns,
              so it is fixed once created.
            </p>
            <div className="border-t border-n-100 pt-2">
              <div className="pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                Views
              </div>
              {list.views.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center gap-2 rounded-md px-1 py-1 text-sm text-n-700"
                >
                  <Icon
                    name={
                      v.icon ??
                      VIEW_KINDS.find((k) => k.value === v.presentation.type)?.icon ??
                      'table-2'
                    }
                    size={13}
                    color="var(--n-500)"
                  />
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  {v.id === view.id && <span className="flex-none text-2xs text-n-400">open</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {page === 'layout' && (
          <div className="flex flex-col gap-0.5">
            {VIEW_KINDS.map((l) => (
              <button
                key={l.value}
                type="button"
                data-testid={`view-switch-${l.value}`}
                onClick={() => setPresentation({ ...p, type: l.value })}
                className={[
                  'flex items-center gap-2 rounded-md border-0 px-2 py-1.5 text-left text-sm',
                  p.type === l.value
                    ? 'bg-cortex-50 text-cortex-700'
                    : 'bg-transparent text-n-700 hover:bg-n-50',
                ].join(' ')}
              >
                <Icon name={l.icon} size={13} />
                <span className="flex-1">{l.label}</span>
                {p.type === l.value && <Icon name="check" size={12} />}
              </button>
            ))}
          </div>
        )}

        {page === 'properties' && (
          <PropertiesPage
            fields={fields}
            columns={p.columns}
            onChange={(columns) => setPresentation({ ...p, columns })}
            canEdit={list.source.type !== null}
            onEditField={(name) => {
              setEditingField(name);
              setPage('field');
            }}
            onNewProperty={onAddProperty !== undefined ? () => setPage('newProperty') : undefined}
          />
        )}

        {page === 'newProperty' && onAddProperty !== undefined && (
          <AddPropertyPanel
            existingNames={fields.map((f) => f.name)}
            ownerType={list.source.type}
            onAdd={(name, kind, relation) => {
              onAddProperty(name, kind, relation);
              setPage('properties');
            }}
            onCancel={() => setPage('properties')}
          />
        )}

        {page === 'field' &&
          editingField !== null &&
          (list.source.type === null ? (
            <p className="m-0 px-2 py-3 text-xs leading-[17px] text-n-500">
              This property can't be edited here — the view has no single source type that declares
              it.
            </p>
          ) : (
            <PropertyEditor
              key={editingField}
              def={
                fields.find((f) => f.name === editingField) ?? {
                  name: editingField,
                  kind: 'text',
                }
              }
              sourceType={list.source.type}
              schema={schema}
              columns={p.columns}
              onColumnsChange={(columns) => setPresentation({ ...p, columns })}
              onRenamed={setEditingField}
              onDeleted={() => {
                setEditingField(null);
                setPage('properties');
              }}
            />
          ))}

        {page === 'axis' && (
          <AxisPage presentation={p} fields={fields} onChange={setPresentation} />
        )}

        {page === 'cards' && (
          <CardsPage presentation={p} fields={fields} onChange={setPresentation} />
        )}

        {page === 'chart' && (
          <ChartPage presentation={p} fields={fields} onChange={setPresentation} />
        )}

        {page === 'blocks' && (
          <BlocksPage presentation={p} fields={fields} onChange={setPresentation} />
        )}

        {page === 'filter' && (
          <FilterBuilder
            filters={view.filters}
            fields={fields}
            onChange={(filters) => setView({ filters })}
          />
        )}

        {page === 'sort' && (
          <SortPage
            sort={p.sort}
            fields={fields}
            onChange={(sort) => setPresentation({ ...p, sort })}
          />
        )}

        {page === 'limit' && (
          <LimitPage limit={p.limit} onChange={(limit) => setPresentation({ ...p, limit })} />
        )}

        {page === 'rows' && <RowsPage presentation={p} onChange={setPresentation} />}

        {page === 'group' && (
          <GroupPage
            group={p.group}
            fields={fields}
            schema={schema}
            sourceType={list.source.type}
            onChange={(group) => setPresentation({ ...p, group })}
          />
        )}
      </div>
    </div>
  );
}

function titleFor(page: Page): string {
  switch (page) {
    case 'layout':
      return 'Layout';
    case 'properties':
      return 'Properties';
    case 'filter':
      return 'Filter';
    case 'sort':
      return 'Sort';
    case 'group':
      return 'Group';
    case 'limit':
      return 'Load limit';
    case 'rows':
      return 'Rows';
    case 'axis':
      return 'Date axis';
    case 'cards':
      return 'Cards';
    case 'chart':
      return 'Chart';
    case 'blocks':
      return 'Blocks';
    case 'list':
      return 'This list';
    case 'newProperty':
      return 'New property';
    case 'field':
      return 'Edit property';
    default:
      return 'View settings';
  }
}

function Row({
  icon,
  label,
  value,
  onClick,
  muted = false,
}: {
  icon: string;
  label: string;
  value: string;
  onClick?: () => void;
  muted?: boolean;
}) {
  const content = (
    <>
      <Icon name={icon} size={13} color="var(--n-500)" />
      <span className={`flex-1 ${muted ? 'text-n-500' : 'text-n-800'}`}>{label}</span>
      {value !== '' && <span className="text-xs text-n-400">{value}</span>}
      {onClick !== undefined && <Icon name="chevron-right" size={12} color="var(--n-400)" />}
    </>
  );
  if (onClick === undefined) {
    return <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">{content}</div>;
  }
  return (
    <button
      type="button"
      data-testid={`view-settings-${label.toLowerCase()}`}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-sm hover:bg-n-50"
    >
      {content}
    </button>
  );
}

/**
 * Property visibility, the Notion way (M12.8): search, a "Shown" section you
 * can drag-reorder with eye toggles (the blue pill switches read as decoration,
 * not controls), a "Hidden" section, Hide all / Show all, and — because this is
 * WHERE properties are managed — add, edit, and remove without leaving the
 * panel: rows drill into an edit page, "+ New property" into the kind catalog.
 */
function PropertiesPage({
  fields,
  columns,
  onChange,
  canEdit,
  onEditField,
  onNewProperty,
}: {
  fields: ColumnDef[];
  columns: ColumnSpec[];
  onChange: (next: ColumnSpec[]) => void;
  /** False on typeless views — no single type to edit properties on. */
  canEdit: boolean;
  onEditField: (name: string) => void;
  onNewProperty?: () => void;
}) {
  const [query, setQuery] = useState('');

  const shown = new Set(columns.filter((c) => c.hidden !== true).map((c) => c.field));
  const visible: ColumnDef[] = columns
    .filter((c) => c.hidden !== true)
    .map((c) => fields.find((f) => f.name === c.field) ?? { name: c.field, kind: 'text' as const });
  const hidden: ColumnDef[] = fields.filter((f) => !shown.has(f.name));

  const matches = (f: ColumnDef) =>
    humanize(f.name).toLowerCase().includes(query.trim().toLowerCase());
  const searching = query.trim() !== '';

  // One reorder implementation, keyboard-operable (M16.2). This used to be a
  // hand-rolled pointer drag whose own comment said it was a copy of the
  // table's — and, like the table's, it could not be driven without a mouse.
  const sortable = useSortableList({
    ids: visible.map((f) => f.name),
    onReorder: (field, to) => onChange(moveColumnTo(columns, field, to)),
    disabled: searching,
    labelFor: (field) => humanize(field),
  });

  const row = (f: ColumnDef, on: boolean, index?: number) => (
    <div
      key={f.name}
      className="group flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-n-50"
      // Only the shown rows are in the sortable's container; the hidden ones
      // below it are the same component with no index and no slot.
      style={index !== undefined ? sortable.rowStyle(index) : undefined}
    >
      {on && !searching && index !== undefined ? (
        <span
          {...sortable.gripProps(f.name, index)}
          className="flex h-5 w-4 flex-none cursor-grab touch-none items-center justify-center text-n-300 hover:text-n-500 focus-visible:text-cortex-600 focus-visible:outline-none"
        >
          <Icon name="grip-vertical" size={12} />
        </span>
      ) : (
        <span className="h-5 w-4 flex-none" />
      )}
      <Icon name={kindMeta(f.kind).icon} size={12} color="var(--n-400)" />
      {canEdit ? (
        <button
          type="button"
          data-testid={`property-row-${f.name}`}
          title={`Edit ${humanize(f.name)}`}
          onClick={() => onEditField(f.name)}
          className={`min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-sm hover:underline ${on ? 'text-n-800' : 'text-n-400'}`}
        >
          {humanize(f.name)}
        </button>
      ) : (
        <span className={`min-w-0 flex-1 truncate text-sm ${on ? 'text-n-800' : 'text-n-400'}`}>
          {humanize(f.name)}
        </span>
      )}
      <IconButton
        icon={on ? 'eye' : 'eye-off'}
        label={`${on ? 'Hide' : 'Show'} ${humanize(f.name)}`}
        size="sm"
        onClick={() => onChange(toggleColumn(columns, f.name))}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-1 pb-1.5">
        <Input
          size="sm"
          ariaLabel="Search for a property"
          placeholder="Search for a property…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          width="100%"
        />
      </div>

      {visible.filter(matches).length > 0 && (
        <div className="flex items-center px-2 pb-0.5">
          <span className="flex-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
            Shown in this view
          </span>
          <button
            type="button"
            onClick={() => onChange(columns.map((c) => ({ ...c, hidden: true })))}
            className="border-0 bg-transparent p-0 text-2xs text-cortex-600 hover:underline"
          >
            Hide all
          </button>
        </div>
      )}
      <div
        ref={sortable.containerRef as React.RefObject<HTMLDivElement>}
        className="flex flex-col gap-0.5"
        style={sortable.containerStyle}
      >
        {visible.map((f, i) => (matches(f) ? row(f, true, i) : null))}
      </div>

      {hidden.filter(matches).length > 0 && (
        <div className="mt-1.5 flex items-center px-2 pb-0.5">
          <span className="flex-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
            Hidden in this view
          </span>
          <button
            type="button"
            onClick={() =>
              onChange([
                ...columns.map((c) => ({ ...c, hidden: false })),
                ...hidden
                  .filter((f) => !columns.some((c) => c.field === f.name))
                  .map((f) => ({ field: f.name })),
              ])
            }
            className="border-0 bg-transparent p-0 text-2xs text-cortex-600 hover:underline"
          >
            Show all
          </button>
        </div>
      )}
      {hidden.map((f) => (matches(f) ? row(f, false) : null))}

      {visible.length === 0 && hidden.length === 0 && (
        <p className="m-0 px-2 py-3 text-xs text-n-400">This type declares no properties yet.</p>
      )}

      {onNewProperty !== undefined && canEdit && (
        <button
          type="button"
          data-testid="new-property"
          onClick={onNewProperty}
          className="mt-1 flex w-full items-center gap-2 rounded-md border-0 border-t border-n-100 bg-transparent px-2 py-1.5 text-left text-sm text-n-500 hover:bg-n-50 hover:text-n-800"
        >
          <Icon name="plus" size={13} />
          New property
        </button>
      )}
    </div>
  );
}

/**
 * The date axis a calendar/timeline/gantt draws on (M12.8) — which property
 * places records, how coarse the scale is, and (gantt) which relation draws
 * dependency arrows. Configuration that only dated layouts have a use for.
 */
function AxisPage({
  presentation,
  fields,
  onChange,
}: {
  presentation: Presentation;
  fields: ColumnDef[];
  onChange: (next: Presentation) => void;
}) {
  const AUTO = '__auto__';
  const dateFields = fields.filter((f) => f.kind === 'date' || f.kind === 'daterange');
  const relations = fields.filter((f) => f.kind === 'relation');

  return (
    <div className="flex flex-col gap-2 px-1">
      <div>
        <span className="mb-1 block text-xs font-medium text-n-600">Date property</span>
        <Select
          size="sm"
          value={presentation.dateField ?? AUTO}
          options={[
            { value: AUTO, label: 'Auto — first date property' },
            ...dateFields.map((f) => ({ value: f.name, label: humanize(f.name) })),
          ]}
          onChange={(e) =>
            onChange({
              ...presentation,
              dateField: e.target.value === AUTO ? undefined : e.target.value,
            })
          }
          width="100%"
        />
      </div>
      {isDayGrid(presentation.type) && (
        <>
          <div>
            <span className="mb-1 block text-xs font-medium text-n-600">Show calendar as</span>
            <Select
              size="sm"
              value={presentation.calendarSpan ?? 'month'}
              options={[
                { value: 'month', label: 'Month' },
                { value: 'week', label: 'Week' },
              ]}
              onChange={(e) =>
                onChange({
                  ...presentation,
                  calendarSpan: e.target.value as NonNullable<Presentation['calendarSpan']>,
                })
              }
              width="100%"
            />
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-n-600">Start week on</span>
            <Select
              size="sm"
              value={presentation.weekStart ?? 'sunday'}
              options={[
                { value: 'sunday', label: 'Sunday' },
                { value: 'monday', label: 'Monday' },
              ]}
              onChange={(e) =>
                onChange({
                  ...presentation,
                  weekStart: e.target.value as NonNullable<Presentation['weekStart']>,
                })
              }
              width="100%"
            />
          </div>
          <div className="pt-0.5">
            <Switch
              checked={presentation.showWeekends !== false}
              onChange={(on) => onChange({ ...presentation, showWeekends: on })}
              label="Show weekends"
            />
            <p className="m-0 pt-1 text-2xs leading-[15px] text-n-400">
              Off drops Saturday and Sunday from the grid, rather than narrowing them.
            </p>
          </div>
        </>
      )}
      {isZoomable(presentation.type) && (
        <>
          <div>
            <span className="mb-1 block text-xs font-medium text-n-600">Zoom</span>
            <Select
              size="sm"
              // DEFAULT_ZOOM, not a literal: this said 'week' while GanttView
              // opened at 'month', so an unconfigured gantt showed a scale its
              // own settings denied. The options come from the engine's list
              // for the same reason — one place decides what the zooms are.
              value={presentation.zoom ?? DEFAULT_ZOOM}
              options={ZOOM_LABELS.map((z) => ({ value: z.value, label: z.label }))}
              onChange={(e) =>
                onChange({
                  ...presentation,
                  zoom: e.target.value as NonNullable<Presentation['zoom']>,
                })
              }
              width="100%"
            />
          </div>
          <div className="pt-0.5">
            <Switch
              checked={presentation.showTable !== false}
              onChange={(on) => onChange({ ...presentation, showTable: on })}
              label="Show table"
            />
            <p className="m-0 pt-1 text-2xs leading-[15px] text-n-400">
              The rows beside the axis, carrying this view&rsquo;s properties.
            </p>
          </div>
        </>
      )}
      {hasDependencies(presentation.type) && (
        <div>
          <span className="mb-1 block text-xs font-medium text-n-600">Dependencies</span>
          <Select
            size="sm"
            value={presentation.dependencyField ?? AUTO}
            options={[
              { value: AUTO, label: 'None' },
              ...relations.map((f) => ({ value: f.name, label: humanize(f.name) })),
            ]}
            onChange={(e) =>
              onChange({
                ...presentation,
                dependencyField: e.target.value === AUTO ? undefined : e.target.value,
              })
            }
            width="100%"
          />
          <p className="m-0 pt-1 text-2xs leading-[15px] text-n-400">
            The relation naming what each record waits on — the arrows the gantt draws.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Everything about a card, in ONE place, each row gated on the capability it
 * actually needs (M16.22, consolidated M16.29).
 *
 * There were two card sections: this page (the gallery's cover, size and fit)
 * and a `BoardSettings` block on the ROOT page (the board's size, preview and
 * "Color columns"). Both were shown to both card layouts, because both hung
 * off one `showsCards` check — so a gallery offered "Color columns", wrote
 * `colorColumns: true` to its view file, and coloured nothing: a gallery has
 * no columns. And "Card size" appeared twice, once per section, writing
 * `cardSize` in one and `gallery.size` in the other.
 *
 * Each control now asks the kind for the capability it depends on — `preview`
 * for a body snippet, `covers` for a cover, `groupColumns` for a tint — so a
 * new card layout gets exactly the settings it can honour, and `satisfies`
 * makes it answer.
 *
 * WHICH properties a card shows is deliberately absent: that is the Properties
 * page, the same one the table uses. A card-only visibility list would be a
 * second answer to one question, and switching a view between Table and
 * Gallery would quietly lose the choice made on the other side.
 *
 * Cover candidates come from the kind's `media` flag rather than a
 * `kind === 'files'` compare, so the day a second file-bearing kind exists it
 * is offered here without anyone remembering to come back (M16.4's rule).
 */
function CardsPage({
  presentation: p,
  fields,
  onChange,
}: {
  presentation: Presentation;
  fields: ColumnDef[];
  onChange: (next: Presentation) => void;
}) {
  const NONE = '__none__';
  const gallery = p.gallery ?? {};
  const covers = fields.filter((f) => MEDIA_KINDS.has(f.kind));
  // Only stored off its default, so an untouched gallery writes no key at all.
  const patchGallery = (next: GallerySpec) => {
    const cleaned: GallerySpec = {
      ...(next.cover !== undefined && next.cover !== '' ? { cover: next.cover } : {}),
      ...(next.fit === true ? { fit: true } : {}),
    };
    const { gallery: _drop, ...rest } = p;
    onChange(Object.keys(cleaned).length === 0 ? rest : { ...rest, gallery: cleaned });
  };

  return (
    <div className="flex flex-col gap-2 px-1">
      <div>
        <span className="mb-1 block text-xs font-medium text-n-600">Card size</span>
        <Select
          size="sm"
          value={p.cardSize ?? 'medium'}
          options={CARD_SIZES.map((s) => ({ value: s, label: CARD_SIZE_LABEL[s] }))}
          onChange={(e) => onChange({ ...p, cardSize: e.target.value as CardSize })}
          width="100%"
        />
      </div>

      {showsPreview(p.type) && (
        <div>
          <span className="mb-1 block text-xs font-medium text-n-600">Card preview</span>
          <Select
            size="sm"
            value={p.cardPreview ?? 'none'}
            options={CARD_PREVIEWS.map((v) => ({ value: v, label: CARD_PREVIEW_LABEL[v] }))}
            onChange={(e) => onChange({ ...p, cardPreview: e.target.value as CardPreview })}
            width="100%"
          />
          <p className="m-0 pt-1 text-2xs leading-[15px] text-n-400">
            Page content shows the first line or two of the record&rsquo;s body.
          </p>
        </div>
      )}

      {showsCovers(p.type) && (
        <>
          <div>
            <span className="mb-1 block text-xs font-medium text-n-600">Card cover</span>
            <Select
              size="sm"
              value={gallery.cover ?? NONE}
              options={[
                { value: NONE, label: 'None' },
                ...covers.map((f) => ({ value: f.name, label: humanize(f.name) })),
              ]}
              onChange={(e) =>
                patchGallery({
                  ...gallery,
                  cover: e.target.value === NONE ? undefined : e.target.value,
                })
              }
              width="100%"
            />
            <p className="m-0 pt-1 text-2xs leading-[15px] text-n-400">
              {covers.length === 0
                ? 'No files property on this type yet — add one and it becomes a cover.'
                : 'The first file on each record. Images are not drawn yet: the webview cannot load a vault file until the asset protocol is enabled, so a cover names its file instead of showing a broken one.'}
            </p>
          </div>
          <div className="border-t border-n-100 pt-2">
            <Switch
              checked={gallery.fit === true}
              onChange={(fit) => patchGallery({ ...gallery, fit })}
              label="Fit media"
              ariaLabel="Fit media"
            />
            <p className="m-0 pt-1 text-2xs leading-[15px] text-n-400">
              Fit the whole cover inside the tile instead of cropping it to fill.
            </p>
          </div>
        </>
      )}

      {hasGroupColumns(p.type) && (
        <div className="border-t border-n-100 pt-2">
          <Switch
            checked={p.colorColumns === true}
            label="Color columns"
            ariaLabel="Color columns"
            onChange={(on) => {
              // Written only when true, so turning it back off leaves the view
              // file as it was rather than storing a false nobody asked for.
              const { colorColumns: _was, ...rest } = p;
              onChange(on ? { ...rest, colorColumns: true } : rest);
            }}
          />
          <p className="m-0 pt-1 text-2xs leading-[15px] text-n-400">
            Paints each column in its group&rsquo;s own colour.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The chart's shape, measure and axes (M16.27; the axis decoupled in M44.3).
 *
 * The X axis is set HERE when `xField` names a property, and falls back to
 * the Group row — the control every other layout shares — when it does not,
 * so a chart configured before `xField` existed keeps drawing what its
 * grouping says. `groupBy` is the second dimension: stacked bars and
 * multi-series lines. The footnote under the controls names whichever axis
 * source is live.
 *
 * The properties offered for sum/average come from the `numeric` flag on
 * KIND_META, not a field-kind `=== 'number'` compare — the rule M16.4
 * established and M16.13 applied to grouping and sorting. (The CHART kind
 * named `number` is unrelated: it is the big-stat layout, M44.2.)
 */
function ChartPage({
  presentation,
  fields,
  onChange,
}: {
  presentation: Presentation;
  fields: ColumnDef[];
  onChange: (next: Presentation) => void;
}) {
  const NONE = '__none__';
  const chart = presentation.chart ?? {};
  const agg: ChartAgg = chart.agg ?? 'count';
  const kind: ChartKind = chart.kind ?? 'bar';
  const axisKind = kind === 'bar' || kind === 'line' || kind === 'donut';
  const horizontal = kind === 'bar' && chart.horizontal === true;
  const numeric = fields.filter((f) => NUMERIC_KINDS.has(f.kind));
  // The same roster the Group control offers (GROUPABLE_KINDS, M16.13): the
  // axis and the second dimension band records exactly the way a grouping
  // level does, so a field one can offer the other must offer too.
  const groupable = fields.filter((f) => GROUPABLE_KINDS.has(f.kind));
  const band = bandLevels(presentation.group)[0];

  /**
   * Stores only DEVIATIONS (M44.2): a value equal to its default is a deleted
   * key, a key the chosen kind cannot read is deleted too — so switching
   * kinds sheds the settings the new kind has no use for, and a `number`
   * chart keeps only kind/agg/value — and the whole `chart` block goes when
   * nothing is off-default.
   */
  const patch = (next: ChartSpec) => {
    const nextKind = next.kind ?? 'bar';
    const nextAxisKind = nextKind === 'bar' || nextKind === 'line' || nextKind === 'donut';
    // `HBarChart` draws no grid and no axis by design — it labels its own
    // bands — so on a horizontal bar those two keys would be stored words
    // nothing reads.
    const nextHorizontal = nextKind === 'bar' && next.horizontal === true;
    // The axis keys (M44.3). `xField` is read by every axis kind — the donut
    // bands its ring by it too — while `groupBy` splits bands into
    // stacked/series parts, which only bar and line draw.
    const nextXField = next.xField !== undefined && nextAxisKind ? next.xField : undefined;
    const nextGroupBy =
      next.groupBy !== undefined && (nextKind === 'bar' || nextKind === 'line')
        ? next.groupBy
        : undefined;
    const cleaned: ChartSpec = {
      ...(next.kind !== undefined && next.kind !== 'bar' ? { kind: next.kind } : {}),
      ...(next.agg !== undefined && next.agg !== 'count' ? { agg: next.agg } : {}),
      // A value property is meaningless under Count, and keeping it would make
      // the YAML claim a measure the view does not use.
      ...(next.agg !== undefined && next.agg !== 'count' && next.value !== undefined
        ? { value: next.value }
        : {}),
      ...(nextXField !== undefined ? { xField: nextXField } : {}),
      ...(nextGroupBy !== undefined ? { groupBy: nextGroupBy } : {}),
      // The legend's hidden rosters are written through onChartChange, never
      // by a control on this page — so each is carried from the CURRENT spec,
      // and dropped exactly when its own dimension changes (absent⇄present
      // included): a new axis or groupBy mints new band/series keys, and the
      // stale ones would silently hide nothing, or the wrong thing.
      ...(chart.hidden !== undefined && nextAxisKind && nextXField === chart.xField
        ? { hidden: chart.hidden }
        : {}),
      ...(chart.hiddenG !== undefined && nextGroupBy !== undefined && nextGroupBy === chart.groupBy
        ? { hiddenG: chart.hiddenG }
        : {}),
      ...(next.omitZero === true && nextAxisKind ? { omitZero: true } : {}),
      ...(nextHorizontal ? { horizontal: true } : {}),
      ...(next.sort !== undefined && nextAxisKind ? { sort: next.sort } : {}),
      ...(next.cumulative === true && (nextKind === 'bar' || nextKind === 'line')
        ? { cumulative: true }
        : {}),
      // Height only drives the svg geometry BarChart/HBarChart/LineChart
      // build — a donut is fixed at 240px and a number chart draws no svg.
      ...(next.height !== undefined &&
      next.height !== 'm' &&
      (nextKind === 'bar' || nextKind === 'line')
        ? { height: next.height }
        : {}),
      ...(next.palette !== undefined && nextAxisKind ? { palette: next.palette } : {}),
      ...(next.colorByValue === true && next.palette !== undefined && nextAxisKind
        ? { colorByValue: true }
        : {}),
      // hideGrid/hideAxis are read only by the Axes path — a vertical bar and
      // a line. HBarChart labels its own bands and DonutChart has no axis.
      ...(next.hideGrid === true && ((nextKind === 'bar' && !nextHorizontal) || nextKind === 'line')
        ? { hideGrid: true }
        : {}),
      ...(next.hideAxis === true && ((nextKind === 'bar' && !nextHorizontal) || nextKind === 'line')
        ? { hideAxis: true }
        : {}),
      // hideLabels is read only by the two bar layouts (vertical + horizontal).
      ...(next.hideLabels === true && nextKind === 'bar' ? { hideLabels: true } : {}),
      ...(next.smooth === true && nextKind === 'line' ? { smooth: true } : {}),
      // `area` is single-series only: LineChart never reads it under groupBy
      // (overlapping washes at one opacity are unreadable), so with a second
      // dimension it would be a stored word nothing draws.
      ...(next.area === true && nextKind === 'line' && nextGroupBy === undefined
        ? { area: true }
        : {}),
      ...(next.hideDonutCenter === true && nextKind === 'donut' ? { hideDonutCenter: true } : {}),
      // The legend defaults ON for a donut and OFF elsewhere, so "off-default"
      // is a comparison against the kind, not a constant.
      ...(next.legend !== undefined && nextAxisKind && next.legend !== (nextKind === 'donut')
        ? { legend: next.legend }
        : {}),
    };
    const { chart: _drop, ...rest } = presentation;
    onChange(Object.keys(cleaned).length === 0 ? rest : { ...rest, chart: cleaned });
  };

  return (
    <div className="flex flex-col gap-2 px-1">
      <div>
        <span className="mb-1 block text-xs font-medium text-n-600">Chart type</span>
        <Select
          size="sm"
          value={chart.kind ?? 'bar'}
          options={CHART_KINDS.map((k) => ({ value: k, label: CHART_KIND_LABEL[k] }))}
          onChange={(e) => patch({ ...chart, kind: e.target.value as ChartKind })}
          width="100%"
        />
      </div>
      {/* The axis is the first question a chart answers, so its picker sits
          above the measure. The sentinel keeps the M16.27 default honest:
          "View grouping" IS where the axis comes from until xField says
          otherwise (M44.3). */}
      {axisKind && (
        <div>
          <span className="mb-1 block text-xs font-medium text-n-600">X axis</span>
          <Select
            size="sm"
            value={chart.xField ?? NONE}
            options={[
              { value: NONE, label: 'View grouping' },
              ...groupable.map((f) => ({ value: f.name, label: humanize(f.name) })),
            ]}
            onChange={(e) =>
              patch({ ...chart, xField: e.target.value === NONE ? undefined : e.target.value })
            }
            width="100%"
          />
        </div>
      )}
      {/* Bar and line only: a donut ignores groupBy and a number chart reads
          no axis at all — a picker there would write a key nothing reads. */}
      {(kind === 'bar' || kind === 'line') && (
        <div>
          <span className="mb-1 block text-xs font-medium text-n-600">Group by</span>
          <Select
            size="sm"
            value={chart.groupBy ?? NONE}
            options={[
              { value: NONE, label: 'None' },
              ...groupable.map((f) => ({ value: f.name, label: humanize(f.name) })),
            ]}
            onChange={(e) =>
              patch({ ...chart, groupBy: e.target.value === NONE ? undefined : e.target.value })
            }
            width="100%"
          />
        </div>
      )}
      <div>
        <span className="mb-1 block text-xs font-medium text-n-600">Measure</span>
        <Select
          size="sm"
          value={agg}
          options={CHART_AGGS.map((a) => ({ value: a, label: CHART_AGG_LABEL[a] }))}
          onChange={(e) => patch({ ...chart, agg: e.target.value as ChartAgg })}
          width="100%"
        />
      </div>
      {agg !== 'count' && (
        <div>
          <span className="mb-1 block text-xs font-medium text-n-600">Of property</span>
          <Select
            size="sm"
            value={chart.value ?? NONE}
            options={[
              { value: NONE, label: 'Choose a number property…' },
              ...numeric.map((f) => ({ value: f.name, label: humanize(f.name) })),
            ]}
            onChange={(e) =>
              patch({ ...chart, value: e.target.value === NONE ? undefined : e.target.value })
            }
            width="100%"
          />
          {numeric.length === 0 && (
            <p className="m-0 pt-1 text-2xs leading-[15px] text-n-400">
              This view has no number property to add up.
            </p>
          )}
        </div>
      )}
      {axisKind && (
        <div className="border-t border-n-100 pt-2">
          <Switch
            checked={chart.omitZero === true}
            onChange={(omitZero) => patch({ ...chart, omitZero })}
            label="Omit zero values"
            ariaLabel="Omit zero values"
          />
        </div>
      )}
      {kind === 'bar' && (
        <div>
          <Switch
            checked={chart.horizontal === true}
            onChange={(on) => patch({ ...chart, horizontal: on })}
            label="Horizontal"
            ariaLabel="Horizontal"
          />
        </div>
      )}
      {axisKind && (
        <div>
          <span className="mb-1 block text-xs font-medium text-n-600">Sort</span>
          <Select
            size="sm"
            value={chart.sort ?? NONE}
            options={[
              { value: NONE, label: 'Declared order' },
              ...CHART_SORTS.map((s) => ({ value: s, label: CHART_SORT_LABEL[s] })),
            ]}
            onChange={(e) =>
              patch({
                ...chart,
                sort: e.target.value === NONE ? undefined : (e.target.value as ChartSort),
              })
            }
            width="100%"
          />
        </div>
      )}
      {(kind === 'bar' || kind === 'line') && (
        <div>
          <Switch
            checked={chart.cumulative === true}
            onChange={(cumulative) => patch({ ...chart, cumulative })}
            label="Cumulative"
            ariaLabel="Cumulative"
          />
        </div>
      )}
      {/* Height only feeds the svg viewBox BarChart/HBarChart/LineChart share
          — a donut is a fixed 240px ring and a number chart draws no svg. */}
      {(kind === 'bar' || kind === 'line') && (
        <div>
          <span className="mb-1 block text-xs font-medium text-n-600">Height</span>
          <SegmentedControl
            ariaLabel="Height"
            options={CHART_HEIGHTS.map((h) => ({ value: h, label: h.toUpperCase() }))}
            value={chart.height ?? 'm'}
            onChange={(h) => patch({ ...chart, height: h as ChartHeight })}
          />
        </div>
      )}
      {axisKind && (
        <div>
          <span className="mb-1 block text-xs font-medium text-n-600">Palette</span>
          <Select
            size="sm"
            value={chart.palette ?? NONE}
            options={[
              { value: NONE, label: 'By option colour' },
              ...PICKABLE_OPTION_COLORS.map((c) => ({ value: c, label: humanize(c) })),
            ]}
            onChange={(e) =>
              patch({ ...chart, palette: e.target.value === NONE ? undefined : e.target.value })
            }
            width="100%"
          />
          {chart.palette !== undefined && (
            <div className="pt-2">
              <Switch
                checked={chart.colorByValue === true}
                onChange={(colorByValue) => patch({ ...chart, colorByValue })}
                label="Shade by value"
                ariaLabel="Shade by value"
              />
            </div>
          )}
        </div>
      )}
      {/* The hide-flavoured specs invert at the control: the SWITCH says what
          the user sees ("Grid lines on"), the SPEC stores the deviation.
          Grid/Axis labels show only for a vertical bar and a line — the two
          shapes that draw through Axes. A horizontal bar labels its own
          bands and a donut has no axis, so neither switch would change
          anything there. Value labels shows for both bar orientations —
          BarChart and HBarChart each read hideLabels themselves. */}
      {axisKind && (
        <div className="flex flex-col gap-2 border-t border-n-100 pt-2">
          {((kind === 'bar' && !horizontal) || kind === 'line') && (
            <Switch
              checked={chart.hideGrid !== true}
              onChange={(on) => patch({ ...chart, hideGrid: !on })}
              label="Grid lines"
              ariaLabel="Grid lines"
            />
          )}
          {((kind === 'bar' && !horizontal) || kind === 'line') && (
            <Switch
              checked={chart.hideAxis !== true}
              onChange={(on) => patch({ ...chart, hideAxis: !on })}
              label="Axis labels"
              ariaLabel="Axis labels"
            />
          )}
          {kind === 'bar' && (
            <Switch
              checked={chart.hideLabels !== true}
              onChange={(on) => patch({ ...chart, hideLabels: !on })}
              label="Value labels"
              ariaLabel="Value labels"
            />
          )}
          {kind === 'line' && (
            <Switch
              checked={chart.smooth === true}
              onChange={(smooth) => patch({ ...chart, smooth })}
              label="Smooth line"
              ariaLabel="Smooth line"
            />
          )}
          {/* Single-series lines only: under groupBy LineChart never reads
              `area`, and a switch that changes nothing is the calendar's
              M16.3 bug. */}
          {kind === 'line' && chart.groupBy === undefined && (
            <Switch
              checked={chart.area === true}
              onChange={(area) => patch({ ...chart, area })}
              label="Area fill"
              ariaLabel="Area fill"
            />
          )}
          {kind === 'donut' && (
            <Switch
              checked={chart.hideDonutCenter !== true}
              onChange={(on) => patch({ ...chart, hideDonutCenter: !on })}
              label="Centre total"
              ariaLabel="Centre total"
            />
          )}
          <Switch
            checked={chart.legend ?? kind === 'donut'}
            onChange={(legend) => patch({ ...chart, legend })}
            label="Legend"
            ariaLabel="Legend"
          />
        </div>
      )}
      {/* The footnote names the LIVE axis source (M44.3): xField when set,
          the view's grouping otherwise. And the shape comes from the chart
          kind (M16.29): this said "bars" whatever was selected, so the one
          sentence explaining the axis described a bar chart to someone
          looking at a donut. */}
      <p className="m-0 border-t border-n-100 pt-2 text-2xs leading-[15px] text-n-400">
        {kind === 'number'
          ? 'A number chart totals every visible row — grouping does not apply.'
          : chart.xField !== undefined
            ? `The ${CHART_PARTS[kind]} come from ${humanize(chart.xField)}, the X axis set here.`
            : band === undefined
              ? `The ${CHART_PARTS[kind]} come from the view’s grouping, and this view has none yet — pick an X axis above, or a property under Group.`
              : `The ${CHART_PARTS[kind]} come from the view’s grouping, currently ${humanize(band.field)}. Pick an X axis above to override it.`}
      </p>
    </div>
  );
}

/**
 * The dashboard's widget count and its Global filter (M16.28; M44.4 shrank
 * this from a flat widget editor to a pointer — Task 1 through 7 made the
 * canvas's own Edit mode the widget editor, add popover, drag and all, so a
 * second editor here would only drift from it). The Global filter stays: it
 * is a `spec`-level rule with no home on the canvas itself, and the two
 * surfaces share `spec.global` and the null-deletes-key rule.
 */
function BlocksPage({
  presentation,
  fields,
  onChange,
}: {
  presentation: Presentation;
  fields: ColumnDef[];
  onChange: (next: Presentation) => void;
}) {
  const spec = presentation.dashboard ?? { rows: [] };
  const write = (next: DashboardSpec) => onChange({ ...presentation, dashboard: next });
  const count = widgetCount(spec);

  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 px-2 text-xs text-n-600">
        {count} {count === 1 ? 'widget' : 'widgets'}
      </p>
      <p className="m-0 px-2 text-2xs leading-[15px] text-n-400">
        Widgets are edited on the dashboard itself — toggle Edit in its corner.
      </p>
      <div className="border-t border-n-100 pt-2">
        <div className="px-0.5 pb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
          Global filter — every widget’s rows pass it
        </div>
        <FilterBuilder
          filters={spec.global ?? null}
          fields={fields}
          onChange={(g) => {
            // An emptied group DELETES the key (FilterChips' null rule) — the
            // same wiring as the canvas's own Global filter popover, because
            // this is the same `spec.global`, edited from a second door.
            if (g === null) {
              const { global: _drop, ...rest } = spec;
              write(rest);
            } else {
              write({ ...spec, global: g });
            }
          }}
        />
      </div>
    </div>
  );
}

const ADD = '__add__';

function SortPage({
  sort,
  fields,
  onChange,
}: {
  sort: SortSpec[];
  fields: ColumnDef[];
  onChange: (next: SortSpec[]) => void;
}) {
  const taken = new Set(sort.map((s) => s.field));
  const available = [
    ...META_SORTS.filter((m) => !taken.has(m.value)),
    ...fields
      .filter((f) => ORDERABLE_KINDS.has(f.kind) && !taken.has(f.name))
      .map((f) => ({ value: f.name, label: humanize(f.name) })),
  ];
  // M16.26: this page enforced NO cap while the toolbar's chain builder passed
  // `max={4}`, so the same view accepted a fifth key here and refused it there.
  const atCap = sort.length >= MAX_SORT_KEYS;

  const sortable = useSortableList({
    ids: sort.map((s) => s.field),
    labelFor,
    onReorder: (field, to) =>
      onChange(
        moveSortKey(
          sort,
          sort.findIndex((s) => s.field === field),
          to,
        ),
      ),
  });

  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={sortable.containerRef as React.RefObject<HTMLDivElement>}
        className="flex flex-col gap-1.5"
        style={sortable.containerStyle}
      >
        {sort.map((s, i) => (
          <div
            key={`${i}:${s.field}`}
            className="group flex items-center gap-1.5"
            style={sortable.rowStyle(i)}
          >
            <Tooltip label="Drag to reorder — the first key breaks ties first">
              <span
                {...sortable.gripProps(s.field, i)}
                className="flex h-6 w-3 flex-none cursor-grab items-center justify-center rounded-xs text-n-300 hover:text-n-600 focus-visible:text-n-600 group-hover:text-n-500"
              >
                <Icon name="grip-vertical" size={13} />
              </span>
            </Tooltip>
            <Select
              size="sm"
              value={s.field}
              options={[{ value: s.field, label: labelFor(s.field) }, ...available].filter(
                (o, j, all) => all.findIndex((x) => x.value === o.value) === j,
              )}
              onChange={(e) =>
                onChange(sort.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))
              }
              width="100%"
            />
            <IconButton
              icon={s.dir === 'asc' ? 'arrow-up' : 'arrow-down'}
              label={`Sort ${i + 1} direction: ${s.dir === 'asc' ? 'ascending' : 'descending'}`}
              size="sm"
              onClick={() =>
                onChange(
                  sort.map((x, j) =>
                    j === i ? { ...x, dir: x.dir === 'asc' ? 'desc' : 'asc' } : x,
                  ),
                )
              }
            />
            <IconButton
              icon="x"
              label={`Remove sort ${i + 1}`}
              size="sm"
              onClick={() => onChange(sort.filter((_, j) => j !== i))}
            />
          </div>
        ))}
      </div>
      {available.length > 0 && !atCap && (
        <Select
          size="sm"
          value={ADD}
          options={[{ value: ADD, label: 'Add a sort…' }, ...available]}
          onChange={(e) => {
            if (e.target.value !== ADD) onChange([...sort, { field: e.target.value, dir: 'asc' }]);
          }}
          width="100%"
        />
      )}
      {atCap && (
        <p className="m-0 px-1 pt-1 text-2xs leading-[15px] text-n-400">
          {MAX_SORT_KEYS} keys is the maximum — a fifth tiebreak never decides anything.
        </p>
      )}
      {sort.length === 0 && (
        <p className="m-0 px-1 pt-1 text-xs leading-[16px] text-n-500">
          Records appear in vault order.
        </p>
      )}
    </div>
  );
}

/**
 * How many records the view draws (M16.26).
 *
 * Presets, not a free number box: the point of a limit is to keep the first
 * paint fast, and a typed one invites 3,000 — which is the state this exists
 * to avoid. "All" is stored as an ABSENT key, so a view that never wanted a
 * limit carries nothing about one in its YAML.
 */
const LIMITS: { value: number | undefined; label: string }[] = [
  { value: 25, label: '25 records' },
  { value: 50, label: '50 records' },
  { value: 100, label: '100 records' },
  { value: undefined, label: 'All records' },
];

function LimitPage({
  limit,
  onChange,
}: {
  limit: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {LIMITS.map((l) => (
        <button
          key={l.label}
          type="button"
          data-testid={`view-limit-${l.value ?? 'all'}`}
          aria-pressed={limit === l.value}
          onClick={() => onChange(l.value)}
          className={[
            'flex items-center gap-2 rounded-md border-0 px-2 py-1.5 text-left text-sm',
            limit === l.value
              ? 'bg-cortex-50 text-cortex-700'
              : 'bg-transparent text-n-700 hover:bg-n-50',
          ].join(' ')}
        >
          <span className="flex-1">{l.label}</span>
          {limit === l.value && <Icon name="check" size={12} />}
        </button>
      ))}
      <p className="m-0 border-t border-n-100 px-1 pt-2 text-2xs leading-[15px] text-n-400">
        A limited view says how many of how many it is showing, under the records. Nothing
        disappears without saying so.
      </p>
    </div>
  );
}

function labelFor(field: string): string {
  return META_SORTS.find((m) => m.value === field)?.label ?? humanize(field);
}

/**
 * How tall a row is, and whether its cells wrap (M16.29).
 *
 * Both are settings for the WHOLE table, and both used to live only on the
 * NAME column's header menu — a menu whose other items are all about the name
 * column itself, and which no other column's menu carried. Someone looking for
 * row height opened Priority's menu, found sort/filter/hide/freeze and no
 * height, and had no reason to think Name's menu held two extra items.
 *
 * They are still writes to `presentation`/`columns`, so the table redraws the
 * moment either changes — nothing about this page is a copy of the table's
 * state.
 */
function RowsPage({
  presentation: p,
  onChange,
}: {
  presentation: Presentation;
  onChange: (next: Presentation) => void;
}) {
  const height = p.rowHeight ?? 'default';
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 pb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
        Row height
      </div>
      {ROW_HEIGHTS.map((value) => (
        <button
          key={value}
          type="button"
          data-testid={`row-height-${value}`}
          aria-pressed={height === value}
          onClick={() => onChange({ ...p, rowHeight: value })}
          className={[
            'flex items-center gap-2 rounded-md border-0 px-2 py-1.5 text-left text-sm',
            height === value
              ? 'bg-cortex-50 text-cortex-700'
              : 'bg-transparent text-n-700 hover:bg-n-50',
          ].join(' ')}
        >
          <span className="flex-1">{ROW_HEIGHT_LABEL[value]}</span>
          {height === value && <Icon name="check" size={12} />}
        </button>
      ))}
      <div className="mt-2 border-t border-n-100 px-1 pt-2">
        <Switch
          checked={allColumnsWrap(p.columns)}
          onChange={() => onChange({ ...p, columns: wrapAllColumns(p.columns) })}
          label="Wrap all columns"
          ariaLabel="Wrap all columns"
        />
        <p className="m-0 pt-1 text-2xs leading-[15px] text-n-400">
          Wrapped cells grow the row instead of clipping. One column at a time is still on its own
          header menu.
        </p>
      </div>
    </div>
  );
}

/**
 * The grouping chain (M9.7).
 *
 * One list. Each row is a property to band by or a relation to nest under,
 * and the picker shows both under headings so the difference is legible
 * without being two separate controls.
 */
function GroupPage({
  group,
  fields,
  schema,
  sourceType,
  onChange,
}: {
  group: GroupSpec[];
  fields: ColumnDef[];
  schema: Schema;
  sourceType: string | null;
  onChange: (next: GroupSpec[]) => void;
}) {
  const bandTaken = new Set(bandLevels(group).map((g) => g.field));

  const optionsAt = (index: number) => {
    const before = group.slice(0, index);
    const typeHere = chainTypes(sourceType, nestLevels(before), schema).pop() ?? null;
    const fieldsHere = typeHere === null ? fields : (schema.types.get(typeHere)?.fields ?? fields);
    const own = group[index];
    const properties = fieldsHere
      .filter((f) => GROUPABLE_KINDS.has(f.kind))
      .filter((f) => own?.field === f.name || !bandTaken.has(f.name))
      .map((f) => ({ value: `property:${f.name}`, label: humanize(f.name) }));
    const relations =
      nestLevels(before).length >= MAX_NEST_DEPTH
        ? []
        : descentOptions(typeHere, schema).map((o) => ({
            value: o.value,
            label: `↳ ${o.label}`,
          }));
    const all = [...properties, ...relations];
    return all.filter((o, i, list) => list.findIndex((x) => x.value === o.value) === i);
  };

  const decode = (value: string): GroupSpec | null => {
    if (value.startsWith('property:')) return { field: value.slice('property:'.length) };
    const descend = parseDescentValue(value);
    return descend === null ? null : { field: descend.field, descend };
  };

  const atBandCap = bandLevels(group).length >= MAX_GROUP_DEPTH;
  const addOptions = optionsAt(group.length).filter(
    (o) => !atBandCap || !o.value.startsWith('property:'),
  );

  return (
    <div className="flex flex-col gap-1.5">
      {group.map((level, i) => (
        <div key={`${i}:${level.field}`} className="flex items-center gap-1.5">
          <span className="w-8 flex-none text-2xs text-n-400">{i === 0 ? 'By' : 'then'}</span>
          <Select
            size="sm"
            value={
              level.descend === undefined ? `property:${level.field}` : descentValue(level.descend)
            }
            options={optionsAt(i)}
            onChange={(e) => {
              const next = decode(e.target.value);
              if (next === null) return;
              // Changing a relation level re-types everything below it, so
              // the tail's options no longer apply.
              const tail =
                level.descend !== undefined || next.descend !== undefined ? [] : group.slice(i + 1);
              onChange([...group.slice(0, i), next, ...tail]);
            }}
            width="100%"
          />
          {level.descend === undefined && (
            <IconButton
              icon={(level.dir ?? 'asc') === 'asc' ? 'arrow-up' : 'arrow-down'}
              label={`Group ${i + 1} direction`}
              size="sm"
              onClick={() =>
                onChange(
                  group.map((g, j) =>
                    j === i ? { ...g, dir: (g.dir ?? 'asc') === 'asc' ? 'desc' : 'asc' } : g,
                  ),
                )
              }
            />
          )}
          <IconButton
            icon="x"
            label={`Remove level ${i + 1}`}
            size="sm"
            onClick={() => onChange(group.filter((_, j) => j !== i))}
          />
        </div>
      ))}

      {/* M16.26: `hideEmpty` has been honoured by `grouping.ts:140` since M9.1
          and no UI ever set it, so the only way to drop the empty bands a
          twelve-option select produces was to hand-edit the YAML.

          PER LEVEL, because the engine is: a board wants its empty columns
          (they are the columns you drag onto) while the sub-level banding
          inside them usually does not. One switch for the whole chain would
          have to lie about a mixed state. */}
      {bandLevels(group).length > 0 && (
        <div className="mt-1 flex flex-col gap-1 border-t border-n-100 pt-2">
          <div className="px-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
            Empty groups
          </div>
          {group.map((level, i) =>
            level.descend !== undefined ? null : (
              <label
                key={`hide:${i}:${level.field}`}
                className="flex items-center gap-2 rounded-md px-1 py-1 text-xs text-n-700"
              >
                <span className="min-w-0 flex-1 truncate">
                  Hide empty {humanize(level.field).toLowerCase()} groups
                </span>
                <Switch
                  ariaLabel={`Hide empty ${humanize(level.field).toLowerCase()} groups`}
                  checked={level.hideEmpty === true}
                  onChange={(on) =>
                    onChange(
                      group.map((g, j) =>
                        j === i ? (on ? { ...g, hideEmpty: true } : omitHideEmpty(g)) : g,
                      ),
                    )
                  }
                />
              </label>
            ),
          )}
        </div>
      )}

      {addOptions.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="w-8 flex-none text-2xs text-n-400">
            {group.length === 0 ? 'By' : 'then'}
          </span>
          <Select
            size="sm"
            value={ADD}
            options={[{ value: ADD, label: 'Add a level…' }, ...addOptions]}
            onChange={(e) => {
              const next = decode(e.target.value);
              if (next !== null) onChange([...group, next]);
            }}
            width="100%"
          />
        </div>
      )}

      <p className="m-0 border-t border-n-100 px-1 pt-2 text-2xs leading-[15px] text-n-400">
        A property bands records by its value. A relation (↳) nests them under what they link to.
      </p>
    </div>
  );
}

/** Off is the DEFAULT, so it is stored as an absent key rather than `false` —
 * the same rule every other optional presentation key follows, and what keeps
 * a view that never touched this from growing a line about it. */
function omitHideEmpty(level: GroupSpec): GroupSpec {
  const { hideEmpty: _dropped, ...rest } = level;
  return rest;
}
