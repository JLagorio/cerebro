import { parsePullRequestUrl } from '@/engine/pullRequest';
import { isKeptOutOfGit } from '@/engine/mailPolicy';
/**
 * In-memory git and read-only gh backend for the browser, vitest, and Playwright.
 *
 * Mirrors the Rust command surface closely enough that every git-aware
 * component renders and behaves outside a packaged build. It models a small
 * repository: a commit log, a working tree of pending changes, and a remote
 * whose behaviour tests can steer through `__cerebroMockGit`. Since M58.4
 * each commit made here also keeps its parent, the bytes of every file it
 * committed (`snapshots`, null for a file it removed) and, for a run's own
 * commit, the run that made it, as runtime.db's `run_commits` records it:
 * the versions the history lens opens, the record attribution reads, what
 * Restore writes back, and what a conversation's changes read back with the
 * mock fleet's runs (M92.12). `window.__cerebroSeedGitHistory` stages such
 * commits for a spec.
 */
import type { RunPageWrites } from '@/engine/attribution';
import type {
  ChangedFile,
  ChangeKind,
  ConversationChangesets,
  RunChangeset,
} from '@/engine/changeset';
import { humanize } from '@/engine/frontmatter';
import type {
  CommitQuery,
  CommitRun,
  ConflictMode,
  FileAt,
  FileChange,
  FileCommit,
  FilePatch,
  GitAuthorIdentity,
  GitProviderStatus,
  GitRemoteStatus,
  GitWorkspaceInfo,
  LastCommitInfo,
  ModifiedFile,
  PulseCommit,
  RemoteResult,
  Resolution,
  RestoreResult,
  VaultPulse,
} from '@/engine/git';
import {
  diffLines,
  fleetRunDetail,
  fleetRunsPage,
  guardHumanWrite,
  guardRestoreTarget,
  HUMAN_ACTOR,
  liveRunOwners,
  liveRunPaths,
  logHumanWrite,
  mockRunChanges,
  peekFile,
  restoreFile,
  type MockRunChange,
} from './mockIpc';
import { sha256Hex } from './sha256';

/** The run that made a commit, as `run_commits` records it (M58.4), and who
 * else wrote each of its paths while it ran. */
interface MockRunRecord {
  runId: string;
  actor: string;
  alsoBy?: Record<string, string[]>;
}

/** A commit as the mock repository holds it (M58.4). `parent` defaults to
 * the next commit in the log; `snapshots` is undefined on a commit made
 * before snapshots were kept, whose versions cannot be read. */
export interface MockCommit extends PulseCommit {
  parent?: string | null;
  snapshots?: Record<string, string | null>;
  run?: MockRunRecord | null;
  /** A renamed file's path before the commit, by its path after. */
  renamedFrom?: Record<string, string>;
}

interface MockState {
  isRepo: boolean;
  commits: MockCommit[];
  modified: ModifiedFile[];
  conflicts: string[];
  conflictMode: ConflictMode;
  remoteUrl: string | null;
  ahead: number;
  behind: number;
  /** Make git's ahead/behind count fail, as a rev-list exiting non-zero
   * does (M92.10): the status then reads both as unknown, and the
   * repository itself is unchanged. */
  countFails: boolean;
  branch: string;
  /** Force the next remote call to fail a particular way. */
  nextRemoteFailure: RemoteResult | null;
  diffs: Record<string, string>;
  /** What each run commit did to each of its files (M58.3), by commit hash
   * then path: what `getFilePatch` and a diff at that commit read. */
  patches: Record<string, Record<string, string>>;
  /** A path's bytes before the first commit that touched it (M58.4), when a
   * run's commit knew them: the mock disk holds files no commit ever took. */
  origins: Record<string, string | null>;
}

function seed(): MockState {
  return {
    isRepo: true,
    commits: [
      {
        // Full hashes, as git's are: commit_runs refuses anything shorter.
        hash: 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2',
        shortHash: 'c2c2c2c',
        message: 'Distil onboarding drop-off from the support thread',
        author: 'Cerebro',
        date: 1_753_800_000,
        changes: {
          files: [
            {
              path: 'knowledge/onboarding-drop-off.md',
              status: 'modified',
              title: 'Onboarding Drop Off',
            },
          ],
          added: 0,
          modified: 1,
          deleted: 0,
        },
      },
      {
        hash: 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1',
        shortHash: 'c1c1c1c',
        message: 'Start tracking this vault with cerebro',
        author: 'Ana Rios',
        date: 1_753_700_000,
        changes: {
          files: [{ path: 'projects/atlas/project.md', status: 'added', title: 'Project' }],
          added: 1,
          modified: 0,
          deleted: 0,
        },
      },
    ],
    modified: [],
    conflicts: [],
    conflictMode: 'none',
    remoteUrl: null,
    ahead: 0,
    behind: 0,
    countFails: false,
    branch: 'main',
    nextRemoteFailure: null,
    diffs: {},
    patches: {},
    origins: {},
  };
}

