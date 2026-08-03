/**
 * What a load limit is hiding, and how to stop hiding it (M16.26).
 *
 * Notion defaults every database to 25 records and every view of ours rendered
 * `entries` in full, so a type with a few thousand records laid out a few
 * thousand rows before the first paint. A limit fixes that and introduces a
 * worse failure in its place — records missing from a view with nothing on
 * screen to say so is indistinguishable from a filter that is wrong.
 *
 * So the limit is never silent. This renders only while it is actually
 * truncating: an unlimited view, or a limited one holding fewer records than
 * its limit, shows nothing at all.
 */
export function ViewLimitNotice({
  shown,
  total,
  onShowAll,
}: {
  shown: number;
  total: number;
  /** Clears the limit on the open view. Absent where nothing can be saved. */
  onShowAll?: () => void;
}) {
  if (shown >= total) return null;
  return (
    <div
      data-testid="view-limit-notice"
      className="flex flex-none items-center gap-2 border-t border-[var(--n-200)] px-5 py-1.5 text-[11.5px] text-[var(--n-500)]"
    >
      <span>
        Showing <span className="[font-family:var(--font-mono)] text-[var(--n-700)]">{shown}</span>{' '}
        of <span className="[font-family:var(--font-mono)] text-[var(--n-700)]">{total}</span>
      </span>
      {onShowAll !== undefined && (
        <button
          type="button"
          data-testid="view-show-all"
          onClick={onShowAll}
          className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[11.5px] text-[var(--cortex-600)] hover:bg-[var(--cortex-50)]"
        >
          Show all
        </button>
      )}
    </div>
  );
}
