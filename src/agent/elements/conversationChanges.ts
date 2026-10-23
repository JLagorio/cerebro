import type { ChatMessage, PrLink } from '@/agent/types';
import { FILE_CHANGE_WORDS } from '@/components/ai/FileTree';
import type { RailSectionState } from '@/components/ai/Rail';
import { plural, vaultPathOf } from '@/components/ai/StepLine';
import {
  foldConversationChanges,
  type ConversationChanges,
  type ConversationFile,
  type TurnChanges,
} from '@/engine/ai/conversationChanges';
import { CHANGESET_WORDS, type ChangeKind, type RunChangeset } from '@/engine/changeset';
import {
  parsePullRequestUrl,
  readinessOf,
  type PrFailure,
  type PrRead,
} from '@/engine/pullRequest';

/**
 * The rail's Changes card (M92.5, §0 Q9): what the conversation changed, its
 * replies' changesets summed file by file across its turns
 * (engine/ai/conversationChanges.ts), the files it added first, then the
 * rest, then the pull requests its session opened. Never a net diff of the
 * vault, and never "+0 −0": a total with no line counted, or none changed,
 * says nothing of lines (CV-05). Pure.
 *
 * Each reply holds its runs' changesets, live or cached with the thread
 * (M58.3); a reply rebuilt from the session file holds none. The heal
 * (M92.12, `conversation_changes`) reads a session's runs back from
 * Cerebro's records, and is folded in for the runs no reply holds: a live
 * or cached changeset wins per run id. Until the rail asks it, `heal` is
 * absent and the card reads the replies alone.
 *
 * A branch's replies up to the one it branched from are copies (M91.6),
 * and say so, row by row. The turn at work changes what it changes when it
 * ends, which the card says rather than reading as nothing changed.
 */

/**
 * What the heal read back (M92.12): the changesets of the conversation's
 * session's runs, oldest first, and whether its cap left runs out; or that
 * the read failed.
 */
export type ChangesHeal =
  | { state: 'read'; changesets: readonly RunChangeset[]; truncated?: boolean }
  | { state: 'unavailable' };

export interface RailChangesInput {
  messages: readonly ChatMessage[];
  /** A turn is in flight, a wait on the person's answer included
   *  (`AgentChat.streaming`): its reply's changes land when it ends. */
  inFlight: boolean;
  /** The conversation's own Claude Code session: a reply that ended in
   *  another was copied by a branch. */
  sessionId: string | null;
  /** The pull requests the conversation's session opened (M56.3). */
  prLinks: readonly PrLink[];
  heal?: ChangesHeal | null;
}

/** A row's second action, which opens a page and so leaves the canvas: the
 *  file's page, or, for a file the conversation deleted, its diff at the
 *  commit that deleted it. */
export type RailChangeOpen =
  { kind: 'page'; path: string } | { kind: 'diff'; path: string; commit: string };

/** One file the conversation changed, as its row reads. */
export interface RailChangeRow {
  key: string;
  path: string;
  /** The path's last segment: the row's title. */
  name: string;
  /** Where it sits, or null at the vault's root. */
  folder: string | null;
  /** Null where a run named it without saying how it changed. */
  kind: ChangeKind | null;
  /** Where a renamed file began the conversation. */
  previousPath: string | null;
  /** Its line after the name: how it changed, its lines, and that a branch
   *  copied it. */
  description: string;
  /** Who else wrote it, whose edits rode in its commits; null where a commit
   *  did not record that. */
  alsoBy: readonly string[] | null;
  /** The reply whose changeset lists it, where its row jumps; null for a run
   *  only the heal read back, which no reply holds. */
  turn: string | null;
  open: RailChangeOpen | null;
}

/** A pull request the session opened. */
export interface RailPullRequest {
  key: string;
  url: string;
  /** As its repository writes it: `owner/repo#12`. */
  name: string;
}

/** A sentence the card says beside its rows; `key` names which. */
export interface RailChangesNote {
  key:
    | 'unavailable'
    | 'pending'
    | 'not-recorded'
    | 'uncommitted'
    | 'no-history'
    | 'shell'
    | 'dropped'
    | 'copied'
    | 'truncated';
  text: string;
}

