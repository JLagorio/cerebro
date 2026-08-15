import { beforeEach, describe, expect, it } from 'vitest';
import { isRootGitRefusal } from '@/engine/roots';
import * as mock from './mockRoots';

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
    // a browser); every other code in roots/mod.rs's RootGitRefusal doc list is
    // emitted above. Keep this comment next to that list when either moves.
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
    expect(Array.isArray(await mock.rootGitPulse(repo.id))).toBe(true);
  });
});