declare global {
  interface Window {
    __cerebroMockGit?: MockState;
  }
}

// Hung off `window` when there is one (so Playwright can steer it from the
// page) and off a module local otherwise — node-side vitest has no window.
let nodeState: MockState | null = null;

function state(): MockState {
  if (typeof window === 'undefined') {
    nodeState ??= seed();
    return nodeState;
  }
  window.__cerebroMockGit ??= seed();
  return window.__cerebroMockGit;
}

/** Test hook: reset to the seeded repository. */
export function resetMockGit(patch: Partial<MockState> = {}): MockState {
  pullRequests.clear();
  const next = { ...seed(), ...patch };
  if (typeof window === 'undefined') {
    nodeState = next;
  } else {
    window.__cerebroMockGit = next;
  }
  return next;
}

const DEFAULT_DIFF = [
  'diff --git a/note.md b/note.md',
  'index 1111111..2222222 100644',
  '--- a/note.md',
  '+++ b/note.md',
  '@@ -1,4 +1,5 @@',
  ' # Onboarding drop-off',
  ' ',
  '-Completion sits at 51%.',
  '+Completion sits at 73%, up from 51% at baseline.',
  '+Support contacts fell alongside it.',
].join('\n');

export async function gitWorkspaceInfo(vault: string): Promise<GitWorkspaceInfo> {
  const s = state();
  return {
    vaultRoot: vault,
    gitRoot: s.isRepo ? vault : null,
    vaultPathspec: null,
    gitRootRelation: s.isRepo ? 'vault' : 'none',
    resolutionFailure: null,
  };
}

export async function isGitRepo(_vault: string): Promise<boolean> {
  return state().isRepo;
}

export async function initGitRepo(_vault: string): Promise<void> {
  const s = state();
  s.isRepo = true;
  if (s.commits.length === 0) {
    s.commits = seed().commits.slice(1);
  }
}

export async function gitAuthorIdentity(_vault: string): Promise<GitAuthorIdentity> {
  return { name: 'Ana Rios', email: 'ana@example.com', source: 'global', warning: null };
}

/** As Rust's `modified_files` (M58.3): each path a live run owns names its
 * run, and every other names nobody. */
export async function getModifiedFiles(_vault: string): Promise<ModifiedFile[]> {
  const owners = liveRunOwners();
  return state()
    .modified.filter((f) => !isKeptOutOfGit(f.path))
    .map((f) => ({ ...f, owner: owners.get(f.path) ?? null }));
}

/** As git_commands.rs `git_discard_file` (M58.1, Q2): a person's write, so
 * knowledge/ is refused like every human door refuses it, and the discard is
 * logged as theirs, a restored file as a write and a removed untracked one
 * as a delete. The path is one file, matched literally as status.rs's
 * `--literal-pathspecs` matches it: an empty or `.` segment is refused, and
 * a path with no change at it has nothing to discard. */
export async function gitDiscardFile(_vault: string, path: string): Promise<void> {
  guardHumanWrite(path);
  if (path.split('/').some((part) => part === '' || part === '.')) {
    throw new Error(`refusing a path that names no one file: ${path}`);
  }
  const s = state();
  const file = s.modified.find((f) => f.path === path);
  if (file === undefined) throw new Error(`nothing to discard at ${path}`);
  s.modified = s.modified.filter((f) => f.path !== path);
  logHumanWrite(file.status === 'untracked' ? 'vault.delete' : 'vault.write', path);
}

/** A commit's parent: the one it names, else the next commit in the log. */
function parentOf(s: MockState, index: number): string | null {
  const commit = s.commits[index];
  if (commit.parent !== undefined) return commit.parent;
  return s.commits[index + 1]?.hash ?? null;
}

/** A commit's own status word for a file, as history.rs reads git's letter. */
function changeOf(status: string): FileChange {
  if (status === 'added' || status === 'untracked') return 'added';
  if (status === 'deleted') return 'deleted';
  if (status === 'renamed') return 'renamed';
  return 'modified';
}

/** Unix seconds as runtime.db spells a time. */
const storedTime = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** As history.rs `file_history` (M58.4): each commit that touched the page,
 * newest first, under the path it had then, a rename followed back. */
