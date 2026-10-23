import { describe, expect, it } from 'vitest';
import {
  RESTORE_KNOWLEDGE,
  RESTORE_NOT_TEXT,
  RESTORE_OUTSIDE,
  RESTORE_REMOVED,
  RESTORE_TOO_LARGE,
  UNCOUNTED_WORDS,
  countsUnknown,
  diffStats,
  isCounted,
  isFailure,
  parseDiff,
  restoreBlock,
  syncState,
} from '@/engine/git';
import type { FileCommit, GitRemoteStatus, RemoteResult } from '@/engine/git';

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

describe('parseDiff line numbers (M58.5)', () => {
  const numbers = (diff: string[]) =>
    parseDiff(diff.join('\n')).map((l) => [l.kind, l.oldLine, l.newLine]);

  it('numbers context, removed and added lines from a header with counts', () => {
    expect(numbers(['@@ -3,3 +3,4 @@', ' keep', '-old', '+new', '+more', ' tail'])).toEqual([
      ['hunk', null, null],
      ['context', 3, 3],
      ['del', 4, null],
      ['add', null, 4],
      ['add', null, 5],
      ['context', 5, 6],
    ]);
  });

  it('reads a header without counts as one line each', () => {
    expect(numbers(['@@ -7 +9 @@', '-old', '+new', ' after'])).toEqual([
      ['hunk', null, null],
      ['del', 7, null],
      ['add', null, 9],
      // Past the hunk's counts: still context, never numbered.
      ['context', null, null],
    ]);
  });

  it('restarts at each hunk and at each file', () => {
    const lines = parseDiff(
      [
        'diff --git a/a.md b/a.md',
        '--- a/a.md',
        '+++ b/a.md',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+A',
        '@@ -10,1 +10,1 @@',
        '-j',
        '+J',
        'diff --git a/b.md b/b.md',
        '--- a/b.md',
        '+++ b/b.md',
        '@@ -2,1 +2,1 @@',
        '-b',
        '+B',
      ].join('\n'),
    );
    expect(lines.filter((l) => l.kind === 'del').map((l) => l.oldLine)).toEqual([1, 10, 2]);
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.newLine)).toEqual([1, 10, 2]);
    expect(lines.filter((l) => l.kind === 'meta').every((l) => l.oldLine === null)).toBe(true);
  });

  it('reads git\u2019s no-newline marker as meta with no number', () => {
    const lines = parseDiff(
      ['@@ -1,1 +1,1 @@', '-old', '\\ No newline at end of file', '+new', ''].join('\n'),
    );
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['hunk', null, null],
      ['del', 1, null],
      ['meta', null, null],
      ['add', null, 1],
      // The trailing empty line is outside the hunk.
      ['context', null, null],
    ]);
  });

  it('numbers nothing outside a hunk', () => {
    const lines = parseDiff(['diff --git a/x b/x', 'index 1..2', '--- a/x', '+++ b/x'].join('\n'));
    expect(lines.every((l) => l.oldLine === null && l.newLine === null)).toBe(true);
  });

  it('keeps the kinds it always gave', () => {
    const lines = parseDiff(
      ['--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,2 @@', '-a', '+b', ' c', ''].join('\n'),
    );
    expect(lines.map((l) => l.kind)).toEqual([
      'meta',
      'meta',
      'hunk',
      'del',
      'add',
      'context',
      'context',
    ]);
  });
});

describe('diffStats', () => {
  it('counts real additions and removals, excluding headers', () => {
    const diff = ['--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,2 @@', '-a', '+b', '+c', ' d'].join('\n');
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1 });
  });
});

const remote: GitRemoteStatus = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  hasRemote: true,
  hasUpstream: true,
  upstream: 'origin/main',
};

/** A branch that tracks nothing, as `remote::remote_status` reads it (M92.10). */
const untracked: GitRemoteStatus = {
  ...remote,
  ahead: null,
  behind: null,
  hasUpstream: false,
  upstream: null,
};

describe('syncState', () => {
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

  // M92.10: a count git did not take is unknown, never the zero that reads
  // "Up to date", whichever count it is and whatever the other one says.
  it('is unknown, never clean, when git did not count', () => {
    expect(syncState({ ...remote, ahead: null, behind: null }, 0, 0)).toBe('unknown');
    expect(syncState({ ...remote, behind: null }, 0, 0)).toBe('unknown');
    expect(syncState({ ...remote, ahead: 2, behind: null }, 0, 0)).toBe('unknown');
    expect(syncState({ ...remote, ahead: null, behind: 3 }, 0, 0)).toBe('unknown');
    expect(syncState(untracked, 0, 0)).toBe('unknown');
    // What is measured on disk still comes first.
    expect(syncState(untracked, 2, 0)).toBe('local-changes');
    expect(syncState(untracked, 0, 1)).toBe('conflict');
  });
});

describe('countsUnknown (M92.10)', () => {
  it('names why a remote has no counts, and nothing once git took both', () => {
    expect(countsUnknown(remote)).toBeNull();
    expect(isCounted(remote)).toBe(true);
    expect(countsUnknown({ ...remote, behind: null })).toBe('unread');
    expect(countsUnknown({ ...remote, ahead: null, behind: null })).toBe('unread');
    expect(countsUnknown(untracked)).toBe('no_upstream');
    expect(isCounted(untracked)).toBe(false);
  });

  it('has words for every reason, and none of them is a number', () => {
    for (const reason of ['no_upstream', 'unread'] as const) {
      expect(UNCOUNTED_WORDS[reason]).toMatch(/^[^\d]+$/);
    }
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

// M58.4: Restore is offered for a text version of a page inside the vault
// that did not remove it, and never for a concept.
describe('restoreBlock', () => {
  const commit = (patch: Partial<FileCommit> = {}): FileCommit => ({
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaa',
    message: 'edit',
    author: 'Ana Rios',
    date: 1_753_700_000,
    parent: 'b'.repeat(40),
    previousAt: null,
    pathAt: 'notes/plan.md',
    previousPath: null,
    change: 'modified',
    ...patch,
  });
  const text = { kind: 'text' as const, text: '# Plan\n' };

  it('offers Restore for a text version of a page', () => {
    expect(restoreBlock('notes/plan.md', commit(), text)).toBeNull();
    expect(restoreBlock('notes/plan.md', commit(), null)).toBeNull();
  });

  it('gives each reason it is not offered', () => {
    expect(restoreBlock('knowledge/c.md', commit(), text)).toBe(RESTORE_KNOWLEDGE);
    expect(restoreBlock('notes/plan.md', commit({ pathAt: null }), text)).toBe(RESTORE_OUTSIDE);
    expect(restoreBlock('notes/plan.md', commit({ change: 'deleted' }), null)).toBe(
      RESTORE_REMOVED,
    );
    expect(restoreBlock('notes/plan.md', commit(), { kind: 'absent' })).toBe(RESTORE_REMOVED);
    expect(restoreBlock('notes/plan.md', commit(), { kind: 'binary' })).toBe(RESTORE_NOT_TEXT);
    expect(restoreBlock('notes/plan.md', commit(), { kind: 'too_large', bytes: 9e6 })).toBe(
      RESTORE_TOO_LARGE,
    );
  });
});
