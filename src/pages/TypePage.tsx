import { useEffect, useMemo, useState } from 'react';
import {
  DeleteTypeDialog,
  RenameTypeDialog,
  TypeStyleDialog,
  TYPE_COLORS,
} from '@/app/TypeDialogs';
import { addFieldToType, removeFieldFromType, setFieldOptions } from '@/app/typeActions';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import { humanize } from '@/detail/FieldEditor';
import { resolveCollection, sortEntries } from '@/engine/collections';
import { kindMeta } from '@/engine/properties';
import {
  isLockedField,
  listTypes,
  type TypeListing,
} from '@/engine/typeCatalog';
import type { FieldDef, Presentation, Selection } from '@/engine/types';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { BoardView } from '@/views/BoardView';
import { ListView } from '@/views/ListView';
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

/** One option chip in the field row's option editor. */
function OptionChip({
  option,
  locked,
  onRemove,
}: {
  option: { id: string; label: string; color: string | null };
  locked: boolean;
  onRemove: () => void;
}) {
  return (
    <span className="group inline-flex items-center gap-1 rounded-full border border-[var(--n-200)] py-0.5 pl-1.5 pr-1.5 text-[11.5px] text-[var(--n-700)]">
      <span
        aria-hidden
        className="h-2 w-2 rounded-full"
        style={{ background: option.color ?? 'var(--n-300)' }}
      />
      {option.label}
      {!locked && (
        <button
          type="button"
          aria-label={`Remove option ${option.label}`}
          onClick={onRemove}
          className="hidden h-3.5 w-3.5 items-center justify-center rounded-full border-0 bg-transparent text-[var(--n-400)] hover:text-[var(--danger-500)] group-hover:inline-flex"
        >
          <Icon name="x" size={10} />
        </button>
      )}
    </span>
  );
}

const OPTIONED_KINDS = new Set(['select', 'multiselect', 'status']);

/** One declared field of the type: kind icon, name, options, lock/remove. */
function FieldRow({ typeName, def }: { typeName: string; def: FieldDef }) {
  const locked = isLockedField(typeName, def.name);
  const meta = kindMeta(def.kind);
  const [newOption, setNewOption] = useState('');
  const options = def.options ?? [];

  const addOption = () => {
    const label = newOption.trim();
    if (label === '') return;
    const id = label.replace(/\s+/g, '-').toLowerCase();
    if (options.some((o) => o.id === id)) return;
    setNewOption('');
    void setFieldOptions(typeName, def.name, [
      ...options,
      { id, label, color: TYPE_COLORS[options.length % TYPE_COLORS.length] },
    ]);
  };

  return (
    <div
      data-testid="type-field-row"
      className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--n-200)] px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <Icon name={meta.icon} size={14} color="var(--n-500)" />
        <span className="text-[13px] font-medium text-[var(--n-900)]">{humanize(def.name)}</span>
        <span className="text-[11.5px] text-[var(--n-400)]">{meta.label}</span>
        <span className="flex-1" />
        {locked ? (
          <span
            title="Built-in property — locked"
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
      {OPTIONED_KINDS.has(def.kind) && def.kind !== 'status' && (
        <div className="flex flex-wrap items-center gap-1.5">
          {options.map((o) => (
            <OptionChip
              key={o.id}
              option={o}
              locked={locked}
              onRemove={() =>
                void setFieldOptions(
                  typeName,
                  def.name,
                  options.filter((x) => x.id !== o.id),
                )
              }
            />
          ))}
          {!locked && (
            <Input
              ariaLabel={`Add option to ${humanize(def.name)}`}
              placeholder="Add option…"
              size="sm"
              value={newOption}
              onChange={(e) => setNewOption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addOption();
              }}
              width={110}
            />
          )}
          {options.length === 0 && locked && (
            <span className="text-[11.5px] text-[var(--n-400)]">No options declared</span>
          )}
        </div>
      )}
    </div>
  );
}

/** The single-pane property configuration surface for a type. */
function TypePropertiesPanel({ listing }: { listing: TypeListing }) {
  const schema = useSchema();
  const fields = schema.types.get(listing.name)?.fields ?? [];
  const [adding, setAdding] = useState(false);

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
          <div className="px-1 py-2 text-[12.5px] text-[var(--n-400)]">
            No properties declared yet.
          </div>
        )}
        {fields.map((f) => (
          <FieldRow key={f.name} typeName={listing.name} def={f} />
        ))}
        {adding ? (
          <AddPropertyPanel
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
    () => resolveCollection(selection, entries, schema, views),
    [selection, entries, schema, views],
  );

  const [tab, setTab] = useState<TypeTab>('records');
  const [dialog, setDialog] = useState<TypeDialog | null>(null);
  const [presentation, setPresentation] = useState<Presentation>(collection.presentation);
  useEffect(() => {
    setTab('records');
    setPresentation(collection.presentation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.name]);

  const sortedEntries = useMemo(
    () => sortEntries(collection.entries, presentation.orderBy, schema),
    [collection.entries, presentation.orderBy, schema],
  );

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
          <ViewToolbar presentation={presentation} onChange={setPresentation} />
          {presentation.type === 'board' ? (
            <BoardView entries={sortedEntries} presentation={presentation} schema={schema} />
          ) : (
            <ListView
              entries={sortedEntries}
              presentation={presentation}
              schema={schema}
              project={null}
            />
          )}
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
