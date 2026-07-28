import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { FixedBelowAnchor } from '@/detail/FieldPopover';
import { kindMeta } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import type { FieldDef } from '@/engine/types';

/**
 * Per-view property visibility (M3.4): which of the type's properties this
 * view shows, and in what order. Writes `presentation.visibleFields`, so the
 * choice persists with the saved view rather than being a global default.
 */
export function PropertyVisibility({
  fields,
  visibleFields,
  onChange,
}: {
  /** Every property the collection's type declares. */
  fields: FieldDef[];
  visibleFields: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = new Set(visibleFields);

  const toggle = (name: string) => {
    // Toggling ON appends, so the column order follows the order you enabled
    // them — matches how the table renders left to right.
    onChange(shown.has(name) ? visibleFields.filter((f) => f !== name) : [...visibleFields, name]);
  };

  const move = (name: string, delta: number) => {
    const i = visibleFields.indexOf(name);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= visibleFields.length) return;
    const next = [...visibleFields];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  // Visible ones first (in their column order), then the rest to switch on.
  const ordered = [
    ...visibleFields
      .map((name) => fields.find((f) => f.name === name) ?? { name, kind: 'text' as const })
      .filter(Boolean),
    ...fields.filter((f) => !shown.has(f.name)),
  ];

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        data-testid="property-visibility"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--n-300)] bg-[var(--n-0)] px-2 text-[12.5px] text-[var(--n-700)] hover:border-[var(--n-400)]"
      >
        <Icon name="sliders-horizontal" size={13} color="var(--n-500)" />
        Properties
        <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
          {visibleFields.length}
        </span>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close properties"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
          />
          <FixedBelowAnchor>
            <div className="w-[268px] rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-lg)]">
              <div className="px-1.5 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
                Shown in this view
              </div>
              <div className="max-h-[300px] overflow-y-auto">
                {ordered.map((f) => {
                  const on = shown.has(f.name);
                  return (
                    <div
                      key={f.name}
                      className="group flex items-center gap-1.5 rounded-[7px] px-1.5 py-1 hover:bg-[var(--n-50)]"
                    >
                      <Icon name={kindMeta(f.kind).icon} size={12} color="var(--n-400)" />
                      <span
                        className={[
                          'min-w-0 flex-1 truncate text-[12.5px]',
                          on ? 'text-[var(--n-800)]' : 'text-[var(--n-400)]',
                        ].join(' ')}
                      >
                        {humanize(f.name)}
                      </span>
                      {on && (
                        <span className="hidden gap-0.5 group-hover:inline-flex">
                          <button
                            type="button"
                            aria-label={`Move ${humanize(f.name)} up`}
                            onClick={() => move(f.name, -1)}
                            className="rounded border-0 bg-transparent p-0.5 text-[var(--n-400)] hover:text-[var(--n-800)]"
                          >
                            <Icon name="chevron-up" size={12} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${humanize(f.name)} down`}
                            onClick={() => move(f.name, 1)}
                            className="rounded border-0 bg-transparent p-0.5 text-[var(--n-400)] hover:text-[var(--n-800)]"
                          >
                            <Icon name="chevron-down" size={12} />
                          </button>
                        </span>
                      )}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={`${on ? 'Hide' : 'Show'} ${humanize(f.name)}`}
                        onClick={() => toggle(f.name)}
                        className="inline-flex h-[18px] w-[30px] flex-none items-center rounded-full border-0 p-0 transition-colors"
                        style={{ background: on ? 'var(--cortex-500)' : 'var(--n-200)' }}
                      >
                        <span
                          className="h-3.5 w-3.5 rounded-full bg-white transition-transform"
                          style={{ transform: `translateX(${on ? 14 : 2}px)` }}
                        />
                      </button>
                    </div>
                  );
                })}
                {ordered.length === 0 && (
                  <div className="p-2 text-[12px] text-[var(--n-400)]">
                    This type declares no properties yet.
                  </div>
                )}
              </div>
            </div>
          </FixedBelowAnchor>
        </>
      )}
    </span>
  );
}
