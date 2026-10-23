/**
 * What a conversation changed (M92.3, Q9), for the rail's Changes card: its
 * runs' commits summed file by file across its turns. Pure: no DOM, no
 * store, no IPC.
 *
 * It is the sum of what each run committed (`engine/changeset.ts`), never a
 * net diff of the vault. A file's kind is the net across its runs: added and
 * then modified stays added; added and then deleted leaves no row, and is
 * noted; a rename renamed again is one rename from where the file began; a
 * file deleted and then written again is the file it was. Its counts add up
 * each run's numstat, and are null, never 0, when any run that changed it
 * left it uncounted: a binary file, a vault with no history, a commit that
 * failed (CV-05). A run that names a path without saying how it changed it
 * (no history, a failed commit) leaves the file's kind null too.
 *
 * A run that said it changed nothing measured zero, and a conversation of
 * such runs is empty. A finished turn that no changeset reached, or whose
 * changeset says not recorded, is not recorded, which never reads as empty.
 */

import type { ChangeKind, RunChangeset } from '@/engine/changeset';

/** One reply's changesets, as its conversation holds them. */
export interface TurnChanges {
  /** The reply's id: where a row its runs changed jumps. */
  turn: string;
  /** Its runs' changesets in run order, two for a turn resumed after a held
   * call; empty where none reached it. */
  changesets: readonly RunChangeset[];
  /** Its turn still runs: what it changes lands when it ends. */
  running?: boolean;
  /** A branch copied it from the conversation it branched from (Q9). */
  copied?: boolean;
}

/** One file the conversation changed. */
export interface ConversationFile {
  /** Where it is now; a deleted file, where it was when deleted. */
  path: string;
  /** How it changed across the conversation; null where a run that changed
   * it named the path without saying how. */
  kind: ChangeKind | null;
  /** Where it was when the conversation began, when that was elsewhere. */
  previousPath?: string;
  /** Summed over every run that changed it; null when any of them left it
   * uncounted, never 0. */
  additions: number | null;
  deletions: number | null;
  /** Who else wrote it, whose edits rode in its commits; null where one of
   * them did not record that (a commit healed from history, M92.12). */
  alsoBy: string[] | null;
  /** The latest reply whose runs changed it: where its row jumps. */
  turn: string;
  /** The latest commit that carried it; null when no run of it committed. */
  commit: string | null;
  /** Only turns a branch copied changed it (Q9). */
  copied: boolean;
}

/** What the changesets say, before the card weighs its own read: nothing
 * changed; rows with every count, and every turn recorded; rows without
 * counts, or some turns not recorded; no turn recorded at all. */
export type ConversationChangesState = 'empty' | 'ready' | 'partial' | 'not_recorded';

export interface ConversationChanges {
  state: ConversationChangesState;
  /** Files whose net kind is added, by path: the card's first group. */
  added: ConversationFile[];
  /** Every other file, by path. */
  others: ConversationFile[];
  /** Files added and then deleted within the conversation, by path: no
   * row, a note. */
  dropped: string[];
  /** Summed over the rows with counts; null when no row has any. */
  additions: number | null;
  deletions: number | null;
  /** Rows without counts. */
  uncounted: number;
  /** Turns whose runs changed files: "across N turns". */
  turns: number;
  /** Of those, the turns a branch copied. */
  copiedTurns: number;
  /** Turns whose changes nobody recorded: finished with no changeset, or
   * holding one that says not recorded. */
  notRecorded: number;
  /** A turn still runs, so its changes have not landed. */
  pending: boolean;
  /** Turns whose runs could not commit what they wrote. */
  uncommitted: number;
  /** A run wrote in a vault that keeps no history. */
  noHistory: boolean;
  /** Turns whose shell commands may have changed files nobody recorded. */
  shellUnrecorded: number;
  /** Every committed run, oldest first: what a commit's diff opens with. */
  commits: { commit: string; runId: string; turn: string }[];
}

/** One file one run named. */
interface Touch {
  path: string;
  /** Null where the run named the path without saying how it changed. */
  kind: ChangeKind | null;
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
  /** Who else rode in the commit: undefined with no commit to ride in,
   * null where the commit did not record that. */
  alsoBy: string[] | null | undefined;
  commit: string | null;
}

