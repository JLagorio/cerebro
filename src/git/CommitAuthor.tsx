import { Icon } from '@/components/ui/Icon';
import { actorLabel } from '@/engine/authors';
import type { CommitRun, GitCommit } from '@/engine/git';
import type { GitRead } from '@/git/useGit';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/** What a failed attribution read says, and its hover. */
export const ATTRIBUTION_UNKNOWN = 'attribution unknown';
export const ATTRIBUTION_UNKNOWN_TITLE = "Cerebro couldn't read which runs made these commits.";
/** What a commit no run's record names says. */
export const UNATTRIBUTED = 'unattributed';

/**
 * Who made one commit (M58.4, CV-35), from runtime.db's commit record and
 * nothing else: a trailer, a message or a git author never names a run.
 *
 * - While the record is being read, it makes no claim.
 * - A read that failed says "attribution unknown", never "unattributed":
 *   those are opposite sentences (CV-05).
 * - No record says "unattributed"; the git author stays one hover away,
 *   because it names whoever's git identity made the commit, not who wrote
 *   the words.
 * - A record names its run's actor through `actorLabel`: an agent opens its
 *   page as Review's `CardAuthor` does, and the attended assistant reads
 *   "Assistant". When your own edits rode along in the run's commit, it says
 *   " with your edits", and names any other run that wrote the page too.
 */
export function CommitAuthor({ commit, runs }: { commit: GitCommit; runs: GitRead<CommitRun[]> }) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  if (runs.kind === 'loading') {
    return <span data-testid="commit-author" data-attributed="pending" />;
  }
  if (runs.kind === 'unavailable') {
    return (
      <span data-testid="commit-author" data-attributed="unknown" title={ATTRIBUTION_UNKNOWN_TITLE}>
        {ATTRIBUTION_UNKNOWN}
      </span>
    );
  }
  const run = runs.data.find((r) => r.hash === commit.hash);
  if (run === undefined) {
    return (
      <span data-testid="commit-author" data-attributed="none" title={commit.author}>
        {UNATTRIBUTED}
      </span>
    );
  }
  const label = actorLabel(run.actor, entries);
  const who = run.actor === null ? 'a run that named no actor' : label.text;
  const extra = [
    run.with_person === true ? ' with your edits' : '',
    run.also_by.length > 0
      ? ` · also edited by ${run.also_by.map((a) => actorLabel(a, entries).text).join(', ')}`
      : '',
  ].join('');
  const title = `${run.actor ?? 'actor not recorded'} · run ${run.run_id}`;
  const agent = label.actor;
  return (
    <span data-testid="commit-author" data-attributed="run" title={title}>
      {agent !== undefined ? (
        <button
          type="button"
          data-testid="commit-author-agent"
          onClick={() => navigate({ kind: 'agents', actor: agent })}
          className="inline-flex items-center gap-1 border-0 bg-transparent p-0 text-2xs font-medium text-n-600 hover:text-cortex-600"
        >
          <Icon name="bot" size={11} color="var(--synapse-500)" />
          {who}
        </button>
      ) : (
        who
      )}
      {extra}
    </span>
  );
}
