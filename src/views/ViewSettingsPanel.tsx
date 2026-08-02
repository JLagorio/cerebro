import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import type { ColumnDef } from '@/engine/columns';
import { moveColumnTo, toggleColumn } from '@/engine/columns';
import {
  chainTypes,
  descentOptions,
  descentValue,
  parseDescentValue,
} from '@/engine/hierarchyOptions';
import { kindMeta } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import { PropertyEditor } from '@/views/PropertyEditor';
import { bandLevels, nestLevels } from '@/engine/types';
import type {
  ChipStyle,
  ColumnSpec,
  FieldDef,
  GroupSpec,
  Presentation,
  Schema,
  SortSpec,
  ListDefinition,
  ViewDefinition,
} from '@/engine/types';
import { MAX_GROUP_DEPTH, MAX_NEST_DEPTH } from '@/engine/views';
import { FilterBuilder } from '@/views/FilterBuilder';
import { VIEW_KINDS } from '@/views/viewKinds';

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
  | 'axis'
  | 'list'
  | 'newProperty'
  | 'field';

/** Layouts that draw records on a date axis — they get the Axis page. */
const DATED_LAYOUTS = new Set(['calendar', 'timeline', 'gantt']);
/** Layouts that render relation chips — they get the chip-style section. */
const CHIP_LAYOUTS = new Set(['table', 'list', 'board']);

