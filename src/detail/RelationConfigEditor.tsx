import { useState } from 'react';
import { Dropdown } from '@/components/ui/Dropdown';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { humanize } from '@/engine/schema';
import type { FieldDef, Schema } from '@/engine/types';

/**
 * Configure a relation field (M12.4): its target data source, its
 * cardinality, and its two-way related property.
 *
 * The derived reciprocal of a two-way pair (a relation with `from:`) is
 * configured from its OWNING side — here it renders a description of where
 * the data actually lives instead of controls that would fight it.
 */
export function RelationConfigEditor({
  typeName,
  def,
  schema,
  onChange,
  onAddReciprocal,
}: {
  typeName: string;
  def: FieldDef;
  schema: Schema;
  /** Writes `target` / `limit` onto the field spec (null deletes the key). */
  onChange: (config: { target?: string | null; limit?: 1 | null }) => void;
  /** Declares the derived reciprocal on the target type. */
  onAddReciprocal: (name: string) => void;
}) {
  const [reciprocalDraft, setReciprocalDraft] = useState(`related ${typeName.toLowerCase()}`);

  if (def.from !== undefined) {
    return (
      <p className="m-0 flex items-start gap-1.5 px-1 py-1 text-[12px] leading-relaxed text-[var(--n-500)]">
        <Icon name="arrow-left-right" size={12} style={{ marginTop: 2 }} />
        <span>
          Two-way relation: this is the derived side of{' '}
          <strong className="font-medium text-[var(--n-700)]">{humanize(def.from.field)}</strong> on{' '}
          <strong className="font-medium text-[var(--n-700)]">{def.from.type}</strong>. It stores
          nothing — the link lives there, and edits here write through.
        </span>
      </p>
    );
  }

  const types = [...schema.types.keys()].filter((t) => t !== 'Type').sort();
  const targetDef = def.target !== undefined ? schema.types.get(def.target) : undefined;
  const reciprocal =
    targetDef?.fields.find(
      (f) => f.kind === 'relation' && f.from?.type === typeName && f.from?.field === def.name,
    ) ?? null;
  // A person field is a relation with an avatar renderer (M16.13b), so it is
  // configured here too — and its unset state means something different: not
  // "any record", but "whoever this vault calls people", which the engine
  // derives from every person field's target (`peopleTypes`).
  const isPerson = def.kind === 'person';

  return (
    <div className="flex flex-col gap-1.5 py-0.5">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[12px] text-[var(--n-600)]">
          {isPerson ? 'People come from' : 'Related to'}
        </span>
        <Dropdown
          size="sm"
          label={isPerson ? 'People come from' : 'Related to'}
          options={[
            {
              value: 'none',
              label: isPerson ? 'This vault’s people' : 'Any record (unenforced)',
            },
            ...types.map((t) => ({ value: t, label: t })),
          ]}
          value={def.target ?? 'none'}
          onChange={(v) => onChange({ target: v === 'none' ? null : v })}
        />
      </div>
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[12px] text-[var(--n-600)]">
          Limit to 1 {isPerson ? 'person' : 'record'}
        </span>
        <Switch
          ariaLabel="Limit to 1 record"
          checked={def.limit === 1}
          onChange={(on) => onChange({ limit: on ? 1 : null })}
        />
      </div>
      <div className="flex items-center gap-2 px-1">
        <span className="flex-none text-[12px] text-[var(--n-600)]">Related property</span>
        {reciprocal !== null ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--n-700)]">
            <Icon name="arrow-left-right" size={11} color="var(--n-400)" />
            <span className="truncate">
              {humanize(reciprocal.name)} on {def.target}
            </span>
          </span>
        ) : def.target === undefined ? (
          <span className="text-[11.5px] text-[var(--n-400)]">Pick a target type first</span>
        ) : (
          <>
            <Input
              size="sm"
              ariaLabel="Related property name"
              value={reciprocalDraft}
              onChange={(e) => setReciprocalDraft(e.target.value)}
              className="min-w-0 flex-1"
            />
            <button
              type="button"
              data-testid="add-reciprocal"
              disabled={reciprocalDraft.trim() === ''}
              onClick={() => onAddReciprocal(reciprocalDraft)}
              className="flex-none rounded-md border border-[var(--n-200)] bg-transparent px-2 py-0.5 text-[11.5px] text-[var(--n-700)] hover:bg-[var(--n-50)] disabled:opacity-40"
            >
              Add on {def.target}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
