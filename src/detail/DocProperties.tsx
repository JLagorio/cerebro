import { useEffect, useState } from 'react';
import { addPropertyToEntry, normalizeFieldName } from '@/app/typeActions';
import { useOpenPath } from '@/app/useOpenPath';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import { visibleProperties } from '@/engine/properties';
import { typeStyle } from '@/engine/typeCatalog';
import type { Entry, FieldKind, Schema } from '@/engine/types';
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
    <div className="group flex min-w-0 items-center gap-2">
      <span className={LABEL}>{humanize(name)}</span>
      <Input
        ariaLabel={humanize(name)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className="min-w-0 flex-1"
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

  const typeDef = entry.type !== null ? (schema.types.get(entry.type) ?? null) : null;
  const declared = typeDef?.fields ?? [];
  const declaredNames = new Set(declared.map((f) => f.name));
  const undeclaredScalars = visibleProperties(Object.keys(entry.properties)).filter(
    (k) => !declaredNames.has(k) && k !== 'type',
  );
  const undeclaredRelations = visibleProperties(Object.keys(entry.relationships)).filter(
    (k) => !declaredNames.has(k),
  );

  const [converting, setConverting] = useState(false);
  const openPath = useOpenPath();

  // M12.1: a doc's type is not a dropdown. Docs are docs — the only way out
  // is the explicit Convert action, which says what it does to the note.
  const convertTo = (typeName: string) => {
    setConverting(false);
    void (async () => {
      await patchFrontmatter(entry.path, { type: typeName });
      toast(`Now a ${typeName} record — this note left Docs`);
      openPath(entry.path);
    })();
  };
  const convertTargets = [...schema.types.keys()].filter((t) => t !== 'Type').sort();

  // Adding a property to a TYPED doc extends the type's YAML schema (the
  // properties engine's source of truth); untyped docs get plain
  // frontmatter seeded by kind (M2.x). M3: routed through typeActions so
  // the type screen and the panels share one hardened write path.
  const addProperty = (
    rawName: string,
    kind: FieldKind,
    relation?: { target: string; limit?: 1; reciprocalName?: string },
  ) => {
    const name = normalizeFieldName(rawName);
    if (name === '') return;
    if (declaredNames.has(name)) {
      toast('Property already exists');
      return;
    }
    void (async () => {
      if (await addPropertyToEntry(entry, name, kind, relation)) {
        if (entry.type !== null) toast(`Added "${humanize(name)}" to every ${entry.type}`);
        setAdding(false);
      }
    })();
  };

  return (
    <div data-testid="doc-properties" aria-label="Document properties" className="pt-1">
      <div className="flex flex-col gap-[7px]">
        <div className="flex items-center gap-2">
          <span className={LABEL}>Type</span>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--n-700)]">
            <Icon
              name={entry.type === null ? 'file-text' : typeStyle(entry.type, schema).icon}
              size={13}
              color={
                entry.type === null
                  ? 'var(--n-400)'
                  : (typeStyle(entry.type, schema).color ?? 'var(--n-400)')
              }
            />
            {entry.type ?? 'Doc'}
          </span>
          {entry.type === null && (
            <button
              type="button"
              onClick={() => setConverting(true)}
              className="rounded-md border-0 bg-transparent px-1 py-0.5 text-[11px] text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
            >
              Convert to record…
            </button>
          )}
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
          <AddPropertyPanel
            existingNames={[
              ...declared.map((f) => humanize(f.name)),
              ...undeclaredScalars.map(humanize),
              ...undeclaredRelations.map(humanize),
            ]}
            ownerType={entry.type}
            onAdd={addProperty}
            onCancel={() => setAdding(false)}
          />
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
      {converting && (
        <Dialog open onClose={() => setConverting(false)} title="Convert to record" width={420}>
          <p className="mb-2 text-[12px] leading-relaxed text-[var(--n-500)]">
            A record belongs to a type: it opens in the record panel, appears in that type&apos;s
            views and Lists, and leaves the Docs tree. Its text and properties come along unchanged.
          </p>
          <div
            role="listbox"
            aria-label="Convert to type"
            className="flex max-h-[300px] flex-col overflow-y-auto"
          >
            {convertTargets.map((t) => {
              const style = typeStyle(t, schema);
              return (
                <button
                  key={t}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => convertTo(t)}
                  className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-[var(--n-50)]"
                >
                  <span
                    className="inline-flex flex-none"
                    style={{ color: style.color ?? 'var(--n-400)' }}
                  >
                    <Icon name={style.icon} size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--n-900)]">
                    {t}
                  </span>
                </button>
              );
            })}
            {convertTargets.length === 0 && (
              <div className="px-2.5 py-4 text-[12px] text-[var(--n-500)]">
                No types yet — create one from the Types section of the sidebar first.
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
