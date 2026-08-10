import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import type { Entry } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';

/** A target the badge may hand to `window.open`. Everything else is a vault path. */
const URL_RE = /^https?:\/\/\S+$/;
const MAX_RESULTS = 8;

/**
 * Bind a node to a URL or a vault record (M29.38, spec D3/D8). One box, two
 * readings: a `https?://` string offers a URL link; anything else searches
 * records — `resolveTarget`'s exact hit first (stem > project folder > title,
 * the Tolaria rule), then title/filename substring matches. Picking a record
 * stores its vault-relative PATH in the click line, so the binding survives a
 * retitle.
 *
 * `entries` is optional BY DESIGN: a host without a vault in hand still gets
 * URL links, and nothing here crashes. Renders through the Popover primitive
 * with ShapePalette's and IconPicker's keyboard contract, deliberately — all
 * four of these open from adjacent buttons on one mini-toolbar, and a Tab that
 * meant different things a centimetre apart would be worse than any of them.
 *
 * `contested` is the one thing this surface must say out loud, and it has two
 * readings of its own (see `nodeLinks`):
 *
 * - with a `current`, a click statement we do NOT own also writes this slot, so
 *   what mermaid draws may not be `current` and a clear cannot fully clear;
 * - without one, the node is linked ONLY by such a statement — `nodeLinks` has
 *   no entry at all — so "no current target" must not be shown as "unlinked".
 */
export function LinkPopover({
  entries,
  current,
  contested,
  onPick,
  onClose,
}: {
  /** Vault entries for the record search, or undefined where there is no vault. */
  entries: Entry[] | undefined;
  /** The OWNED target, or null when the editor owns no click line for this node. */
  current: string | null;
  /** True when a click statement the editor does not own also writes this slot. */
  contested: boolean;
  /** Called with a target to set, null to clear. */
  onPick: (target: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const isUrl = URL_RE.test(q);

  const matches = useMemo(() => {
    if (entries === undefined || q === '' || isUrl) return [];
    const exact = resolveTarget(q, entries);
    const needle = q.toLowerCase();
    const rest = entries.filter(
      (e) =>
        e !== exact &&
        (e.title.toLowerCase().includes(needle) || e.filename.toLowerCase().includes(needle)),
    );
    return [...(exact !== null ? [exact] : []), ...rest].slice(0, MAX_RESULTS);
  }, [entries, q, isUrl]);

  const pick = (target: string | null): void => {
    onPick(target);
    onClose();
  };

  return (
    <Popover
      onClose={onClose}
      role="dialog"
      ariaLabel="Link popover"
      trapFocus
      className="w-64 p-2"
    >
      <div
        data-testid="mermaid-link-popover"
        // Portals bubble through the REACT tree, so without this every
        // Backspace typed or pressed in here reaches StructuralEditor's
        // onKeyDown and deletes the very node being linked (M29.33). One
        // handler on the container covers every control, the input included.
        onKeyDown={(e) => e.stopPropagation()}
        className="flex max-h-96 flex-col gap-1.5"
      >
        <input
          autoFocus
          type="text"
          aria-label="Link target"
          placeholder={entries !== undefined ? 'Paste a URL or search records…' : 'Paste a URL…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            // Enter takes the top offer — but only once something has been
            // typed. With the box empty every record is "first", and linking
            // to whichever one that is would be an edit nobody asked for
            // (ShapePalette's and IconPicker's rule, same reason).
            if (e.key !== 'Enter' || q === '') return;
            if (isUrl) {
              pick(q);
              return;
            }
            const first = matches[0];
            if (first !== undefined) pick(first.path);
          }}
          className="w-full flex-none rounded border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-800 outline-none focus:border-cortex-500"
        />
        {contested && (
          <div
            data-testid="mermaid-link-contested"
            className="flex-none rounded bg-n-50 px-1.5 py-1 text-2xs leading-snug text-n-500"
          >
            {current !== null
              ? 'Another click line also links this node, so the diagram may open something else — and removing this one cannot clear it.'
              : 'This node is linked by a click form the editor does not own, so it cannot be edited here. Setting a target adds a line below it.'}
          </div>
        )}
        {current !== null && (
          <button
            type="button"
            aria-label="Remove link"
            onClick={() => pick(null)}
            className="flex w-full flex-none items-center gap-1.5 rounded-md border border-n-200 bg-n-0 px-2 py-1 text-left text-xs text-n-600 hover:bg-n-50"
          >
            <Icon name="x" size={12} color="var(--n-500)" />
            <span className="truncate">Remove link ({current})</span>
          </button>
        )}
        {isUrl && (
          <button
            type="button"
            aria-label="Link to URL"
            onClick={() => pick(q)}
            className="flex w-full flex-none items-center gap-1.5 rounded-md border border-n-200 bg-n-0 px-2 py-1 text-left text-xs text-n-700 hover:bg-n-50"
          >
            <Icon name="link" size={12} color="var(--n-500)" />
            <span className="truncate">{q}</span>
          </button>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {matches.map((e) => (
            <button
              key={e.path}
              type="button"
              title={e.path}
              aria-label={`Link to ${e.title}`}
              onClick={() => pick(e.path)}
              className="flex w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-left text-xs text-n-700 hover:bg-n-50"
            >
              <Icon name="file-text" size={12} color="var(--n-500)" />
              <span className="truncate">{e.title}</span>
            </button>
          ))}
        </div>
        {!isUrl && q !== '' && matches.length === 0 && entries !== undefined && (
          <div className="flex-none px-1 py-1 text-xs text-n-400">
            No records match &quot;{q}&quot;
          </div>
        )}
      </div>
    </Popover>
  );
}
