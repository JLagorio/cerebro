import { describe, expect, it } from 'vitest';
import type { RemoteOutcome, RemoteResult } from './git';
import {
  DIVERGED_MESSAGE,
  gitBadgeText,
  isMarkdownPath,
  parentPath,
  syncLanded,
  syncNotice,
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
  it('stays silent when a repo is clean and in sync', () => {
    expect(gitBadgeText({ branch: 'main', ahead: 0, behind: 0, dirty: 0 })).toBeNull();
  });

  it('speaks the branch only once there is something to say', () => {
    expect(gitBadgeText({ branch: 'main', ahead: 2, behind: 0, dirty: 0 })).toBe('main ↑2');
    expect(gitBadgeText({ branch: 'main', ahead: 0, behind: 3, dirty: 0 })).toBe('main ↓3');
    expect(gitBadgeText({ branch: 'wip', ahead: 0, behind: 0, dirty: 4 })).toBe('wip ●4');
  });

  it('orders ahead, behind, then dirty', () => {
    expect(gitBadgeText({ branch: 'main', ahead: 1, behind: 2, dirty: 3 })).toBe('main ↑1 ↓2 ●3');
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
});
