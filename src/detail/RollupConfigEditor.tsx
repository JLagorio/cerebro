import { Dropdown } from '@/components/ui/Dropdown';
import { humanize } from '@/engine/schema';
import { CORRESPONDENCE_PROPERTIES } from '@/engine/correspondents';
import {
  FIELD_FORMATS,
  ROLLUP_CALCS,
  relationTargetFor,
  rollupCalcMeta,
} from '@/engine/properties';
import { useVaultStore } from '@/stores/vaultStore';
import type { FieldDef, Schema } from '@/engine/types';

const NONE = '__none__';
const MAIL = '__mail__';
const REVERSE = '__reverse__';

const row = 'flex items-center gap-2';
const label = 'w-[86px] flex-none text-xs text-n-500';

/**
 * Rollup wiring: aggregate a property on related records or cached mail. A
 * declared reverse source already names the records linking here; a forward
 * source picks one of this type's relation fields.
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
  const own = schema.types.get(typeName);
  const ownFields = own?.fields ?? [];
  const mail = def.source === 'correspondence';
  const offersMail = own?.emailDomain != null || ownFields.some((field) => field.kind === 'email');
  const relationFields = ownFields.filter((f) => f.kind === 'relation' || f.kind === 'person');

  const relationDef = relationFields.find((f) => f.name === def.relation) ?? null;
  // Was `kind === 'person' ? 'Person' : …` (M16.13b). A rollup through a
  // person field offered the fields of a type this vault might not have, and
  // silently listed none for a vault whose people are `Teammate`s.
  const targetType =
    def.from?.type ??
    (relationDef === null ? null : relationTargetFor(relationDef, entries, typeName));
  const targetFields = targetType === null ? [] : (schema.types.get(targetType)?.fields ?? []);
  const calc = rollupCalcMeta(def.calculate);
  const percentDone = calc.calc === 'percent_done';
  const offeredFields = mail
    ? CORRESPONDENCE_PROPERTIES.map((name) => ({ name }))
    : percentDone
      ? targetFields.filter((field) => field.kind === 'status' || field.kind === 'checkbox')
      : targetFields;

  return (
    <div className="flex flex-col gap-2">
      {def.from === undefined || mail || offersMail ? (
        <div className={row}>
          <span className={label}>Follow</span>
          <Dropdown
            size="sm"
            label="Relation to follow"
            width={200}
            options={[
              { value: NONE, label: 'Pick a relation…' },
              ...(def.from === undefined || mail
                ? []
                : [
                    {
                      value: REVERSE,
                      label: `${def.from.type} → ${humanize(def.from.field)}`,
                    },
                  ]),
              ...(offersMail || mail ? [{ value: MAIL, label: 'Cached mail' }] : []),
              ...relationFields.map((f) => ({
                value: f.name,
                label: `${humanize(f.name)}${f.target !== undefined ? ` → ${f.target}` : ''}`,
              })),
            ]}
            value={mail ? MAIL : def.from !== undefined ? REVERSE : (def.relation ?? NONE)}
            onChange={(v) => {
              if (v === REVERSE) return;
              onChange(
                v === MAIL
                  ? {
                      source: 'correspondence',
                      relation: null,
                      from: null,
                      property: 'last_message_at',
                      calculate: 'latest',
                    }
                  : { source: null, from: null, relation: v === NONE ? null : v },
              );
            }}
          />
        </div>
      ) : (
        <p className="m-0 text-xs leading-4 text-n-500">
          {def.from.type} records linking here through {humanize(def.from.field)}.
        </p>
      )}
      {!mail && !offersMail && def.from === undefined && relationFields.length === 0 && (
        <p className="m-0 pl-[94px] text-xs leading-4 text-n-400">
          This type has no relation property yet — add one first, then point the rollup at it.
        </p>
      )}
      <div className={row}>
        <span className={label}>Calculate</span>
        <Dropdown
          size="sm"
          label="Calculation"
          width={200}
          options={ROLLUP_CALCS.filter(
            (c) => !mail || ['latest', 'earliest', 'count'].includes(c.calc),
          ).map((c) => ({ value: c.calc, label: c.label }))}
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
                  !mail && relationDef === null && def.from === undefined
                    ? 'Pick a relation first'
                    : !mail && targetType === null
                      ? 'That relation targets any record'
                      : 'Pick a property…',
              },
              ...offeredFields.map((f) => ({ value: f.name, label: humanize(f.name) })),
            ]}
            value={def.property ?? NONE}
            onChange={(v) => onChange({ property: v === NONE ? null : v })}
          />
        </div>
      )}
      {percentDone && targetType !== null && offeredFields.length === 0 && (
        <p className="m-0 pl-[94px] text-xs leading-4 text-n-400">
          Percent done needs a status or checkbox property on {targetType}.
        </p>
      )}
      {!mail && calc.needsProperty && relationDef !== null && targetType === null && (
        <p className="m-0 pl-[94px] text-xs leading-4 text-n-400">
          Give <strong className="font-medium">{humanize(relationDef.name)}</strong> a target type
          and its properties will be listed here.
        </p>
      )}
      {(!mail || def.calculate === 'count') && <FormatRow def={def} onChange={onChange} />}
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