/** One file followed across the runs: where it began and where it is. */
interface Chain {
  /** Where it was when the conversation began; null when a run added it. */
  origin: string | null;
  path: string;
  /** A run deleted it, and none wrote it again. */
  gone: boolean;
  /** A run named it without saying how it changed. */
  unknown: boolean;
  /** Every run that changed it counted both sides. */
  counted: boolean;
  additions: number;
  deletions: number;
  alsoBy: string[] | null;
  turn: string;
  commit: string | null;
  copied: boolean;
}

const byPath = (a: string, b: string): number =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

/** A committed run's files, or the paths a run named without its commit. */
function touchesOf(changeset: RunChangeset): Touch[] {
  switch (changeset.state) {
    case 'committed':
      return changeset.files.map((file) => ({
        path: file.path,
        kind: file.kind,
        previousPath: file.previous_path,
        additions: file.additions,
        deletions: file.deletions,
        alsoBy: Array.isArray(file.also_by) ? file.also_by : null,
        commit: changeset.commit,
      }));
    case 'not_a_repo':
    case 'unavailable':
      return changeset.files.map((path) => ({
        path,
        kind: null,
        previousPath: null,
        additions: null,
        deletions: null,
        alsoBy: undefined,
        commit: null,
      }));
    // A run whose changes were not recorded lists none of its files here,
    // as its own footer lists none.
    case 'not_recorded':
    case 'nothing':
      return [];
  }
}

/** A file's kind across the conversation, from where it began and where it
 * is; null where a run named it without saying how it changed. */
function netKind(chain: Chain): ChangeKind | null {
  if (chain.unknown) return null;
  if (chain.origin === null) return 'added';
  if (chain.gone) return 'deleted';
  return chain.origin === chain.path ? 'modified' : 'renamed';
}