export async function getFileHistory(_vault: string, path: string): Promise<FileCommit[]> {
  const s = state();
  // Rust answers a vault that is not a repository with no history, not an
  // error — and not whatever commits a test left in the log.
  if (!s.isRepo) return [];
  const rows: FileCommit[] = [];
  let current = path;
  s.commits.forEach((c, index) => {
    const file = c.changes?.files.find((f) => f.path === current);
    if (file === undefined) return;
    const previousPath = c.renamedFrom?.[current] ?? null;
    rows.push({
      hash: c.hash,
      shortHash: c.shortHash,
      // Rust's `%s`: the subject line, never the trailers under it.
      message: c.message.split('\n')[0],
      author: c.author,
      date: c.date,
      parent: parentOf(s, index),
      previousAt: null,
      pathAt: current,
      previousPath,
      change: previousPath === null ? changeOf(file.status) : 'renamed',
    });
    if (previousPath !== null) current = previousPath;
  });
  rows.forEach((row, n) => {
    const older = rows[n + 1];
    if (older !== undefined && row.change !== 'added') row.previousAt = storedTime(older.date);
  });
  return rows.slice(0, 50);
}

/** `path` at `rev`, as history.rs `file_at_commit` reads it: the snapshot of
 * the newest commit at or before `rev` that touched it. A commit with no
 * snapshots, or an unknown revision, cannot be read and throws. */
function fileAt(s: MockState, path: string, rev: string): FileAt {
  const from = s.commits.findIndex((c) => c.hash === rev);
  if (from === -1) throw new Error(`unknown revision: ${rev}`);
  for (const c of s.commits.slice(from)) {
    if (c.changes?.files.some((f) => f.path === path) !== true) continue;
    const held = c.snapshots?.[path];
    if (held === undefined) throw new Error(`${c.shortHash} kept no copy of ${path}`);
    return held === null ? { kind: 'absent' } : { kind: 'text', text: held };
  }
  const origin = s.origins[path];
  return origin === undefined || origin === null
    ? { kind: 'absent' }
    : { kind: 'text', text: origin };
}

/** As git_commands.rs `get_file_at_commit` (M58.4). */
export async function getFileAtCommit(
  _vault: string,
  path: string,
  commit: string,
): Promise<FileAt> {
  const s = state();
  if (!s.isRepo) throw new Error('this vault is not a git repository');
  return fileAt(s, path, commit);
}

export async function getFileDiff(_vault: string, path: string): Promise<string> {
  return state().diffs[path] ?? DEFAULT_DIFF;
}

/** As history.rs `file_diff_at_commit` (M58.4): a run commit's own patch;
 * else one hunk from the commit's version against its parent's, the old
 * one under `previousPath` when the commit renamed the file; else, for a
 * commit that kept no copies, the stock diff. */
export async function getFileDiffAtCommit(
  _vault: string,
  path: string,
  commit: string,
  previousPath: string | null = null,
): Promise<string> {
  const s = state();
  const patch = s.patches[commit]?.[path];
  if (patch !== undefined) return patch;
  const index = s.commits.findIndex((c) => c.hash === commit);
  if (index === -1 || s.commits[index].snapshots === undefined) return DEFAULT_DIFF;
  const text = (at: FileAt) => (at.kind === 'text' ? at.text : null);
  const after = text(fileAt(s, path, commit));
  const parent = parentOf(s, index);
  const before = parent === null ? null : text(fileAt(s, previousPath ?? path, parent));
  const from = previousPath ?? path;
  const diff = diffLines(before, after);
  return [
    `diff --git a/${from} b/${path}`,
    ...(previousPath === null ? [] : [`rename from ${previousPath}`, `rename to ${path}`]),
    before === null ? '--- /dev/null' : `--- a/${from}`,
    after === null ? '+++ /dev/null' : `+++ b/${path}`,
    `@@ -${diff.at + 1},${diff.deletions} +${diff.at + 1},${diff.additions} @@`,
    ...diff.removed.map((l) => `-${l}`),
    ...diff.added.map((l) => `+${l}`),
  ].join('\n');
}

/** As Rust's `file_patch_at_commit` (M58.3): a run commit's own patch for
 * the file, else the stock diff. Nothing the mock holds is binary or over
 * the 2 MiB cap. Refused, as Rust refuses it, in a vault with no history. */
export async function getFilePatch(
  _vault: string,
  path: string,
  commit: string,
): Promise<FilePatch> {
  const s = state();
  if (!s.isRepo) throw new Error('this vault is not a git repository');
  return { text: s.patches[commit]?.[path] ?? DEFAULT_DIFF, truncated: false, binary: false };
}

export async function getCommitDiff(_vault: string, _commit: string): Promise<string> {
  return DEFAULT_DIFF;
}

export async function getVaultPulse(_vault: string): Promise<VaultPulse> {
  const s = state();
  const commits: PulseCommit[] = s.commits.map(
    ({ parent: _p, snapshots: _s, run: _r, renamedFrom: _f, ...commit }) => commit,
  );
  return { tracked: s.isRepo, commits: s.isRepo ? commits : [] };
}

export async function getLastCommitInfo(_vault: string): Promise<LastCommitInfo | null> {
  const [head] = state().commits;
  if (head === undefined) return null;
  return { shortHash: head.shortHash, message: head.message, date: head.date };
}

