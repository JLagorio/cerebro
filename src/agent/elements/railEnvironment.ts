import type { RunReach } from '@/agent/types';
import type { RailSectionState } from '@/components/ai/Rail';
import { listAgents } from '@/engine/agents';
import { countsUnknown, UNCOUNTED_WORDS } from '@/engine/git';
import type { Entry } from '@/engine/types';
import { SYNC_TONE, syncCount } from '@/git/SyncBadge';
import type { GitState } from '@/git/useGit';
import type { Decision } from '@/lib/policy/toolApproval';

/**
 * The rail's Environment card (M92.9, §2): where the conversation runs. The
 * vault; its history, the branch and the sync state as the shell's SyncBadge
 * says it (`useGit`, the one git state, its branch kept with no remote); who
 * answers in the vault's panel (`panelAgents`, M56.6); and what the
 * conversation's latest run reaches (`RunReach`, M92.8) in five words:
 * pages, shell, web, subagents and edit mode. Pure.
 *
 * What it says (CV-05, CV-44): a vault that keeps no history says "History
 * off"; a git read that failed is unavailable, never a vault with none.
 * Commits git could not count are never "Up to date", and a count that
 * failed leaves the card partial, as does a binding nobody could read. A
 * conversation whose runs never said what they reach is not recorded.
 */

/** The card's words. */
export const RAIL_ENVIRONMENT_WORDS = {
  title: 'Environment',
  none: 'None',
  vault: 'Vault',
  history: 'History',
  historyOff: 'History off',
  branchNotRecorded: 'Branch not recorded',
  sync: 'Sync',
  noRemote: 'No remote',
  unavailable: "Couldn't read this vault's history",
  answersAs: 'Answers as',
  assistant: 'Assistant',
  /** A binding no agent answers to: the assistant answers (M56.6). */
  missingAgent: (handle: string) => `@${handle} not found`,
  bindingUnreadable: "Couldn't read",
  partialBinding: "Couldn't read who answers in this vault's panel.",
  reachNotRecorded: 'What this conversation reaches is not recorded',
  reachNotRecordedDetail: 'A turn records it as it starts.',
  pages: 'Pages',
  shell: 'Shell',
  web: 'Web',
  subagents: 'Subagents',
  edits: 'Edit mode',
  /** Pages, when the run holds none of Cerebro's own tools. */
  notReached: 'Not reached',
  notRecorded: 'Not recorded',
} as const;

/** How a family's decisions read, together: every tool of it runs, one
 *  asks, one waits for Review, none runs, or some do and some do not. */
export type Reached = 'on' | 'asks' | 'queues' | 'off' | 'some';

/** What a family's line says, read together, where it has no words of its
 *  own. */
const SWITCHED: Readonly<Record<Reached, string>> = {
  on: 'On',
  asks: 'Asks first',
  queues: 'Waits for Review',
  off: 'Off',
  some: 'Partly',
};

/** The line each family is, by the tool-approval table's family id, and
 *  each reading's words (M92.8's reach words). */
const REACH = [
  {
    key: 'pages',
    family: 'confirmable',
    words: {
      on: 'Reads and writes',
      asks: 'Asks before writing',
      queues: 'Writes wait for Review',
      off: 'Page writes off',
      some: 'Some page writes',
    },
  },
  { key: 'shell', family: 'shell', words: SWITCHED },
  { key: 'web', family: 'web', words: SWITCHED },
  { key: 'subagents', family: 'delegate', words: SWITCHED },
  { key: 'edits', family: 'file_write', words: { ...SWITCHED, asks: 'Asks before each edit' } },
] as const satisfies readonly {
  key: string;
  family: string;
  words: Readonly<Record<Reached, string>>;
}[];

/** Each reach line's family id, for the test that holds them to the
 *  table. */
export const REACH_FAMILIES: readonly string[] = REACH.map((line) => line.family);

/** What edit mode says when edits run and Claude Code accepts them as they
 *  come (`--permission-mode acceptEdits`). */
const ACCEPTS_EDITS = 'Accepts edits';

/** How `decisions` read together; null when the plan named none for the
 *  family (not recorded). */
