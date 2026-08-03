import { useMemo, useState } from 'react';
import { applyAdoption, convertSummary } from '@/app/adoptActions';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { analyzeVault } from '@/engine/adopt';
import { kindMeta } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import { typeStyle } from '@/engine/typeCatalog';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

const keyOf = (typeName: string, fieldName: string) => `${typeName}\0${fieldName}`;

/**
 * The adoption wizard (M12.6): open an existing vault — an Obsidian vault
 * with years of freeform frontmatter — and cross the gap to declared types
 * in one reviewed pass. The analysis proposes; every row here is a decision
 * the user makes; Apply executes exactly what stayed checked. Idempotent by
 * construction: a fully adopted vault proposes nothing.
 */
export function AdoptSchemaDialog({ onClose }: { onClose: () => void }) {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const proposals = useMemo(() => analyzeVault(entries, schema), [entries, schema]);

  const [active, setActive] = useState(0);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const included = (typeName: string, fieldName: string) =>
    !excluded.has(keyOf(typeName, fieldName));
  const toggle = (typeName: string, fieldName: string) => {
    const key = keyOf(typeName, fieldName);
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const apply = () => {
    setApplying(true);
    void (async () => {
      await applyAdoption(proposals, included);
      setApplying(false);
      onClose();
    })();
  };

  const fieldCount = proposals.reduce(
    (sum, p) => sum + p.fields.filter((f) => included(p.name, f.name)).length,
    0,
  );

  if (proposals.length === 0) {
    return (
      <Dialog open onClose={onClose} title="Adopt vault schema" width={480}>
        <div className="flex items-start gap-2.5 py-2">
          <Icon name="badge-check" size={18} color="var(--success-500)" />
          <p className="m-0 text-[13px] leading-relaxed text-n-600">
            Nothing to adopt. Every type in this vault is declared, and every stored value fits its
            declared kind.
          </p>
        </div>
      </Dialog>
    );
  }

  const current = proposals[Math.min(active, proposals.length - 1)];

  return (
    <Dialog
      open
      onClose={onClose}
      title="Adopt vault schema"
      width={760}
      primaryAction={{
        label: applying
          ? 'Adopting…'
          : `Adopt ${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}`,
        onClick: apply,
        disabled: applying,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <p className="m-0 mb-3 text-[12.5px] leading-relaxed text-n-500">
        These types were found in frontmatter without a full declaration. Adopting writes a Type doc
        per type, declares the checked fields with the inferred kinds, and converts stored values
        that don&apos;t fit — or clears the ones with no honest reading. Records themselves stay
        where they are.
      </p>
      <div className="flex min-h-0 gap-3" style={{ height: 380 }}>
        <div className="flex w-[200px] flex-none flex-col gap-px overflow-y-auto rounded-[10px] border border-n-200 p-1">
          {proposals.map((p, i) => {
            const style = typeStyle(p.name, schema);
            return (
              <button
                key={p.name}
                type="button"
                data-testid={`adopt-type-${p.name}`}
                aria-selected={i === active}
                onClick={() => setActive(i)}
                className={[
                  'flex items-center gap-2 rounded-[7px] border-0 px-2 py-1.5 text-left',
                  i === active ? 'bg-n-50' : 'bg-transparent hover:bg-n-25',
                ].join(' ')}
              >
                <Icon name={style.icon} size={13} color={style.color ?? 'var(--n-500)'} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-n-900">{p.name}</span>
                <span className="flex-none [font-family:var(--font-mono)] text-[10.5px] text-n-400">
                  {p.records}
                </span>
                <span
                  className={[
                    'flex-none rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.05em]',
                    p.docPath === null ? 'bg-cortex-50 text-cortex-700' : 'bg-n-50 text-n-500',
                  ].join(' ')}
                >
                  {p.docPath === null ? 'new' : 'update'}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-y-auto rounded-[10px] border border-n-200 p-2">
          {current.fields.map((f) => {
            const on = included(current.name, f.name);
            const note = convertSummary(f);
            return (
              <div
                key={f.name}
                data-testid="adopt-field-row"
                className="flex items-start gap-2 rounded-[8px] px-1.5 py-1.5 hover:bg-n-25"
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={`Include ${humanize(f.name)}`}
                  onClick={() => toggle(current.name, f.name)}
                  className={[
                    'mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-[5px] border',
                    on
                      ? // text-inverse, never text-white: index.css resets the stock palette, so
                        // `text-white` emits no CSS and the check inherited near-black on blue (M15).
                        'border-cortex-500 bg-cortex-500 text-inverse'
                      : 'border-n-300 bg-n-0',
                  ].join(' ')}
                >
                  {on && <Icon name="check" size={11} />}
                </button>
                <Icon
                  name={kindMeta(f.kind).icon}
                  size={13}
                  color="var(--n-500)"
                  style={{ marginTop: 3 }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-n-900">{humanize(f.name)}</span>
                    <span className="text-[11px] text-n-400">
                      {kindMeta(f.kind).label}
                      {f.kind === 'relation' && f.target !== null && ` → ${f.target}`}
                      {f.declared && ' · declared'}
                    </span>
                    <span className="flex-1" />
                    <span className="[font-family:var(--font-mono)] text-[10.5px] text-n-400">
                      {Math.round(f.coverage * 100)}%
                    </span>
                  </div>
                  {f.samples.length > 0 && (
                    <div className="truncate text-[11.5px] text-n-500">{f.samples.join(' · ')}</div>
                  )}
                  {note !== null && (
                    <div className="mt-0.5 inline-flex items-center gap-1 rounded-[5px] bg-warn-50 px-1.5 py-px text-[10.5px] text-warn-700">
                      <Icon name="wand-sparkles" size={10} />
                      {note}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {current.fields.length === 0 && (
            <p className="m-0 px-2 py-4 text-[12.5px] text-n-500">
              No fields to declare — adopting simply writes the Type doc so “{current.name}” stops
              being a ghost.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
