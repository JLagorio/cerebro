import { findOptionByLabel } from '@/engine/properties';
import { resolveOptionColor } from '@/lib/swatch';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { useEscapeLayer } from '@/components/ui/Popover';

/**
 * Escape dismisses THIS overlay and nothing behind it.
 *
 * Registered on `window` in the CAPTURE phase so it runs before the
 * bubble-phase listener the record panel binds, and stops propagation so a
 * single keystroke dismisses exactly one surface — the rule Dropdown already
 * states ("an open dropdown must swallow Escape before global listeners").
 * Without this, Escape inside a field popover tore down the whole record
 * panel, which is the opposite of what the popover's own footer promises.
 */
export function useEscapeToClose(onClose: () => void): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      latest.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/**
 * Fixed-position wrapper that pins its children just below the nearest
 * `relative` trigger wrapper and clamps them inside the viewport. Escapes
 * overflow containers (the doc side panel scrolls), which plain `absolute`
 * popovers cannot.
 *
 * It is also a LAYER (M16.29). `Popover` (M16.1) registers one; this older
 * wrapper registered nothing, and the View settings panel, the view-tab menus,
 * the chain builder and the sync badge all still mount through it. A whole
 * family of dismissable surfaces was therefore invisible to the stack, so
 * `hasLayers()` answered false while one of them was open on screen and the
 * record panel's Escape handler closed the RECORD — leaving the popover over
 * an empty canvas. Registering here fixes every one of them at once.
 *
 * Pass `onClose` and it takes the keystroke as well. Without one it still
 * registers, because a surface the stack cannot see is a surface whose
 * keystrokes land on whatever is behind it.
 */
export function FixedBelowAnchor({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEscapeLayer(onClose);
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

/** Mount inside a conditionally-rendered overlay to give it Escape without
 * hoisting a conditional hook into the parent. */
export function EscapeToClose({ onClose }: { onClose: () => void }) {
  useEscapeToClose(onClose);
  return null;
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
  /** Shown instead of "No matches" when the field has no options at all, so a
   * freshly declared Select says where its options come from. */
  emptyHint?: string;
  /**
   * Shown in place of the Create row when a label is typed but this surface
   * cannot create (M16.12). `emptyHint` cannot carry it: that only renders
   * when the option list is EMPTY, and the case that needs explaining most —
   * a status set a project overrides — always has options in it.
   */
  unavailableHint?: string;
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
  emptyHint,
  unavailableHint,
  onPick,
  onClose,
}: FieldPopoverProps) {
  useEscapeToClose(onClose);
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const visible =
    trimmed === ''
      ? options
      : options.filter((o) => o.label.toLowerCase().includes(trimmed.toLowerCase()));
  // Multi mode keeps the popover open so several values land in one visit.
  const multi = activeIds !== undefined;
  const selected = new Set(activeIds ?? (activeId != null ? [activeId] : []));
  // By SLUG, not by label (M16.12). The id is a slug, so "In-Progress" and
  // "In Progress" are one option under two labels — comparing labels offered
  // to create the second, the write APPENDED, and the type doc ended holding
  // two entries with the same id. Every lookup in the app is a `.find` on id,
  // so the FIRST won: the new label was invisible forever, the record kept
  // rendering the old one, and the write reported success.
  const clash = trimmed === '' ? undefined : findOptionByLabel(options, trimmed);
  const canCreate = onCreate !== undefined && trimmed !== '' && clash === undefined;
  // A slug collision whose LABEL does not match the filter used to leave the
  // popover showing "No matches" with no create row — a hard dead end on a
  // value that already exists. Show the option instead.
  const rows = visible.length === 0 && clash !== undefined ? [clash] : visible;

  return (
    <>
      <button
        type="button"
        // tabIndex -1: the scrim is a click target, not a stop on the tab
        // route — focus landing on an invisible full-screen button reads as
        // focus being lost. Matches Dropdown's scrim.
        tabIndex={-1}
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
            {rows.map((o) => (
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
                      ? {
                          border: `1.5px solid ${
                            o.color === null ? 'var(--n-400)' : resolveOptionColor(o.color).solid
                          }`,
                        }
                      : { background: resolveOptionColor(o.color).solid }
                  }
                />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {selected.has(o.id) && <Icon name="check" size={14} color="var(--cortex-600)" />}
              </button>
            ))}
            {rows.length === 0 && !canCreate && (
              <div className="p-2 text-[12px] leading-relaxed text-[var(--n-500)]">
                {options.length === 0 && emptyHint !== undefined ? emptyHint : 'No matches'}
              </div>
            )}
            {/* A footer, not a response to typing: when creation is
                unavailable the popover is not even searchable (`searchable`
                is derived from onCreate), so there is no box to type into and
                no moment at which a typed-only hint would ever appear. */}
            {!canCreate && clash === undefined && unavailableHint !== undefined && (
              <div className="border-t border-[var(--n-100)] px-2 pb-1 pt-1.5 text-[11.5px] leading-relaxed text-[var(--n-500)]">
                {unavailableHint}
              </div>
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