/** A new commit's hash: 40 hex characters, as git's are (M58.3). */
function mintHash(s: MockState, message: string): string {
  return sha256Hex(`${s.commits.length}:${message}:${Date.now()}:${Math.random()}`).slice(0, 40);
}

/** Put a commit on top of the log, keeping each committed file's bytes as
 * they are now (M58.4), and the run that made it when a run did. */
function pushCommit(
  s: MockState,
  message: string,
  files: { path: string; status: string }[],
  run: MockRunRecord | null = null,
): MockCommit {
  const hash = mintHash(s, message);
  const commit: MockCommit = {
    parent: s.commits[0]?.hash ?? null,
    snapshots: Object.fromEntries(files.map((f) => [f.path, peekFile(f.path)])),
    run,
    hash,
    shortHash: hash.slice(0, 7),
    message,
    author: 'Ana Rios',
    date: Math.floor(Date.now() / 1000),
    changes: {
      files: files.map((f) => ({
        path: f.path,
        status: f.status,
        title: f.path.split('/').pop() ?? f.path,
      })),
      added: files.filter((f) => f.status === 'added' || f.status === 'untracked').length,
      modified: files.filter((f) => f.status === 'modified').length,
      deleted: files.filter((f) => f.status === 'deleted').length,
    },
  };
  s.commits = [commit, ...s.commits];
  s.ahead += 1;
  return commit;
}

/** As Rust's `commit_all` (M58.3): every change but the paths a live run
 * owns, which wait for that run's own commit. The short hash, as Rust
 * answers it, or null when there was nothing of the person's to commit. */
export async function gitCommit(_vault: string, message: string): Promise<string | null> {
  const s = state();
  s.modified = s.modified.filter((file) => !isKeptOutOfGit(file.path));
  const owners = liveRunOwners();
  const mine = s.modified.filter((f) => !owners.has(f.path));
  if (mine.length === 0) return null;
  const commit = pushCommit(s, message, mine);
  s.modified = s.modified.filter((f) => owners.has(f.path));
  return commit.shortHash;
}

/** A mock run's own commit (M58.3), as Rust's `settle_run` makes it: exactly
 * `changes`, whatever else is modified, under `message`. Its patches are
 * kept for `getFilePatch`. Returns the full hash, or null when the vault
 * keeps no history or nothing changed. */
export function commitRun(
  changes: MockRunChange[],
  message: string,
  run: MockRunRecord | null = null,
): string | null {
  const s = state();
  if (!s.isRepo || changes.length === 0) return null;
  const paths = new Set(changes.map((c) => c.path));
  // A path no commit took before: the bytes the run found are what it was.
  for (const c of changes) {
    const taken = s.commits.some((k) => k.changes?.files.some((f) => f.path === c.path));
    if (!taken && !(c.path in s.origins)) s.origins[c.path] = c.before;
  }
  const commit = pushCommit(
    s,
    message,
    changes.map((c) => ({ path: c.path, status: c.kind })),
    run,
  );
  s.patches[commit.hash] = Object.fromEntries(changes.map((c) => [c.path, c.patch]));
  s.modified = s.modified.filter((f) => !paths.has(f.path));
  return commit.hash;
}

/** The label a run's commit subject opens with, as `changeset.rs` names it. */
function runLabel(actor: string): string {
  if (actor.startsWith('process:')) return actor.slice('process:'.length);
  if (actor === 'claude-code') return 'assistant';
  if (actor.startsWith('agent:m26-')) return actor.slice('agent:m26-'.length);
  return actor;
}

/**
 * Settle a mock run (M58.3), as Rust's reader does before Done: commit what
 * the run `runId` wrote under its own subject and trailers, and say what
 * changed. `summary` is what a person asked, for an attended run.
 */
export function settleMockRun(runId: string, actor: string, summary: string | null): RunChangeset {
  const kept_out_of_git = liveRunPaths(runId).filter((path) => isKeptOutOfGit(path)).length;
  const changes = mockRunChanges(runId).filter((change) => !isKeptOutOfGit(change.path));
  if (changes.length === 0)
    return { kept_out_of_git, state: 'nothing', run_id: runId, shell_unrecorded: false };
  if (!state().isRepo) {
    return {
      kept_out_of_git,
      state: 'not_a_repo',
      run_id: runId,
      files: changes.map((c) => c.path),
      shell_unrecorded: false,
    };
  }
  const said =
    summary
      ?.split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ??
    `changed ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`;
  const subject = `${runLabel(actor)}: ${said}`;
  const cut = subject.length <= 72 ? subject : `${subject.slice(0, 71).trimEnd()}\u2026`;
  const message = `${cut}\n\nCerebro-Run: ${runId}\nCerebro-Actor: ${actor}`;
  // Recorded as runtime.db's `run_commits` would be (M58.4): this run made it.
  const commit = commitRun(changes, message, {
    runId,
    actor,
    alsoBy: Object.fromEntries(changes.map((c) => [c.path, c.alsoBy])),
  });
  if (commit === null)
    return { kept_out_of_git, state: 'nothing', run_id: runId, shell_unrecorded: false };
  const files: ChangedFile[] = changes.map((c) => ({
    path: c.path,
    previous_path: null,
    kind: c.kind,
    additions: c.additions,
    deletions: c.deletions,
    also_by: c.alsoBy,
  }));
  return {
    kept_out_of_git,
    state: 'committed',
    run_id: runId,
    commit,
    files,
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    binary: 0,
    shell_unrecorded: false,
  };
}

