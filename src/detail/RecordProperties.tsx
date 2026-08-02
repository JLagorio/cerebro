import { useState } from 'react';
import { addPropertyToEntry } from '@/app/typeActions';
import { IconButton } from '@/components/ui/IconButton';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import { visibleProperties } from '@/engine/properties';
import type { Entry, Schema } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';

/** Readable text for a key the type does not declare. `properties` holds
 * `Scalar | Scalar[]` and, after a field is dropped from a type, can hold
 * object-shaped leftovers (a daterange's {start, end}) — `String(value)`
 * turned those into "[object Object]". */
function undeclaredDisplay(entry: Entry, name: string): string {
  if (name in entry.relationships) return entry.relationships[name].join(', ');
  const value = entry.properties[name];
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The property stack for one record: declared fields as editors, undeclared
 * frontmatter read-only, plus the add-property flyout. Extracted from
 * DetailPanel (M3) so the overlay panel and the split view's right-hand pane
 * share one code path.
 */
export function RecordProperties({ entry, schema }: { entry: Entry; schema: Schema }) {
  const [addingProp, setAddingProp] = useState(false);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);

  const typeDef = entry.type ? (schema.types.get(entry.type) ?? null) : null;
  const declared = typeDef?.fields ?? [];
  const declaredNames = new Set(declared.map((f) => f.name));
  const undeclared = visibleProperties([
    ...Object.keys(entry.properties),
    ...Object.keys(entry.relationships),
  ]).filter((k) => !declaredNames.has(k) && k !== 'type' && k !== 'key');

  return (
    <div className="mb-4 flex flex-col gap-[7px]">
      {declared.map((f) => (
        // items-start + a flexible value column: multi-value fields (people,
        // relations) wrap onto several lines and must not be squeezed into a
        // content-width box beside the label.
        <div key={f.name} className="flex min-w-0 items-start gap-2">
          <span className="w-24 flex-none pt-[3px] text-[12px] text-[var(--n-500)]">
            {humanize(f.name)}
          </span>
          <div className="min-w-0 flex-1">
            <FieldEditor entry={entry} def={f} schema={schema} />
          </div>
        </div>
      ))}
      {undeclared.map((name) => (
        // A key the type no longer declares is still the user's data. It used
        // to render `String(value)` — "[object Object]" for a leftover
        // daterange — inside a fixed-width row, with no way to remove it from
        // the panel at all. Now it reads, wraps, and can be dropped.
        <div key={name} className="group flex min-w-0 items-start gap-2">
          <span className="w-24 flex-none truncate pt-[3px] text-[12px] text-[var(--n-500)]">
            {humanize(name)}
          </span>
          <div className="min-w-0 flex-1">
            <span className="block text-[12.5px] text-[var(--n-700)] [overflow-wrap:anywhere]">
              {undeclaredDisplay(entry, name)}
            </span>
          </div>
          <span className="inline-flex flex-none opacity-0 focus-within:opacity-100 group-hover:opacity-100">
            <IconButton
              icon="x"
              label={`Remove ${humanize(name)}`}
              size="sm"
              onClick={() => void patchFrontmatter(entry.path, { [name]: null })}
            />
          </span>
        </div>
      ))}
      {addingProp ? (
        <AddPropertyPanel
          existingNames={[...declared.map((f) => humanize(f.name)), ...undeclared.map(humanize)]}
          ownerType={entry.type}
          onAdd={(name, kind, relation) => {
            void (async () => {
              if (await addPropertyToEntry(entry, name, kind, relation)) setAddingProp(false);
            })();
          }}
          onCancel={() => setAddingProp(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAddingProp(true)}
          className="mt-0.5 self-start rounded-md border-0 bg-transparent px-1 py-0.5 text-[12px] text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
        >
          + Add property
        </button>
      )}
    </div>
  );
}
