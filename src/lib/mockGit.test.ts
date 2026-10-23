// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunPageWrites } from '@/engine/attribution';
import type { ChangedFile, RunChangeset } from '@/engine/changeset';
import * as gitIpc from '@/lib/gitIpc';
import { failNext, resetFaults } from '@/lib/mockFaults';
import {
  commitRun,
  commitRuns,
  conversationChanges,
  getFileAtCommit,
  getFileDiffAtCommit,
  getFileHistory,
  getFilePatch,
  getModifiedFiles,
  getVaultPulse,
  gitCommit,
  gitDiscardFile,
  gitPull,
  gitPush,
  gitRemoteStatus,
  resetMockGit,
  restoreNoteVersion,
  seedGitHistory,
  settleMockRun,
  type SeedCommit,
} from '@/lib/mockGit';
import {
  __seedFleet,
  agentAppend,
  agentCreate,
  beginMockRun,
  endMockRun,
  HUMAN_ACTOR,
  resetMockFs,
  type FleetRun,
  type FleetRunDetail,
  type MockWrite,
} from '@/lib/mockIpc';

const SEEDED = 'knowledge/onboarding-drop-off.md';

// M53.15: the mock answers the way Rust does. A vault that is not a
// repository is untracked and has no history, whatever commits a test left
// in the log; the seeded repository is tracked and has history.
describe('mock git history', () => {
  beforeEach(() => {
    resetMockGit();
  });

  it('reads a vault that is not a repository as untracked, with no history', async () => {
    resetMockGit({ isRepo: false });
    expect(await getVaultPulse('/v')).toEqual({ tracked: false, commits: [] });
    expect(await getFileHistory('/v', SEEDED)).toEqual([]);
  });

  it('reads the seeded repository as tracked, with history for a seeded path', async () => {
    const pulse = await getVaultPulse('/v');
    expect(pulse.tracked).toBe(true);
    expect(pulse.commits.length).toBeGreaterThan(0);

    const history = await getFileHistory('/v', SEEDED);
    expect(history.map((c) => c.hash)).toEqual(['c2'.repeat(20)]);
    // A file history is FileCommit rows, as Rust's are: no file list.
    expect(history[0]).not.toHaveProperty('changes');
    expect(history[0]).toMatchObject({
      parent: 'c1'.repeat(20),
      pathAt: SEEDED,
      previousPath: null,
      change: 'modified',
    });
  });

  it('leaves a commit whose files are unknown out of every file history', async () => {
    const [head] = resetMockGit().commits;
    resetMockGit({ commits: [{ ...head, changes: null }] });
    expect(await getFileHistory('/v', SEEDED)).toEqual([]);
  });
});

// M92.10: the mock counts as `remote::remote_status` does. Counts exist only
// against an upstream, and a count git could not take is null, never 0.
describe('mock git remote counts', () => {
  beforeEach(() => {
    resetMockGit();
  });

  it('counts against the upstream once there is one', async () => {
    resetMockGit({ remoteUrl: 'https://example.test/notes.git', ahead: 2, behind: 1 });
    expect(await gitRemoteStatus('/v')).toMatchObject({
      ahead: 2,
      behind: 1,
      hasUpstream: true,
      upstream: 'origin/main',
    });
  });

  it('counts nothing without an upstream', async () => {
    expect(await gitRemoteStatus('/v')).toMatchObject({
      ahead: null,
      behind: null,
      hasRemote: false,
      hasUpstream: false,
      upstream: null,
    });
  });

  it('reads a failed count as unknown, and leaves the repository to pull and push', async () => {
    resetMockGit({
      remoteUrl: 'https://example.test/notes.git',
      ahead: 2,
      behind: 1,
      countFails: true,
    });
    expect(await gitRemoteStatus('/v')).toMatchObject({
      ahead: null,
      behind: null,
      hasUpstream: true,
    });
    // The count failing is a read failing: what the person asks for still runs.
    expect((await gitPull('/v')).status).toBe('updated');
    expect((await gitPush('/v')).status).toBe('ok');
    expect(await gitRemoteStatus('/v')).toMatchObject({ ahead: null, behind: null });
  });
});

