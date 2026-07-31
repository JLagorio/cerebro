import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { AddPropertyPanel, type RelationConfig } from '@/detail/AddPropertyPanel';
import { FixedBelowAnchor } from '@/detail/FieldPopover';
import { moveColumn, toggleColumn, type ColumnDef } from '@/engine/columns';
import { kindMeta } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import type { ColumnSpec, FieldDef } from '@/engine/types';

/**
 * Per-view columns (M3.4, reshaped M9.2): which of the type's properties this
 * view shows, in what order, and — new — a way to create a property that does
 * not exist yet.
 *
 * Writes `presentation.columns`, so the choice persists with the saved view.
 * Hiding sets `hidden` rather than removing the entry, so re-showing a column
 * returns it to its position instead of appending it to the end.
 */
export function PropertyVisibility({
  fields,
  columns,
  onChange,
  onAddProperty,
  canAddProperty = false,
  ownerType = null,
}: {
  /** Every property the collection's type declares. */
  fields: ColumnDef[];
  columns: ColumnSpec[];
  onChange: (next: ColumnSpec[]) => void;
  /** M9.2: creates the property on the source type, then adds the column.
   * M12.4: relations carry their config (target/limit/reciprocal). */
  onAddProperty?: (name: string, kind: FieldDef['kind'], relation?: RelationConfig) => void;
  /** False on typeless views — there is no single type to add a property to. */
  canAddProperty?: boolean;
  /** The source type — seeds the relation step's reciprocal name (M12.4). */
  ownerType?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const shown = new Set(columns.filter((c) => c.hidden !== true).map((c) => c.field));

  // Visible ones first (in column order), then declared-but-hidden ones.
  const ordered: ColumnDef[] = [
    ...columns
      .filter((c) => c.hidden !== true)
      .map((c) => fields.find((f) => f.name === c.field) ?? { name: c.field, kind: 'text' as const }),
    ...fields.filter((f) => !shown.has(f.name)),
  ];

  const visibleCount = shown.size;

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
          {visibleCount}
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
            <div className="w-[280px] rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-lg)]">
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
                      {/* A property whose kind differs across the types in a
                          mixed view: say so rather than letting a header imply
                          one shared shape. */}
                      {f.heterogeneous === true && (
                        <span
                          title="This property is declared with different kinds across the types in this view"
                          className="flex-none text-[var(--warn-500)]"
                        >
                          <Icon name="triangle-alert" size={11} />
                        </span>
                      )}
                      {on && (
                        <span className="hidden gap-0.5 group-hover:inline-flex">
                          <button
                            type="button"
                            aria-label={`Move ${humanize(f.name)} up`}
                            onClick={() => onChange(moveColumn(columns, f.name, -1))}
                            className="rounded border-0 bg-transparent p-0.5 text-[var(--n-400)] hover:text-[var(--n-800)]"
                          >
                            <Icon name="chevron-up" size={12} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${humanize(f.name)} down`}
                            onClick={() => onChange(moveColumn(columns, f.name, 1))}
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
                        onClick={() => onChange(toggleColumn(columns, f.name))}
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

              {/* M9.2: the Notion move — a column IS a property, so the place
                  you choose columns is the place you create one. */}
              {onAddProperty !== undefined && (
                <div className="mt-1 border-t border-[var(--n-100)] pt-1.5">
                  {adding ? (
                    <AddPropertyPanel
                      existingNames={fields.map((f) => humanize(f.name))}
                      ownerType={ownerType}
                      onAdd={(name, kind, relation) => {
                        onAddProperty(name, kind, relation);
                        setAdding(false);
                      }}
                      onCancel={() => setAdding(false)}
                    />
                  ) : (
                    <button
                      type="button"
                      data-testid="add-property-from-view"
                      disabled={!canAddProperty}
                      title={
                        canAddProperty
                          ? undefined
                          : 'This view lists more than one type, so there is no single type to add a property to.'
                      }
                      onClick={() => setAdding(true)}
                      className="w-full rounded-[7px] border-0 bg-transparent px-1.5 py-1 text-left text-[12.5px] text-[var(--n-500)] enabled:hover:bg-[var(--n-50)] enabled:hover:text-[var(--n-800)] disabled:cursor-default disabled:text-[var(--n-300)]"
                    >
                      + New property
                    </button>
                  )}
                </div>
              )}
            </div>
          </FixedBelowAnchor>
        </>
      )}
    </span>
  );
}
