import { StateMessage } from '@/components/ui/StateMessage';
import { useMemo, useState } from 'react';
import { runStatus } from '@/agent/elements/runs';
import { useOpenPath } from '@/app/useOpenPath';
import { StepIcon } from '@/components/ai/StepLine';
import { TraceLine, TraceTitle } from '@/components/ai/Trace';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { dayKeyOf, dayWords, feedOf, revealed, runText, type FeedItem } from '@/engine/activity';
import type { CommitQuery, CommitRun, PulseChanges, PulseCommit, VaultPulse } from '@/engine/git';
import { CommitAuthor } from '@/git/CommitAuthor';
import { DiffView } from '@/git/DiffView';
import { relativeDate } from '@/git/GitHistoryPanel';
import { useCommitDiff, useCommitRuns, useVaultPulse, type GitRead } from '@/git/useGit';
import type { ActivityRun, HistoryActivity } from '@/lib/ipc';
import { RunWhy, runWhyText } from '@/status/RunWhy';
import { useVaultStore } from '@/stores/vaultStore';
import type { ActivityRead } from './vaultActivityStore';
import { useVaultActivity } from './vaultActivityStore';
import '@/status/runs.css';

/**
 * What happened in the vault, day by day (M64.2): editing sessions, agent
 * runs and checkpoints, newest first.
 *
 * A session is one writer's stretch of edits (`engine/activity.ts`); a run
 * absorbs the sessions it wrote; a checkpoint (a git commit) is its own row,
 * never blended into a session. Stretches with nothing in them read as gap
 * lines — "No edits or runs" for days Cerebro saw, "Not recorded" for days
 * it did not — and only when every lane read, because a day with nothing in
 * a lane that failed is a day nobody looked at (CV-05). Each lane that
 * failed says so on its own line; checkpoints and activity fail apart.
 *
 * Who made each commit is the page's History panel's reading (M58.4,
 * `CommitAuthor`): a run only from runtime.db's commit record, else
 * "unattributed", and "attribution unknown" when the record could not be
 * read. The git author stays in the hover.
 */

/** How many days that hold something one reveal shows. */
export const DAYS_PER_REVEAL = 14;

/** What each activity lane says when it could not be read. */
const LANE_WORDS = {
  writes: 'Edits could not be read, so no session here is a statement about them.',
  runs: 'Agent runs could not be read, so none are listed here.',
  app_sessions: 'When Cerebro was open could not be read, so no quiet stretch is said here.',
  recording_since: 'When Cerebro began recording edits could not be read.',
} as const;
const LANES = ['writes', 'runs', 'app_sessions', 'recording_since'] as const;

export interface ActivityFeedProps {
  read: ActivityRead;
  reload: () => void;
  pulse: GitRead<VaultPulse>;
  reloadPulse: () => void;
}