/** `turns` oldest first, as the conversation holds them. */
export function foldConversationChanges(turns: readonly TurnChanges[]): ConversationChanges {
  const chains: Chain[] = [];
  /** Chains by the path each is at now. */
  const at = new Map<string, Chain>();
  /** Deleted chains by the path each was deleted at. */
  const gone = new Map<string, Chain>();

  const start = (path: string, origin: string | null): Chain => {
    const chain: Chain = {
      origin,
      path,
      gone: false,
      unknown: false,
      counted: true,
      additions: 0,
      deletions: 0,
      alsoBy: [],
      turn: '',
      commit: null,
      copied: true,
    };
    chains.push(chain);
    at.set(path, chain);
    return chain;
  };

  /** The chain at `path`, or one deleted there, which a run wrote again. */
  const find = (path: string): Chain | undefined => {
    const here = at.get(path);
    if (here !== undefined) return here;
    const back = gone.get(path);
    if (back === undefined) return undefined;
    gone.delete(path);
    back.gone = false;
    at.set(path, back);
    return back;
  };

  const chainOf = (touch: Touch): Chain => {
    const { path } = touch;
    if (touch.kind === 'added') return find(path) ?? start(path, null);
    if (touch.kind === 'deleted') {
      const chain = at.get(path) ?? gone.get(path) ?? start(path, path);
      at.delete(path);
      chain.gone = true;
      gone.set(path, chain);
      return chain;
    }
    return find(path) ?? start(path, path);
  };

  /** One run's renames, moved at once: each takes the file at its previous
   * path before any lands, so a shift (a→b, b→c) keeps both files, and a
   * file added where another moved from starts its own chain, whatever
   * order the run lists them in. */
  const move = (touches: readonly Touch[]): Map<Touch, Chain> => {
    const moves = touches.flatMap((touch) => {
      const from = touch.previousPath;
      if (touch.kind !== 'renamed' || from === null || from === touch.path) return [];
      return [{ touch, chain: at.get(from) ?? start(from, from) }];
    });
    for (const { touch } of moves) at.delete(touch.previousPath as string);
    for (const { touch, chain } of moves) {
      chain.path = touch.path;
      at.set(touch.path, chain);
    }
    return new Map(moves.map(({ touch, chain }) => [touch, chain]));
  };

  const runs = new Set<string>();
  const commits: ConversationChanges['commits'] = [];
  let changedTurns = 0;
  let copiedTurns = 0;
  let notRecorded = 0;
  let measured = 0;
  let uncommitted = 0;
  let shellUnrecorded = 0;
  let pending = false;
  let noHistory = false;

  for (const { turn, changesets, running = false, copied = false } of turns) {
    if (running) pending = true;
    let changed = false;
    let recorded = false;
    let unrecorded = !running && changesets.length === 0;
    let failed = false;
    let shell = false;
    for (const changeset of changesets) {
      // A run is folded once: one listed twice never doubles a count.
      if (changeset.run_id !== null) {
        if (runs.has(changeset.run_id)) continue;
        runs.add(changeset.run_id);
      }
      if (changeset.state === 'not_recorded') {
        unrecorded = true;
        continue;
      }
      recorded = true;
      if (changeset.shell_unrecorded === true) shell = true;
      if (changeset.state === 'not_a_repo') noHistory = true;
      if (changeset.state === 'unavailable') failed = true;
      if (changeset.state === 'committed') {
        commits.push({ commit: changeset.commit, runId: changeset.run_id, turn });
      }
      const touches = touchesOf(changeset);
      const moved = move(touches);
      for (const touch of touches) {
        changed = true;
        const chain = moved.get(touch) ?? chainOf(touch);
        chain.turn = turn;
        chain.copied &&= copied;
        if (touch.kind === null) chain.unknown = true;
        if (touch.additions === null || touch.deletions === null) chain.counted = false;
        else {
          chain.additions += touch.additions;
          chain.deletions += touch.deletions;
        }
        if (touch.commit !== null) chain.commit = touch.commit;
        if (touch.alsoBy === null) chain.alsoBy = null;
        else if (touch.alsoBy !== undefined && chain.alsoBy !== null) {
          const known = chain.alsoBy;
          chain.alsoBy = [...known, ...touch.alsoBy.filter((actor) => !known.includes(actor))];
        }
      }
    }
    if (changed) {
      changedTurns += 1;
      if (copied) copiedTurns += 1;
    }
    if (unrecorded) notRecorded += 1;
    if (recorded) measured += 1;
    if (failed) uncommitted += 1;
    if (shell) shellUnrecorded += 1;
  }

  const added: ConversationFile[] = [];
  const others: ConversationFile[] = [];
  const dropped: string[] = [];
  for (const chain of chains) {
    if (chain.origin === null && chain.gone) {
      dropped.push(chain.path);
      continue;
    }
    const row: ConversationFile = {
      path: chain.path,
      kind: netKind(chain),
      additions: chain.counted ? chain.additions : null,
      deletions: chain.counted ? chain.deletions : null,
      alsoBy: chain.alsoBy,
      turn: chain.turn,
      commit: chain.commit,
      copied: chain.copied,
    };
    if (chain.origin !== null && chain.origin !== chain.path) row.previousPath = chain.origin;
    (row.kind === 'added' ? added : others).push(row);
  }
  added.sort((a, b) => byPath(a.path, b.path));
  others.sort((a, b) => byPath(a.path, b.path));
  dropped.sort(byPath);

  let additions: number | null = null;
  let deletions: number | null = null;
  let uncounted = 0;
  for (const row of [...added, ...others]) {
    if (row.additions === null || row.deletions === null) {
      uncounted += 1;
      continue;
    }
    additions = (additions ?? 0) + row.additions;
    deletions = (deletions ?? 0) + row.deletions;
  }

  const rows = added.length + others.length + dropped.length;
  const state: ConversationChangesState =
    rows === 0
      ? notRecorded === 0
        ? 'empty'
        : measured === 0
          ? 'not_recorded'
          : 'partial'
      : notRecorded > 0 || uncounted > 0
        ? 'partial'
        : 'ready';

  return {
    state,
    added,
    others,
    dropped,
    additions,
    deletions,
    uncounted,
    turns: changedTurns,
    copiedTurns,
    notRecorded,
    pending,
    uncommitted,
    noHistory,
    shellUnrecorded,
    commits,
  };
}