export interface RailChanges {
  /** The card's state (CV-44): the fold's, with a failed heal laid over it,
   *  and a card that holds pull requests, a caveat or a turn that could not
   *  commit never empty. */
  state: RailSectionState;
  /** A turn is at work, and what it changes lands when it ends. */
  pending: boolean;
  /** What an empty card's heading line says after its name; null for "None". */
  none: string | null;
  /** The heading line's count: its files, else its pull requests. */
  count: string | null;
  added: readonly RailChangeRow[];
  others: readonly RailChangeRow[];
  pullRequests: readonly RailPullRequest[];
  /** "+12 −3 across 3 turns", and how many files its lines leave out; null
   *  when no turn changed a file. */
  summary: string | null;
  /** What the card says before its rows: that the heal failed, that a turn
   *  is at work. */
  lead: readonly RailChangesNote[];
  /** What it says after them. */
  notes: readonly RailChangesNote[];
  /** Every committed run, oldest first: the run a turn's commit opens with. */
  commits: ConversationChanges['commits'];
}

export const RAIL_CHANGES_WORDS = {
  title: 'Changes',
  /** The rest of an empty card's heading line while a turn is at work, so
   *  the line reads "Changes land when this turn ends". */
  pendingTail: ' land when this turn ends',
  pending: 'Changes land when this turn ends.',
  notRecorded: (turns: number) => `Changes not recorded for ${plural(turns, 'turn', 'turns')}.`,
  uncommitted: (turns: number) =>
    `Couldn't commit the changes of ${plural(turns, 'turn', 'turns')}.`,
  noHistory: CHANGESET_WORDS.notARepo,
  shell: (turns: number) =>
    `Shell commands in ${plural(turns, 'turn', 'turns')} may have changed other files; those aren't recorded here.`,
  dropped: (names: string) => `Added and then deleted: ${names}.`,
  more: (count: number) => `${count} more`,
  copied: (turns: number) =>
    `${plural(turns, 'turn was', 'turns were')} copied when this conversation branched.`,
  unavailable: "Couldn't read back this conversation's earlier changes.",
  truncated: 'Not every earlier run was read back.',
  files: (count: number) => plural(count, 'file', 'files'),
  pullRequestCount: (count: number) => plural(count, 'pull request', 'pull requests'),
  across: (turns: number) => `across ${plural(turns, 'turn', 'turns')}`,
  uncounted: (files: number) => `${plural(files, 'file', 'files')} without line counts`,
  added: 'Added',
  changed: 'Changed',
  pullRequests: 'Pull requests',
  binary: CHANGESET_WORDS.binary,
  noLines: 'no line changes',
  notCommitted: 'not committed',
  copiedRow: 'copied',
  from: (path: string) => `from ${path}`,
  alsoByNotRecorded: 'who else edited it: not recorded',
  /** Around a file's name in its first action's name: where it goes. */
  jump: 'Jump to where ',
  jumpAfter: ' changed',
  jumpPullRequest: 'Jump to ',
  show: 'Show where it changed in the conversation',
  showPullRequest: 'Show it in the conversation',
  open: (name: string) => `Open ${name} (leaves full screen)`,
  openDiff: (name: string) => `Open the diff of ${name} (leaves full screen)`,
  showAll: (count: number) => `Show all ${count}`,
  showFewer: 'Show fewer',
  prReading: 'reading…',
  prState: (words: string) => `state unavailable: ${words}`,
} as const;

/** A pull request's read that failed, in a row's few words. */
const PR_FAILURE_WORDS: Readonly<Record<PrFailure, string>> = {
  invalid_url: 'not a GitHub pull request',
  gh_missing: "gh isn't installed",
  not_signed_in: 'gh is not signed in',
  not_found: 'not found',
  offline: "GitHub couldn't be reached",
  rate_limited: 'GitHub is limiting reads',
  gh_outdated: 'gh needs an update',
  timed_out: 'the read timed out',
  unreadable: "GitHub's answer couldn't be read",
  failed: 'the read failed',
};

/** Where a pull request stands, from forge.rs's read-only read: still
 *  reading, merged, closed, a draft, or open with its checks' readiness; a
 *  read that failed says why, and never reads as open. */
