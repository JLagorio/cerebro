import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { ColumnDef } from '@/engine/columns';
import { moveColumn, toggleColumn } from '@/engine/columns';
import {
  chainTypes,
  descentOptions,
  descentValue,
  parseDescentValue,
} from '@/engine/hierarchyOptions';
import { kindMeta } from '@/engine/properties';
import { humanize } from '@/engine/schema';
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

type Page = 'root' | 'layout' | 'properties' | 'filter' | 'sort' | 'group' | 'list';

const GROUPABLE_KINDS = new Set([
  'status', 'select', 'multiselect', 'person', 'checkbox', 'relation',
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
}: ViewSettingsPanelProps) {
  const [page, setPage] = useState<Page>('root');
  const view = list.views.find((v) => v.id === viewId) ?? list.views[0];
  const p = view.presentation;

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
    <aside
      data-testid="view-settings-panel"
      aria-label="View settings"
      className="flex w-[320px] max-w-[80vw] flex-none flex-col border-l border-[var(--n-200)] bg-[var(--n-0)]"
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

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {page === 'root' && (
          <>
            <div className="px-1 pb-2">
              {/* M11: this names the VIEW, not the List. Two tabs of one
                  database need two names, and the List's own name is edited
                  where the List is — one row down, under "This list". */}
              <Input
                ariaLabel="View name"
                placeholder="View name"
                value={view.name}
                onChange={(e) => setView({ name: e.target.value })}
                width="100%"
              />
            </div>
            <Row icon="table-2" label="Layout" value={layoutName} onClick={() => setPage('layout')} />
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
                relation nests. They were two rows answering one question. */}
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

            {/* M11: how related records draw, per view. A dense table wants
                bare chips; a mixed one wants to see which type each points at. */}
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

            <div className="mt-2 border-t border-[var(--n-100)] pt-2">
              <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
                This list
              </div>
              <Row
                icon="database"
                label={list.source.type ?? 'Everything'}
                value={`${list.views.length} ${list.views.length === 1 ? 'view' : 'views'}`}
                onClick={() => setPage('list')}
              />
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
                  className="flex w-full items-center gap-2 rounded-[7px] border-0 bg-transparent px-2 py-1.5 text-left text-[12.5px] text-[var(--danger-600,#B3261E)] hover:bg-[var(--danger-50)]"
                >
                  <Icon name="trash-2" size={13} />
                  Delete list
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
                value={list.name}
                onChange={(e) => onChange({ ...list, name: e.target.value })}
                width="100%"
              />
            </div>
            <p className="m-0 text-[11.5px] leading-[16px] text-[var(--n-500)]">
              Records come from{' '}
              <span className="font-medium text-[var(--n-800)]">
                {list.source.type ?? 'everything in the vault'}
              </span>
              . The source is what the list IS — changing it would invalidate every view's
              columns, so it is fixed once created.
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
                    name={v.icon ?? VIEW_KINDS.find((k) => k.value === v.presentation.type)?.icon ?? 'table-2'}
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
          />
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
    </aside>
  );
}

function titleFor(page: Page): string {
  switch (page) {
    case 'layout': return 'Layout';
    case 'properties': return 'Properties';
    case 'filter': return 'Filter';
    case 'sort': return 'Sort';
    case 'group': return 'Group';
    case 'list': return 'This list';
    default: return 'View settings';
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
      <div className="flex items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12.5px]">{content}</div>
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

function PropertiesPage({
  fields,
  columns,
  onChange,
}: {
  fields: ColumnDef[];
  columns: ColumnSpec[];
  onChange: (next: ColumnSpec[]) => void;
}) {
  const shown = new Set(columns.filter((c) => c.hidden !== true).map((c) => c.field));
  const ordered: ColumnDef[] = [
    ...columns
      .filter((c) => c.hidden !== true)
      .map((c) => fields.find((f) => f.name === c.field) ?? { name: c.field, kind: 'text' as const }),
    ...fields.filter((f) => !shown.has(f.name)),
  ];

  return (
    <div className="flex flex-col gap-0.5">
      {ordered.map((f) => {
        const on = shown.has(f.name);
        return (
          <div
            key={f.name}
            className="group flex items-center gap-1.5 rounded-[7px] px-2 py-1 hover:bg-[var(--n-50)]"
          >
            <Icon name={kindMeta(f.kind).icon} size={12} color="var(--n-400)" />
            <span
              className={`min-w-0 flex-1 truncate text-[12.5px] ${on ? 'text-[var(--n-800)]' : 'text-[var(--n-400)]'}`}
            >
              {humanize(f.name)}
            </span>
            {on && (
              <span className="hidden gap-0.5 group-hover:inline-flex">
                <IconButton
                  icon="chevron-up"
                  label={`Move ${humanize(f.name)} up`}
                  size="sm"
                  onClick={() => onChange(moveColumn(columns, f.name, -1))}
                />
                <IconButton
                  icon="chevron-down"
                  label={`Move ${humanize(f.name)} down`}
                  size="sm"
                  onClick={() => onChange(moveColumn(columns, f.name, 1))}
                />
              </span>
            )}
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={`${on ? 'Hide' : 'Show'} ${humanize(f.name)}`}
              onClick={() => onChange(toggleColumn(columns, f.name))}
              className="inline-flex h-[18px] w-[30px] flex-none items-center rounded-full border-0 p-0 transition-colors"
              style={{ background: on ? 'var(--cortex-500)' : 'var(--n-200)' }}
            >
              <span
                className="h-3.5 w-3.5 rounded-full bg-white transition-transform"
                style={{ transform: `translateX(${on ? 14 : 2}px)` }}
              />
            </button>
          </div>
        );
      })}
      {ordered.length === 0 && (
        <p className="m-0 px-2 py-3 text-[12px] text-[var(--n-400)]">
          This type declares no properties yet.
        </p>
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
            options={[
              { value: s.field, label: labelFor(s.field) },
              ...available,
            ].filter((o, j, all) => all.findIndex((x) => x.value === o.value) === j)}
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
    const fieldsHere =
      typeHere === null ? fields : (schema.types.get(typeHere)?.fields ?? fields);
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
            value={level.descend === undefined ? `property:${level.field}` : descentValue(level.descend)}
            options={optionsAt(i)}
            onChange={(e) => {
              const next = decode(e.target.value);
              if (next === null) return;
              // Changing a relation level re-types everything below it, so
              // the tail's options no longer apply.
              const tail =
                level.descend !== undefined || next.descend !== undefined
                  ? []
                  : group.slice(i + 1);
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
        A property bands records by its value. A relation (↳) nests them under
        what they link to.
      </p>
    </div>
  );
}
