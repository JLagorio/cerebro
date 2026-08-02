import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';

/**
 * Fixed-position wrapper that pins its children just below the nearest
 * `relative` trigger wrapper and clamps them inside the viewport. Escapes
 * overflow containers (the doc side panel scrolls), which plain `absolute`
 * popovers cannot.
 */
export function FixedBelowAnchor({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const anchor = node.parentElement?.getBoundingClientRect();
    const self = node.getBoundingClientRect();
    if (anchor === undefined) return;
    setPos({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - self.width - 8)),
      top: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - self.height - 8)),
    });
  }, []);
  return (
    <div
      ref={ref}
      className="fixed z-50"
      style={
        pos === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: pos.left, top: pos.top }
      }
    >
      {/* Animated on an inner wrapper so the entrance transform never skews
          the measurement above (M12.8). */}
      <div className="cb-menu-in">{children}</div>
    </div>
  );
}

export interface FieldPopoverOption {
  id: string;
  label: string;
  color: string | null;
  hollow?: boolean;
}

export interface FieldPopoverProps {
  options: FieldPopoverOption[];
  activeId?: string | null;
  /** Multi-value fields (multi-select, person, relation): every selected id.
   * Set this and the popover toggles instead of picking-and-closing. */
  activeIds?: string[];
  /** show a title-filter input (person/relation pickers) */
  searchable?: boolean;
  /** Offer "Create <query>" when the typed text matches no option. */
  onCreate?: (label: string) => void;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** Anchored option popover; render inside a `relative` wrapper next to its trigger. */
export function FieldPopover({
  options,
  activeId,
  activeIds,
  searchable,
  onCreate,
  onPick,
  onClose,
}: FieldPopoverProps) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const visible =
    trimmed === ''
      ? options
      : options.filter((o) => o.label.toLowerCase().includes(trimmed.toLowerCase()));
  // Multi mode keeps the popover open so several values land in one visit.
  const multi = activeIds !== undefined;
  const selected = new Set(activeIds ?? (activeId != null ? [activeId] : []));
  const canCreate =
    onCreate !== undefined &&
    trimmed !== '' &&
    !options.some((o) => o.label.toLowerCase() === trimmed.toLowerCase());

  return (
    <>
      <button
        type="button"
        aria-label="Close popover"
        onClick={onClose}
        onWheel={onClose}
        className="fixed inset-0 z-40 cursor-default bg-transparent"
      />
      <FixedBelowAnchor>
        <div
          role="listbox"
          className="w-60 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-lg)]"
        >
          {searchable && (
            <div className="pb-1.5">
              <Input
                autoFocus
                size="sm"
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                width="100%"
              />
            </div>
          )}
          <div className="max-h-[264px] overflow-y-auto">
            {visible.map((o) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={selected.has(o.id)}
                onClick={() => {
                  onPick(o.id);
                  if (!multi) onClose();
                }}
                className="flex w-full items-center gap-2 rounded-[7px] px-2 py-[7px] text-left text-[13px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
              >
                <span
                  className="box-border h-2 w-2 flex-none rounded-full"
                  style={
                    o.hollow || !o.color
                      ? { border: `1.5px solid ${o.color ?? 'var(--n-400)'}` }
                      : { background: o.color }
                  }
                />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {selected.has(o.id) && <Icon name="check" size={14} color="var(--cortex-600)" />}
              </button>
            ))}
            {visible.length === 0 && !canCreate && (
              <div className="p-2 text-[12px] text-[var(--n-400)]">No matches</div>
            )}
            {canCreate && (
              <button
                type="button"
                onClick={() => {
                  onCreate?.(trimmed);
                  setQuery('');
                  if (!multi) onClose();
                }}
                className="flex w-full items-center gap-2 rounded-[7px] px-2 py-[7px] text-left text-[13px] text-[var(--n-700)] hover:bg-[var(--n-50)]"
              >
                <Icon name="plus" size={13} color="var(--n-400)" />
                <span className="min-w-0 flex-1 truncate">
                  Create <span className="font-medium text-[var(--n-900)]">{trimmed}</span>
                </span>
              </button>
            )}
          </div>
          {multi && (
            <div className="border-t border-[var(--n-100)] px-2 pb-0.5 pt-1.5 text-[11px] text-[var(--n-400)]">
              Pick as many as you need — Esc or click away to close.
            </div>
          )}
        </div>
      </FixedBelowAnchor>
    </>
  );
}