export function ActivityFeed({ read, reload, pulse, reloadPulse }: ActivityFeedProps) {
  const entries = useVaultStore((s) => s.entries);
  const openPath = useOpenPath();
  const [days, setDays] = useState(DAYS_PER_REVEAL);
  const [open, setOpen] = useState<{ hash: string; message: string } | null>(null);
  const diff = useCommitDiff(open === null ? null : open.hash);
  const commits: PulseCommit[] | null =
    pulse.kind === 'ready' && pulse.data.tracked ? pulse.data.commits : null;
  const queries = useMemo<CommitQuery[]>(
    () => (commits ?? []).map((c) => ({ hash: c.hash, path: null, since: null })),
    [commits],
  );
  const runs = useCommitRuns(queries);
  const activity: HistoryActivity | null = read.kind === 'ready' ? read.data : null;
  const today = read.kind === 'ready' ? read.today : dayKeyOf(Date.now());
  const groups = useMemo(
    () => feedOf(activity, commits, today, entries),
    [activity, commits, today, entries],
  );

  if (read.kind === 'loading' || pulse.kind === 'loading')
    return <StateMessage state="loading" title="Reading recent activity…" compact />;

  const shown = revealed(groups, days);
  const failedLanes = activity === null ? [] : LANES.filter((l) => activity[l].state !== 'read');

  return (
    <section data-testid="history-feed" className="flex flex-col gap-3">
      {read.kind === 'unavailable' && (
        <div className="flex flex-col items-start gap-2">
          <p
            data-testid="section-unavailable"
            data-lane="all"
            className="m-0 text-xs text-(--text-meta)"
          >
            Edits, agent runs and when Cerebro was open could not be read, so nothing here is a
            statement about them.
          </p>
          <Button size="sm" testId="feed-retry" onClick={reload}>
            Try again
          </Button>
        </div>
      )}
      {failedLanes.map((lane) => (
        <p
          key={lane}
          data-testid="section-unavailable"
          data-lane={lane}
          className="m-0 text-xs text-(--text-meta)"
        >
          {LANE_WORDS[lane]}
        </p>
      ))}
      {pulse.kind === 'unavailable' && (
        <div className="flex flex-col items-start gap-2">
          <p
            data-testid="section-unavailable"
            data-lane="checkpoints"
            className="m-0 text-xs text-(--text-meta)"
          >
            Checkpoints could not be read.
          </p>
          <Button size="sm" testId="history-retry" onClick={reloadPulse}>
            Try again
          </Button>
        </div>
      )}
      {pulse.kind === 'ready' && !pulse.data.tracked && (
        <p data-testid="history-untracked" className="m-0 text-xs text-(--text-meta)">
          This vault keeps no checkpoints. Turn history on in Settings to keep every version of
          every page.
        </p>
      )}

      {shown.groups.map((group) =>
        group.kind === 'gap' ? (
          <p
            key={`gap-${group.to}`}
            data-testid="history-gap"
            data-state={group.state}
            className="m-0 border-l-2 border-n-100 py-0.5 pl-3 text-2xs text-n-400"
          >
            {group.text}
          </p>
        ) : (
          <section
            key={group.day}
            data-testid="history-day"
            data-day={group.day}
            className="flex flex-col gap-2"
          >
            <h2 className="m-0 text-2xs font-medium uppercase tracking-[0.04em] text-(--text-meta)">
              {dayWords(group.day)}
            </h2>
            {group.items.map((item) => (
              <Item
                key={item.key}
                item={item}
                runs={runs}
                onOpenCommit={(c) => setOpen({ hash: c.hash, message: c.message })}
                onOpenPath={openPath}
                exists={(path) => entries.some((e) => e.path === path)}
              />
            ))}
          </section>
        ),
      )}

      {shown.more && (
        <div>
          <Button
            size="sm"
            testId="history-earlier"
            onClick={() => setDays((n) => n + DAYS_PER_REVEAL)}
          >
            Show earlier
          </Button>
        </div>
      )}

      <p data-testid="history-outside" className="m-0 pt-2 text-2xs text-n-400">
        Edits made outside Cerebro aren't recorded here; they show up only as checkpoints.
      </p>

      {open !== null && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          title={open.message}
          width={760}
          secondaryAction={{ label: 'Close', onClick: () => setOpen(null) }}
        >
          {/* Nothing while the diff is out, and never DiffView's "No changes."
              for a read that failed: that would describe a commit nobody
              looked at. */}
          {diff.kind === 'unavailable' && (
            <p
              data-testid="section-unavailable"
              className="m-0 px-1 py-3 text-sm text-(--text-meta)"
            >
              What this commit changed could not be read, so nothing here is a statement about it.
            </p>
          )}
          {diff.kind === 'ready' && <DiffView diff={diff.data} />}
        </Dialog>
      )}
    </section>
  );
}

function Item({
  item,
  runs,
  onOpenCommit,
  onOpenPath,
  exists,
}: {
  item: FeedItem<ActivityRun>;
  runs: GitRead<CommitRun[]>;
  onOpenCommit: (commit: PulseCommit) => void;
  onOpenPath: (path: string) => void;
  exists: (path: string) => boolean;
}) {
  switch (item.kind) {
    case 'session': {
      const page = item.session.pages.find((p) => exists(p.path));
      return (
        <div
          data-testid="history-session"
          data-actor={item.session.actor ?? ''}
          className="flex min-w-0 items-baseline gap-2 text-sm text-n-800"
        >
          {page === undefined ? (
            <span className="min-w-0 flex-1 truncate">{item.text}</span>
          ) : (
            <button
              type="button"
              onClick={() => onOpenPath(page.path)}
              className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-sm text-n-800 hover:text-cortex-600"
            >
              {item.text}
            </button>
          )}
        </div>
      );
    }
    case 'run': {
      const why = runWhyText(item.run.cause, item.run.started_at);
      const turns = item.runs.length > 1 ? ` · ${item.runs.length} turns` : '';
      // A trace line (M91.14) in the state of the row's latest run, or of a
      // turn of it still going.
      const status = runStatus(
        item.runs.some((run) => run.outcome === 'running')
          ? 'running'
          : (item.runs.at(-1) ?? item.run).outcome,
      );
      return (
        <div
          data-testid="history-run"
          data-run={item.run.run_id}
          title={runText(item, why)}
          className="flex min-w-0 text-sm text-n-800"
        >
          <TraceLine
            status={status.trace}
            statusText={status.statusText}
            className="cb-run-line cb-run-line-sm"
          >
            <StepIcon state={status.state} icon={status.icon} />
            <TraceTitle className="flex-none text-n-800">
              {item.who} ran{turns} ·
            </TraceTitle>
            <RunWhy cause={item.run.cause} startedAt={item.run.started_at} />
            <span className="min-w-0 flex-1 truncate text-2xs text-(--text-meta)">
              · {item.wrote}
              {item.approved ? ' · you allowed it' : ''}
            </span>
          </TraceLine>
        </div>
      );
    }
    case 'commit':
      return (
        <CommitCard
          commit={item.commit}
          runs={runs}
          onOpen={onOpenCommit}
          onOpenPath={onOpenPath}
        />
      );
  }
}

