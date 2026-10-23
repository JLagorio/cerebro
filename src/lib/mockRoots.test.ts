import { beforeEach, describe, expect, it } from 'vitest';
import { isRootGitRefusal } from '@/engine/roots';
import * as mock from './mockRoots';
import { seedBytes, reset as resetBytes } from './mockBytes';

/** A NUL written as an escape — never a raw byte in a source file. */
const NUL = '\u0000';

beforeEach(() => {
  mock.resetMockRoots();
});

describe('mount', () => {
  it('mounts a directory and lists it', async () => {
    const root = await mock.mountRoot('/repos/alpha');
    expect('id' in root).toBe(true);
    expect(await mock.listRoots()).toHaveLength(1);
  });

  it('refuses the same path twice', async () => {
    await mock.mountRoot('/repos/alpha');
    const again = await mock.mountRoot('/repos/alpha');
    expect('code' in again && again.code).toBe('already_mounted');
  });

  it('refuses a second knowledge root and names the first', async () => {
    mock.seedRoot({ path: '/vault', label: 'vault', knowledge: true });
    mock.seedKnowledgeDir('/repos/brain');
    const refused = await mock.mountRoot('/repos/brain');
    expect('code' in refused && refused.code).toBe('knowledge_root_exists');
    expect('message' in refused && refused.message).toContain('vault');
  });
});

describe('readFileText guards — parity with roots/read.rs', () => {
  it('refuses a path escaping the root', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    expect(await mock.readFileText(root.id, '../../etc/passwd')).toEqual({ kind: 'notFound' });
  });

  it('refuses a file over the size cap', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedFile('/repos/alpha', 'big.txt', 'x'.repeat(mock.MAX_BYTES + 1));
    const out = await mock.readFileText(root.id, 'big.txt');
    expect(out.kind).toBe('tooLarge');
  });

  it('refuses a file containing NUL', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedFile('/repos/alpha', 'image.png', `PNG${NUL}data`);
    expect(await mock.readFileText(root.id, 'image.png')).toEqual({ kind: 'binary' });
  });

  it('reads a text file', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedFile('/repos/alpha', 'README.md', '# Alpha');
    expect(await mock.readFileText(root.id, 'README.md')).toEqual({
      kind: 'text',
      content: '# Alpha',
    });
  });

  it('reports a missing file as notFound', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    expect(await mock.readFileText(root.id, 'nope.md')).toEqual({ kind: 'notFound' });
  });
});

describe('listDir', () => {
  it('returns one level, directories before files', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedFile('/repos/alpha', 'z.md', '# Z');
    mock.seedFile('/repos/alpha', 'sub/deep.md', '# Deep');

    const out = await mock.listDir(root.id, '');
    expect(out.map((e) => e.name)).toEqual(['sub', 'z.md']);
    expect(out[0].isDir).toBe(true);
  });

  it('descends into a subdirectory', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedFile('/repos/alpha', 'sub/deep.md', '# Deep');

    const out = await mock.listDir(root.id, 'sub');
    expect(out.map((e) => e.path)).toEqual(['sub/deep.md']);
  });

  it('refuses a path escaping the root', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    expect(await mock.listDir(root.id, '../..')).toEqual([]);
  });

  it('keeps roots isolated from each other', async () => {
    const alpha = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedRoot({ path: '/repos/beta', label: 'beta' });
    mock.seedFile('/repos/alpha', 'a.md', '# A');
    mock.seedFile('/repos/beta', 'b.md', '# B');

    expect((await mock.listDir(alpha.id, '')).map((e) => e.name)).toEqual(['a.md']);
  });
});

