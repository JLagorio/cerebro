import { useEffect, useMemo, useState } from 'react';
import { DeleteTypeDialog, RenameTypeDialog, TypeStyleDialog } from '@/app/TypeDialogs';
import {
  addFieldToType,
  moveFieldOnType,
  removeFieldFromType,
  renameFieldOnType,
  setFieldConfig,
  normalizeFieldName,
  setFieldOptions,
  setTypeStatuses,
} from '@/app/typeActions';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import { humanize } from '@/detail/FieldEditor';
import { OptionListEditor } from '@/detail/OptionListEditor';
import { FormatRow, RollupConfigEditor } from '@/detail/RollupConfigEditor';
import { StatusListEditor } from '@/detail/StatusListEditor';
import { resolveSurface, sortEntries } from '@/engine/surface';
import { columnUniverse } from '@/engine/columns';
import { clonePresentation, toggleSort } from '@/engine/views';
import { kindMeta } from '@/engine/properties';
import { DEFAULT_STATUSES } from '@/engine/schema';
import {
  isLockedField,
  listTypes,
  type TypeListing,
} from '@/engine/typeCatalog';
import type { FieldDef, Presentation, Schema, Selection, StatusDef } from '@/engine/types';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { resolveDateField } from '@/engine/schedule';
import { useQuickAdd } from '@/views/QuickAdd';
import { ViewCanvas } from '@/views/ViewCanvas';
import { ViewToolbar } from '@/views/ViewToolbar';

export type TypeSelection = Extract<Selection, { kind: 'type' }>;

type TypeTab = 'records' | 'properties';
type TypeDialog = 'rename' | 'style' | 'delete';

/** Underline tab (same pattern as ProjectPage's ViewTab). */
function PageTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1.5 border-0 border-b-2 bg-transparent px-2 pb-2 pt-1 text-[13px]',
        active
          ? 'border-[var(--cortex-500)] font-semibold text-[var(--n-900)]'
          : 'border-transparent font-normal text-[var(--n-500)] hover:text-[var(--n-800)]',
      ].join(' ')}
      style={{ borderBottomStyle: 'solid' }}
    >
      <Icon name={icon} size={13} />
      {label}
    </button>
  );
}

/**
 * One declared field: kind icon, editable name, and — for option-bearing
 * kinds — its expandable value editor. The name and the option set are
 * editable for custom fields; system built-ins show the lock instead
 * (M3.1: renaming/option editing were the top gaps in the feedback round).
 */
