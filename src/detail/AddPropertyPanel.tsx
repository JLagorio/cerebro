import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { CREATABLE_PROPERTY_KINDS } from '@/engine/properties';
import type { FieldKind } from '@/engine/types';

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

/**
 * The "+ Add property" flyout (M2.x, extracted M3): a name input over the
 * property-kind catalog. Shared by the doc Info tab, the detail panel, and
 * the type screen's Properties tab — the caller owns validation + writes.
 */
export function AddPropertyPanel({
  existingNames = [],
  onAdd,
  onCancel,
}: {
  /** Names already on this type/record, so kind-first defaults stay unique. */
  existingNames?: string[];
  /** Called with the raw typed name and picked kind; close on success. */
  onAdd: (name: string, kind: FieldKind) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');

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
            onClick={() =>
              onAdd(name.trim() === '' ? uniqueName(k.label, existingNames) : name, k.kind)
            }
            className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-[5px] text-left text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
          >
            <Icon name={k.icon} size={13} color="var(--n-500)" />
            {k.label}
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
