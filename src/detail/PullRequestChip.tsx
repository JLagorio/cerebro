import { Icon } from '@/components/ui/Icon';
import {
  checkState,
  originOf,
  parsePullRequestUrl,
  readinessOf,
  type PrRead,
} from '@/engine/pullRequest';
import { usePullRequest } from './usePullRequest';
import { useEffect } from 'react';

const FAILURE_WORDS = {
  invalid_url: 'This is not a supported GitHub pull request URL.',
  gh_missing: "gh isn't installed. Install GitHub CLI, then sign in with gh auth login.",
  not_signed_in: 'Sign in with gh auth login to read this pull request.',
  not_found: 'This pull request was not found or your gh login cannot read it.',
  offline: 'GitHub could not be reached.',
  rate_limited: 'GitHub is rate limiting this read. Try again later.',
  gh_outdated: 'Update gh to read these pull request fields.',
  timed_out: 'The GitHub read timed out.',
  unreadable: 'GitHub returned a pull request response this app could not read.',
  failed: 'The GitHub read failed.',
};
export function PullRequestChip({
  url,
  onRead,
}: {
  url: string;
  onRead?: (url: string, read: PrRead | null) => void;
}) {
  const { read, loading, refresh } = usePullRequest(url);
  useEffect(() => {
    onRead?.(url, read);
  }, [url, read, onRead]);
  return <PullRequestChipView url={url} read={read} loading={loading} onRefresh={refresh} />;
}
/** Render one read without owning its request lifetime. */
export function PullRequestChipView({
  url,
  read,
  loading = false,
  onRefresh,
}: {
  url: string;
  read: PrRead | null;
  loading?: boolean;
  onRefresh: () => void;
}) {
  const parsed = parsePullRequestUrl(url);
  if (parsed === null) return null;
  const readiness = read === null ? 'checks_unknown' : readinessOf(read);
  const pr = read?.state === 'read' ? read.pr : null;
  const origin = pr === null ? null : originOf(pr);
  const state =
    pr?.state === 'MERGED'
      ? 'merged'
      : pr?.state === 'CLOSED'
        ? 'closed'
        : pr?.isDraft === true
          ? 'draft'
          : (readiness ?? 'checks_unknown').replaceAll('_', ' ');
  const counts = pr?.checks?.reduce(
    (all, check) => {
      all[checkState(check)]++;
      return all;
    },
    { passing: 0, failing: 0, running: 0, unknown: 0 },
  );
  const title = [
    pr?.title,
    read === null ? 'Reading from gh…' : read.state === 'read' ? null : FAILURE_WORDS[read.state],
    pr === null
      ? null
      : `Review: ${pr.reviewDecision?.toLowerCase().replaceAll('_', ' ') ?? 'review not recorded'} · ${pr.mergeStateStatus === null ? 'mergeability unknown' : `Mergeability: ${pr.mergeStateStatus.toLowerCase().replaceAll('_', ' ')}`}`,
    counts === undefined
      ? 'Checks: not reported'
      : `${counts.passing} passing · ${counts.failing} failing · ${counts.running} running · ${counts.unknown} unknown`,
    origin === null
      ? null
      : `${origin.name} origin hint from ${origin.evidence}. This is not verified authorship.`,
    read === null ? null : `as of ${read.checkedAt} from gh`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span
      data-testid="pr-chip"
      data-state={pr?.state.toLowerCase() ?? read?.state ?? 'loading'}
      data-readiness={readiness ?? 'none'}
      title={title}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-n-200 bg-n-25 px-2 py-1 text-xs text-n-600"
    >
      <Icon name="git-pull-request" size={13} />
      <a
        href={parsed.canonical}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 truncate text-cortex-600 hover:underline"
      >
        {parsed.owner}/{parsed.repo}#{parsed.number}
      </a>
      <span className="shrink-0">{state}</span>
      {origin !== null && <span className="text-n-400">· {origin.name}</span>}
      <button
        type="button"
        data-testid="pr-chip-refresh"
        aria-label={`Refresh ${parsed.owner}/${parsed.repo}#${parsed.number}`}
        disabled={loading}
        onClick={onRefresh}
        className="flex shrink-0 rounded-sm border-0 bg-transparent p-0.5 text-n-400 hover:bg-n-100 hover:text-n-700 disabled:opacity-50"
      >
        <Icon name="refresh-cw" size={12} />
      </button>
    </span>
  );
}
