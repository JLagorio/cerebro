import { useState } from 'react';
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
import type { ColumnSpec, Schema } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The floating property editor (M12.8): everything about one property —
 * name, kind, and the kind's own configuration (options, statuses, relation
 * wiring, rollup calc, number format) — in whatever popover hosts it. This
 * replaced the type-properties ASIDE: config edits fly out next to what they
 * configure (the column header, the settings menu) instead of docking a
 * panel on the far side of the window.
 */
export function PropertyEditor({
  def,
  sourceType,
  schema,
  columns,
  onColumnsChange,
  onRenamed,
  onDeleted,
}: {
  def: ColumnDef;
  /** The type whose schema the edits write. */
  sourceType: string;
  schema: Schema;
  /** The open view's columns — a rename must follow the field it names. */
  columns: ColumnSpec[];
  onColumnsChange: (next: ColumnSpec[]) => void;
  /** Hosts track the edited property by name; a rename must retarget them. */
  onRenamed?: (next: string) => void;
  onDeleted?: () => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const [draft, setDraft] = useState(humanize(def.name));
  const [changingKind, setChangingKind] = useState(false);

  const locked = isLockedField(sourceType, def.name);
  const typeDef = schema.types.get(sourceType);
  const statuses =
    typeDef !== undefined && typeDef.statuses.length > 0 ? typeDef.statuses : DEFAULT_STATUSES;
  // setTypeStatuses wants the Type doc's path — resolve it the way the type
  // catalog does: the Type-typed entry whose title is the type's name.
  const docPath = entries.find((e) => e.type === 'Type' && e.title === sourceType)?.path ?? null;

  const hasValues = def.kind === 'select' || def.kind === 'multiselect' || def.kind === 'status';
  const hasConfig = def.kind === 'rollup' || def.kind === 'number' || def.kind === 'relation';

  const commitRename = () => {
    const next = draft.trim();
    if (locked || next === '' || humanize(def.name) === next) return;
    void (async () => {
      if (await renameFieldOnType(sourceType, def.name, next)) {
        const normalized = normalizeFieldName(next);
        onColumnsChange(
          columns.map((c) => (c.field === def.name ? { ...c, field: normalized } : c)),
        );
        onRenamed?.(normalized);
      }
    })();
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <span className="mb-1 block text-[11.5px] font-medium text-[var(--n-600)]">Name</span>
        {locked ? (
          <div className="flex items-center gap-1.5 px-1 text-[12.5px] text-[var(--n-600)]">
            <Icon name="lock" size={11} />
            {humanize(def.name)}
            <span className="text-[11px] text-[var(--n-400)]">Built-in</span>
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
            className="flex w-full items-center gap-2 rounded-[7px] border-0 bg-transparent px-1 py-1 text-left text-[12.5px] text-[var(--n-700)] hover:bg-[var(--n-50)]"
          >
            <Icon name="repeat-2" size={12} color="var(--n-500)" />
            <span className="min-w-0 flex-1">Type</span>
            <span className="flex items-center gap-1 text-[11px] text-[var(--n-400)]">
              {kindMeta(def.kind).label}
              <Icon name={changingKind ? 'chevron-down' : 'chevron-right'} size={11} />
            </span>
          </button>
          {changingKind && (
            <div className="mt-1 max-h-[200px] overflow-y-auto rounded-[7px] bg-[var(--n-25)] p-0.5">
              {CREATABLE_PROPERTY_KINDS.filter((k) => !k.computed).map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  data-testid={`change-type-${k.kind}`}
                  onClick={() => {
                    setChangingKind(false);
                    void changeFieldKind(sourceType, def.name, k.kind);
                  }}
                  className="flex w-full items-center gap-2 rounded-[6px] border-0 bg-transparent px-2 py-1 text-left text-[12.5px] text-[var(--n-700)] hover:bg-[var(--n-50)]"
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
        <div className="border-t border-[var(--n-100)] pt-1.5">
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
          ) : def.kind === 'relation' ? (
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
          onClick={() => {
            void (async () => {
              if (await removeFieldFromType(sourceType, def.name)) {
                onColumnsChange(columns.filter((c) => c.field !== def.name));
                onDeleted?.();
              }
            })();
          }}
          className="flex w-full items-center gap-2 rounded-[7px] border-0 border-t border-[var(--n-100)] bg-transparent px-1 py-1.5 text-left text-[12.5px] text-[var(--danger-600,#B3261E)] hover:bg-[var(--danger-50)]"
        >
          <Icon name="trash-2" size={13} />
          Delete property
        </button>
      )}
    </div>
  );
}