// M58.1 (Q2): Discard is a person's write, through the bundle guard.
describe('mock git discard', () => {
  const writes = () =>
    (window as unknown as { __cerebroMockWrites: MockWrite[] }).__cerebroMockWrites;

  beforeEach(() => {
    resetMockFs();
    resetMockGit({
      modified: [
        { path: 'notes/a.md', status: 'modified', staged: false },
        { path: 'notes/new.md', status: 'untracked', staged: false },
        { path: 'knowledge/concepts/a.md', status: 'modified', staged: false },
      ],
    });
  });

  it('refuses knowledge/ and logs a human:me row', async () => {
    await expect(gitDiscardFile('/v', 'knowledge/concepts/a.md')).rejects.toThrow('read-only');
    expect(writes()).toEqual([]);
    await gitDiscardFile('/v', 'notes/a.md');
    await gitDiscardFile('/v', 'notes/new.md');
    expect(writes().map((w) => [w.kind, w.path, w.actor, w.runId])).toEqual([
      ['vault.write', 'notes/a.md', HUMAN_ACTOR, null],
      ['vault.delete', 'notes/new.md', HUMAN_ACTOR, null],
    ]);
    expect((await getModifiedFiles('/v')).map((f) => f.path)).toEqual(['knowledge/concepts/a.md']);
  });

  it('takes the path literally, as status.rs does', async () => {
    await expect(gitDiscardFile('/v', 'kn?wledge/concepts/a.md')).rejects.toThrow(
      'nothing to discard',
    );
    for (const path of ['.', './notes/a.md', 'notes//a.md', 'notes/']) {
      await expect(gitDiscardFile('/v', path)).rejects.toThrow();
    }
    expect(writes()).toEqual([]);
    expect((await getModifiedFiles('/v')).map((f) => f.path)).toHaveLength(3);
  });
});

