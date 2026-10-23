import { memo, useId, useState } from 'react';
import {
  GROUP_ROWS,
  pullRequestWords,
  RAIL_CHANGES_WORDS,
  type RailChangeOpen,
  type RailChangeRow,
  type RailChanges,
  type RailChangesNote,
  type RailPullRequest,
} from '@/agent/elements/conversationChanges';
import { openOutside } from '@/agent/rail/ConversationRail';
import { FILE_CHANGE_ICONS } from '@/components/ai/FileTree';
import { RailSection } from '@/components/ai/Rail';
import { Trace, TraceIcon, TraceLine, TraceTitle } from '@/components/ai/Trace';
import { Icon } from '@/components/ui/Icon';
import { motionAllowed } from '@/components/ui/motion';
import { usePullRequest } from '@/detail/usePullRequest';
import { httpUrl } from '@/engine/ai/sources';
import { actorLabel } from '@/engine/authors';
import { alsoByWords } from '@/engine/changeset';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The rail's Changes card (M92.5, §0 Q9): what the conversation changed, as
 * `railChanges` folds it — the files it added, then the rest, then the pull
 * requests its session opened, each with its state as forge.rs reads it,
 * read-only. It says what it cannot count rather than counting it as nothing
 * (CV-05): a turn still at work, turns nobody recorded, files without line
 * counts.
 *
 * A row's first action stays in the canvas: it shows where the file changed,
 * in its turn's changeset in the transcript (TurnChangeset's File Tree), or a
 * pull request where the transcript lists it. Its second, "Open … (leaves
 * full screen)", floats the conversation first (`openOutside`), since the
 * canvas hides the page it opens; a deleted file opens its diff. Every
 * control is a button and a tab stop of its own (WebKit), never an href
 * (CV-16). Folded away, the card asks nothing: a pull request's state is
 * read only while the rail can be seen.
 */

export interface ChangesCardProps {
  changes: RailChanges;
  /** The rail is folded away (M92.1). */
  folded: boolean;
  /** The rail's: closes a drawer without handing focus back, then runs
   *  `go`. */
  jump: (go: () => void) => void;
  /** Open a page of the vault: a row's second action. */
  onOpenPath: (path: string) => void;
  /** Open a file's diff at a commit: a deleted file's second action. Absent
   *  where diffs cannot be shown. */
  onViewDiff?: (path: string, commit: string) => void;
  /** Bring a transcript element into view: the host's transcript scroller,
   *  which keeps a streaming turn from pulling the reader back. Left out,
   *  the browser scrolls it into view. */
  reveal?: (element: HTMLElement) => void;
}

/** Where a row's first action lands. */
type ChangeTarget =
  { kind: 'file'; turn: string; path: string } | { kind: 'pull-request'; url: string };

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** The first control in `within` a reader can reach now, under no closed
 *  fold. */
function reachable(within: Element): HTMLElement | null {
  for (const control of within.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (control.closest('[hidden]') === null) return control;
  }
  return null;
}

/**
 * What a target is in the transcript, and the control to focus there. A
 * file is a row of its turn's changeset, the latest run's first, since its
 * row names the latest reply that changed it: a committed file's File Tree
 * row, or an uncommitted file's line. Where its row is gone, the changeset
 * stands for it; where the reply has none, the reply. A pull request is its
 * link in the list the transcript keeps under the thread.
 */
function targetIn(
  scope: ParentNode,
  target: ChangeTarget,
): { at: HTMLElement; focus: HTMLElement | null } | null {
  if (target.kind === 'pull-request') {
    const list = scope.querySelector<HTMLElement>('[data-testid="thread-pr-links"]');
    if (list === null) return null;
    const href = httpUrl(target.url);
    const link = [...list.querySelectorAll<HTMLAnchorElement>('a[href]')].find(
      (anchor) =>
        href !== null &&
        anchor.getAttribute('href') === href &&
        anchor.closest('[hidden]') === null,
    );
    return link === undefined ? { at: list, focus: reachable(list) } : { at: link, focus: link };
  }
  const reply = [...scope.querySelectorAll<HTMLElement>('[data-message-id]')].find(
    (row) => row.dataset.messageId === target.turn,
  );
  if (reply === undefined) return null;
  const footers = [
    ...reply.querySelectorAll<HTMLElement>('[data-testid="turn-changeset"]'),
  ].reverse();
  for (const footer of footers) {
    const file =
      [...footer.querySelectorAll<HTMLElement>('[data-slot="file-tree-file"]')].find(
        (row) => row.dataset.path === target.path,
      ) ??
      [...footer.querySelectorAll<HTMLElement>('[data-testid="turn-changeset-file"]')].find(
        (row) => row.textContent === target.path,
      );
    if (file !== undefined) return { at: file, focus: reachable(file) ?? reachable(footer) };
  }
  const [latest] = footers;
  return latest === undefined
    ? { at: reply, focus: null }
    : { at: latest, focus: reachable(latest) };
}