export function reached(decisions: readonly Decision[] | undefined): Reached | null {
  if (decisions === undefined || decisions.length === 0) return null;
  if (decisions.includes('ask')) return 'asks';
  if (decisions.includes('queue')) return 'queues';
  const runs = decisions.filter((decision) => decision === 'allow' || decision === 'cli').length;
  if (runs === decisions.length) return 'on';
  return runs === 0 ? 'off' : 'some';
}

/** Who answers in the vault's panel (M56.6), as the card reads it. */
export type AnswersAs =
  | { state: 'reading' }
  | { state: 'unreadable' }
  | { state: 'assistant' }
  | { state: 'agent'; title: string }
  | { state: 'missing'; handle: string };

/**
 * The panel's binding as `panelAgents` holds it for the vault (absent while
 * unread), whether its read failed, and the vault's agents to name it by.
 */
export function answersAs(
  handle: string | null | undefined,
  unreadable: boolean,
  entries: Entry[],
): AnswersAs {
  if (unreadable) return { state: 'unreadable' };
  if (handle === undefined) return { state: 'reading' };
  if (handle === null) return { state: 'assistant' };
  const agent = listAgents(entries).find((one) => one.handle === handle);
  return agent === undefined
    ? { state: 'missing', handle }
    : { state: 'agent', title: agent.title };
}

export type RailEnvironmentLineKey =
  'vault' | 'history' | 'sync' | 'answers' | (typeof REACH)[number]['key'];

/** One line of the card: a term and its value in words. */
export interface RailEnvironmentLine {
  key: RailEnvironmentLineKey;
  term: string;
  value: string;
  /** The line's own state, for its `data-state`. */
  state: string;
  /** More than the value says: the vault's path, why counts are unknown. */
  detail?: string;
  /** The sync line's icon and colour, the SyncBadge's. */
  icon?: { name: string; color: string };
}

export interface RailEnvironment {
  /** The card's state (CV-44), or null until git has answered: a claim made
   *  then could be wrong a moment later, so the card makes none. */
  state: RailSectionState | null;
  /** What the heading line says after the name: the branch, or that the
   *  vault keeps no history. */
  count: string | undefined;
  lines: readonly RailEnvironmentLine[];
  /** Why the git read failed: the unavailable card's detail. */
  reason: string | null;
  /** Why some of it could not be read, each in words. */
  notes: readonly string[];
  /** No run has said what this conversation reaches. */
  reachNotRecorded: boolean;
}

export interface RailEnvironmentInput {
  /** The open vault. */
  vault: string | null;
  /** The shared git state (`useGit`). */
  git: Pick<
    GitState,
    'ready' | 'isRepo' | 'readError' | 'branch' | 'remote' | 'sync' | 'modified' | 'conflicts'
  >;
  answers: AnswersAs;
  /** What the conversation's latest run said it reaches
   *  (`conversations.threadReach`); null when none has. */
  reach: RunReach | null;
}

/** The vault's folder name, as the status bar names it. */
function vaultName(vault: string): string {
  return vault.split('/').filter(Boolean).pop() ?? vault;
}

/** The sync line: the SyncBadge's words for the state, or, with no remote
 *  and nothing changed, that there is none to sync with. */
function syncLine(git: RailEnvironmentInput['git']): RailEnvironmentLine {
  const { sync, remote } = git;
  if (remote === null && sync === 'clean') {
    return {
      key: 'sync',
      term: RAIL_ENVIRONMENT_WORDS.sync,
      value: RAIL_ENVIRONMENT_WORDS.noRemote,
      state: 'local',
    };
  }
  const tone = SYNC_TONE[sync];
  const unknown = remote === null ? null : countsUnknown(remote);
  return {
    key: 'sync',
    term: RAIL_ENVIRONMENT_WORDS.sync,
    value: tone.label(syncCount(sync, git)),
    state: sync,
    ...(sync === 'unknown' && unknown !== null ? { detail: UNCOUNTED_WORDS[unknown] } : {}),
    icon: { name: tone.icon, color: tone.color },
  };
}

