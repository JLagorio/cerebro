import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { CommitQuery, CommitRun, FileCommit } from '@/engine/git';
import { CommitAuthor } from '@/git/CommitAuthor';
import { useCommitRuns, useFileHistory, type GitRead } from '@/git/useGit';
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

/** What a version did to the page, in words, or null for an edit. */
export function changeWords(commit: FileCommit): string | null {
  if (commit.change === 'added') return 'created it';
  if (commit.change === 'deleted') return 'removed it';
  if (commit.previousPath !== null) {
    return `renamed from ${commit.previousPath.split('/').pop() ?? commit.previousPath}`;
  }
  return null;
}

/** The attribution read for a page's rows: each commit, under the path it
 * had, from the page's previous commit on. */
export function historyQueries(rows: FileCommit[]): CommitQuery[] {
  return rows.map((r) => ({ hash: r.hash, path: r.pathAt, since: r.previousAt }));
}

const NO_ROWS: FileCommit[] = [];

/**
 * One version of a page (M58.4): its subject, who made it from the commit
 * record (`CommitAuthor`), when, and what it did to the page. The subject
 * opens the version lens (M9.7: in place of the editor). `runs` is one
 * batched attribution read for every row its host shows.
 */
export function CommitRow({
  commit,
  path,
  runs,
}: {
  commit: FileCommit;
  path: string;
  runs: GitRead<CommitRun[]>;
}) {
  const openDiff = useUiStore((s) => s.openDiff);
  const words = changeWords(commit);
  return (
    <div data-testid="git-commit" className="border-l-2 border-n-200 pl-2.5">
      <button
        type="button"
        onClick={() => openDiff(path, commit.hash)}
        className="w-full truncate border-0 bg-transparent p-0 text-left text-xs text-cortex-600 hover:underline"
        title={`Open version ${commit.shortHash}`}
      >
        {commit.message}
      </button>
      <div className="flex flex-wrap items-center gap-x-1 text-2xs text-n-400">
        <CommitAuthor commit={commit} runs={runs} />
        {runs.kind !== 'loading' && <span aria-hidden>·</span>}
        <span>{relativeDate(commit.date)}</span>
        {words !== null && (
          <>
            <span aria-hidden>·</span>
            <span data-testid="git-commit-change">{words}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** The row a page holding changes no commit has yet leads its History with
 * (M58.4): it opens the lens on those changes. */
export function UncommittedRow({ path }: { path: string }) {
  const openDiff = useUiStore((s) => s.openDiff);
  return (
    <div data-testid="git-uncommitted" className="border-l-2 border-warn-300 pl-2.5">
      <button
        type="button"
        onClick={() => openDiff(path, null)}
        className="w-full truncate border-0 bg-transparent p-0 text-left text-xs text-cortex-600 hover:underline"
      >
        Not in history yet
      </button>
      <div className="text-2xs text-n-400">Changes since the last version</div>
    </div>
  );
}

/**
 * One page's versions at the foot of the record peek (M9.4, M58.4): a
 * `CommitRow` per version. It stays silent until there is something to
 * show, since a heading over an empty list is chrome there, but says a read
 * that FAILED (M53.15): rendering nothing for it would claim the page has
 * no history when nobody could tell. A page's History panel merges these
 * rows with its edits and Knowledge changes instead (`history/PageHistory`,
 * M64.2b), reusing `CommitRow` and `UncommittedRow`.
 */
export function GitHistoryPanel({ path, compact = false }: { path: string; compact?: boolean }) {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const expanded = expandedPath === path;
  const history = useFileHistory(path);
  const rows = history.kind === 'ready' ? history.data : NO_ROWS;
  const queries = useMemo(() => historyQueries(rows), [rows]);
  const runs = useCommitRuns(queries);

  if (history.kind === 'loading') return null;

  const heading = (
    <div className="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
      <Icon name="history" size={12} />
      History
    </div>
  );

  if (history.kind === 'unavailable') {
    return (
      <div
        data-testid="git-history"
        data-variant="foot"
        className={compact ? 'cb-peek-history cb-peek-history-unavailable' : 'mt-5'}
      >
        {heading}
        <p data-testid="section-unavailable" className="m-0 text-xs text-n-500">
          {HISTORY_UNREADABLE}
        </p>
      </div>
    );
  }

  if (rows.length === 0) return null;

  return (
    <div
      data-testid="git-history"
      data-variant="foot"
      className={compact ? 'cb-peek-history' : 'mt-5'}
    >
      {compact ? (
        <button
          type="button"
          tabIndex={0}
          className="cb-peek-section-toggle"
          data-testid="peek-history-toggle"
          aria-expanded={expanded}
          onClick={() => setExpandedPath(expanded ? null : path)}
        >
          <Icon name="history" size={14} />
          <span>History</span>
          <span className="cb-peek-section-count">{rows.length}</span>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
        </button>
      ) : (
        heading
      )}
      <div className="flex flex-col gap-2" hidden={compact && !expanded}>
        {rows.map((c) => (
          <CommitRow key={c.hash} commit={c} path={path} runs={runs} />
        ))}
      </div>
    </div>
  );
}

/** What a page's versions say when they could not be read (M53.15). */
export const HISTORY_UNREADABLE = "This page's history could not be read.";