/** A full commit hash, the only spelling `run_commits` stores. */
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * As fleet.rs `commit_runs` (M58.4, CV-35): the run each commit's record
 * names, and nothing for a commit with none, whatever its message says.
 * With a path, whether your writes rode along and which other runs' did.
 * A hash that is not full, or more than 200, is refused in Rust's words.
 */
export async function commitRuns(_vault: string, queries: CommitQuery[]): Promise<CommitRun[]> {
  if (queries.length > 200) {
    throw new Error(`At most 200 commits can be asked about at once, not ${queries.length}.`);
  }
  const bad = queries.find((q) => !FULL_HASH.test(q.hash));
  if (bad !== undefined) throw new Error(`${JSON.stringify(bad.hash)} is not a full commit hash.`);
  const s = state();
  const answered: CommitRun[] = [];
  for (const q of queries) {
    const run = s.commits.find((c) => c.hash === q.hash)?.run;
    if (run == null || answered.some((a) => a.hash === q.hash)) continue;
    const others = q.path === null ? [] : (run.alsoBy?.[q.path] ?? []);
    answered.push({
      hash: q.hash,
      run_id: run.runId,
      actor: run.actor,
      with_person: q.path === null ? null : others.includes(HUMAN_ACTOR),
      also_by: others.filter((a) => a !== HUMAN_ACTOR && a !== run.actor),
    });
  }
  return answered;
}

/** `git::conversation::MAX_RUNS`: the most runs one read takes, the newest. */
const CONVERSATION_RUNS = 100;
/** Why a run reads not recorded, in `git::conversation`'s and
 *  `changeset::WRITES_NOT_RECORDED`'s words. */
const NO_COMMIT_RECORDED = 'no commit was recorded for this run';
const NO_WRITE_RECORDED = 'no page write was recorded for this run';
const WRITES_NOT_RECORDED = "this run's writes were not recorded";
/** A Claude Code session id as `cause::is_cli_session_id` reads one. */
const CLI_SESSION_ID = /^(?!-)[0-9A-Za-z-]{8,64}$/;

/** Whether a run's commit may take `path`, as `changeset::keeps` says:
 *  vault-relative, never escaping, outside `.git/` and `.cerebro/`. */
function keeps(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.startsWith('\\')) return false;
  const parts = path.split('/');
  return !parts.some((part) => part === '..' || part === '.git') && parts[0] !== '.cerebro';
}

/** A file's lines in a mock commit, as git's numstat counts them: from the
 *  run's own patch, else from its copy against its parent's; null where the
 *  commit kept neither, or a side is not text. */
function numstatAt(
  s: MockState,
  index: number,
  path: string,
  previousPath: string | null,
): { additions: number | null; deletions: number | null } {
  const commit = s.commits[index];
  const patch = s.patches[commit.hash]?.[path];
  if (patch !== undefined) {
    // Lines under the hunk header only: `+++`/`---` name the files.
    const lines = patch.split('\n');
    const hunk = lines.findIndex((line) => line.startsWith('@@'));
    const body = hunk === -1 ? [] : lines.slice(hunk + 1);
    return {
      additions: body.filter((line) => line.startsWith('+')).length,
      deletions: body.filter((line) => line.startsWith('-')).length,
    };
  }
  const uncounted = { additions: null, deletions: null };
  const side = (at: FileAt): string | null | undefined =>
    at.kind === 'text' ? at.text : at.kind === 'absent' ? null : undefined;
  try {
    const parent = parentOf(s, index);
    const after = side(fileAt(s, path, commit.hash));
    const before = parent === null ? null : side(fileAt(s, previousPath ?? path, parent));
    if (after === undefined || before === undefined) return uncounted;
    const diff = diffLines(before, after);
    return { additions: diff.additions, deletions: diff.deletions };
  } catch {
    // A commit that kept no copies cannot be counted (`fileAt`).
    return uncounted;
  }
}

/** A run's commit read back, as `conversation::read_commit` reads git's:
 *  each file's kind and counts, and nothing only the run's reader knew. */
