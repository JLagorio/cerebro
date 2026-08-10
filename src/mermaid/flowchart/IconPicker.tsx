import { useMemo, useState } from 'react';
import { Icon, resolveIcon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';

/**
 * Diagram node icon picker (M29.35, spec D6). Distinct from
 * src/components/ui/IconPicker on purpose: this one deals in PACK-PREFIXED
 * values (`lucide:rocket`) because that is what mermaid's `@{ icon: … }`
 * resolves — a name without a pack prefix resolves to nothing and renders the
 * placeholder box (mermaid's fallbackPrefix is ''). The curated list keeps
 * "pick an icon" a choice, not a scroll; the free-text row keeps every other
 * lucide glyph one keystroke away. Preview uses the app's own Icon component —
 * same glyph family, so what you see is what mermaid draws.
 *
 * Renders through the Popover primitive with ShapePalette's keyboard contract,
 * deliberately: all three of these popovers open from adjacent buttons on one
 * mini-toolbar, and a Tab that meant different things a centimetre apart would
 * be worse than any of them.
 */

/** Verified in lucide-react 0.525 AND @iconify-json/lucide (test-enforced). */
export const CURATED_ICONS: string[] = [
  'activity',
  'archive',
  'bell',
  'bookmark',
  'boxes',
  'building',
  'calendar',
  'camera',
  'chart-bar',
  'chart-pie',
  'check',
  'clock',
  'cloud',
  'code',
  'cpu',
  'credit-card',
  'database',
  'download',
  'eye',
  'file-text',
  'flag',
  'folder',
  'funnel',
  'git-branch',
  'git-merge',
  'globe',
  'hard-drive',
  'heart',
  'house',
  'image',
  'inbox',
  'info',
  'key',
  'layers',
  'lightbulb',
  'link',
  'lock',
  'mail',
  'map-pin',
  'message-square',
  'monitor',
  'network',
  'package',
  'pencil',
  'phone',
  'play',
  'rocket',
  'search',
  'send',
  'server',
  'settings',
  'shield',
  'smartphone',
  'star',
  'table',
  'target',
  'terminal',
  'timer',
  'trending-up',
  'triangle-alert',
  'trophy',
  'truck',
  'upload',
  'user',
  'users',
  'workflow',
  'wrench',
  'zap',
];

/** A plausible lucide name: lowercase kebab, nothing else. */
const LUCIDE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function IconPicker({
  current,
  onPick,
  onClose,
}: {
  /** The node's current icon (`lucide:x`), or null. */
  current: string | null;
  /** Called with `lucide:<name>` to set, null to clear. */
  onPick: (icon: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const matches = useMemo(
    () => (q === '' ? CURATED_ICONS : CURATED_ICONS.filter((n) => n.includes(q))),
    [q],
  );

  // Any plausible lucide name typed in full is offered verbatim — the picker
  // must not gatekeep the pack's eighteen hundred glyphs behind a 68-name list.
  const freeText = LUCIDE_NAME.test(q) && !CURATED_ICONS.includes(q) ? q : null;

  return (
    <Popover onClose={onClose} role="dialog" ariaLabel="Icon picker" trapFocus className="w-64 p-2">
      <div
        data-testid="mermaid-icon-picker"
        // Portals bubble through the REACT tree, so without this every
        // Backspace typed or pressed in here reaches StructuralEditor's
        // onKeyDown and deletes the very node being decorated (M29.33). One
        // handler on the container covers every control, the input included.
        onKeyDown={(e) => e.stopPropagation()}
        className="flex max-h-96 flex-col gap-1.5"
      >
        <input
          autoFocus
          type="search"
          aria-label="Search icons"
          placeholder="Search icons…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            // Enter takes the top offer — but only once a query has narrowed
            // the list. With the box empty every icon is "first", and setting
            // Activity because someone pressed Enter on an unfiltered grid is
            // an edit nobody asked for (ShapePalette's rule, same reason).
            if (e.key !== 'Enter' || q === '') return;
            // `matches[0]` is typed `string` without noUncheckedIndexedAccess,
            // so ONE null check does the whole job — ShapePalette's shape.
            const first = matches[0] ?? freeText;
            if (first !== null) onPick(`lucide:${first}`);
          }}
          className="w-full flex-none rounded border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-800 outline-none focus:border-cortex-500"
        />
        {current !== null && (
          <button
            type="button"
            aria-label="Remove icon"
            onClick={() => onPick(null)}
            className="flex w-full flex-none items-center gap-1.5 rounded-md border border-n-200 bg-n-0 px-2 py-1 text-xs text-n-600 hover:bg-n-50"
          >
            <Icon name="x" size={12} color="var(--n-500)" />
            Remove icon ({current})
          </button>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-8 gap-0.5">
            {matches.map((n) => (
              <button
                key={n}
                type="button"
                title={n}
                aria-label={`Icon ${n}`}
                aria-pressed={current === `lucide:${n}`}
                onClick={() => onPick(`lucide:${n}`)}
                className={`flex h-7 w-7 items-center justify-center rounded border-0 hover:bg-n-50 ${
                  current === `lucide:${n}` ? 'bg-cortex-50' : 'bg-transparent'
                }`}
              >
                <Icon name={n} size={15} color="var(--n-600)" />
              </button>
            ))}
          </div>
          {matches.length === 0 && freeText === null && (
            <div className="px-1 py-2 text-xs text-n-400">No icons match.</div>
          )}
        </div>
        {freeText !== null && (
          <button
            type="button"
            aria-label={`Use lucide:${freeText}`}
            onClick={() => onPick(`lucide:${freeText}`)}
            className="flex w-full flex-none items-center gap-1.5 rounded-md border border-dashed border-n-200 bg-transparent px-2 py-1 text-left text-xs text-n-600 hover:border-n-300"
          >
            {/* An unresolvable name still gets offered — mermaid's pack is
                bigger than lucide-react's and both drift — but it previews as
                the dashed-square placeholder, an honest hint that mermaid may
                draw its own placeholder box for this one too. Asked here
                rather than left to Icon's own fallback because an unknown name
                is EXPECTED input in this box, not the bug Icon's dev warning
                would report it as (once per prefix, on every keystroke). */}
            <Icon
              name={resolveIcon(freeText).Comp === null ? 'square-dashed' : freeText}
              size={14}
              color="var(--n-600)"
            />
            Use lucide:{freeText}
          </button>
        )}
      </div>
    </Popover>
  );
}
