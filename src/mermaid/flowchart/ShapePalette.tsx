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
    <Popover onClose={onClose} role="dialog" ariaLabel="Shape palette" className="w-60 p-2">
      <div data-testid="shape-palette" className="flex max-h-96 flex-col gap-1.5">
        <input
          autoFocus
          aria-label="Search shapes"
          placeholder="Search shapes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Portals bubble through the REACT tree, so without this every
          // Backspace typed in here reaches StructuralEditor's onKeyDown and
          // deletes the very node being reshaped.
          onKeyDown={(e) => e.stopPropagation()}
          className="w-full flex-none rounded border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-800 outline-none focus:border-cortex-500"
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {CATEGORIES.map((cat) => {
            const inCat = visible.filter((s) => s.category === cat);
            if (inCat.length === 0) return null;
            return (
              <div key={cat}>
                <div className="px-0.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-n-400">
                  {cat}
                </div>
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
