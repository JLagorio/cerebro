import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { CREATABLE_PROPERTY_KINDS } from '@/engine/properties';
import { typeStyle } from '@/engine/typeCatalog';
import type { FieldKind } from '@/engine/types';
import { useSchema } from '@/stores/vaultStore';

/** "Select", then "Select 2", "Select 3"… — kind-first adds must not collide
 * with a property that already exists (M3.1: a second Select silently failed
 * with "Property already exists"). */
function uniqueName(base: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i += 1) {
    if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }
  return base;
}

/** Relation creation config (M12.4): every relation names its data source. */
export interface RelationConfig {
  target: string;
  limit?: 1;
  /** Name of the derived reciprocal to declare on the target type; absent
   * means one-way. */
  reciprocalName?: string;
}

/**
 * The "+ Add property" flyout (M2.x, extracted M3): a name input over the
 * property-kind catalog. Shared by the doc Info tab, the detail panel, and
 * the type screen's Properties aside — the caller owns validation + writes.
 *
 * M12.4: picking Relation opens a second step instead of writing immediately
 * — a relation without a data source accepts anything, which is the old
 * world. The step asks for the target type, the limit, and optionally the
 * name of the two-way related property on the target.
 */
export function AddPropertyPanel({
  existingNames = [],
  ownerType = null,
  onAdd,
  onCancel,
}: {
  /** Names already on this type/record, so kind-first defaults stay unique. */
  existingNames?: string[];
  /** The type this property is being declared on — seeds the reciprocal's
   * default name; null on untyped docs (relation config hidden there). */
  ownerType?: string | null;
  /** Called with the raw typed name and picked kind; close on success. */
  onAdd: (name: string, kind: FieldKind, relation?: RelationConfig) => void;
  onCancel: () => void;
}) {
  const schema = useSchema();
  const [name, setName] = useState('');
  const [step, setStep] = useState<'catalog' | 'relation'>('catalog');
  const [target, setTarget] = useState<string | null>(null);
  const [single, setSingle] = useState(false);
  const [twoWay, setTwoWay] = useState(false);
  const [reciprocal, setReciprocal] = useState('');

  const targets = [...schema.types.keys()].filter((t) => t !== 'Type').sort();

  const pick = (kind: FieldKind, label: string) => {
    // A relation on a TYPE gets the enforced-config step. On an untyped doc
    // there is no schema to write, so it stays a plain frontmatter key.
    if (kind === 'relation' && ownerType !== null) {
      setStep('relation');
      return;
    }
    onAdd(name.trim() === '' ? uniqueName(label, existingNames) : name, kind);
  };

  const addRelation = () => {
    if (target === null) return;
    const finalName = name.trim() === '' ? uniqueName(target, existingNames) : name;
    onAdd(finalName, 'relation', {
      target,
      ...(single ? { limit: 1 as const } : {}),
      ...(twoWay
        ? {
            reciprocalName:
              reciprocal.trim() !== ''
                ? reciprocal
                : `related ${(ownerType ?? 'records').toLowerCase()}`,
          }
        : {}),
    });
  };

  if (step === 'relation') {
    return (
      <div
        data-testid="add-relation-panel"
        className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-[var(--n-200)] p-1.5"
      >
        <Input
          autoFocus
          ariaLabel="Property name"
          placeholder={target === null ? 'Relation name' : `Related ${target}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setStep('catalog');
          }}
          className="min-w-0"
          width="100%"
        />
        <span className="px-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
          Related to
        </span>
        <div className="max-h-[160px] overflow-y-auto">
          {targets.map((t) => {
            const style = typeStyle(t, schema);
            return (
              <button
                key={t}
                type="button"
                role="option"
                aria-selected={target === t}
                data-testid={`relation-target-${t}`}
                onClick={() => setTarget(t)}
                className={[
                  'flex w-full items-center gap-2 rounded-md border-0 px-1.5 py-[5px] text-left text-[12.5px]',
                  target === t
                    ? 'bg-[var(--cortex-50)] text-[var(--n-900)]'
                    : 'bg-transparent text-[var(--n-800)] hover:bg-[var(--n-50)]',
                ].join(' ')}
              >
                <Icon name={style.icon} size={13} color={style.color ?? 'var(--n-500)'} />
                <span className="min-w-0 flex-1 truncate">{t}</span>
                {target === t && <Icon name="check" size={13} color="var(--cortex-600)" />}
              </button>
            );
          })}
          {targets.length === 0 && (
            <p className="m-0 px-1.5 py-2 text-[12px] text-[var(--n-500)]">
              No types to relate to yet — create one first.
            </p>
          )}
        </div>
        <div className="flex items-center justify-between px-1 py-0.5">
          <span className="text-[12px] text-[var(--n-600)]">Limit to 1 record</span>
          <Switch ariaLabel="Limit to 1 record" checked={single} onChange={setSingle} />
        </div>
        <div className="flex items-center justify-between px-1 py-0.5">
          <span className="text-[12px] text-[var(--n-600)]">Add related property</span>
          <Switch
            ariaLabel="Add related property"
            checked={twoWay}
            onChange={setTwoWay}
            disabled={target === null}
          />
        </div>
        {twoWay && target !== null && (
          <Input
            ariaLabel="Related property name"
            placeholder={`Related ${(ownerType ?? 'records').toLowerCase()}`}
            value={reciprocal}
            onChange={(e) => setReciprocal(e.target.value)}
            className="min-w-0"
            width="100%"
          />
        )}
        <button
          type="button"
          data-testid="add-relation"
          disabled={target === null}
          onClick={addRelation}
          className="mt-0.5 rounded-md border-0 bg-[var(--cortex-600)] px-2 py-1.5 text-[12.5px] font-medium text-white hover:bg-[var(--cortex-700)] disabled:cursor-default disabled:opacity-40"
        >
          Add relation
        </button>
        <button
          type="button"
          onClick={() => setStep('catalog')}
          className="self-start rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-[var(--n-400)] hover:text-[var(--n-700)]"
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="add-property-panel"
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--n-200)] p-1.5"
    >
      <Input
        autoFocus
        ariaLabel="Property name"
        placeholder="Property name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim() !== '') onAdd(name, 'text');
          if (e.key === 'Escape') onCancel();
        }}
        className="min-w-0"
        width="100%"
      />
      <span className="px-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
        Type
      </span>
      <div className="max-h-[220px] overflow-y-auto">
        {/* Picking a kind with the name still blank names the property after
            the kind (Notion's flow) — the catalog is never disabled. */}
        {CREATABLE_PROPERTY_KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            data-testid={`property-kind-${k.kind}`}
            onClick={() => pick(k.kind, k.label)}
            className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-[5px] text-left text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
          >
            <Icon name={k.icon} size={13} color="var(--n-500)" />
            {k.label}
            {k.kind === 'relation' && ownerType !== null && (
              <span className="ml-auto inline-flex">
                <Icon name="chevron-right" size={12} color="var(--n-400)" />
              </span>
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="self-start rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-[var(--n-400)] hover:text-[var(--n-700)]"
      >
        Cancel
      </button>
    </div>
  );
}