function answersLine(answers: AnswersAs): RailEnvironmentLine | null {
  const line = (value: string, state: string): RailEnvironmentLine => ({
    key: 'answers',
    term: RAIL_ENVIRONMENT_WORDS.answersAs,
    value,
    state,
  });
  switch (answers.state) {
    case 'reading':
      return null;
    case 'unreadable':
      return line(RAIL_ENVIRONMENT_WORDS.bindingUnreadable, 'unavailable');
    case 'assistant':
      return line(RAIL_ENVIRONMENT_WORDS.assistant, 'assistant');
    case 'agent':
      return line(answers.title, 'agent');
    case 'missing':
      return {
        ...line(RAIL_ENVIRONMENT_WORDS.missingAgent(answers.handle), 'missing'),
        detail: `@${answers.handle} — no agent answers to this name, so the assistant answers`,
      };
  }
}

/** The five reach lines, as the run's plan decided each family. */
function reachLines(reach: RunReach): RailEnvironmentLine[] {
  return REACH.map(({ key, family, words }): RailEnvironmentLine => {
    const term = RAIL_ENVIRONMENT_WORDS[key];
    if (key === 'pages' && !reach.cerebro) {
      return { key, term, value: RAIL_ENVIRONMENT_WORDS.notReached, state: 'off' };
    }
    const reading = reached(reach.families[family]);
    if (reading === null) {
      return { key, term, value: RAIL_ENVIRONMENT_WORDS.notRecorded, state: 'not-recorded' };
    }
    const value =
      key === 'edits' && reading === 'on' && reach.permission_mode === 'acceptEdits'
        ? ACCEPTS_EDITS
        : words[reading];
    return { key, term, value, state: reading };
  });
}

/**
 * The card, from the open vault, the shared git state, the panel's binding
 * and the run's reach. Its state, first rule wins: no vault is empty; git
 * not read yet makes no claim; a git read that failed is unavailable;
 * counts git could not take or a binding nobody could read is partial; no
 * run's reach is not recorded; else ready.
 */
export function railEnvironment({
  vault,
  git,
  answers,
  reach,
}: RailEnvironmentInput): RailEnvironment {
  const nothing = { count: undefined, lines: [], reason: null, notes: [], reachNotRecorded: false };
  if (vault === null) return { ...nothing, state: 'empty' };
  if (!git.ready && git.readError === null) return { ...nothing, state: null };
  const lines: RailEnvironmentLine[] = [
    {
      key: 'vault',
      term: RAIL_ENVIRONMENT_WORDS.vault,
      value: vaultName(vault),
      state: 'open',
      detail: vault,
    },
  ];
  const notes: string[] = [];
  const unread = git.readError !== null;
  let count: string | undefined;
  if (!unread && git.isRepo === false) {
    lines.push({
      key: 'history',
      term: RAIL_ENVIRONMENT_WORDS.history,
      value: RAIL_ENVIRONMENT_WORDS.historyOff,
      state: 'off',
    });
    count = RAIL_ENVIRONMENT_WORDS.historyOff;
  } else if (!unread && git.isRepo === true) {
    lines.push({
      key: 'history',
      term: RAIL_ENVIRONMENT_WORDS.history,
      value: git.branch ?? RAIL_ENVIRONMENT_WORDS.branchNotRecorded,
      state: git.branch === null ? 'not-recorded' : 'tracked',
    });
    lines.push(syncLine(git));
    count = git.branch ?? undefined;
    if (git.remote !== null && countsUnknown(git.remote) === 'unread') {
      notes.push(UNCOUNTED_WORDS.unread);
    }
  }
  const said = answersLine(answers);
  if (said !== null) lines.push(said);
  if (answers.state === 'unreadable') notes.push(RAIL_ENVIRONMENT_WORDS.partialBinding);
  if (reach !== null) lines.push(...reachLines(reach));
  return {
    state: unread
      ? 'unavailable'
      : notes.length > 0
        ? 'partial'
        : reach === null
          ? 'not-recorded'
          : 'ready',
    count,
    lines,
    reason: git.readError,
    notes,
    reachNotRecorded: reach === null,
  };
}