function readBackCommit(s: MockState, index: number, runId: string): RunChangeset {
  const commit = s.commits[index];
  const files: ChangedFile[] = (commit.changes?.files ?? []).map((file) => {
    const previous = commit.renamedFrom?.[file.path] ?? null;
    const kind: ChangeKind =
      previous !== null
        ? 'renamed'
        : file.status === 'added' || file.status === 'untracked' || file.status === 'renamed'
          ? 'added'
          : file.status === 'deleted'
            ? 'deleted'
            : 'modified';
    return {
      path: file.path,
      previous_path: previous,
      kind,
      ...numstatAt(s, index, file.path, previous),
      also_by: null,
    };
  });
  const counted = files.filter((f) => f.additions !== null && f.deletions !== null);
  const total = (pick: (f: ChangedFile) => number | null): number | null =>
    counted.length === 0 ? null : counted.reduce((n, f) => n + (pick(f) ?? 0), 0);
  return {
    kept_out_of_git: null,
    state: 'committed',
    run_id: runId,
    commit: commit.hash,
    files,
    additions: total((f) => f.additions),
    deletions: total((f) => f.deletions),
    binary: files.length - counted.length,
    shell_unrecorded: null,
  };
}

const notRecordedRun = (runId: string, reason: string): RunChangeset => ({
  kept_out_of_git: null,
  state: 'not_recorded',
  run_id: runId,
  reason,
  files: [],
});

/** A run in a vault with no history, as `conversation::without_history`
 *  reads it: the paths its booked writes name, mail left out. */
async function readBackWithoutHistory(runId: string): Promise<RunChangeset> {
  // A listed run with no detail booked no writes: Rust reads its row's
  // `writes_booked`, and a row that says nothing is not recorded.
  const wrote = await fleetRunDetail(runId).then(
    (detail): RunPageWrites => detail.wrote,
    (): RunPageWrites => ({ state: 'not_recorded' }),
  );
  if (wrote.state === 'not_recorded') return notRecordedRun(runId, WRITES_NOT_RECORDED);
  const paths = wrote.writes.flatMap((w) => (w.to === null ? [w.path] : [w.path, w.to]));
  const files = [...new Set(paths)].filter((path) => keeps(path) && !isKeptOutOfGit(path)).sort();
  if (files.length === 0) return notRecordedRun(runId, NO_WRITE_RECORDED);
  return {
    kept_out_of_git: null,
    state: 'not_a_repo',
    run_id: runId,
    files,
    shell_unrecorded: null,
  };
}

/**
 * As `git::conversation::changes` (M92.12): the ended runs the mock fleet
 * books under this session in this vault, the newest 100, oldest first,
 * each as its commit record (`run` on a mock commit, CV-35) and the mock
 * repository read it back. A run no commit record names is not recorded,
 * whatever its message says; a vault with no history lists the paths its
 * booked writes name. The fleet's own page cap (200 a vault) bounds what
 * the mock can see; an unavailable fleet fails the read, as an unopened
 * runtime database does.
 */
export async function conversationChanges(
  vault: string,
  sessionId: string,
): Promise<ConversationChangesets> {
  if (!CLI_SESSION_ID.test(sessionId)) {
    throw new Error(`${JSON.stringify(sessionId)} is not a Claude Code session id.`);
  }
  const vaultId = vault === '/demo-vault' ? 'demo' : vault;
  const runs = (await fleetRunsPage({ vault_id: vaultId, limit: 200 })).filter(
    (run) => run.cli_session_id === sessionId && run.outcome !== 'running',
  );
  const s = state();
  const changesets: RunChangeset[] = [];
  for (const run of runs.slice(0, CONVERSATION_RUNS).reverse()) {
    if (!s.isRepo) {
      changesets.push(await readBackWithoutHistory(run.run_id));
      continue;
    }
    const index = s.commits.findIndex((c) => c.run?.runId === run.run_id);
    changesets.push(
      index === -1
        ? notRecordedRun(run.run_id, NO_COMMIT_RECORDED)
        : readBackCommit(s, index, run.run_id),
    );
  }
  return { changesets, truncated: runs.length > CONVERSATION_RUNS };
}

/** Restore's refusals, in restore.rs's words. */
const NO_HISTORY = 'This vault keeps no history, so there is no version to restore.';
const NOT_IN_HISTORY = "That version is not in this page's history.";
const OUTSIDE_VAULT = 'That version of the page is outside this vault.';
const REMOVED = 'That version removed the page, so there is nothing to restore.';
const NOT_TEXT = "That version is not text, so it can't be restored here.";
const TOO_LARGE = 'That version is too large to restore here.';
const STILL_WRITING =
  'An agent run is still writing this page. Stop it or let it finish, then restore.';