export function pullRequestWords(read: PrRead | null): string {
  if (read === null) return RAIL_CHANGES_WORDS.prReading;
  if (read.state !== 'read') {
    return RAIL_CHANGES_WORDS.prState(PR_FAILURE_WORDS[read.state] ?? PR_FAILURE_WORDS.failed);
  }
  const { pr } = read;
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.state !== 'OPEN') return 'state unknown';
  if (pr.isDraft === true) return 'draft';
  switch (readinessOf(read)) {
    case 'ready':
      return 'open · ready';
    case 'not_ready':
      return 'open · not ready';
    case 'no_checks':
      return 'open · no checks';
    default:
      return 'open · checks unknown';
  }
}

/** How many rows a group shows before "Show all". */
export const GROUP_ROWS = 8;
/** How many names the note on added-then-deleted files spells out. */
const DROPPED_NAMES = 3;

const NO_CHANGESETS: readonly RunChangeset[] = [];
/** A run only the heal read back stands for a turn of its own, under an id
 *  no reply has: Cerebro's records do not say which reply it ran for. */
const HEALED = 'healed:';

/** The reply of the turn in flight: the last assistant message after the
 *  last user message, which a held call leaves waiting rather than done. */
function liveReply(messages: readonly ChatMessage[]): string | null {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message.role === 'user') return null;
    if (message.role === 'assistant') return message.id;
  }
  return null;
}

/** Where a branch's copies end: the last reply that ended in another
 *  session than the conversation's own, or -1. A branch copies the thread
 *  up to the reply it branched from (M91.6), so every reply before that one
 *  is a copy too, one cut off before it named its session among them. */
function copiedThrough(messages: readonly ChatMessage[], sessionId: string | null): number {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const { role, anchor } = messages[at];
    if (role === 'assistant' && anchor !== undefined && anchor.sessionId !== sessionId) return at;
  }
  return -1;
}

/** Each reply's changesets, as the conversation holds them. */
function replyTurns({ messages, inFlight, sessionId }: RailChangesInput): TurnChanges[] {
  const live = inFlight ? liveReply(messages) : null;
  const copies = copiedThrough(messages, sessionId);
  const turns: TurnChanges[] = [];
  messages.forEach((message, at) => {
    if (message.role !== 'assistant') return;
    const turn: TurnChanges = { turn: message.id, changesets: message.changesets ?? NO_CHANGESETS };
    if (message.id === live) turn.running = true;
    if (at <= copies) turn.copied = true;
    turns.push(turn);
  });
  return turns;
}

/**
 * The replies' turns with what the heal read back. A run a reply holds is
 * folded from the reply, live or cached; each run only the heal read is a
 * turn of its own, before the replies', as the replies that lost theirs are
 * the older ones (a thread rebuilt from its session file, or trimmed to fit
 * the store). A finished reply of the conversation's own that holds no
 * changeset ran at least one run, so each run only the heal read stands for
 * at most one such reply, oldest first, which is then no longer counted as
 * not recorded. Replies past the runs it read stay not recorded: a heal that
 * found fewer runs than that, or none, never reads them as unchanged
 * (CV-05). A branch's copies ran in the session it branched from, which the
 * heal does not read.
 */
