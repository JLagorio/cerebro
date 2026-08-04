import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import {
  addFieldToType,
  changeFieldKind,
  normalizeFieldName,
  removeFieldFromType,
  renameFieldOnType,
  setFieldConfig,
  setFieldOptions,
  setTypeStatuses,
} from '@/app/typeActions';
import { OptionListEditor } from '@/detail/OptionListEditor';
import { RelationConfigEditor } from '@/detail/RelationConfigEditor';
import { FormatRow, RollupConfigEditor } from '@/detail/RollupConfigEditor';
import { StatusListEditor } from '@/detail/StatusListEditor';
import type { ColumnDef } from '@/engine/columns';
import { CREATABLE_PROPERTY_KINDS, kindMeta } from '@/engine/properties';
import { DEFAULT_STATUSES, humanize } from '@/engine/schema';
import { isLockedField } from '@/engine/typeCatalog';
import type { ColumnSpec, FieldDef, Schema } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The floating property editor (M12.8): everything about one property —
 * name, kind, and the kind's own configuration (options, statuses, relation
 * wiring, rollup calc, number format) — in whatever popover hosts it. This
 * replaced the type-properties ASIDE: config edits fly out next to what they
 * configure (the column header, the settings menu) instead of docking a
 * panel on the far side of the window.
 */
/**
 * The confirmation a kind change owes the user (M15).
 *
 * `changeFieldKind` rewrites EVERY record of the type on disk and drops the
 * property's option list on the way. It used to fire from a single click in a
 * submenu, with no count, no preview and no undo — a mis-aimed click on a
 * 400-record select column wrote 400 files and destroyed the options, and the
 * only recovery in the app is git.
 */
export function ConfirmKindChange({
  name,
  from,
  to,
  count,
  onConfirm,
  onCancel,
}: {
  name: string;
  from: FieldDef['kind'];
  to: FieldDef['kind'];
  /** Records of this type that will be rewritten. */
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const losesOptions = from === 'select' || from === 'multiselect' || from === 'status';
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Change "${name}" to ${kindMeta(to).label}?`}
      width={420}
      primaryAction={{ label: 'Change type', onClick: onConfirm }}
      secondaryAction={{ label: 'Cancel', onClick: onCancel }}
    >
      <p className="m-0 text-sm text-n-600">
        This rewrites {count === 1 ? '1 record' : `${count} records`} on disk
        {losesOptions ? " and discards this property's option list" : ''}. Values that cannot be
        read as {kindMeta(to).label.toLowerCase()} are dropped. This cannot be undone from the app.
      </p>
    </Dialog>
  );
}

/**
 * The confirmation deleting a property owes the user (M16.29).
 *
 * `removeFieldFromType` rewrites the TYPE, so one click took the property off
 * every record of that type at once, with no confirmation and no undo. The
 * cruelty was that the surface it fired from — the record panel's property
 * menu — already computes and PRINTS the blast radius in its footer ("Changes
 * Work item — 45 records") and then guarded nothing.
 *
 * What the deletion actually does is not obvious from watching it, so the
 * dialog says all three parts: how far it reaches, that the stored values stay
 * in the files and merely stop being shown, and — for the kinds that carry
 * one — that the option list and its colours go with the property. Only the
 * last is truly unrecoverable, and only git can bring it back.
 */
export function ConfirmDeleteProperty({
  name,
  kind,
  sourceType,
  count,
  onConfirm,
  onCancel,
}: {
  /** Humanized, as the user reads it on the row. */
  name: string;
  kind: FieldDef['kind'];
  /** The type the property is declared on — the footer's own words. */
  sourceType: string;
  /** Records of this type the removal reaches. */
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const losesOptions = kind === 'select' || kind === 'multiselect' || kind === 'status';
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Delete "${name}"?`}
      width={440}
      footerNote="Recoverable from git history, not from the app."
      primaryAction={{ label: 'Delete', onClick: onConfirm }}
      secondaryAction={{ label: 'Cancel', onClick: onCancel }}
    >
      <p className="m-0 text-sm leading-relaxed text-n-600">
        This changes {sourceType} — {count === 1 ? '1 record' : `${count} records`}. Each one keeps
        its {name.toLowerCase()} value in its frontmatter, but nothing in the app will show or edit
        it again until the property is declared once more.
        {losesOptions ? " The property's option list and its colours are not kept anywhere." : ''}
      </p>
    </Dialog>
  );
}

