import { useState } from 'react';
import { addPropertyToEntry } from '@/app/typeActions';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import type { Entry, Schema } from '@/engine/types';

/**
 * The property stack for one record: declared fields as editors, undeclared
 * frontmatter read-only, plus the add-property flyout. Extracted from
 * DetailPanel (M3) so the overlay panel and the split view's right-hand pane
 * share one code path.
 */
export function RecordProperties({ entry, schema }: { entry: Entry; schema: Schema }) {
  const [addingProp, setAddingProp] = useState(false);

  const typeDef = entry.type ? (schema.types.get(entry.type) ?? null) : null;
  const declared = typeDef?.fields ?? [];
  const declaredNames = new Set(declared.map((f) => f.name));
  const undeclared = [...Object.keys(entry.properties), ...Object.keys(entry.relationships)].filter(
    (k) => !declaredNames.has(k) && k !== 'type' && k !== 'key',
  );

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
        <div key={name} className="flex items-center gap-2">
          <span className="w-24 flex-none text-[12px] text-[var(--n-500)]">{humanize(name)}</span>
          <span className="text-[12.5px] text-[var(--n-700)]">
            {name in entry.relationships
              ? entry.relationships[name].join(', ')
              : String(entry.properties[name])}
          </span>
        </div>
      ))}
      {addingProp ? (
        <AddPropertyPanel
          existingNames={[...declared.map((f) => humanize(f.name)), ...undeclared.map(humanize)]}
          onAdd={(name, kind) => {
            void (async () => {
              if (await addPropertyToEntry(entry, name, kind)) setAddingProp(false);
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
