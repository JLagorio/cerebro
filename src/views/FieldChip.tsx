import { resolveOptionColor } from '@/lib/swatch';
import { Avatar } from '@/components/ui/Avatar';
import type { ResolvedField } from '@/engine/types';

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
      <span className="inline-flex flex-none items-center rounded-md border border-dashed border-[var(--n-300)] px-1.5 py-0.5 text-[11px] text-[var(--n-400)]">
        {resolved.display}
      </span>
    );
  }
  if (kind === 'person') {
    return (
      <span className="inline-flex flex-none items-center gap-1.5 text-[12px] text-[var(--n-700)]">
        <Avatar name={resolved.display} size={20} />
        {resolved.display}
      </span>
    );
  }
  if (kind === 'date' || kind === 'daterange') {
    return (
      <span className="inline-flex flex-none [font-family:var(--font-mono)] text-[11px] text-[var(--n-500)]">
        {resolved.display}
      </span>
    );
  }
  if (kind === 'status' || kind === 'select' || kind === 'multiselect') {
    const sw = resolveOptionColor(resolved.color);
    const color = resolved.color === null ? 'var(--n-400)' : sw.solid;
    const hollow = optionHollow(resolved);
    return (
      <span className="inline-flex flex-none items-center gap-1.5 text-[12px] text-[var(--n-700)]">
        <span
          className="box-border h-[9px] w-[9px] flex-none rounded-full"
          style={
            hollow
              ? { border: `1.5px solid ${color}` }
              : { background: color, border: `1.5px solid ${color}` }
          }
        />
        {resolved.display}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-none text-[12px] text-[var(--n-600)]">
      {resolved.display}
    </span>
  );
}