export function PropertyEditor({
  def,
  sourceType,
  schema,
  columns = [],
  onColumnsChange,
  onRenamed,
  onDeleted,
}: {
  def: ColumnDef;
  /** The type whose schema the edits write. */
  sourceType: string;
  schema: Schema;
  /**
   * The open view's columns — a rename must follow the field it names.
   * Optional because the detail panel (M16.7) mounts this too and has none:
   * a record's property list IS the type's declared order, not a per-view
   * selection of it.
   */
  columns?: ColumnSpec[];
  onColumnsChange?: (next: ColumnSpec[]) => void;
  /** Hosts track the edited property by name; a rename must retarget them. */
  onRenamed?: (next: string) => void;
  onDeleted?: () => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const [draft, setDraft] = useState(humanize(def.name));
  const [changingKind, setChangingKind] = useState(false);
  const [pendingKind, setPendingKind] = useState<FieldDef['kind'] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const locked = isLockedField(sourceType, def.name);
  const typeDef = schema.types.get(sourceType);
  const statuses =
    typeDef !== undefined && typeDef.statuses.length > 0 ? typeDef.statuses : DEFAULT_STATUSES;
  // setTypeStatuses wants the Type doc's path — resolve it the way the type
  // catalog does: the Type-typed entry whose title is the type's name.
  const docPath = entries.find((e) => e.type === 'Type' && e.title === sourceType)?.path ?? null;

  const hasValues = def.kind === 'select' || def.kind === 'multiselect' || def.kind === 'status';
  // `person` configures like a relation (M16.13b) — it IS one, with an avatar
  // renderer. Leaving it out meant a person field had no control anywhere that
  // could change which records it picks from.
  const hasConfig =
    def.kind === 'rollup' ||
    def.kind === 'number' ||
    def.kind === 'relation' ||
    def.kind === 'person';

  const commitRename = () => {
    const next = draft.trim();
    if (locked || next === '' || humanize(def.name) === next) return;
    void (async () => {
      if (await renameFieldOnType(sourceType, def.name, next)) {
        const normalized = normalizeFieldName(next);
        onColumnsChange?.(
          columns.map((c) => (c.field === def.name ? { ...c, field: normalized } : c)),
        );
        onRenamed?.(normalized);
      }
    })();
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <span className="mb-1 block text-xs font-medium text-n-600">Name</span>
        {locked ? (
          <div className="flex items-center gap-1.5 px-1 text-sm text-n-600">
            <Icon name="lock" size={11} />
            {humanize(def.name)}
            <span className="text-2xs text-n-400">Built-in</span>
          </div>
        ) : (
          <Input
            size="sm"
            ariaLabel={`Rename ${humanize(def.name)}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setDraft(humanize(def.name));
            }}
            width="100%"
          />
        )}
      </div>

      {!locked && (
        <div>
          <button
            type="button"
            data-testid="property-editor-type"
            onClick={() => setChangingKind(!changingKind)}
            className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-1 py-1 text-left text-sm text-n-700 hover:bg-n-50"
          >
            <Icon name="repeat-2" size={12} color="var(--n-500)" />
            <span className="min-w-0 flex-1">Type</span>
            <span className="flex items-center gap-1 text-2xs text-n-400">
              {kindMeta(def.kind).label}
              <Icon name={changingKind ? 'chevron-down' : 'chevron-right'} size={11} />
            </span>
          </button>
          {changingKind && (
            <div className="mt-1 max-h-[200px] overflow-y-auto rounded-md bg-n-25 p-0.5">
              {CREATABLE_PROPERTY_KINDS.filter((k) => !k.computed).map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  data-testid={`change-type-${k.kind}`}
                  onClick={() => setPendingKind(k.kind)}
                  className="flex w-full items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1 text-left text-sm text-n-700 hover:bg-n-50"
                >
                  <Icon name={k.icon} size={12} color="var(--n-500)" />
                  <span className="min-w-0 flex-1">{k.label}</span>
                  {k.kind === def.kind && <Icon name="check" size={12} color="var(--cortex-600)" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {(hasValues || hasConfig) && (
        <div className="border-t border-n-100 pt-1.5">
          {def.kind === 'status' ? (
            // Statuses are the type's workflow, editable even on system
            // types: the lock covers the field, not the team's stages.
            <StatusListEditor
              statuses={statuses}
              onChange={(next) => void setTypeStatuses({ name: sourceType, docPath }, next)}
            />
          ) : def.kind === 'rollup' ? (
            <RollupConfigEditor
              typeName={sourceType}
              def={def}
              schema={schema}
              onChange={(config) => void setFieldConfig(sourceType, def.name, config)}
            />
          ) : def.kind === 'number' ? (
            <FormatRow
              def={def}
              onChange={(config) => void setFieldConfig(sourceType, def.name, config)}
            />
          ) : def.kind === 'relation' || def.kind === 'person' ? (
            <RelationConfigEditor
              typeName={sourceType}
              def={def}
              schema={schema}
              onChange={(config) => void setFieldConfig(sourceType, def.name, config)}
              onAddReciprocal={(name) => {
                if (def.target === undefined) return;
                void addFieldToType(def.target, name, 'relation', {
                  from: { type: sourceType, field: def.name },
                });
              }}
            />
          ) : (
            <OptionListEditor
              options={def.options ?? []}
              label={humanize(def.name)}
              onChange={(next) => void setFieldOptions(sourceType, def.name, next)}
            />
          )}
        </div>
      )}

      {!locked && (
        <button
          type="button"
          // Asks first (M16.29). This used to remove the property from the
          // type on the click, which took it off every record at once.
          onClick={() => setConfirmDelete(true)}
          className="flex w-full items-center gap-2 rounded-md border-0 border-t border-n-100 bg-transparent px-1 py-1.5 text-left text-sm text-danger-600 hover:bg-danger-50"
        >
          <Icon name="trash-2" size={13} />
          Delete property
        </button>
      )}
      {confirmDelete && (
        <ConfirmDeleteProperty
          name={humanize(def.name)}
          kind={def.kind}
          sourceType={sourceType}
          count={entries.filter((e) => e.type === sourceType).length}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void (async () => {
              if (await removeFieldFromType(sourceType, def.name)) {
                onColumnsChange?.(columns.filter((c) => c.field !== def.name));
                onDeleted?.();
              }
            })();
          }}
        />
      )}
      {pendingKind !== null && (
        <ConfirmKindChange
          name={humanize(def.name)}
          from={def.kind}
          to={pendingKind}
          count={entries.filter((e) => e.type === sourceType).length}
          onCancel={() => setPendingKind(null)}
          onConfirm={() => {
            setPendingKind(null);
            setChangingKind(false);
            void changeFieldKind(sourceType, def.name, pendingKind);
          }}
        />
      )}
    </div>
  );
}