const GROUPABLE_KINDS = new Set([
  'status',
  'select',
  'multiselect',
  'person',
  'checkbox',
  'relation',
]);
const ORDERABLE_KINDS = new Set(['status', 'select', 'number', 'date', 'daterange']);
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
      className="flex max-h-[min(70vh,640px)] w-[320px] flex-col overflow-hidden rounded-[12px] border border-[var(--n-200)] bg-[var(--n-0)] shadow-[var(--shadow-lg)]"
    >
      <header className="flex flex-none items-center gap-1.5 border-b border-[var(--n-200)] px-3 py-2.5">
        {page !== 'root' && (
          <IconButton icon="arrow-left" label="Back" size="sm" onClick={() => setPage('root')} />
        )}
        <span className="flex-1 truncate text-[13px] font-semibold text-[var(--n-900)]">
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
            <Row
              icon="eye"
              label="Properties"
              value={String(visible)}
              onClick={() => setPage('properties')}
            />
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
                M12.8: absent on the calendar — days are its grouping. */}
            {p.type !== 'calendar' && (
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
            {/* M12.8: tailoring per layout — the dated views expose the axis
                they draw on, which the table has no use for. */}
            {DATED_LAYOUTS.has(p.type) && (
              <Row
                icon="calendar"
                label="Date axis"
                value={p.dateField === undefined ? 'Auto' : humanize(p.dateField)}
                onClick={() => setPage('axis')}
              />
            )}

            {/* M11: how related records draw, per view. A dense table wants
                bare chips; a mixed one wants to see which type each points at. */}
            {CHIP_LAYOUTS.has(p.type) && (
              <div className="mt-2 border-t border-[var(--n-100)] pt-2">
                <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
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
                        'flex items-start gap-2 rounded-[7px] border-0 px-2 py-1.5 text-left text-[12.5px]',
                        chipStyle === style.value
                          ? 'bg-[var(--cortex-50)] text-[var(--cortex-700)]'
                          : 'bg-transparent text-[var(--n-700)] hover:bg-[var(--n-50)]',
                      ].join(' ')}
                    >
                      <Icon
                        name={style.value === 'plain' ? 'tag' : 'shapes'}
                        size={13}
                        color={chipStyle === style.value ? 'var(--cortex-600)' : 'var(--n-500)'}
                      />
                      <span className="min-w-0 flex-1">
                        {style.label}
                        <span className="mt-px block text-[11px] leading-[15px] text-[var(--n-400)]">
                          {style.hint}
                        </span>
                      </span>
                      {chipStyle === style.value && <Icon name="check" size={12} />}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-2 border-t border-[var(--n-100)] pt-2">
              {surface === 'list' && (
                <>
                  <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
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
                  className="mt-1 flex w-full items-center gap-2 rounded-[7px] border-0 bg-transparent px-2 py-1.5 text-left text-[12.5px] text-[var(--n-600)] hover:bg-[var(--n-50)]"
                >
                  <Icon name="trash-2" size={13} />
                  Delete this view
                </button>
              )}
              {onDeleteList !== undefined && (
                <button
                  type="button"
                  onClick={onDeleteList}
                  className="flex w-full items-center gap-2 rounded-[7px] border-0 bg-transparent px-2 py-1.5 text-left text-[12.5px] text-[var(--danger-600)] hover:bg-[var(--danger-50)]"
                >
                  <Icon name="trash-2" size={13} />
                  {surface === 'type' ? 'Delete type' : 'Delete list'}
                </button>
              )}
            </div>
          </>
        )}

        {page === 'list' && (
          <div className="flex flex-col gap-2 px-1">
            <div>
              <span className="mb-1 block text-[11.5px] font-medium text-[var(--n-600)]">
                List name
              </span>
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
            <p className="m-0 text-[11.5px] leading-[16px] text-[var(--n-500)]">
              Records come from{' '}
              <span className="font-medium text-[var(--n-800)]">
                {list.source.type ?? 'everything in the vault'}
              </span>
              . The source is what the list IS — changing it would invalidate every view's columns,
              so it is fixed once created.
            </p>
            <div className="border-t border-[var(--n-100)] pt-2">
              <div className="pb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
                Views
              </div>
              {list.views.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center gap-2 rounded-[7px] px-1 py-1 text-[12.5px] text-[var(--n-700)]"
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
                  {v.id === view.id && (
                    <span className="flex-none text-[10.5px] text-[var(--n-400)]">open</span>
                  )}
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
                  'flex items-center gap-2 rounded-[7px] border-0 px-2 py-1.5 text-left text-[12.5px]',
                  p.type === l.value
                    ? 'bg-[var(--cortex-50)] text-[var(--cortex-700)]'
                    : 'bg-transparent text-[var(--n-700)] hover:bg-[var(--n-50)]',
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
            <p className="m-0 px-2 py-3 text-[12px] leading-[17px] text-[var(--n-500)]">
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
    case 'axis':
      return 'Date axis';
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
      <span className={`flex-1 ${muted ? 'text-[var(--n-500)]' : 'text-[var(--n-800)]'}`}>
        {label}
      </span>
      {value !== '' && <span className="text-[11.5px] text-[var(--n-400)]">{value}</span>}
      {onClick !== undefined && <Icon name="chevron-right" size={12} color="var(--n-400)" />}
    </>
  );
  if (onClick === undefined) {
    return (
      <div className="flex items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12.5px]">
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid={`view-settings-${label.toLowerCase()}`}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[7px] border-0 bg-transparent px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--n-50)]"
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const shown = new Set(columns.filter((c) => c.hidden !== true).map((c) => c.field));
  const visible: ColumnDef[] = columns
    .filter((c) => c.hidden !== true)
    .map((c) => fields.find((f) => f.name === c.field) ?? { name: c.field, kind: 'text' as const });
  const hidden: ColumnDef[] = fields.filter((f) => !shown.has(f.name));

  const matches = (f: ColumnDef) =>
    humanize(f.name).toLowerCase().includes(query.trim().toLowerCase());
  const searching = query.trim() !== '';

  /** Drag a shown row by its grip to a new slot. Same shape as the table's
   * header drag: measure once, pick the slot by midpoint, commit on release. */
  const startDrag = (field: string) => (e: React.PointerEvent) => {
    if (searching || e.button !== 0) return;
    e.preventDefault();
    const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[];
    const mids = rows.map((r) => {
      const box = r.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    const move = (ev: PointerEvent) => {
      setDragging(field);
      setDropSlot(Math.min(mids.filter((m) => ev.clientY > m).length, rows.length));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDragging(null);
      setDropSlot(null);
      const slot = mids.filter((m) => ev.clientY > m).length;
      const from = visible.findIndex((f) => f.name === field);
      if (from === -1) return;
      onChange(moveColumnTo(columns, field, slot > from ? slot - 1 : slot));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const row = (f: ColumnDef, on: boolean, index?: number) => (
    <div
      key={f.name}
      className={[
        'group flex items-center gap-1.5 rounded-[7px] px-1 py-1 hover:bg-[var(--n-50)]',
        dragging === f.name ? 'opacity-60' : '',
      ].join(' ')}
      style={
        index !== undefined && dropSlot === index
          ? { boxShadow: 'inset 0 2px 0 var(--cortex-500)' }
          : index !== undefined && dropSlot === visible.length && index === visible.length - 1
            ? { boxShadow: 'inset 0 -2px 0 var(--cortex-500)' }
            : undefined
      }
    >
      {on && !searching ? (
        <span
          onPointerDown={startDrag(f.name)}
          className="flex h-5 w-4 flex-none cursor-grab touch-none items-center justify-center text-[var(--n-300)] hover:text-[var(--n-500)]"
          aria-hidden
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
          className={`min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[12.5px] hover:underline ${on ? 'text-[var(--n-800)]' : 'text-[var(--n-400)]'}`}
        >
          {humanize(f.name)}
        </button>
      ) : (
        <span
          className={`min-w-0 flex-1 truncate text-[12.5px] ${on ? 'text-[var(--n-800)]' : 'text-[var(--n-400)]'}`}
        >
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
          <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
            Shown in this view
          </span>
          <button
            type="button"
            onClick={() => onChange(columns.map((c) => ({ ...c, hidden: true })))}
            className="border-0 bg-transparent p-0 text-[11px] text-[var(--cortex-600)] hover:underline"
          >
            Hide all
          </button>
        </div>
      )}
      <div ref={listRef} className="flex flex-col gap-0.5">
        {visible.map((f, i) => (matches(f) ? row(f, true, i) : null))}
      </div>

      {hidden.filter(matches).length > 0 && (
        <div className="mt-1.5 flex items-center px-2 pb-0.5">
          <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
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
            className="border-0 bg-transparent p-0 text-[11px] text-[var(--cortex-600)] hover:underline"
          >
            Show all
          </button>
        </div>
      )}
      {hidden.map((f) => (matches(f) ? row(f, false) : null))}

      {visible.length === 0 && hidden.length === 0 && (
        <p className="m-0 px-2 py-3 text-[12px] text-[var(--n-400)]">
          This type declares no properties yet.
        </p>
      )}

      {onNewProperty !== undefined && canEdit && (
        <button
          type="button"
          data-testid="new-property"
          onClick={onNewProperty}
          className="mt-1 flex w-full items-center gap-2 rounded-[7px] border-0 border-t border-[var(--n-100)] bg-transparent px-2 py-1.5 text-left text-[12.5px] text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]"
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
        <span className="mb-1 block text-[11.5px] font-medium text-[var(--n-600)]">
          Date property
        </span>
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
      {(presentation.type === 'timeline' || presentation.type === 'gantt') && (
        <div>
          <span className="mb-1 block text-[11.5px] font-medium text-[var(--n-600)]">Zoom</span>
          <Select
            size="sm"
            value={presentation.zoom ?? 'week'}
            options={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' },
              { value: 'quarter', label: 'Quarter' },
            ]}
            onChange={(e) =>
              onChange({
                ...presentation,
                zoom: e.target.value as NonNullable<Presentation['zoom']>,
              })
            }
            width="100%"
          />
        </div>
      )}
      {presentation.type === 'gantt' && (
        <div>
          <span className="mb-1 block text-[11.5px] font-medium text-[var(--n-600)]">
            Dependencies
          </span>
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
          <p className="m-0 pt-1 text-[11px] leading-[15px] text-[var(--n-400)]">
            The relation naming what each record waits on — the arrows the gantt draws.
          </p>
        </div>
      )}
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

  return (
    <div className="flex flex-col gap-1.5">
      {sort.map((s, i) => (
        <div key={`${i}:${s.field}`} className="flex items-center gap-1.5">
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
                sort.map((x, j) => (j === i ? { ...x, dir: x.dir === 'asc' ? 'desc' : 'asc' } : x)),
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
      {available.length > 0 && (
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
      {sort.length === 0 && (
        <p className="m-0 px-1 pt-1 text-[11.5px] leading-[16px] text-[var(--n-500)]">
          Records appear in vault order.
        </p>
      )}
    </div>
  );
}

function labelFor(field: string): string {
  return META_SORTS.find((m) => m.value === field)?.label ?? humanize(field);
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
          <span className="w-8 flex-none text-[11px] text-[var(--n-400)]">
            {i === 0 ? 'By' : 'then'}
          </span>
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

      {addOptions.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="w-8 flex-none text-[11px] text-[var(--n-400)]">
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

      <p className="m-0 border-t border-[var(--n-100)] px-1 pt-2 text-[11px] leading-[15px] text-[var(--n-400)]">
        A property bands records by its value. A relation (↳) nests them under what they link to.
      </p>
    </div>
  );
}