/**
 * As git_commands.rs `restore_note_version` (M58.4), in its order and words:
 * the note target and the bundle guard, a repository, a full hash in the
 * page's history, a version inside the vault that is text and did not
 * remove the page, no live run that wrote it. Then identical bytes write
 * nothing; a page with changes not yet committed is committed first as
 * "Before restoring <title>"; the version's bytes are written as yours; and
 * "Restore <title> to <short> (<date>)" is committed. Neither commit is a
 * run's, so both read "unattributed".
 */
export async function restoreNoteVersion(
  vault: string,
  path: string,
  commit: string,
): Promise<RestoreResult> {
  guardRestoreTarget(path);
  const s = state();
  if (!s.isRepo) throw new Error(NO_HISTORY);
  if (!FULL_HASH.test(commit)) throw new Error(NOT_IN_HISTORY);
  const row = (await getFileHistory(vault, path)).find((r) => r.hash === commit);
  if (row === undefined) throw new Error(NOT_IN_HISTORY);
  if (row.pathAt === null) throw new Error(OUTSIDE_VAULT);
  if (row.change === 'deleted') throw new Error(REMOVED);
  const version = fileAt(s, row.pathAt, commit);
  if (version.kind === 'absent') throw new Error(REMOVED);
  if (version.kind === 'binary') throw new Error(NOT_TEXT);
  if (version.kind === 'too_large') throw new Error(TOO_LARGE);
  if (liveRunOwners().has(path)) throw new Error(STILL_WRITING);
  if (peekFile(path) === version.text) {
    return { unchanged: true, before: null, restored: null, commitError: null };
  }
  const title = humanize(path.split('/').pop()?.replace(/\.md$/, '') ?? path);
  const dirty = s.modified.find((f) => f.path === path);
  const before =
    dirty === undefined ? null : pushCommit(s, `Before restoring ${title}`, [dirty]).hash;
  restoreFile(path, version.text);
  const day = new Date(row.date * 1000).toISOString().slice(0, 10);
  const restored = pushCommit(s, `Restore ${title} to ${row.shortHash} (${day})`, [
    { path, status: 'modified' },
  ]);
  s.modified = s.modified.filter((f) => f.path !== path);
  return { unchanged: false, before, restored: restored.hash, commitError: null };
}

/** One commit a spec stages (M58.4): its files, the bytes each held after
 * it (null for a file it removed), a rename's old path, and the run that
 * made it when one did. */
export interface SeedCommit {
  hash: string;
  message: string;
  author?: string;
  date: number;
  files: { path: string; status: string; previousPath?: string }[];
  snapshots: Record<string, string | null>;
  run?: { runId: string; actor: string } | null;
}

/** Stage `commits`, newest first, on top of the log. */
export function seedGitHistory(commits: SeedCommit[]): void {
  const s = state();
  s.isRepo = true;
  const staged: MockCommit[] = commits.map((c) => ({
    hash: c.hash,
    shortHash: c.hash.slice(0, 7),
    message: c.message,
    author: c.author ?? 'Ana Rios',
    date: c.date,
    changes: {
      files: c.files.map((f) => ({
        path: f.path,
        status: f.status,
        title: f.path.split('/').pop() ?? f.path,
      })),
      added: c.files.filter((f) => f.status === 'added').length,
      modified: c.files.filter((f) => f.status !== 'added' && f.status !== 'deleted').length,
      deleted: c.files.filter((f) => f.status === 'deleted').length,
    },
    snapshots: c.snapshots,
    run: c.run ?? null,
    renamedFrom: Object.fromEntries(
      c.files.flatMap((f) => (f.previousPath === undefined ? [] : [[f.path, f.previousPath]])),
    ),
  }));
  s.commits = [...staged, ...s.commits];
}

if (typeof window !== 'undefined') {
  (
    window as unknown as { __cerebroSeedGitHistory: typeof seedGitHistory }
  ).__cerebroSeedGitHistory = seedGitHistory;
}

export async function gitHasPendingChanges(_vault: string): Promise<boolean> {
  return state().modified.length > 0;
}

export async function gitFileUrl(_vault: string, path: string): Promise<string | null> {
  const s = state();
  if (s.remoteUrl === null) return null;
  return `https://github.com/acme/notes/blob/${s.branch}/${path}`;
}

/** As `remote::remote_status` (M92.10): git counts only against an
 * upstream, and a count it could not take is null, never 0. */
export async function gitRemoteStatus(_vault: string): Promise<GitRemoteStatus> {
  const s = state();
  const tracked = s.remoteUrl !== null;
  const counted = tracked && !s.countFails;
  return {
    branch: s.branch,
    ahead: counted ? s.ahead : null,
    behind: counted ? s.behind : null,
    hasRemote: tracked,
    hasUpstream: tracked,
    upstream: tracked ? `origin/${s.branch}` : null,
  };
}

function takeFailure(): RemoteResult | null {
  const s = state();
  const failure = s.nextRemoteFailure;
  s.nextRemoteFailure = null;
  return failure;
}