function withHeal(turns: readonly TurnChanges[], heal: ChangesHeal | null): TurnChanges[] {
  if (heal === null || heal.state !== 'read') return [...turns];
  const held = new Set<string>();
  for (const turn of turns) {
    for (const changeset of turn.changesets) {
      if (changeset.run_id !== null) held.add(changeset.run_id);
    }
  }
  const healed: TurnChanges[] = [];
  for (const changeset of heal.changesets) {
    // A changeset that names no run cannot be told from one a reply holds.
    if (changeset.run_id === null || held.has(changeset.run_id)) continue;
    held.add(changeset.run_id);
    healed.push({ turn: `${HEALED}${changeset.run_id}`, changesets: [changeset] });
  }
  let unclaimed = healed.length;
  const kept = turns.filter((turn) => {
    if (turn.running === true || turn.copied === true || turn.changesets.length > 0) return true;
    if (unclaimed === 0) return true;
    unclaimed -= 1;
    return false;
  });
  return [...healed, ...kept];
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A file's lines in words: "+a −b", "no line changes" for a counted zero,
 *  "binary" where git counted none, or nothing where no commit said how it
 *  changed. Never "+0 −0" (CV-05). */
function linesOf(file: ConversationFile): string | null {
  if (file.additions === null || file.deletions === null) {
    return file.kind === null ? null : RAIL_CHANGES_WORDS.binary;
  }
  if (file.additions === 0 && file.deletions === 0) return RAIL_CHANGES_WORDS.noLines;
  return `+${file.additions} −${file.deletions}`;
}

function rowOf(file: ConversationFile, replies: ReadonlySet<string>): RailChangeRow {
  const slash = file.path.lastIndexOf('/');
  const description = [
    file.kind === null ? RAIL_CHANGES_WORDS.notCommitted : FILE_CHANGE_WORDS[file.kind],
    linesOf(file),
    file.copied ? RAIL_CHANGES_WORDS.copiedRow : null,
  ]
    .filter((words) => words !== null)
    .join(' · ');
  // A deleted file has no page left: its diff at the commit that deleted it
  // shows what went.
  const open: RailChangeOpen | null =
    file.kind === 'deleted'
      ? file.commit === null
        ? null
        : { kind: 'diff', path: file.path, commit: file.commit }
      : vaultPathOf(file.path) === null
        ? null
        : { kind: 'page', path: file.path };
  return {
    key: `${file.kind ?? 'unknown'}:${file.path}`,
    path: file.path,
    name: nameOf(file.path),
    folder: slash > 0 ? file.path.slice(0, slash) : null,
    kind: file.kind,
    previousPath: file.previousPath ?? null,
    description,
    alsoBy: file.alsoBy,
    turn: replies.has(file.turn) ? file.turn : null,
    open,
  };
}

function pullRequestsOf(links: readonly PrLink[]): RailPullRequest[] {
  const seen = new Set<string>();
  const rows: RailPullRequest[] = [];
  for (const link of links) {
    const key = parsePullRequestUrl(link.url)?.key ?? link.url;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, url: link.url, name: `${link.repository}#${link.number}` });
  }
  return rows;
}