describe('root git parity', () => {
  it('the mock emits every refusal the Rust surface can emit', async () => {
    const repo = mock.seedRoot({ path: '/repos/alpha', label: 'alpha', git: true });
    const plain = mock.seedRoot({ path: '/notes', label: 'notes', git: false });
    mock.seedRootGit('/repos/alpha', { branch: 'main' });

    // no_such_root
    const unknown = await mock.rootGitRemoteStatus('nope');
    expect('code' in unknown && unknown.code).toBe('no_such_root');

    // no_git_capability — a mounted root with no git capability
    const notRepo = await mock.rootGitRemoteStatus(plain.id);
    expect('code' in notRepo && notRepo.code).toBe('no_git_capability');

    // git_error — seeded, because a mock that cannot FAIL cannot prove parity
    mock.seedRootGitFailure(repo.id);
    const failed = await mock.rootGitRemoteStatus(repo.id);
    expect('code' in failed && failed.code).toBe('git_error');

    // config_unavailable is Rust-transport-only (there is no app config dir in
    // a browser), and parent_repo is the sync gate's, emitted under 'root git
    // sync' below; every other code in roots/mod.rs's RootGitRefusal doc list
    // is emitted above. Keep this comment next to that list when either moves.
  });

  it('the gate applies to every root git command, not just status', async () => {
    const plain = mock.seedRoot({ path: '/notes', label: 'notes', git: false });
    for (const call of [
      mock.rootGitRemoteStatus(plain.id),
      mock.rootGitModifiedFiles(plain.id),
      mock.rootGitPulse(plain.id),
      mock.rootGitFileUrl(plain.id, 'README.md'),
      mock.rootGitWorkspaceInfo(plain.id),
    ]) {
      const result = await call;
      expect(isRootGitRefusal(result) && result.code).toBe('no_git_capability');
    }
  });

  it('a repo root answers status, pulse and file url', async () => {
    const repo = mock.seedRoot({ path: '/repos/alpha', label: 'alpha', git: true });
    mock.seedRootGit('/repos/alpha', { branch: 'main', ahead: 1, behind: 3 });

    const status = await mock.rootGitRemoteStatus(repo.id);
    expect('branch' in status && status.branch).toBe('main');
    expect('ahead' in status && status.ahead).toBe(1);
    expect(await mock.rootGitPulse(repo.id)).toEqual({ tracked: true, commits: [] });
  });
});