export async function gitPull(_vault: string): Promise<RemoteResult> {
  const forced = takeFailure();
  if (forced !== null) return forced;
  const s = state();
  if (s.remoteUrl === null) {
    return {
      status: 'no_remote',
      message: 'No remote is configured.',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  if (s.behind === 0) {
    return {
      status: 'up_to_date',
      message: 'Already up to date.',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  s.behind = 0;
  return {
    status: 'updated',
    message: 'Updated from origin.',
    updatedFiles: ['projects/atlas/project.md'],
    conflictFiles: [],
  };
}

export async function gitPush(_vault: string): Promise<RemoteResult> {
  const forced = takeFailure();
  if (forced !== null) return forced;
  const s = state();
  if (s.remoteUrl === null) {
    return {
      status: 'no_remote',
      message: 'No remote is configured.',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  if (s.behind > 0) {
    return {
      status: 'rejected',
      message: "The remote has commits you don't. Pull before pushing.",
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  s.ahead = 0;
  return { status: 'ok', message: 'Pushed.', updatedFiles: [], conflictFiles: [] };
}

export async function gitAddRemote(_vault: string, url: string): Promise<RemoteResult> {
  const s = state();
  if (s.remoteUrl !== null) {
    return {
      status: 'error',
      message: 'A remote is already configured. Disconnect it first.',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  const allowed = /^(https?:\/\/|ssh:\/\/|git@)/.test(url.trim());
  if (!allowed) {
    return {
      status: 'error',
      message: 'Use an https:// or ssh remote URL.',
      updatedFiles: [],
      conflictFiles: [],
    };
  }
  s.remoteUrl = url.trim();
  return { status: 'ok', message: 'Remote connected.', updatedFiles: [], conflictFiles: [] };
}

export async function gitDisconnectRemote(_vault: string): Promise<void> {
  state().remoteUrl = null;
}

export async function gitClone(_url: string, destination: string): Promise<string> {
  return destination;
}

export async function getConflictFiles(_vault: string): Promise<string[]> {
  return [...state().conflicts];
}

export async function getConflictMode(_vault: string): Promise<ConflictMode> {
  return state().conflictMode;
}

export async function gitResolveConflict(
  _vault: string,
  path: string,
  _keep: Resolution,
): Promise<void> {
  const s = state();
  s.conflicts = s.conflicts.filter((p) => p !== path);
}

export async function gitCommitConflictResolution(_vault: string): Promise<string> {
  const s = state();
  if (s.conflicts.length > 0) {
    throw new Error(`${s.conflicts.length} files still conflicted`);
  }
  s.conflictMode = 'none';
  return 'resolved';
}

export async function gitAbortConflict(_vault: string): Promise<void> {
  const s = state();
  s.conflicts = [];
  s.conflictMode = 'none';
}

export async function gitProviderStatus(): Promise<GitProviderStatus> {
  return {
    selectedProvider: 'native',
    native: {
      provider: 'native',
      label: 'System git',
      available: true,
      version: 'git version 2.39.5',
      path: '/usr/bin/git',
      message: 'Ready.',
    },
    distributions: [],
  };
}

// The PR reader has no disk or git effects. A browser spec may seed outcomes;
// absent gh is unavailable, never an empty successful check rollup.
const pullRequests = new Map<string, import('@/engine/pullRequest').PrRead>();
export function seedPullRequests(rows: Record<string, import('@/engine/pullRequest').PrRead>) {
  pullRequests.clear();
  for (const [url, read] of Object.entries(rows)) {
    const parsed = parsePullRequestUrl(url);
    if (parsed !== null) pullRequests.set(parsed.key, structuredClone(read));
  }
}
export async function pullRequestState(
  url: string,
  _refresh = false,
): Promise<import('@/engine/pullRequest').PrRead> {
  const parsed = parsePullRequestUrl(url);
  if (parsed === null) return { state: 'invalid_url', checkedAt: new Date().toISOString() };
  const seeded = pullRequests.get(parsed.key);
  if (
    seeded?.state === 'read' &&
    (seeded.pr.number !== parsed.number || parsePullRequestUrl(seeded.pr.url)?.key !== parsed.key)
  )
    return { state: 'unreadable', checkedAt: new Date().toISOString() };
  return seeded === undefined
    ? { state: 'gh_missing', checkedAt: new Date().toISOString() }
    : structuredClone(seeded);
}
if (typeof window !== 'undefined') {
  const host = window as unknown as {
    __cerebroSeedPullRequests: typeof seedPullRequests;
    __cerebroPullRequests?: Parameters<typeof seedPullRequests>[0];
  };
  host.__cerebroSeedPullRequests = seedPullRequests;
  if (host.__cerebroPullRequests !== undefined) seedPullRequests(host.__cerebroPullRequests);
}