function CommitCard({
  commit: c,
  runs,
  onOpen,
  onOpenPath,
}: {
  commit: PulseCommit;
  runs: GitRead<CommitRun[]>;
  onOpen: (commit: PulseCommit) => void;
  onOpenPath: (path: string) => void;
}) {
  return (
    // The card LOOKS clickable across its width; the message button stays the
    // accessible name and the keyboard target, and clicks that land on a real
    // control (a file chip) are left to it.
    <div
      data-testid="pulse-commit"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button') === null) onOpen(c);
      }}
      className="cursor-pointer rounded-lg border border-n-200 p-3 hover:border-n-300 hover:bg-n-25"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <button
          type="button"
          onClick={() => onOpen(c)}
          className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-sm font-medium text-n-900 hover:text-cortex-600"
        >
          {c.message}
        </button>
        <span className="flex-none [font-family:var(--font-mono)] text-2xs text-n-400">
          {c.shortHash}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-2xs text-(--text-meta)">
        <CommitAuthor commit={c} runs={runs} />
        {runs.kind !== 'loading' && <span>·</span>}
        <span>{relativeDate(c.date)}</span>
        {c.changes === null ? (
          // Not +0 / ~0: nobody counted, so no number is shown.
          <span
            data-testid="pulse-files-unknown"
            className="text-n-400"
            title="The files this commit changed could not be read"
          >
            files unknown
          </span>
        ) : (
          <ChangeCounts changes={c.changes} />
        )}
      </div>
      {c.changes !== null && c.changes.files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {c.changes.files.slice(0, 8).map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onOpenPath(f.path)}
              title={f.path}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-n-200 bg-transparent px-2 py-[2px] text-2xs text-n-600 hover:border-n-400 hover:text-n-900"
            >
              <span className="truncate">{f.title}</span>
            </button>
          ))}
          {c.changes.files.length > 8 && (
            <span className="self-center text-2xs text-n-400">
              +{c.changes.files.length - 8} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** `+1` and `~1` are undecodable without knowing the convention, and colour is
 * the only other cue — so each counter carries its own words for hover and for
 * a screen reader. */
function ChangeCounts({ changes }: { changes: PulseChanges }) {
  const { added, modified, deleted } = changes;
  return (
    <>
      {added > 0 && (
        <span
          className="text-success-600"
          title={`${added} file${added === 1 ? '' : 's'} added`}
          aria-label={`${added} file${added === 1 ? '' : 's'} added`}
        >
          +{added}
        </span>
      )}
      {modified > 0 && (
        <span
          className="text-warn-700"
          title={`${modified} file${modified === 1 ? '' : 's'} changed`}
          aria-label={`${modified} file${modified === 1 ? '' : 's'} changed`}
        >
          ~{modified}
        </span>
      )}
      {deleted > 0 && (
        <span
          className="text-danger-700"
          title={`${deleted} file${deleted === 1 ? '' : 's'} deleted`}
          aria-label={`${deleted} file${deleted === 1 ? '' : 's'} deleted`}
        >
          −{deleted}
        </span>
      )}
    </>
  );
}

/** The feed over History's shared read and the vault's checkpoints. */
export function HistoryFeedSection() {
  const { read, reload } = useVaultActivity();
  const { pulse, reload: reloadPulse } = useVaultPulse();
  return <ActivityFeed read={read} reload={reload} pulse={pulse} reloadPulse={reloadPulse} />;
}
