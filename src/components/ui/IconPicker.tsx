import { useMemo, useState } from 'react';
import { icons } from 'lucide-react';
import { Icon, resolveIcon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';

/**
 * Searchable lucide icon grid (M16.26).
 *
 * `TypeStyleDialog` had the only one, inline and reachable from nothing else,
 * which is why a VIEW could not have an icon: `ViewDefinition.icon` has been
 * parsed, serialized and rendered since M11, `newView` hardcodes `null`, and
 * no control in the app ever wrote one.
 *
 * A cap of 96 is not laziness — the full set is well over a thousand, and a
 * grid that long turns "pick an icon" into scrolling rather than choosing.
 * Type to narrow.
 */

/**
 * lucide export names are PascalCase; `Icon` takes kebab-case. The second rule
 * splits a run of capitals before a capitalised word, so `AArrowDown` becomes
 * `a-arrow-down` rather than `aarrow-down` — which `Icon` would PascalCase
 * back to `AarrowDown` and fail to find.
 */
const kebab = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();

/**
 * Only the names `Icon` can actually resolve.
 *
 * `TypeStyleDialog` listed every lucide export kebab-cased and nothing checked
 * the result, but the two conversions are not inverses: `Icon` reads a name by
 * PascalCasing each dash-separated word, and lucide has exports whose casing
 * that cannot reproduce — `ArrowDownAZ` kebabs to
 * `arrow-down-az` and comes back as `ArrowDownAz`. Searching the type icon
 * picker for "az" therefore offered four tiles that render M15.7's
 * dashed-square fallback, and picking one wrote a dead name into the vault's
 * YAML. Round-tripping through the real resolver is the only honest filter —
 * a hand-kept exception list is the M15.9 bug again.
 */
const ALL_ICONS = Object.keys(icons)
  .map(kebab)
  .filter((n) => resolveIcon(n).Comp !== null);

const SHOWN = 96;

export interface IconPickerProps {
  /** The selected icon name, or null when nothing is chosen. */
  value: string | null;
  onChange: (name: string) => void;
  /** Tint for the selected tile — a type's colour, when it has one. */
  color?: string;
  /**
   * Offered as a first tile that clears the choice. The label says what
   * "none" falls back to, because on a view tab it is not nothing: the tab
   * shows its LAYOUT's icon instead.
   */
  clear?: { label: string; icon: string; onClear: () => void };
  columns?: number;
  maxHeight?: number;
}

export function IconPicker({
  value,
  onChange,
  color,
  clear,
  columns = 8,
  maxHeight = 180,
}: IconPickerProps) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q === '' ? ALL_ICONS : ALL_ICONS.filter((n) => n.includes(q))).slice(0, SHOWN);
  }, [query]);

  const tile = (selected: boolean) =>
    [
      'flex h-9 w-9 items-center justify-center rounded-md border',
      selected
        ? 'border-[var(--cortex-500)] bg-[var(--n-50)]'
        : 'border-transparent hover:bg-[var(--n-50)]',
    ].join(' ');

  return (
    <div>
      <Input
        placeholder="Search icons…"
        ariaLabel="Search icons"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        width="100%"
      />
      <div
        className="mt-2 grid gap-1 overflow-y-auto"
        style={{
          maxHeight,
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {clear !== undefined && (
          <button
            type="button"
            title={clear.label}
            aria-label={clear.label}
            aria-pressed={value === null}
            onClick={clear.onClear}
            className={tile(value === null)}
          >
            <Icon name={clear.icon} size={16} color="var(--n-400)" />
          </button>
        )}
        {matches.map((n) => (
          <button
            key={n}
            type="button"
            title={n}
            aria-label={`Icon ${n}`}
            aria-pressed={value === n}
            onClick={() => onChange(n)}
            className={tile(value === n)}
          >
            <Icon
              name={n}
              size={16}
              color={value === n ? (color ?? 'var(--cortex-600)') : 'var(--n-600)'}
            />
          </button>
        ))}
        {matches.length === 0 && (
          <div
            className="py-3 text-center text-[12px] text-[var(--n-400)]"
            style={{ gridColumn: `span ${columns} / span ${columns}` }}
          >
            No icons match "{query}"
          </div>
        )}
      </div>
    </div>
  );
}
