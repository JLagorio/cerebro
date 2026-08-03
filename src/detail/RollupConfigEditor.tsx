import { Dropdown } from '@/components/ui/Dropdown';
import { humanize } from '@/engine/schema';
import {
  FIELD_FORMATS,
  ROLLUP_CALCS,
  relationTargetFor,
  rollupCalcMeta,
} from '@/engine/properties';
import { useVaultStore } from '@/stores/vaultStore';
import type { FieldDef, Schema } from '@/engine/types';

const NONE = '__none__';

const row = 'flex items-center gap-2';
const label = 'w-[86px] flex-none text-[11.5px] text-n-500';

/**
 * Rollup wiring (M3.4): follow one of this type's relation fields, read a
 * property off the related records, aggregate it. Before this existed a
 * Rollup property could be created but never configured — it displayed `0`
 * forever because `relation` was empty.
 */
export function RollupConfigEditor({
  typeName,
  def,
  schema,
  onChange,
}: {
  typeName: string;
  def: FieldDef;
  schema: Schema;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const ownFields = schema.types.get(typeName)?.fields ?? [];
  const relationFields = ownFields.filter((f) => f.kind === 'relation' || f.kind === 'person');

  const relationDef = relationFields.find((f) => f.name === def.relation) ?? null;
  // Was `kind === 'person' ? 'Person' : …` (M16.13b). A rollup through a
  // person field offered the fields of a type this vault might not have, and
  // silently listed none for a vault whose people are `Teammate`s.
  const targetType =
    relationDef === null ? null : relationTargetFor(relationDef, entries, typeName);
  const targetFields = targetType === null ? [] : (schema.types.get(targetType)?.fields ?? []);
  const calc = rollupCalcMeta(def.calculate);

  return (
    <div className="flex flex-col gap-2">
      <div className={row}>
        <span className={label}>Follow</span>
        <Dropdown
          size="sm"
          label="Relation to follow"
          width={200}
          options={[
            { value: NONE, label: 'Pick a relation…' },
            ...relationFields.map((f) => ({
              value: f.name,
              label: `${humanize(f.name)}${f.target !== undefined ? ` → ${f.target}` : ''}`,
            })),
          ]}
          value={def.relation ?? NONE}
          onChange={(v) => onChange({ relation: v === NONE ? null : v })}
        />
      </div>
      {relationFields.length === 0 && (
        <p className="m-0 pl-[94px] text-[11.5px] leading-4 text-n-400">
          This type has no relation property yet — add one first, then point the rollup at it.
        </p>
      )}
      <div className={row}>
        <span className={label}>Calculate</span>
        <Dropdown
          size="sm"
          label="Calculation"
          width={200}
          options={ROLLUP_CALCS.map((c) => ({ value: c.calc, label: c.label }))}
          value={def.calculate ?? 'count'}
          onChange={(v) => onChange({ calculate: v })}
        />
      </div>
      {calc.needsProperty && (
        <div className={row}>
          <span className={label}>Of property</span>
          <Dropdown
            size="sm"
            label="Property to aggregate"
            width={200}
            options={[
              {
                value: NONE,
                label:
                  relationDef === null
                    ? 'Pick a relation first'
                    : targetType === null
                      ? 'That relation targets any record'
                      : 'Pick a property…',
              },
              ...targetFields.map((f) => ({ value: f.name, label: humanize(f.name) })),
            ]}
            value={def.property ?? NONE}
            onChange={(v) => onChange({ property: v === NONE ? null : v })}
          />
        </div>
      )}
      {calc.needsProperty && relationDef !== null && targetType === null && (
        <p className="m-0 pl-[94px] text-[11.5px] leading-4 text-n-400">
          Give <strong className="font-medium">{humanize(relationDef.name)}</strong> a target type
          and its properties will be listed here.
        </p>
      )}
      <FormatRow def={def} onChange={onChange} />
    </div>
  );
}

/** Display format for any numeric value — rollups and plain number fields. */
export function FormatRow({
  def,
  onChange,
}: {
  def: FieldDef;
  onChange: (config: Record<string, unknown>) => void;
}) {
  return (
    <div className={row}>
      <span className={label}>Show as</span>
      <Dropdown
        size="sm"
        label="Display format"
        width={200}
        options={FIELD_FORMATS.map((f) => ({ value: f.format, label: f.label }))}
        value={def.format ?? 'plain'}
        onChange={(v) => onChange({ format: v === 'plain' ? null : v })}
      />
      <Dropdown
        size="sm"
        label="Decimal places"
        width={116}
        options={[0, 1, 2, 3].map((n) => ({ value: String(n), label: `${n} decimals` }))}
        value={String(def.precision ?? 2)}
        onChange={(v) => onChange({ precision: Number(v) })}
      />
    </div>
  );
}
