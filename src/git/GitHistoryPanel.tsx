import { Icon } from '@/components/ui/Icon';
import { useFileHistory } from '@/git/useGit';
import { useUiStore } from '@/stores/uiStore';

/** Relative dates, because "3d ago" answers the question "is this current?"
 * and an ISO timestamp does not. */
export function relativeDate(unixSeconds: number, now = Date.now()): string {
  const days = Math.floor((now / 1000 - unixSeconds) / 86400);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1mo ago' : `${months}mo ago`;
}

/**
 * One note's history (M9.4). Ported from tolaria's GitHistoryPanel; lifts
 * cleanly because it is genuinely small.
 *
 * Renders nothing when the note has no commits — a heading over an empty
 * list is chrome, and a note you just created has no history to show.
 */
export function GitHistoryPanel({ path }: { path: string }) {
  const { commits, loading } = useFileHistory(path);
  // M9.7: the diff replaces the editor in place rather than opening over it.
  const openDiff = useUiStore((s) => s.openDiff);

  if (loading || commits.length === 0) return null;

  return (
    <div data-testid="git-history" className="mt-5">
      <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-n-500">
        <Icon name="history" size={12} />
        History
      </div>
      <div className="flex flex-col gap-2">
        {commits.map((c) => (
          <div key={c.hash} data-testid="git-commit" className="border-l-2 border-n-200 pl-2.5">
            <button
              type="button"
              onClick={() => openDiff(path, c.hash)}
              className="w-full truncate border-0 bg-transparent p-0 text-left text-[12px] text-cortex-600 hover:underline"
              title={`View what ${c.shortHash} changed`}
            >
              <span className="[font-family:var(--font-mono)] text-[11px]">{c.shortHash}</span>
              {' · '}
              {c.message}
            </button>
            <div className="text-[10.5px] text-n-400">
              {c.author} · {relativeDate(c.date)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