function FieldRow({
  typeName,
  def,
  schema,
  statuses,
  onStatusesChange,
}: {
  typeName: string;
  def: FieldDef;
  schema: Schema;
  /** Status set this type's records use — only read for `status` fields. */
  statuses: StatusDef[];
  onStatusesChange: (next: StatusDef[]) => void;
}) {
  const locked = isLockedField(typeName, def.name);
  const meta = kindMeta(def.kind);
  const options = def.options ?? [];
  const hasValues = def.kind === 'select' || def.kind === 'multiselect' || def.kind === 'status';
  // M3.4: rollups need wiring, numbers need a display format — both live in
  // the same expander as option sets so every field configures in one place.
  const hasConfig = def.kind === 'rollup' || def.kind === 'number';

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(humanize(def.name));
  const [expanded, setExpanded] = useState(false);

  const commitRename = () => {
    setRenaming(false);
    const next = draft.trim();
    if (next === '' || next === humanize(def.name)) {
      setDraft(humanize(def.name));
      return;
    }
    void (async () => {
      if (!(await renameFieldOnType(typeName, def.name, next))) setDraft(humanize(def.name));
    })();
  };

  const valueCount = def.kind === 'status' ? statuses.length : options.length;

  return (
    <div
      data-testid="type-field-row"
      className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--n-200)] px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <Icon name={meta.icon} size={14} color="var(--n-500)" />
        {renaming ? (
          <Input
            autoFocus
            size="sm"
            ariaLabel={`Rename ${humanize(def.name)}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setDraft(humanize(def.name));
                setRenaming(false);
              }
            }}
            width={200}
          />
        ) : (
          <button
            type="button"
            disabled={locked}
            title={locked ? undefined : 'Rename property'}
            onClick={() => setRenaming(true)}
            className="rounded-md border-0 bg-transparent px-1 py-0.5 text-[13px] font-medium text-[var(--n-900)] enabled:hover:bg-[var(--n-50)] disabled:cursor-default"
          >
            {humanize(def.name)}
          </button>
        )}
        <span className="text-[11.5px] text-[var(--n-400)]">{meta.label}</span>
        <span className="flex-1" />
        {(hasValues || hasConfig) && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[11.5px] text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]"
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
            {hasValues
              ? `${valueCount} ${def.kind === 'status' ? 'statuses' : 'options'}`
              : 'Configure'}
          </button>
        )}
        {/* M9.6: declaration order drives default column order everywhere,
            so reordering here is the schema-level equivalent of dragging a
            table header. Available on built-ins too — the lock covers a
            property's existence, not where it sits. */}
        <span className="inline-flex gap-0.5">
          <IconButton
            icon="chevron-up"
            label={`Move ${humanize(def.name)} up`}
            size="sm"
            onClick={() => void moveFieldOnType(typeName, def.name, -1)}
          />
          <IconButton
            icon="chevron-down"
            label={`Move ${humanize(def.name)} down`}
            size="sm"
            onClick={() => void moveFieldOnType(typeName, def.name, 1)}
          />
        </span>
        {locked ? (
          <span
            title="Built-in property — its name and kind are fixed"
            className="inline-flex items-center gap-1 text-[11px] text-[var(--n-400)]"
          >
            <Icon name="lock" size={11} />
            Built-in
          </span>
        ) : (
          <IconButton
            icon="trash-2"
            label={`Remove ${humanize(def.name)}`}
            size="sm"
            onClick={() => void removeFieldFromType(typeName, def.name)}
          />
        )}
      </div>
      {(hasValues || hasConfig) && expanded && (
        <div className="border-t border-[var(--n-100)] pt-1.5">
          {def.kind === 'status' ? (
            // Statuses are the type's workflow, editable even on system
            // types: the lock covers the field, not the team's stages.
            <StatusListEditor statuses={statuses} onChange={onStatusesChange} />
          ) : def.kind === 'rollup' ? (
            <RollupConfigEditor
              typeName={typeName}
              def={def}
              schema={schema}
              onChange={(config) => void setFieldConfig(typeName, def.name, config)}
            />
          ) : def.kind === 'number' ? (
            <FormatRow
              def={def}
              onChange={(config) => void setFieldConfig(typeName, def.name, config)}
            />
          ) : (
            <OptionListEditor
              options={options}
              label={humanize(def.name)}
              onChange={(next) => void setFieldOptions(typeName, def.name, next)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The single-pane property configuration surface for a type. */
function TypePropertiesPanel({ listing }: { listing: TypeListing }) {
  const schema = useSchema();
  const typeDef = schema.types.get(listing.name);
  const fields = typeDef?.fields ?? [];
  const [adding, setAdding] = useState(false);

  // A type with no `statuses:` of its own starts from the app defaults —
  // showing that set is what makes "edit statuses" work on a fresh type:
  // saving writes the (possibly edited) list onto this Type doc. M12.2: no
  // type inherits from another type's statuses anymore.
  const statuses =
    typeDef !== undefined && typeDef.statuses.length > 0 ? typeDef.statuses : DEFAULT_STATUSES;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-2">
        {listing.system && (
          <div className="mb-1 flex items-start gap-2 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-25)] px-3 py-2.5 text-[12.5px] leading-[18px] text-[var(--n-600)]">
            <Icon name="lock" size={13} style={{ marginTop: 2 }} />
            <span>
              <strong className="font-semibold text-[var(--n-800)]">{listing.name}</strong> is a
              system type: its name and built-in properties are locked. Custom properties you add
              here are fully yours.
            </span>
          </div>
        )}
        {fields.length === 0 && (
          <div className="py-6">
            <EmptyState
              icon="settings-2"
              title="No properties yet"
              description="Add one below and every record of this type gains the field."
            />
          </div>
        )}
        {fields.map((f) => (
          <FieldRow
            key={f.name}
            typeName={listing.name}
            def={f}
            schema={schema}
            statuses={statuses}
            onStatusesChange={(next) => void setTypeStatuses(listing, next)}
          />
        ))}
        {adding ? (
          <AddPropertyPanel
            existingNames={fields.map((f) => humanize(f.name))}
            onAdd={(name, kind) => {
              void (async () => {
                if (await addFieldToType(listing.name, name, kind)) setAdding(false);
              })();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-1 self-start rounded-md border-0 bg-transparent px-1 py-0.5 text-[12.5px] text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
          >
            + Add property
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * M3 type screen: the record list for one type (rows open in the right-hand
 * detail panel) plus the Properties configuration tab.
 */
export function TypePage({ selection }: { selection: TypeSelection }) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();

  const listing = useMemo<TypeListing>(
    () =>
      listTypes(entries, schema).find((t) => t.name === selection.name) ?? {
        name: selection.name,
        icon: 'file-text',
        color: null,
        count: 0,
        system: false,
        docPath: null,
      },
    [entries, schema, selection.name],
  );

  const collection = useMemo(
    () => resolveSurface(selection, entries, schema, views),
    [selection, entries, schema, views],
  );

  // M9.2: one resolution path shared with every other surface.
  const typeFields = useMemo(
    () => columnUniverse({ type: listing.name, project: null }, collection.entries, schema),
    [schema, listing.name, collection.entries],
  );
  const scope = `type:${listing.name}`;
  // M9.6: the type screen could only list; now it can create.
  const quickAdd = useQuickAdd(listing.name, null);

  const [tab, setTab] = useState<TypeTab>('records');
  const [dialog, setDialog] = useState<TypeDialog | null>(null);
  const [presentation, setPresentation] = useState<Presentation>(collection.presentation);
  useEffect(() => {
    setTab('records');
    setPresentation(clonePresentation(collection.presentation));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.name]);

  const sortedEntries = useMemo(
    () => sortEntries(collection.entries, presentation.sort, schema),
    [collection.entries, presentation.sort, schema],
  );

  // The calendar creates WITH a date, which the band mechanism cannot carry:
  // a band sets a grouping value, not an arbitrary property.
  const dateField = resolveDateField(presentation, typeFields);
  const onCreateOn =
    dateField === null
      ? undefined
      : (title: string, day: string) => quickAdd(title, {}, { [dateField]: day });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex-none px-5 pt-3.5">
        <div className="mb-2.5 flex min-w-0 items-center gap-2">
          <Icon name={listing.icon} size={16} color={listing.color ?? 'var(--n-600)'} />
          <h1 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.005em]">
            {listing.name}
          </h1>
          <span className="[font-family:var(--font-mono)] text-[11.5px] text-[var(--n-400)]">
            {listing.count}
          </span>
          {listing.system && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--n-200)] px-2 py-0.5 text-[11px] text-[var(--n-500)]">
              <Icon name="lock" size={10} />
              System type
            </span>
          )}
          <span className="flex-1" />
          <IconButton
            icon="palette"
            label="Customize icon & color"
            onClick={() => setDialog('style')}
          />
          {!listing.system && (
            <>
              <IconButton
                icon="pencil"
                label="Change display name"
                onClick={() => setDialog('rename')}
              />
              {listing.docPath !== null && (
                <IconButton
                  icon="trash-2"
                  label="Delete type"
                  onClick={() => setDialog('delete')}
                />
              )}
            </>
          )}
        </div>
        <div role="tablist" aria-label="Type tabs" className="flex items-end gap-1 border-b border-[var(--n-200)]">
          <PageTab
            active={tab === 'records'}
            icon="list"
            label="Records"
            onClick={() => setTab('records')}
          />
          <PageTab
            active={tab === 'properties'}
            icon="settings-2"
            label="Properties"
            onClick={() => setTab('properties')}
          />
        </div>
      </div>
      {tab === 'properties' ? (
        <TypePropertiesPanel listing={listing} />
      ) : (
        <>
          <ViewToolbar
            presentation={presentation}
            onChange={setPresentation}
            fields={typeFields}
            sourceType={listing.name}
            schema={schema}
            onAddProperty={(name, kind) => {
              void (async () => {
                if (await addFieldToType(listing.name, name, kind)) {
                  setPresentation((p) => ({
                    ...p,
                    columns: [...p.columns, { field: normalizeFieldName(name) }],
                  }));
                }
              })();
            }}
          />
          <ViewCanvas
            entries={sortedEntries}
            allEntries={entries}
            presentation={presentation}
            schema={schema}
            fields={typeFields}
            scope={scope}
            createType={listing.name}
            onCreate={quickAdd}
            onCreateOn={onCreateOn}
            onColumnsChange={(columns) => setPresentation({ ...presentation, columns })}
            onOrderBy={(field) => setPresentation(toggleSort(presentation, field))}
            onZoomChange={(zoom) => setPresentation({ ...presentation, zoom })}
          />
        </>
      )}
      {dialog === 'style' && (
        <TypeStyleDialog listing={listing} onClose={() => setDialog(null)} />
      )}
      {dialog === 'rename' && (
        <RenameTypeDialog listing={listing} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && (
        <DeleteTypeDialog listing={listing} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
