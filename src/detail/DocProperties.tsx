import { useEffect, useState } from 'react';
import { Dropdown } from '@/components/ui/Dropdown';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import type { Entry, Schema } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const LABEL = 'w-24 flex-none text-[12px] text-[var(--n-500)]';

/** Undeclared scalar frontmatter: plain text editing. Numeric values stay
 * numeric when the draft still parses as a number. */
function UndeclaredRow({ entry, name }: { entry: Entry; name: string }) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const value = entry.properties[name];
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => {
    setDraft(String(value ?? ''));
  }, [value]);

  const commit = () => {
    if (draft === String(value ?? '')) return;
    const next =
      typeof value === 'number' && draft.trim() !== '' && !Number.isNaN(Number(draft))
        ? Number(draft)
        : draft;
    void patchFrontmatter(entry.path, { [name]: next });
  };

  return (
    <div className="group flex items-center gap-2">
      <span className={LABEL}>{humanize(name)}</span>
      <Input
        ariaLabel={humanize(name)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        width="100%"
      />
      <span className="hidden group-hover:inline-flex">
        <IconButton
          icon="x"
          label={`Remove ${humanize(name)}`}
          size="sm"
          onClick={() => void patchFrontmatter(entry.path, { [name]: null })}
        />
      </span>
    </div>
  );
}

/**
 * Info tab of the doc side panel (M2 Task 16, Tolaria Inspector pattern;
 * M2.x: embedded in the tabbed panel): assign a type, edit its declared
 * fields, manage loose frontmatter keys. Everything writes through
 * patchFrontmatter (optimistic, disk-first on rescan).
 */
export function DocProperties({ entry, schema }: { entry: Entry; schema: Schema }) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const toast = useUiStore((s) => s.toast);

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  const typeDef = entry.type !== null ? (schema.types.get(entry.type) ?? null) : null;
  const declared = typeDef?.fields ?? [];
  const declaredNames = new Set(declared.map((f) => f.name));
  const undeclaredScalars = Object.keys(entry.properties).filter(
    (k) => !declaredNames.has(k) && k !== 'type',
  );
  const undeclaredRelations = Object.keys(entry.relationships).filter(
    (k) => !declaredNames.has(k),
  );

  const typeOptions = [
    { value: 'none', label: 'None' },
    ...[...schema.types.keys()].sort().map((t) => ({ value: t, label: t })),
  ];

  const addProperty = () => {
    const name = newName.trim();
    if (name === '') return;
    if (name === 'type' || name in entry.properties || name in entry.relationships) {
      toast('Property already exists');
      return;
    }
    void patchFrontmatter(entry.path, { [name]: '' });
    setNewName('');
    setAdding(false);
  };

  return (
    <div data-testid="doc-properties" aria-label="Document properties" className="pt-1">
      <div className="flex flex-col gap-[7px]">
        <div className="flex items-center gap-2">
          <span className={LABEL}>Type</span>
          <Dropdown
            size="sm"
            label="Type"
            options={typeOptions}
            value={entry.type ?? 'none'}
            onChange={(v) =>
              void patchFrontmatter(entry.path, { type: v === 'none' ? null : v })
            }
          />
        </div>
        {declared.map((f) => (
          <div key={f.name} className="flex items-center gap-2">
            <span className={LABEL}>{humanize(f.name)}</span>
            <FieldEditor entry={entry} def={f} schema={schema} />
          </div>
        ))}
        {undeclaredScalars.map((name) => (
          <UndeclaredRow key={name} entry={entry} name={name} />
        ))}
        {undeclaredRelations.map((name) => (
          <div key={name} className="flex items-center gap-2">
            <span className={LABEL}>{humanize(name)}</span>
            <span className="text-[12.5px] text-[var(--n-700)]">
              {entry.relationships[name].join(', ')}
            </span>
          </div>
        ))}
        {adding ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              ariaLabel="Property name"
              placeholder="Property name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => {
                if (newName.trim() === '') setAdding(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addProperty();
                if (e.key === 'Escape') {
                  setNewName('');
                  setAdding(false);
                }
              }}
              width="100%"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-0.5 self-start rounded-md border-0 bg-transparent px-1 py-0.5 text-[12px] text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
          >
            + Add property
          </button>
        )}
      </div>
      <div className="mt-4 border-t border-[var(--n-100)] pt-2 text-[10px] text-[var(--n-400)] [font-family:var(--font-mono)]">
        <div>Created {entry.createdAt.slice(0, 10)}</div>
        <div>Modified {entry.modifiedAt.slice(0, 10)}</div>
      </div>
    </div>
  );
}
