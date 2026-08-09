import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { PALETTE_SHAPES, SHAPE_ALIASES } from './shapes';

const CATEGORIES = ['Basic', 'Process', 'Technical', 'Annotation'] as const;

/**
 * The shape palette (M29.32): a searchable grid over the FULL registry (spec
 * §4.4) — every short name mermaid 11.16.0 accepts, grouped by our four
 * categories, scrolling inside the popover past its max height. Renders
 * through the Popover primitive, anchored to the node mini-toolbar it opens
 * from (the nearest positioned ancestor — Popover's documented default).
 * Picking calls onPick with the registry short name; the caller owns the op
 * and the close.
 *
 * Keyboard-complete, because 48 buttons behind a search box is exactly where
 * tabbing stops being a path: reaching Cloud took FORTY Tab presses before
 * `trapFocus` and the Enter handler below. The pattern is the one this repo
 * already settled for searchable dialogs — `trapFocus` as in Picker.tsx and
 * AddPropertyPanel.tsx, Enter-takes-the-first-result as in RelationPicker.tsx
 * ("the whole flow without leaving the keyboard").
 */
export function ShapePalette({
  current,
  onPick,
  onClose,
}: {
  /** Registry short name of the node's current shape, for the pressed state. */
  current: string | null;
  onPick: (shape: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return PALETTE_SHAPES;
    return PALETTE_SHAPES.filter(
      (s) =>
        s.name.includes(q) ||
        s.label.toLowerCase().includes(q) ||
        (SHAPE_ALIASES[s.name] ?? []).some((a) => a.includes(q)),
    );
  }, [query]);

  return (
    <Popover
      onClose={onClose}
      role="dialog"
      ariaLabel="Shape palette"
      trapFocus
      className="w-60 p-2"
    >
      <div data-testid="shape-palette" className="flex max-h-96 flex-col gap-1.5">
        <input
          autoFocus
          type="search"
          aria-label="Search shapes"
          placeholder="Search shapes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Portals bubble through the REACT tree, so without this every
            // Backspace typed in here reaches StructuralEditor's onKeyDown and
            // deletes the very node being reshaped.
            e.stopPropagation();
            // Enter takes the top match — but only once a query has narrowed
            // the list. With the box empty every shape is "first", and picking
            // Rectangle because someone pressed Enter on an unfiltered grid is
            // an edit nobody asked for.
            if (e.key !== 'Enter' || query.trim() === '') return;
            const first = visible[0];
            if (first !== undefined) onPick(first.name);
          }}
          className="w-full flex-none rounded border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-800 outline-none focus:border-cortex-500"
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {CATEGORIES.map((cat) => {
            const inCat = visible.filter((s) => s.category === cat);
            if (inCat.length === 0) return null;
            return (
              <div key={cat}>
                {/* A heading, not a div: these four are the palette's only
                    structure, and heading navigation is how a screen reader
                    walks it (RelationPicker.tsx uses h3 the same way). */}
                <h3 className="px-0.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-n-400">
                  {cat}
                </h3>
                <div className="grid grid-cols-5 gap-0.5">
                  {inCat.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      title={s.label}
                      aria-label={`Shape: ${s.label}`}
                      aria-pressed={current === s.name}
                      onClick={() => onPick(s.name)}
                      className={`flex items-center justify-center rounded border-0 p-1.5 hover:bg-n-50 ${
                        current === s.name ? 'bg-cortex-50' : 'bg-transparent'
                      }`}
                    >
                      <Icon name={s.icon} size={15} color="var(--n-600)" />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {visible.length === 0 && (
            <div className="px-1 py-2 text-xs text-n-400">No shapes match.</div>
          )}
        </div>
      </div>
    </Popover>
  );
}