function droppedWords(paths: readonly string[]): string {
  const names = paths.slice(0, DROPPED_NAMES).map(nameOf);
  const rest = paths.length - names.length;
  if (rest > 0) names.push(RAIL_CHANGES_WORDS.more(rest));
  return names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The fold's lines and turns: "+12 −3 across 3 turns", lines only where
 *  some were counted and changed, and how many files they leave out. */
function summaryOf(fold: ConversationChanges): string | null {
  if (fold.turns === 0) return null;
  const across = RAIL_CHANGES_WORDS.across(fold.turns);
  const counted =
    fold.additions !== null && fold.deletions !== null && fold.additions + fold.deletions > 0;
  if (!counted) return `${across.charAt(0).toUpperCase()}${across.slice(1)}`;
  const lines = `+${fold.additions} −${fold.deletions} ${across}`;
  return fold.uncounted > 0 ? `${lines} · ${RAIL_CHANGES_WORDS.uncounted(fold.uncounted)}` : lines;
}

function changesOf(input: RailChangesInput, replies: readonly TurnChanges[]): RailChanges {
  const heal = input.heal ?? null;
  const fold = foldConversationChanges(withHeal(replies, heal));
  const ids = new Set(replies.map((turn) => turn.turn));
  const added = fold.added.map((file) => rowOf(file, ids));
  const others = fold.others.map((file) => rowOf(file, ids));
  const pullRequests = pullRequestsOf(input.prLinks);
  const truncated = heal?.state === 'read' && heal.truncated === true;

  const notes: RailChangesNote[] = [];
  if (fold.notRecorded > 0) {
    notes.push({ key: 'not-recorded', text: RAIL_CHANGES_WORDS.notRecorded(fold.notRecorded) });
  }
  // Said with rows or without: a run that ended while Cerebro quit names no
  // file when its writes were not known (changeset::quitting), so a turn
  // that could not commit is never read as one that changed nothing.
  if (fold.uncommitted > 0) {
    notes.push({ key: 'uncommitted', text: RAIL_CHANGES_WORDS.uncommitted(fold.uncommitted) });
  }
  if (fold.noHistory) notes.push({ key: 'no-history', text: RAIL_CHANGES_WORDS.noHistory });
  if (fold.shellUnrecorded > 0) {
    notes.push({ key: 'shell', text: RAIL_CHANGES_WORDS.shell(fold.shellUnrecorded) });
  }
  if (fold.dropped.length > 0) {
    notes.push({ key: 'dropped', text: RAIL_CHANGES_WORDS.dropped(droppedWords(fold.dropped)) });
  }
  if (fold.copiedTurns > 0) {
    notes.push({ key: 'copied', text: RAIL_CHANGES_WORDS.copied(fold.copiedTurns) });
  }
  if (truncated) notes.push({ key: 'truncated', text: RAIL_CHANGES_WORDS.truncated });

  // The fold says what the changesets say; the card weighs its own read
  // over it. A failed heal is unavailable, whatever the replies hold. Where
  // the fold found nothing, a turn that could not commit, a shell that may
  // have changed files unrecorded, or a capped heal leaves it unknown, never
  // "None"; pull requests alone are something to show.
  const quiet = fold.state === 'empty';
  const state: RailSectionState =
    heal?.state === 'unavailable'
      ? 'unavailable'
      : fold.state === 'not_recorded'
        ? 'not-recorded'
        : fold.state === 'partial' ||
            truncated ||
            (quiet && (fold.uncommitted > 0 || fold.shellUnrecorded > 0))
          ? 'partial'
          : quiet && pullRequests.length === 0
            ? 'empty'
            : 'ready';

  const lead: RailChangesNote[] = [];
  if (state === 'unavailable')
    lead.push({ key: 'unavailable', text: RAIL_CHANGES_WORDS.unavailable });
  if (fold.pending && state !== 'empty') {
    lead.push({ key: 'pending', text: RAIL_CHANGES_WORDS.pending });
  }

  const files = added.length + others.length;
  return {
    state,
    pending: fold.pending,
    none: state === 'empty' && fold.pending ? RAIL_CHANGES_WORDS.pendingTail : null,
    count:
      files > 0
        ? RAIL_CHANGES_WORDS.files(files)
        : pullRequests.length > 0
          ? RAIL_CHANGES_WORDS.pullRequestCount(pullRequests.length)
          : null,
    added,
    others,
    pullRequests,
    summary: summaryOf(fold),
    lead,
    notes,
    commits: fold.commits,
  };
}

const sameTurns = (a: readonly TurnChanges[], b: readonly TurnChanges[]): boolean =>
  a.length === b.length &&
  a.every(
    (turn, at) =>
      turn.turn === b[at].turn &&
      turn.changesets === b[at].changesets &&
      turn.running === b[at].running &&
      turn.copied === b[at].copied,
  );

/** The same answer from the heal: a failure, or the same changesets read. */
const sameHeal = (a: ChangesHeal | null, b: ChangesHeal | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    (a.state === 'read'
      ? b.state === 'read' && a.changesets === b.changesets && a.truncated === b.truncated
      : b.state === 'unavailable'));

/** The last card made, and what it was made from. */
let last: {
  replies: readonly TurnChanges[];
  prLinks: readonly PrLink[];
  heal: ChangesHeal | null;
  changes: RailChanges;
} | null = null;

/**
 * The conversation's changes, as the card shows them. The same object comes
 * back while the replies' changesets, which turn is at work and which were
 * copied, the pull requests and the heal's answer are the same: a reply's
 * changesets change only when a run's Changeset lands, so a turn's stream
 * never hands the rail a new one.
 */
export function railChanges(input: RailChangesInput): RailChanges {
  const replies = replyTurns(input);
  const heal = input.heal ?? null;
  if (
    last !== null &&
    last.prLinks === input.prLinks &&
    sameHeal(last.heal, heal) &&
    sameTurns(last.replies, replies)
  ) {
    return last.changes;
  }
  const changes = changesOf(input, replies);
  last = { replies, prLinks: input.prLinks, heal, changes };
  return changes;
}

/** The run whose commit `commit` is, which a turn's diff opens with so notes
 *  left on its lines go back to it (M58.5); null when no run of the
 *  conversation made it. */
export function runOfCommit(changes: RailChanges, commit: string): string | null {
  return changes.commits.find((made) => made.commit === commit)?.runId ?? null;
}
