import { useMemo, useState, type ReactNode } from 'react';
import { runStatus } from '@/agent/elements/runs';
import { StepIcon } from '@/components/ai/StepLine';
import { TraceLine, TraceTitle } from '@/components/ai/Trace';
import { dayKeyOf, foldTimeline, pageDays, pageTimeline, type PageEntry } from '@/engine/activity';
import type { CommitRun, FileCommit } from '@/engine/git';
import { isKnowledgePath } from '@/engine/okf';
import {
  CommitRow,
  HISTORY_UNREADABLE,
  UncommittedRow,
  historyQueries,
} from '@/git/GitHistoryPanel';
import { useCommitRuns, useGit, type GitRead } from '@/git/useGit';
import type { ActivityRun } from '@/lib/ipc';
import { RunWhy } from '@/status/RunWhy';
import { useVaultStore } from '@/stores/vaultStore';
import { usePageActivity } from './usePageActivity';
import '@/status/runs.css';

/** How many of a page's newest rows show before the fold (Q13). */
export const PAGE_HISTORY_KEEP = 8;

/** What each lane says when it could not be read, or has nothing to say. */
export const PAGE_HISTORY_WORDS = {
  writes: 'Edits could not be read, so no row here says who edited this page.',
  runs: 'Agent runs could not be read, so none are listed here.',
  recordingSince: 'When Cerebro began recording edits could not be read.',
  knowledge: 'Knowledge changes could not be read.',
  noLedger: "This vault keeps no ledger, so Knowledge changes aren't listed.",
  noConceptEvents: 'No Knowledge changes are recorded for this page.',
  notRecorded:
    "Cerebro hasn't recorded an edit in this vault yet; the versions below are the only record.",
  notRecordedAlone: "Cerebro hasn't recorded an edit in this vault yet.",
  attribution: "Whether this page changed outside Cerebro couldn't be read.",
  gitOff:
    'History is off: this vault keeps no history. Turn it on in Settings to keep every version of every page.',
  noVersions:
    'No versions yet. A version appears here each time this page is committed to history.',
  empty: 'No history yet for this page.',
} as const;

const NO_COMMITS: FileCommit[] = [];

/**
 * One page's History (M64.2b, D18): the side panel's History, on docs and
 * concepts alike. Its versions (M58.4) and what Cerebro recorded share one
 * timeline, newest day first, and are never blended: a commit is its own row
 * (`CommitRow`, named from the commit record alone, CV-35), a session is one
 * writer's stretch of edits, a run speaks for the sessions it wrote, and on a
 * concept the ledger's events stand in for the file's writes.
 *
 * Every read fails alone (CV-05): edits, versions, Knowledge changes and
 * whether the page changed outside Cerebro each say on their own line that
 * they could not be read, while the rest still render. A seam marks where
 * Cerebro began recording edits after the page's oldest version, and a top
 * line says the page changed outside Cerebro. The newest eight rows show,
 * the oldest stays pinned, and the rest fold behind "Show N more".
 *
 * The timeline keeps M58.4's `git-history` testid, so a page's versions are
 * found where they always were.
 */