// M58.3: a run's own commit, the paths a live run owns, and its patches.
describe('mock git and live runs', () => {
  const stamp = { actor: 'claude-code', runId: 'mock-test-1' };

  beforeEach(() => {
    resetMockFs();
    resetMockGit({
      modified: [
        { path: 'notes/a.md', status: 'modified', staged: false },
        { path: 'notes/mine.md', status: 'modified', staged: false },
      ],
    });
    (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.set(
      'notes/a.md',
      '# A\n',
    );
  });

  it('names the run that owns a path, and leaves it out of a person’s commit', async () => {
    beginMockRun(stamp.runId, stamp.actor);
    await agentAppend('/v', 'notes/a.md', 'Run line.', undefined, stamp);
    const files = await getModifiedFiles('/v');
    expect(files.map((f) => [f.path, f.owner?.runId ?? null])).toEqual([
      ['notes/a.md', stamp.runId],
      ['notes/mine.md', null],
    ]);
    const short = await gitCommit('/v', 'Update mine');
    expect(short).toMatch(/^[0-9a-f]{7}$/);
    const state = window.__cerebroMockGit;
    expect(state?.commits[0].changes?.files.map((f) => f.path)).toEqual(['notes/mine.md']);
    expect(state?.commits[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect((await getModifiedFiles('/v')).map((f) => f.path)).toEqual(['notes/a.md']);
    expect(await gitCommit('/v', 'again')).toBeNull();
    endMockRun(stamp.runId);
  });

  it('commits a run’s own paths and keeps its patch', async () => {
    beginMockRun(stamp.runId, stamp.actor);
    await agentAppend('/v', 'notes/a.md', 'Run line.', undefined, stamp);
    const changeset = settleMockRun(stamp.runId, stamp.actor, 'add a line\nmore');
    endMockRun(stamp.runId);
    expect(changeset).toMatchObject({
      state: 'committed',
      run_id: stamp.runId,
      additions: 2,
      deletions: 0,
      files: [{ path: 'notes/a.md', kind: 'modified', additions: 2, deletions: 0 }],
    });
    const commit = (changeset as { commit: string }).commit;
    const state = window.__cerebroMockGit;
    expect(state?.commits[0].message).toBe(
      `assistant: add a line\n\nCerebro-Run: ${stamp.runId}\nCerebro-Actor: claude-code`,
    );
    expect(state?.modified.map((f) => f.path)).toEqual(['notes/mine.md']);
    const patch = await getFilePatch('/v', 'notes/a.md', commit);
    expect(patch).toEqual({
      text: expect.stringContaining('+Run line.'),
      truncated: false,
      binary: false,
    });
    expect(commitRun([], 'nothing')).toBeNull();
  });

  it('reads a vault with no history as files without counts', async () => {
    resetMockGit({ isRepo: false });
    beginMockRun(stamp.runId, stamp.actor);
    await agentAppend('/v', 'notes/a.md', 'Run line.', undefined, stamp);
    expect(settleMockRun(stamp.runId, stamp.actor, null)).toEqual({
      state: 'not_a_repo',
      kept_out_of_git: 0,
      run_id: stamp.runId,
      files: ['notes/a.md'],
      shell_unrecorded: false,
    });
    endMockRun(stamp.runId);
    await expect(getFilePatch('/v', 'notes/a.md', 'abc')).rejects.toThrow('not a git repository');
  });
});

// M58.4: versions, the commit record, Restore, and the seed seam.
describe('mock git versions and Restore', () => {
  const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  const writes = () =>
    (window as unknown as { __cerebroMockWrites: MockWrite[] }).__cerebroMockWrites;
  const PAGE = 'notes/plan.md';
  const h = (c: string) => c.repeat(40);
  const history: SeedCommit[] = [
    {
      hash: h('3'),
      message: 'release-scout: refresh\n\nCerebro-Run: run-scout-1',
      date: 1_790_000_300,
      files: [{ path: PAGE, status: 'modified' }],
      snapshots: { [PAGE]: '# Plan\n\nThird.\n' },
      run: { runId: 'run-scout-1', actor: 'process:release-scout' },
    },
    {
      hash: h('2'),
      message: 'forged\n\nCerebro-Run: run-scout-1',
      date: 1_790_000_200,
      files: [{ path: PAGE, status: 'renamed', previousPath: 'notes/old.md' }],
      snapshots: { [PAGE]: '# Plan\n\nSecond.\n' },
    },
    {
      hash: h('1'),
      message: 'create',
      date: 1_790_000_100,
      files: [{ path: 'notes/old.md', status: 'added' }],
      snapshots: { 'notes/old.md': '# Plan\n\nFirst.\n' },
    },
  ];

  beforeEach(() => {
    resetMockFs();
    resetMockGit();
    seedGitHistory(history);
    fs().set(PAGE, '# Plan\n\nThird.\n');
  });

  it('reads FileCommit rows, a rename followed back to its old name', async () => {
    const rows = await getFileHistory('/v', PAGE);
    expect(rows.map((r) => [r.hash, r.pathAt, r.previousPath, r.change, r.parent])).toEqual([
      [h('3'), PAGE, null, 'modified', h('2')],
      [h('2'), PAGE, 'notes/old.md', 'renamed', h('1')],
      [h('1'), 'notes/old.md', null, 'added', 'c2'.repeat(20)],
    ]);
    expect(rows[0].previousAt).toBe(new Date(1_790_000_200 * 1000).toISOString());
    expect(rows[2].previousAt).toBeNull();
    expect(await getFileAtCommit('/v', 'notes/old.md', h('1'))).toEqual({
      kind: 'text',
      text: '# Plan\n\nFirst.\n',
    });
    expect(await getFileAtCommit('/v', PAGE, h('1'))).toEqual({ kind: 'absent' });
    const diff = await getFileDiffAtCommit('/v', PAGE, h('2'), 'notes/old.md');
    expect(diff).toContain('rename from notes/old.md');
    expect(diff).toContain('-First.');
    expect(diff).toContain('+Second.');
  });

  it('keeps each committed file as it was at the commit', async () => {
    resetMockGit({ modified: [{ path: PAGE, status: 'modified', staged: false }] });
    fs().set(PAGE, '# Plan\n\nTyped.\n');
    await gitCommit('/v', 'Update plan');
    fs().set(PAGE, '# Plan\n\nLater.\n');
    const [head] = await getFileHistory('/v', PAGE);
    expect(await getFileAtCommit('/v', PAGE, head.hash)).toEqual({
      kind: 'text',
      text: '# Plan\n\nTyped.\n',
    });
    // A commit made before snapshots were kept cannot be read.
    await expect(getFileAtCommit('/v', SEEDED, 'c2'.repeat(20))).rejects.toThrow('kept no copy');
  });

  it("answers only the commits a run's record names, never a trailer", async () => {
    expect(
      await commitRuns('/v', [
        { hash: h('3'), path: PAGE, since: null },
        { hash: h('2'), path: PAGE, since: null },
      ]),
    ).toEqual([
      {
        hash: h('3'),
        run_id: 'run-scout-1',
        actor: 'process:release-scout',
        with_person: false,
        also_by: [],
      },
    ]);
    await expect(commitRuns('/v', [{ hash: 'abc', path: null, since: null }])).rejects.toThrow(
      'is not a full commit hash',
    );
    await expect(
      commitRuns('/v', [{ hash: 'A'.repeat(40), path: null, since: null }]),
    ).rejects.toThrow('is not a full commit hash');
    const many = Array.from({ length: 201 }, () => ({ hash: h('3'), path: null, since: null }));
    await expect(commitRuns('/v', many)).rejects.toThrow('At most 200');
  });

  it('records a run commit made by the mock run', async () => {
    const stamp = { actor: 'claude-code', runId: 'mock-restore-1' };
    beginMockRun(stamp.runId, stamp.actor);
    await agentAppend('/v', PAGE, 'Run line.', undefined, stamp);
    const changeset = settleMockRun(stamp.runId, stamp.actor, 'append');
    endMockRun(stamp.runId);
    const commit = (changeset as { commit: string }).commit;
    expect(await commitRuns('/v', [{ hash: commit, path: PAGE, since: null }])).toEqual([
      { hash: commit, run_id: stamp.runId, actor: 'claude-code', with_person: false, also_by: [] },
    ]);
  });

  it("restores in Rust's order and words", async () => {
    await expect(restoreNoteVersion('/v', 'knowledge/c.md', h('1'))).rejects.toThrow('read-only');
    await expect(restoreNoteVersion('/v', 'data/table.csv', h('1'))).rejects.toThrow('not a note');
    await expect(restoreNoteVersion('/v', PAGE, 'c2'.repeat(20))).rejects.toThrow(
      "That version is not in this page's history.",
    );
    await expect(restoreNoteVersion('/v', PAGE, h('2').slice(0, 7))).rejects.toThrow(
      "That version is not in this page's history.",
    );
    expect(await restoreNoteVersion('/v', PAGE, h('3'))).toEqual({
      unchanged: true,
      before: null,
      restored: null,
      commitError: null,
    });
    expect(writes()).toEqual([]);

    resetMockGit();
    seedGitHistory(history);
    const state = window.__cerebroMockGit!;
    state.modified = [{ path: PAGE, status: 'modified', staged: false }];
    fs().set(PAGE, '# Plan\n\nUnsaved.\n');
    const restored = await restoreNoteVersion('/v', PAGE, h('2'));
    expect(fs().get(PAGE)).toBe('# Plan\n\nSecond.\n');
    expect(restored.unchanged).toBe(false);
    expect(state.commits[0].hash).toBe(restored.restored);
    expect(state.commits[0].message).toMatch(/^Restore Plan to 2222222 \(\d{4}-\d{2}-\d{2}\)$/);
    expect(state.commits[1].message).toBe('Before restoring Plan');
    expect(state.commits[1].hash).toBe(restored.before);
    expect(await getFileAtCommit('/v', PAGE, restored.before!)).toEqual({
      kind: 'text',
      text: '# Plan\n\nUnsaved.\n',
    });
    expect(writes().map((w) => [w.kind, w.path, w.actor, w.runId])).toEqual([
      ['vault.write', PAGE, HUMAN_ACTOR, null],
    ]);
    expect(await commitRuns('/v', [{ hash: restored.restored!, path: PAGE, since: null }])).toEqual(
      [],
    );
  });

  it('refuses a page a live run wrote', async () => {
    const stamp = { actor: 'claude-code', runId: 'mock-live-1' };
    beginMockRun(stamp.runId, stamp.actor);
    await agentAppend('/v', PAGE, 'Run line.', undefined, stamp);
    await expect(restoreNoteVersion('/v', PAGE, h('2'))).rejects.toThrow(
      'An agent run is still writing this page. Stop it or let it finish, then restore.',
    );
    endMockRun(stamp.runId);
  });

  it('stages history through the window seam', () => {
    resetMockGit();
    const seam = (window as unknown as { __cerebroSeedGitHistory: typeof seedGitHistory })
      .__cerebroSeedGitHistory;
    seam([history[0]]);
    expect(window.__cerebroMockGit?.commits[0].hash).toBe(h('3'));
  });
});

it('keeps mail out of a run and a checkpoint while preserving its page', async () => {
  const files = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  resetMockFs();
  resetMockGit({ modified: [{ path: 'sources/mail/one.md', status: 'modified', staged: false }] });
  files.set('sources/mail/one.md', '# Private\n');
  const stamp = { actor: 'claude-code', runId: 'mail-only' };
  beginMockRun(stamp.runId, stamp.actor);
  // Seed the native cache door's outcome; ordinary agent note doors cannot
  // write this folder. This test exercises git's treatment of its receipt.
  files.set('sources/mail/one.md', '# Private\n\nSeen.\n');
  (window as unknown as { __cerebroMockWrites: MockWrite[] }).__cerebroMockWrites.push({
    kind: 'vault.write',
    path: 'sources/mail/one.md',
    to: null,
    actor: stamp.actor,
    runId: stamp.runId,
    approvedBy: null,
  });
  expect(settleMockRun(stamp.runId, stamp.actor, null)).toMatchObject({
    state: 'nothing',
    kept_out_of_git: 1,
  });
  endMockRun(stamp.runId);
  expect(await gitCommit('/v', 'checkpoint')).toBeNull();
  expect(files.get('sources/mail/one.md')).toContain('Seen.');
});

// M69.11: gh reads are ephemeral and cannot alter git or vault bytes.
describe('mock pull requests', () => {
  it('refuses malformed URLs, reports missing gh, and clones seeded reads', async () => {
    const { pullRequestState, seedPullRequests } = await import('./mockGit');
    const url = 'https://github.com/acme/notes/pull/1';
    seedPullRequests({});
    expect((await pullRequestState(url)).state).toBe('gh_missing');
    expect((await pullRequestState('https://github.com.evil.test/a/b/pull/1')).state).toBe(
      'invalid_url',
    );
    seedPullRequests({ [url]: { state: 'offline', checkedAt: 'before' } });
    const result = await pullRequestState(url + '/files', true);
    result.checkedAt = 'changed';
    expect((await pullRequestState(url)).checkedAt).toBe('before');
    resetMockGit();
    expect((await pullRequestState(url)).state).toBe('gh_missing');
  });
});

// M92.12: a conversation's changes read back, as `git::conversation` reads
// runtime.db's runs and run_commits, then git: here the mock fleet's runs,
// the mock log's run records and its commits.
describe('mock conversation changes', () => {
  const SESSION = '00000000-0000-4000-8000-000000000092';
  const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  const at = (second: number) =>
    `2026-10-23T09:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}Z`;
  const run = (runId: string, second: number, over: Partial<FleetRun> = {}): FleetRun => ({
    run_id: runId,
    actor: 'claude-code',
    vault_id: '/v',
    mode: 'attended',
    lane: 'agent',
    started_at: at(second),
    ended_at: at(second),
    outcome: 'succeeded',
    usage_state: 'exact',
    input_tokens: 1,
    output_tokens: 1,
    proposals_submitted: 0,
    applied: 0,
    rejected: 0,
    parent_run_id: null,
    cause: null,
    cli_session_id: SESSION,
    ...over,
  });
  const detail = (of: FleetRun, wrote: RunPageWrites): FleetRunDetail => ({
    run: of,
    cost_components: null,
    assembly: null,
    model_id: null,
    refusals: [],
    refusals_total: 0,
    wrote,
  });
  const runIds = (changesets: RunChangeset[]) => changesets.map((c) => c.run_id);

  beforeEach(() => {
    resetMockFs();
    resetFaults();
    resetMockGit();
  });

  afterEach(() => {
    // The demo fleet again, for every other spec.
    resetMockFs();
    resetFaults();
  });

  it('reads a run’s commit back as the run settled it, and nothing only its reader knew', async () => {
    fs().set('notes/a.md', '# A\n');
    const stamp = { actor: 'claude-code', runId: 'run-live' };
    beginMockRun(stamp.runId, stamp.actor);
    await agentAppend('/v', 'notes/a.md', 'Run line.', undefined, stamp);
    await agentCreate('/v', { folder: 'notes', slug: 'new', body: '# New\n\nBody.\n' }, stamp);
    const live = settleMockRun(stamp.runId, stamp.actor, 'tidy');
    endMockRun(stamp.runId);
    __seedFleet([run('run-live', 1)]);
    const read = await conversationChanges('/v', SESSION);
    expect(read.truncated).toBe(false);
    const [healed] = read.changesets;
    if (live.state !== 'committed' || healed?.state !== 'committed') {
      throw new Error('both are the run’s commit');
    }
    const shape = (files: ChangedFile[]) =>
      files.map(({ path, kind, additions, deletions }) => ({ path, kind, additions, deletions }));
    expect(shape(healed.files)).toEqual(shape(live.files));
    expect(healed).toMatchObject({
      commit: live.commit,
      additions: live.additions,
      deletions: live.deletions,
      binary: live.binary,
      kept_out_of_git: null,
      shell_unrecorded: null,
    });
    expect(healed.files.map((f) => f.also_by)).toEqual([null, null]);
  });

  it('reads a seeded commit’s rename and counts from its copies', async () => {
    seedGitHistory([
      {
        hash: 'b'.repeat(40),
        message: 'assistant: move',
        date: 1_790_000_200,
        files: [{ path: 'notes/new.md', status: 'renamed', previousPath: 'notes/old.md' }],
        snapshots: { 'notes/new.md': '# Old\n\nMoved.\n' },
        run: { runId: 'run-move', actor: 'claude-code' },
      },
      {
        hash: 'a'.repeat(40),
        message: 'create',
        date: 1_790_000_100,
        files: [{ path: 'notes/old.md', status: 'added' }],
        snapshots: { 'notes/old.md': '# Old\n' },
      },
    ]);
    __seedFleet([run('run-move', 1)]);
    const { changesets } = await conversationChanges('/v', SESSION);
    expect(changesets).toEqual([
      {
        kept_out_of_git: null,
        state: 'committed',
        run_id: 'run-move',
        commit: 'b'.repeat(40),
        files: [
          {
            path: 'notes/new.md',
            previous_path: 'notes/old.md',
            kind: 'renamed',
            additions: 2,
            deletions: 0,
            also_by: null,
          },
        ],
        additions: 2,
        deletions: 0,
        binary: 0,
        shell_unrecorded: null,
      },
    ]);
  });

  it('reads a run no commit record names as not recorded, whatever its trailer says (CV-35)', async () => {
    seedGitHistory([
      {
        hash: 'c'.repeat(40),
        message: 'assistant: tidy\n\nCerebro-Run: run-trailer\nCerebro-Actor: claude-code',
        date: 1_790_000_100,
        files: [{ path: 'a.md', status: 'modified' }],
        snapshots: { 'a.md': '# a\n' },
        run: null,
      },
    ]);
    __seedFleet([run('run-trailer', 1)]);
    expect((await conversationChanges('/v', SESSION)).changesets).toEqual([
      {
        kept_out_of_git: null,
        state: 'not_recorded',
        run_id: 'run-trailer',
        reason: 'no commit was recorded for this run',
        files: [],
      },
    ]);
  });

  it('lists the paths a run booked in a vault with no history, mail left out', async () => {
    resetMockGit({ isRepo: false });
    const wrote = (path: string, to: string | null = null) => ({
      kind: to === null ? 'vault.write' : 'vault.rename',
      path,
      to,
      at: at(1),
      approved_by: null,
    });
    const paths = run('run-paths', 1);
    const quiet = run('run-quiet', 2);
    __seedFleet([paths, quiet, run('run-unbooked', 3)], {
      'run-paths': detail(paths, {
        state: 'partial',
        writes: [
          wrote('notes/b.md'),
          wrote('a.md'),
          wrote('old.md', 'moved.md'),
          wrote('sources/mail/kept.md'),
          wrote('.cerebro/connectors.json'),
        ],
      }),
      'run-quiet': detail(quiet, { state: 'recorded', writes: [] }),
    });
    expect((await conversationChanges('/v', SESSION)).changesets).toEqual([
      {
        kept_out_of_git: null,
        state: 'not_a_repo',
        run_id: 'run-paths',
        files: ['a.md', 'moved.md', 'notes/b.md', 'old.md'],
        shell_unrecorded: null,
      },
      // Its own Write and Edit calls are in no row: none is never "nothing".
      {
        kept_out_of_git: null,
        state: 'not_recorded',
        run_id: 'run-quiet',
        reason: 'no page write was recorded for this run',
        files: [],
      },
      {
        kept_out_of_git: null,
        state: 'not_recorded',
        run_id: 'run-unbooked',
        reason: "this run's writes were not recorded",
        files: [],
      },
    ]);
  });

  it('leaves out another vault’s runs, another session’s and one still at work', async () => {
    __seedFleet([
      run('run-here', 1),
      run('run-elsewhere', 2, { vault_id: '/elsewhere' }),
      run('run-other-session', 3, { cli_session_id: '00000000-0000-4000-8000-000000000093' }),
      run('run-live', 4, { outcome: 'running', ended_at: null }),
    ]);
    expect(runIds((await conversationChanges('/v', SESSION)).changesets)).toEqual(['run-here']);
  });

  it('keeps the newest 100 runs, oldest first, and says it left older ones out', async () => {
    const many = Array.from({ length: 101 }, (_, n) => run(`run-${String(n).padStart(3, '0')}`, n));
    __seedFleet(many);
    const capped = await conversationChanges('/v', SESSION);
    expect(capped.truncated).toBe(true);
    expect(capped.changesets).toHaveLength(100);
    expect(runIds(capped.changesets).at(0)).toBe('run-001');
    expect(runIds(capped.changesets).at(-1)).toBe('run-100');
    __seedFleet(many.slice(1));
    const exact = await conversationChanges('/v', SESSION);
    expect(exact.truncated).toBe(false);
    expect(exact.changesets).toHaveLength(100);
  });

  it('refuses an id that is no session, and fails when the fleet cannot be read', async () => {
    await expect(conversationChanges('/v', 'short')).rejects.toThrow(
      'is not a Claude Code session id',
    );
    __seedFleet(null);
    await expect(conversationChanges('/v', SESSION)).rejects.toThrow();
  });

  it('fails through the lab’s fault, once (CV-44)', async () => {
    __seedFleet([run('run-here', 1)]);
    failNext('conversation_changes');
    await expect(gitIpc.conversationChanges('/v', SESSION)).rejects.toThrow(
      'state lab: conversation_changes was told to fail once',
    );
    // The burst ends with its task.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runIds((await gitIpc.conversationChanges('/v', SESSION)).changesets)).toEqual([
      'run-here',
    ]);
  });
});