/** Scroll to a target and focus it, once. */
function revealIn(
  scope: ParentNode,
  target: ChangeTarget,
  reveal: ((element: HTMLElement) => void) | undefined,
): void {
  const found = targetIn(scope, target);
  if (found === null) return;
  if (reveal !== undefined) reveal(found.at);
  // jsdom has no scrollIntoView.
  else
    found.at.scrollIntoView?.({ block: 'center', behavior: motionAllowed() ? 'smooth' : 'auto' });
  found.focus?.focus({ preventScroll: true });
}

/** A row's second action's label. */
const openLabel = (row: RailChangeRow, open: RailChangeOpen): string =>
  open.kind === 'diff' ? RAIL_CHANGES_WORDS.openDiff(row.name) : RAIL_CHANGES_WORDS.open(row.name);

export const ChangesCard = memo(function ChangesCard({
  changes,
  folded,
  jump,
  onOpenPath,
  onViewDiff,
  reveal,
}: ChangesCardProps) {
  // The rail is the panel's aside's third area (M92.1): the transcript it
  // shows a change in is the aside's own.
  const show = (from: HTMLElement, target: ChangeTarget) => {
    const scope: ParentNode = from.closest('aside') ?? from.ownerDocument;
    jump(() => revealIn(scope, target, reveal));
  };
  const open = (target: RailChangeOpen) =>
    openOutside(() =>
      target.kind === 'page' ? onOpenPath(target.path) : onViewDiff?.(target.path, target.commit),
    );
  // A deleted file's diff is offered only where diffs can be shown.
  const opens = (row: RailChangeRow): RailChangeOpen | null =>
    row.open === null || (row.open.kind === 'diff' && onViewDiff === undefined) ? null : row.open;
  return (
    <RailSection
      data-testid="rail-changes"
      data-pending={changes.pending || undefined}
      title={RAIL_CHANGES_WORDS.title}
      icon="file-diff"
      state={changes.state}
      count={changes.count ?? undefined}
      none={changes.none ?? undefined}
    >
      <div className="flex min-w-0 flex-col gap-2">
        {changes.lead.map((note) => (
          <Note key={note.key} note={note} />
        ))}
        {changes.summary !== null && (
          <p data-testid="rail-changes-summary" className="m-0 text-2xs text-n-500">
            {changes.summary}
          </p>
        )}
        <ChangeGroup
          group="added"
          label={RAIL_CHANGES_WORDS.added}
          rows={changes.added}
          show={show}
          open={open}
          opens={opens}
        />
        <ChangeGroup
          group="changed"
          label={RAIL_CHANGES_WORDS.changed}
          rows={changes.others}
          show={show}
          open={open}
          opens={opens}
        />
        {changes.pullRequests.length > 0 && (
          <PullRequestGroup pullRequests={changes.pullRequests} folded={folded} show={show} />
        )}
        {changes.notes.map((note) => (
          <Note key={note.key} note={note} />
        ))}
      </div>
    </RailSection>
  );
});

/** A failed heal is the card's unavailable sentence (CV-44); every other
 *  note is a quiet line. */
function Note({ note }: { note: RailChangesNote }) {
  return (
    <p
      data-testid={note.key === 'unavailable' ? 'section-unavailable' : 'rail-changes-note'}
      data-note={note.key}
      className="m-0 text-2xs text-n-500"
    >
      {note.text}
    </p>
  );
}

/** One group of files, named, its first rows shown and the rest a press
 *  away. */
function ChangeGroup({
  group,
  label,
  rows,
  show,
  open,
  opens,
}: {
  group: 'added' | 'changed';
  label: string;
  rows: readonly RailChangeRow[];
  show: (from: HTMLElement, target: ChangeTarget) => void;
  open: (target: RailChangeOpen) => void;
  opens: (row: RailChangeRow) => RailChangeOpen | null;
}) {
  const labelId = useId();
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, GROUP_ROWS);
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-group={group}
      className="flex min-w-0 flex-col gap-1.5"
    >
      <GroupLabel id={labelId} label={label} count={rows.length} />
      <Trace role="list">
        {shown.map((row) => (
          <ChangeRowItem key={row.key} row={row} show={show} open={open} opens={opens(row)} />
        ))}
      </Trace>
      {rows.length > GROUP_ROWS && (
        <button
          type="button"
          tabIndex={0}
          aria-expanded={all}
          onClick={() => setAll((was) => !was)}
          className="motion-hover w-fit rounded-xs border-0 bg-transparent p-0 text-2xs text-cortex-600 hover:text-cortex-700"
        >
          {all ? RAIL_CHANGES_WORDS.showFewer : RAIL_CHANGES_WORDS.showAll(rows.length)}
        </button>
      )}
    </div>
  );
}

function GroupLabel({ id, label, count }: { id: string; label: string; count: number }) {
  return (
    <h4 id={id} className="m-0 text-2xs font-medium text-n-500">
      {label} · {count}
    </h4>
  );
}

/** One file: its name and how it changed, which shows where it changed; the
 *  page it opens beside it; where it began and who else wrote it under it. */