describe('root git sync', () => {
  it('refuses parent_repo for a root nested in a larger repository', async () => {
    const nested = mock.seedRoot({ path: '/work/mono/sub', label: 'sub', git: true });
    mock.seedRootGit('/work/mono/sub', { branch: 'main', behind: 2 });
    mock.seedRootNested('/work/mono/sub');

    for (const call of [mock.rootGitFetch(nested.id), mock.rootGitPullFf(nested.id)]) {
      const result = await call;
      expect(isRootGitRefusal(result) && result.code).toBe('parent_repo');
    }
    // The READ surface still answers — status is pathspec-scoped — and says
    // where the enclosing repository is, as Rust's resolve does.
    const status = await mock.rootGitRemoteStatus(nested.id);
    expect(isRootGitRefusal(status)).toBe(false);
    expect(await mock.rootGitWorkspaceInfo(nested.id)).toEqual({
      vaultRoot: '/work/mono/sub',
      gitRoot: '/work/mono',
      vaultPathspec: 'sub',
      gitRootRelation: 'parent',
      resolutionFailure: null,
    });
  });

  it('refuses a diverged fast-forward and leaves the counts alone', async () => {
    const repo = mock.seedRoot({ path: '/repos/div', label: 'div', git: true });
    mock.seedRootGit('/repos/div', { branch: 'main', ahead: 1, behind: 1 });

    const pulled = await mock.rootGitPullFf(repo.id);

    expect(!isRootGitRefusal(pulled) && pulled.status).toBe('rejected');
    const after = await mock.rootGitRemoteStatus(repo.id);
    expect(!isRootGitRefusal(after) && after.behind).toBe(1);
  });

  it('a failing remote fails fetch and pull as remote::classify reports it', async () => {
    const repo = mock.seedRoot({ path: '/repos/locked', label: 'locked', git: true });
    mock.seedRootGit('/repos/locked', { branch: 'main', behind: 2 });

    for (const failure of ['auth_error', 'network_error', 'error'] as const) {
      mock.seedRootGitRemoteFailure('/repos/locked', failure);
      for (const call of [mock.rootGitFetch(repo.id), mock.rootGitPullFf(repo.id)]) {
        const result = await call;
        expect(!isRootGitRefusal(result) && result.status).toBe(failure);
      }
    }
    mock.seedRootGitRemoteFailure('/repos/locked', 'auth_error');
    const fetched = await mock.rootGitFetch(repo.id);
    expect(!isRootGitRefusal(fetched) && fetched.message).toBe(
      'Git could not authenticate with the remote. Check your credential helper or SSH key.',
    );
    // A failed pull moved nothing.
    const after = await mock.rootGitRemoteStatus(repo.id);
    expect(!isRootGitRefusal(after) && after.behind).toBe(2);

    // Rust asks for a remote before git runs, so a remoteless root answers
    // no_remote however its remote would have failed.
    const bare = mock.seedRoot({ path: '/repos/bare', label: 'bare', git: true });
    mock.seedRootGit('/repos/bare', { hasRemote: false });
    mock.seedRootGitRemoteFailure('/repos/bare', 'network_error');
    const none = await mock.rootGitFetch(bare.id);
    expect(!isRootGitRefusal(none) && none.status).toBe('no_remote');
  });

  it('fast-forwards a root that is only behind', async () => {
    const repo = mock.seedRoot({ path: '/repos/ff', label: 'ff', git: true });
    mock.seedRootGit('/repos/ff', { branch: 'main', ahead: 0, behind: 3 });

    const pulled = await mock.rootGitPullFf(repo.id);

    expect(!isRootGitRefusal(pulled) && pulled.status).toBe('updated');
    const after = await mock.rootGitRemoteStatus(repo.id);
    expect(!isRootGitRefusal(after) && after.behind).toBe(0);
  });

  // M92.10: as `remote::remote_status`, counts exist only against an
  // upstream, and one git could not take stays null and moves nothing.
  it('counts nothing without an upstream, and never pulls through an unknown count', async () => {
    const plain = mock.seedRoot({ path: '/repos/plain', label: 'plain', git: true });
    expect(await mock.rootGitRemoteStatus(plain.id)).toMatchObject({
      ahead: null,
      behind: null,
      hasUpstream: false,
      upstream: null,
    });

    const loose = mock.seedRoot({ path: '/repos/loose', label: 'loose', git: true });
    mock.seedRootGit('/repos/loose', { branch: 'topic', ahead: 2, hasUpstream: false });
    expect(await mock.rootGitRemoteStatus(loose.id)).toMatchObject({
      ahead: null,
      behind: null,
      upstream: null,
    });

    const broken = mock.seedRoot({ path: '/repos/broken', label: 'broken', git: true });
    mock.seedRootGit('/repos/broken', { branch: 'main', ahead: null, behind: null });
    for (const root of [loose, broken]) {
      const pulled = await mock.rootGitPullFf(root.id);
      expect(!isRootGitRefusal(pulled) && pulled.status).toBe('error');
      const after = await mock.rootGitRemoteStatus(root.id);
      expect(!isRootGitRefusal(after) && after.behind).toBeNull();
    }
  });
});

describe('thumbnail browser parity', () => {
  beforeEach(() => resetBytes());
  it('keeps dimensions unrecorded and recognizes PNG bytes', async () => {
    seedBytes('0', 'picture.png', { bytes: [137, 80, 78, 71, 13, 10, 26, 10] });
    expect(await mock.fileThumbnail('0', 'picture.png', 128)).toEqual({
      state: 'ready',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      width: null,
      height: null,
      source: 'image',
    });
  });
  it('rejects escapes and reports unsupported Office bytes without inventing a preview', async () => {
    seedBytes('0', 'file.docx', { text: 'PK archive' });
    expect(await mock.fileThumbnail('0', 'file.docx', 128)).toEqual({
      state: 'none',
      reason: 'unsupported',
    });
    for (const path of ['../picture.png', '/etc/passwd', 'missing.png'])
      expect(await mock.fileThumbnail('0', path, 128)).toEqual({
        state: 'none',
        reason: 'notFound',
      });
  });
});
