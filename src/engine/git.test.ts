import { describe, expect, it } from 'vitest';
import { diffStats, isFailure, parseDiff, syncState } from '@/engine/git';
import type { RemoteResult } from '@/engine/git';

const result = (status: RemoteResult['status']): RemoteResult => ({
  status,
  message: '',
  updatedFiles: [],
  conflictFiles: [],
});

describe('parseDiff', () => {
  // The trap: `---` and `+++` are file headers. Matched after the single
  // character checks, every diff would open with a phantom removed line.
  it('classifies file headers as meta, not as additions and deletions', () => {
    const lines = parseDiff(['--- a/x.md', '+++ b/x.md'].join('\n'));
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta']);
  });

  it('classifies hunks, additions, deletions, and context', () => {
    const lines = parseDiff(['@@ -1 +1 @@', '-old', '+new', ' same'].join('\n'));
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'add', 'context']);
  });

  it('treats the rest of git’s preamble as meta', () => {
    const lines = parseDiff(
      ['diff --git a/x b/x', 'index 111..222 100644', 'new file mode 100644'].join('\n'),
    );
    expect(lines.every((l) => l.kind === 'meta')).toBe(true);
  });
});

describe('diffStats', () => {
  it('counts real additions and removals, excluding headers', () => {
    const diff = ['--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,2 @@', '-a', '+b', '+c', ' d'].join('\n');
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1 });
  });
});

describe('syncState', () => {
  const remote = {
    branch: 'main',
    ahead: 0,
    behind: 0,
    hasRemote: true,
    hasUpstream: true,
    upstream: 'origin/main',
  };

  it('reports conflicts above everything else', () => {
    expect(syncState({ ...remote, ahead: 3, behind: 2 }, 5, 1)).toBe('conflict');
  });

  it('reports uncommitted work before remote divergence', () => {
    expect(syncState({ ...remote, ahead: 2 }, 3, 0)).toBe('local-changes');
  });

  it('distinguishes ahead, behind, and diverged', () => {
    expect(syncState({ ...remote, ahead: 1 }, 0, 0)).toBe('ahead');
    expect(syncState({ ...remote, behind: 1 }, 0, 0)).toBe('behind');
    expect(syncState({ ...remote, ahead: 1, behind: 1 }, 0, 0)).toBe('diverged');
  });

  it('is clean with no remote and nothing pending', () => {
    expect(syncState(null, 0, 0)).toBe('clean');
  });
});

describe('isFailure', () => {
  // The distinction is the point: each of these needs a different fix, so
  // they must not collapse into one "sync failed".
  it('names the outcomes the user has to act on', () => {
    for (const status of ['error', 'auth_error', 'network_error', 'rejected'] as const) {
      expect(isFailure(result(status))).toBe(true);
    }
    for (const status of ['ok', 'up_to_date', 'updated', 'no_remote', 'conflict'] as const) {
      expect(isFailure(result(status))).toBe(false);
    }
  });
});