export function PageHistory({ path }: { path: string }) {
  const { activity, history, attribution } = usePageActivity(path);
  const git = useGit();
  const entries = useVaultStore((s) => s.entries);
  const [unfolded, setUnfolded] = useState(false);
  const commits = history.kind === 'ready' ? history.data : null;
  const queries = useMemo(() => historyQueries(commits ?? NO_COMMITS), [commits]);
  const runs = useCommitRuns(queries);
  const isKnowledge = isKnowledgePath(path);
  const gitOff = git.ready && !git.isRepo;

  const timeline = useMemo(
    () =>
      pageTimeline({
        activity: activity.kind === 'ready' ? activity.data : null,
        commits: gitOff ? null : commits,
        attribution: attribution.kind === 'ready' ? attribution.data : null,
        isKnowledge,
        entries,
      }),
    [activity, commits, attribution, gitOff, isKnowledge, entries],
  );

  if (activity.kind === 'loading' || attribution.kind === 'loading') return null;
  if (history.kind === 'loading' && !gitOff) return null;

  const read = activity.kind === 'ready' ? activity.data : null;
  const pending = !gitOff && git.modified.some((f) => f.path === path);
  const lines: ReactNode[] = [];
  const unavailable = (lane: string, text: string) =>
    lines.push(
      <p key={lane} data-testid="section-unavailable" data-lane={lane} className={LINE}>
        {text}
      </p>,
    );
  const said = (testid: string, text: string) =>
    lines.push(
      <p key={testid} data-testid={testid} className={LINE}>
        {text}
      </p>,
    );

  if (attribution.kind === 'unavailable')
    unavailable('attribution', PAGE_HISTORY_WORDS.attribution);
  if (read === null || read.writes.state === 'unavailable') {
    unavailable('writes', PAGE_HISTORY_WORDS.writes);
  } else if (read.runs.state === 'unavailable') {
    unavailable('runs', PAGE_HISTORY_WORDS.runs);
  }
  if (read !== null && read.recording_since.state === 'unavailable') {
    unavailable('recording_since', PAGE_HISTORY_WORDS.recordingSince);
  } else if (
    read !== null &&
    read.recording_since.state === 'read' &&
    read.recording_since.at === null
  ) {
    const versions = (commits?.length ?? 0) > 0;
    said(
      'page-history-not-recorded',
      versions ? PAGE_HISTORY_WORDS.notRecorded : PAGE_HISTORY_WORDS.notRecordedAlone,
    );
  }
  if (isKnowledge) {
    // The page read carries the Knowledge lane: when it failed, so did that.
    const lane = read === null ? null : read.knowledge;
    if (lane === null || lane.state === 'unavailable') {
      unavailable('knowledge', PAGE_HISTORY_WORDS.knowledge);
    } else if (lane.state === 'not_recorded') {
      said('page-history-no-ledger', PAGE_HISTORY_WORDS.noLedger);
    } else if (lane.events.length === 0) {
      said('page-history-no-concept-events', PAGE_HISTORY_WORDS.noConceptEvents);
    }
  }
  if (gitOff) said('page-history-git-off', PAGE_HISTORY_WORDS.gitOff);
  else if (history.kind === 'unavailable') unavailable('versions', HISTORY_UNREADABLE);

  const rows = timeline.entries;
  const empty =
    rows.length === 0 &&
    timeline.outside === null &&
    !pending &&
    lines.length === 0 &&
    read !== null &&
    read.writes.state === 'read';
  if (!gitOff && commits !== null && commits.length === 0 && !pending && rows.length > 0) {
    said('page-history-no-versions', PAGE_HISTORY_WORDS.noVersions);
  }

  const fold = unfolded
    ? { shown: rows, hidden: 0, pinned: null }
    : foldTimeline(rows, PAGE_HISTORY_KEEP);
  const today = dayKeyOf(Date.now());

  return (
    <section data-testid="page-history" className="flex flex-col gap-2 py-1.5">
      {timeline.outside !== null && (
        <p
          data-testid="page-history-outside"
          className="m-0 border-l-2 border-warn-300 px-1.5 pl-2.5 text-xs text-n-700"
        >
          {timeline.outside}
        </p>
      )}
      {lines}
      {empty && (
        <p data-testid="page-history-empty" className="m-0 px-1.5 py-2 text-sm text-n-600">
          {PAGE_HISTORY_WORDS.empty}
        </p>
      )}
      <div data-testid="git-history" data-variant="panel" className="flex flex-col gap-2">
        {pending && <UncommittedRow path={path} />}
        <Days entries={fold.shown} today={today} path={path} runs={runs} />
        {fold.hidden > 0 && (
          <button
            type="button"
            data-testid="page-history-more"
            onClick={() => setUnfolded(true)}
            className="self-start border-0 bg-transparent px-1.5 py-0.5 text-2xs text-cortex-600 hover:underline"
          >
            Show {fold.hidden} more
          </button>
        )}
        {fold.pinned !== null && (
          <Days entries={[fold.pinned]} today={today} path={path} runs={runs} />
        )}
      </div>
    </section>
  );
}

const LINE = 'm-0 px-1.5 text-xs text-n-500';

function Days({
  entries,
  today,
  path,
  runs,
}: {
  entries: PageEntry<ActivityRun>[];
  today: string;
  path: string;
  runs: GitRead<CommitRun[]>;
}) {
  return (
    <>
      {pageDays(entries, today).map((group) => (
        <div
          key={`${group.day ?? 'untimed'}:${group.entries[0].key}`}
          className="flex flex-col gap-1.5"
        >
          <h3
            data-testid="page-history-day"
            className="m-0 px-1.5 pt-1 text-metadata font-medium text-n-500"
          >
            {group.label}
          </h3>
          {group.entries.map((entry) => (
            <Row key={entry.key} entry={entry} path={path} runs={runs} />
          ))}
        </div>
      ))}
    </>
  );
}

function Row({
  entry,
  path,
  runs,
}: {
  entry: PageEntry<ActivityRun>;
  path: string;
  runs: GitRead<CommitRun[]>;
}) {
  switch (entry.kind) {
    case 'commit':
      return <CommitRow commit={entry.commit} path={path} runs={runs} />;
    case 'session':
      return (
        <div
          data-testid="history-session"
          data-actor={entry.session.actor ?? ''}
          className="border-l-2 border-cortex-200 pl-2.5 text-xs text-n-800"
        >
          {entry.text}
        </div>
      );
    case 'run': {
      // A trace line in its run's state (M91.14): its icon and ink, and its
      // word for a screen reader.
      const status = runStatus(entry.run.outcome);
      return (
        <div
          data-testid="history-run"
          data-run={entry.run.run_id}
          className="flex min-w-0 border-l-2 border-synapse-200 pl-2.5 text-xs text-n-800"
        >
          <TraceLine
            status={status.trace}
            statusText={status.statusText}
            className="cb-run-line cb-run-line-xs"
          >
            <StepIcon state={status.state} icon={status.icon} />
            <TraceTitle className="flex-none text-n-800">{entry.text} ·</TraceTitle>
            <RunWhy cause={entry.run.cause} startedAt={entry.run.started_at} />
          </TraceLine>
        </div>
      );
    }
    case 'concept':
      return (
        <div
          data-testid="history-concept"
          data-kind={entry.event.kind}
          title={entry.event.run_id === null ? undefined : `run ${entry.event.run_id}`}
          className="border-l-2 border-synapse-200 pl-2.5 text-xs text-n-800"
        >
          {entry.text}
        </div>
      );
    case 'seam':
      return (
        <p
          data-testid="page-history-seam"
          className="m-0 border-t border-dashed border-n-200 px-1.5 pt-1.5 text-2xs text-n-500"
        >
          {entry.text}
        </p>
      );
  }
}
