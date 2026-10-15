// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  commitRun,
  commitRuns,
  getFileAtCommit,
  getFileDiffAtCommit,
  getFileHistory,
  getFilePatch,
  getModifiedFiles,
  getVaultPulse,
  gitCommit,
  gitDiscardFile,
  resetMockGit,
  restoreNoteVersion,
  seedGitHistory,
  settleMockRun,
  type SeedCommit,
} from '@/lib/mockGit';
import {
  agentAppend,
  beginMockRun,
  endMockRun,
  HUMAN_ACTOR,
  resetMockFs,
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
  await agentAppend('/v', 'sources/mail/one.md', 'Seen.', undefined, stamp);
  expect(settleMockRun(stamp.runId, stamp.actor, null)).toMatchObject({
    state: 'nothing',
    kept_out_of_git: 1,
  });
  endMockRun(stamp.runId);
  expect(await gitCommit('/v', 'checkpoint')).toBeNull();
  expect(files.get('sources/mail/one.md')).toContain('Seen.');
});
