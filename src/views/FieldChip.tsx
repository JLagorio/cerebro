import { resolveOptionColor } from '@/lib/swatch';
import { Avatar } from '@/components/ui/Avatar';
import type { ResolvedField } from '@/engine/types';
import { TABLE_ANATOMY } from '@/views/tableAnatomy';

function optionHollow(resolved: ResolvedField): boolean {
  const options = resolved.def?.options;
  if (!options) return false;
  return options.some((o) => o.id === resolved.raw && o.hollow === true);
}

/** One right-aligned value chip in a list row, rendered per ResolvedField kind. */
export function FieldChip({ resolved }: { resolved: ResolvedField }) {
  if (resolved.display === '') return null;
  const kind = resolved.def?.kind ?? 'text';

  if (resolved.ghost) {
    return (
      <span className="inline-flex min-w-0 max-w-full [overflow-wrap:anywhere] items-center rounded-md border border-dashed border-n-300 px-1.5 py-0.5 text-2xs text-n-400">
        <span className="min-w-0 [overflow-wrap:anywhere]">{resolved.display}</span>
      </span>
    );
  }
  if (kind === 'person') {
    return (
      <span className="inline-flex min-w-0 max-w-full [overflow-wrap:anywhere] items-center gap-1.5 text-metadata text-n-700">
        <Avatar name={resolved.display} size={20} />
        <span className="min-w-0 [overflow-wrap:anywhere]">{resolved.display}</span>
      </span>
    );
  }
  if (kind === 'date' || kind === 'daterange') {
    // Dates ride in the UI font like every other chip kind here. Mono is for
    // columnar alignment — TableView renders its own cells and keeps it — but
    // a chip sits inline on a card or list row, where mono buys no alignment
    // and only makes the one value that is not text look like code.
    return (
      <span className="inline-flex min-w-0 max-w-full [overflow-wrap:anywhere] text-metadata text-n-500">
        <span className="min-w-0 [overflow-wrap:anywhere]">{resolved.display}</span>
      </span>
    );
  }
  if (kind === 'status' || kind === 'select' || kind === 'multiselect') {
    const sw = resolveOptionColor(resolved.color);
    const color = resolved.color === null ? 'var(--n-400)' : sw.solid;
    const hollow = optionHollow(resolved);
    return (
      <span className="inline-flex min-w-0 max-w-full [overflow-wrap:anywhere] items-center gap-1.5 rounded-full bg-n-50 px-2 py-0.5 text-metadata text-n-700">
        <span
          className={TABLE_ANATOMY.selectDot}
          style={
            hollow
              ? { border: `1.5px solid ${color}` }
              : { background: color, border: `1.5px solid ${color}` }
          }
        />
        <span className="min-w-0 [overflow-wrap:anywhere]">{resolved.display}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 max-w-full [overflow-wrap:anywhere] text-metadata text-n-500">
      <span className="min-w-0 [overflow-wrap:anywhere]">{resolved.display}</span>
    </span>
  );
}