function ChangeRowItem({
  row,
  show,
  open,
  opens,
}: {
  row: RailChangeRow;
  show: (from: HTMLElement, target: ChangeTarget) => void;
  open: (target: RailChangeOpen) => void;
  opens: RailChangeOpen | null;
}) {
  const turn = row.turn;
  const meta = [row.folder, row.description].filter((words) => words !== null).join(' · ');
  const line = (
    <>
      <TraceLine>
        <TraceIcon>
          <Icon name={row.kind === null ? 'file' : FILE_CHANGE_ICONS[row.kind]} size={16} />
        </TraceIcon>
        <TraceTitle>
          {turn !== null && <span className="sr-only">{RAIL_CHANGES_WORDS.jump}</span>}
          {row.name}
          {turn !== null && <span className="sr-only">{RAIL_CHANGES_WORDS.jumpAfter}</span>}
        </TraceTitle>
      </TraceLine>
      <span className="pl-6 text-2xs text-n-500 [overflow-wrap:anywhere]">{meta}</span>
    </>
  );
  return (
    <div
      role="listitem"
      data-testid="rail-change"
      data-path={row.path}
      data-kind={row.kind ?? 'unknown'}
      className="flex min-w-0 flex-col gap-0.5"
    >
      <div className="flex min-w-0 items-start gap-1">
        {turn === null ? (
          // A run only the heal read back: no reply in the transcript holds
          // it, so there is nowhere in the canvas to show.
          <span title={row.path} className="flex min-w-0 flex-col items-start gap-0.5">
            {line}
          </span>
        ) : (
          <button
            type="button"
            tabIndex={0}
            title={`${row.path}\n${RAIL_CHANGES_WORDS.show}`}
            onClick={(event) => show(event.currentTarget, { kind: 'file', turn, path: row.path })}
            className="cb-ai-step-link min-w-0 flex-col items-start gap-0.5"
          >
            {line}
          </button>
        )}
        {opens !== null && (
          <button
            type="button"
            tabIndex={0}
            data-testid="rail-change-open"
            aria-label={openLabel(row, opens)}
            title={openLabel(row, opens)}
            onClick={() => open(opens)}
            className="motion-hover ml-auto inline-flex flex-none rounded-xs border-0 bg-transparent p-0.5 text-n-400 hover:text-n-800"
          >
            <Icon name="arrow-up-right" size={14} />
          </button>
        )}
      </div>
      {row.previousPath !== null && (
        <p className="m-0 pl-6 text-2xs text-n-500 [overflow-wrap:anywhere]">
          {RAIL_CHANGES_WORDS.from(row.previousPath)}
        </p>
      )}
      {(row.alsoBy === null || row.alsoBy.length > 0) && <AlsoBy actors={row.alsoBy} />}
    </div>
  );
}

/** Who else wrote a file, by name; a commit healed from history did not
 *  record it, and says so. */
function AlsoBy({ actors }: { actors: readonly string[] | null }) {
  const entries = useVaultStore((s) => s.entries);
  const words =
    actors === null
      ? RAIL_CHANGES_WORDS.alsoByNotRecorded
      : alsoByWords([...actors], (actor) => actorLabel(actor, entries).text);
  return words === null ? null : <p className="m-0 pl-6 text-2xs text-n-500">{words}</p>;
}

function PullRequestGroup({
  pullRequests,
  folded,
  show,
}: {
  pullRequests: readonly RailPullRequest[];
  folded: boolean;
  show: (from: HTMLElement, target: ChangeTarget) => void;
}) {
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-group="pull-requests"
      className="flex min-w-0 flex-col gap-1.5"
    >
      <GroupLabel
        id={labelId}
        label={RAIL_CHANGES_WORDS.pullRequests}
        count={pullRequests.length}
      />
      <Trace role="list">
        {pullRequests.map((pr) => (
          <div
            key={pr.key}
            role="listitem"
            data-testid="rail-change-pr"
            data-url={pr.url}
            className="flex min-w-0"
          >
            <button
              type="button"
              tabIndex={0}
              title={`${pr.url}\n${RAIL_CHANGES_WORDS.showPullRequest}`}
              onClick={(event) => show(event.currentTarget, { kind: 'pull-request', url: pr.url })}
              className="cb-ai-step-link min-w-0 flex-col items-start gap-0.5"
            >
              <TraceLine>
                <TraceIcon>
                  <Icon name="git-pull-request" size={16} />
                </TraceIcon>
                <TraceTitle>
                  <span className="sr-only">{RAIL_CHANGES_WORDS.jumpPullRequest}</span>
                  {pr.name}
                </TraceTitle>
              </TraceLine>
              {/* Read only while the rail can be seen. */}
              {!folded && <PullRequestState url={pr.url} />}
            </button>
          </div>
        ))}
      </Trace>
    </div>
  );
}

/** A pull request's state, as forge.rs reads it through gh, read-only and
 *  cached there: never refreshed from here. */
function PullRequestState({ url }: { url: string }) {
  const { read } = usePullRequest(url);
  return (
    <span
      data-testid="rail-change-pr-state"
      data-state={
        read === null
          ? 'loading'
          : read.state === 'read'
            ? read.pr.state.toLowerCase()
            : 'unavailable'
      }
      className="pl-6 text-2xs text-n-500"
    >
      {pullRequestWords(read)}
    </span>
  );
}
