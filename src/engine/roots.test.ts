import { describe, expect, it } from 'vitest';
import {
  UNCOUNTED_WORDS,
  type GitRemoteStatus,
  type RemoteOutcome,
  type RemoteResult,
} from './git';
import {
  DIVERGED_MESSAGE,
  gitBadgeText,
  isMarkdownPath,
  isRootGitRefusal,
  parentPath,
  syncLanded,
  syncNotice,
  uncountedSync,
  type RootGitBadge,
} from './roots';

describe('isMarkdownPath', () => {
  it('accepts .md and .markdown regardless of case', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/Guide.MARKDOWN')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isMarkdownPath('src/main.rs')).toBe(false);
    expect(isMarkdownPath('mdfile')).toBe(false);
  });
});

describe('parentPath', () => {
  it('drops the last segment', () => {
    expect(parentPath('docs/guide/setup.md')).toBe('docs/guide');
  });

  it('returns the root for a top-level path', () => {
    expect(parentPath('README.md')).toBe('');
  });
});

describe('gitBadgeText', () => {
  const badge = (counts: Partial<RootGitBadge>): RootGitBadge => ({
    branch: 'main',
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    dirty: 0,
    ...counts,
  });

  it('stays silent when a repo is clean and in sync', () => {
    expect(gitBadgeText(badge({}))).toBeNull();
  });

  it('speaks the branch only once there is something to say', () => {
    expect(gitBadgeText(badge({ ahead: 2 }))).toBe('main ↑2');
    expect(gitBadgeText(badge({ behind: 3 }))).toBe('main ↓3');
    expect(gitBadgeText(badge({ branch: 'wip', dirty: 4 }))).toBe('wip ●4');
  });

  it('orders ahead, behind, then dirty', () => {
    expect(gitBadgeText(badge({ ahead: 1, behind: 2, dirty: 3 }))).toBe('main ↑1 ↓2 ●3');
  });

  // M92.10: silence says "in sync", so a count git did not take speaks.
  it('marks a count git did not take with ?, never the silence of a zero', () => {
    expect(gitBadgeText(badge({ ahead: null, behind: null }))).toBe('main ↑? ↓?');
    expect(gitBadgeText(badge({ behind: null }))).toBe('main ↓?');
    expect(gitBadgeText(badge({ ahead: 2, behind: null, dirty: 1 }))).toBe('main ↑2 ↓? ●1');
  });

  it('shows no counts for a branch with no upstream to count against', () => {
    const loose = { ahead: null, behind: null, hasUpstream: false };
    expect(gitBadgeText(badge(loose))).toBeNull();
    expect(gitBadgeText(badge({ ...loose, dirty: 2 }))).toBe('main ●2');
  });
});

describe('syncNotice', () => {
  const result = (status: RemoteOutcome, message = ''): RemoteResult => ({
    status,
    message,
    updatedFiles: [],
    conflictFiles: [],
  });

  it('stays silent before any sync, and after one that landed', () => {
    expect(syncNotice(undefined)).toBeNull();
    for (const status of ['ok', 'up_to_date', 'updated'] as const) {
      expect(syncNotice(result(status, 'Fetched'))).toBeNull();
      expect(syncLanded(result(status))).toBe(true);
    }
  });

  it('names every outcome that did not land, with its own message as the title', () => {
    const hint =
      'Git could not authenticate with the remote. Check your credential helper or SSH key.';
    expect(syncNotice(result('auth_error', hint))).toEqual({ text: 'auth failed', title: hint });
    expect(syncNotice(result('rejected', DIVERGED_MESSAGE))).toEqual({
      text: 'diverged',
      title: DIVERGED_MESSAGE,
    });
    expect(syncNotice(result('network_error', 'Could not reach the remote.'))?.text).toBe(
      'offline',
    );
    expect(syncNotice(result('no_remote', 'No remote configured'))?.text).toBe('no remote');
    expect(syncNotice(result('conflict', 'CONFLICT'))?.text).toBe('conflict');
    expect(syncNotice(result('error', 'git failed'))).toEqual({
      text: 'failed',
      title: 'git failed',
    });
    for (const status of [
      'auth_error',
      'rejected',
      'network_error',
      'no_remote',
      'error',
    ] as const) {
      expect(syncLanded(result(status))).toBe(false);
    }
  });

  it('renders parent_repo as the quiet nested state, and any other refusal as a failure', () => {
    const nested = { code: 'parent_repo', message: 'this root sits inside a larger repository' };
    expect(syncNotice(nested)?.text).toBe('nested');
    expect(syncLanded(nested)).toBe(false);

    const gone = { code: 'no_such_root', message: 'no mounted root with id root-9' };
    expect(syncNotice(gone)).toEqual({ text: 'failed', title: gone.message });
  });

  // M92.10: the store's own answer when git did not count after the fetch.
  it('says a sync that could not count couldn’t tell, and why, and never that it landed', () => {
    const status: GitRemoteStatus = {
      branch: 'main',
      ahead: null,
      behind: null,
      hasRemote: true,
      hasUpstream: true,
      upstream: 'origin/main',
    };
    const unread = uncountedSync(status);
    expect(unread).toEqual({
      uncounted: 'unread',
      message: `${UNCOUNTED_WORDS.unread}, so nothing was pulled`,
    });
    expect(syncNotice(unread)).toEqual({ text: "couldn't tell", title: unread.message });
    expect(syncLanded(unread)).toBe(false);
    expect(isRootGitRefusal(unread)).toBe(false);

    const loose = uncountedSync({ ...status, hasUpstream: false, upstream: null });
    expect(loose.uncounted).toBe('no_upstream');
    expect(syncNotice(loose)?.title).toBe(`${UNCOUNTED_WORDS.no_upstream}, so nothing was pulled`);

    // A status read that answered nothing counted nothing either.
    expect(uncountedSync(undefined).uncounted).toBe('unread');
  });
});
