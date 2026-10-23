// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ModifiedFile } from '@/engine/git';

const { git, gitIpc } = vi.hoisted(() => ({
  git: {
    isRepo: true as boolean | null,
    readError: null as string | null,
    modified: [] as ModifiedFile[],
    conflicts: [] as string[],
    conflictMode: 'none' as 'merge' | 'rebase' | 'none',
    refresh: (() => Promise.resolve()) as () => Promise<void>,
  },
  gitIpc: {
    getFileDiff: vi.fn(async () => ''),
    gitCommit: vi.fn(async () => 'abc1234' as string | null),
    gitDiscardFile: vi.fn(async () => undefined),
  },
}));

vi.mock('@/lib/gitIpc', () => gitIpc);
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => () => undefined }));
vi.mock('@/git/useGit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/git/useGit')>();
  return {
    ...actual,
    useGit: () => ({
      ready: true,
      isRepo: git.isRepo,
      readError: git.readError,
      branch: 'main',
      modified: git.modified,
      conflicts: git.conflicts,
      conflictMode: git.conflictMode,
      remote: null,
      sync: 'local-changes',
      refresh: () => git.refresh(),
    }),
  };
});

import { ChangesPage } from './ChangesPage';
import { useVaultStore } from '@/stores/vaultStore';

const changed = (path: string, owner: ModifiedFile['owner'] = null): ModifiedFile => ({
  path,
  status: 'modified',
  staged: false,
  owner,
});

beforeEach(() => {
  vi.clearAllMocks();
  git.isRepo = true;
  git.readError = null;
  git.conflicts = [];
  git.conflictMode = 'none';
  git.refresh = () => Promise.resolve();
  useVaultStore.setState({ vaultPath: '/v', entries: [] });
});
afterEach(cleanup);

/**
 * A file a live run is writing waits for that run's own commit (M58.3, Q7):
 * the page names the run, offers no Discard, and the commit here counts and
 * names only the other files.
 */
describe('ChangesPage and a live run’s files', () => {
  it('names the run that owns a file and offers no Discard for it', () => {
    git.modified = [
      changed('notes/a.md', { runId: 'run-1', actor: 'claude-code' }),
      changed('notes/mine.md'),
    ];
    render(<ChangesPage />);
    expect(screen.getByTestId('changed-file-owner')?.textContent).toContain(
      'Being written by Assistant',
    );
    const owned = screen.getByRole('button', { name: 'Discard changes to notes/a.md' });
    expect((owned as HTMLButtonElement).disabled).toBe(true);
    expect(owned.getAttribute('title')).toEqual(
      expect.stringContaining('Being written by Assistant'),
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Discard changes to notes/mine.md',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('prefills and counts the commit from the files no run owns', () => {
    git.modified = [
      changed('notes/a.md', { runId: 'run-1', actor: 'claude-code' }),
      changed('notes/b.md', { runId: 'run-1', actor: 'claude-code' }),
      changed('notes/mine.md'),
    ];
    render(<ChangesPage />);
    expect(
      (screen.getByRole('textbox', { name: 'Commit message' }) as HTMLInputElement).value,
    ).toBe('Update mine');
    expect((screen.getByRole('button', { name: /Commit 1/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('offers no commit when only a run’s files changed', () => {
    git.modified = [changed('notes/a.md', { runId: 'run-1', actor: 'claude-code' })];
    render(<ChangesPage />);
    expect((screen.getByRole('button', { name: /Commit 0/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('offers no Discard for a knowledge/ file, and says why', () => {
    git.modified = [changed('knowledge/concepts/a.md')];
    render(<ChangesPage />);
    const button = screen.getByRole('button', {
      name: 'Discard changes to knowledge/concepts/a.md',
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toBe(
      'knowledge/ is maintained by the AI knowledge base and is read-only here. Verify the concept, or ask the agent to revise it.',
    );
  });
});

/**
 * Keep mine on the last conflicted file leaves a clean tree and an open
 * merge (M58.3): the banner stays, with Finish merge, until the merge ends.
 */
describe('ChangesPage and an open merge', () => {
  it('keeps Finish merge while a merge is in progress with nothing conflicted', () => {
    git.modified = [];
    git.conflictMode = 'merge';
    render(<ChangesPage />);
    expect(screen.getByTestId('conflict-banner').textContent).toContain(
      'Every conflict is resolved (merge in progress)',
    );
    expect(screen.getByRole('button', { name: 'Finish merge' })).toBeTruthy();
  });

  it('shows no banner when no merge or rebase is open', () => {
    git.modified = [];
    render(<ChangesPage />);
    expect(screen.queryByTestId('conflict-banner')).toBeNull();
  });
});

/**
 * A git read that failed (M92.9) is not a vault with no history: the page
 * says the read failed and reads again on request, and never offers to start
 * tracking, nor lists files an earlier read found.
 */
describe('ChangesPage and a git read that failed', () => {
  it('shows unavailable with the reason, never Enable history, and reads again on Try again', () => {
    git.isRepo = null;
    git.readError = 'git is not on this PATH';
    git.modified = [changed('notes/mine.md')];
    const refresh = vi.fn(() => Promise.resolve());
    git.refresh = refresh;
    render(<ChangesPage />);
    const unavailable = screen.getByTestId('section-unavailable');
    expect(unavailable.textContent).toContain('Couldn’t read this vault’s history');
    expect(unavailable.textContent).toContain('git is not on this PATH');
    expect(screen.queryByText('This vault has no history yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable history' })).toBeNull();
    expect(screen.queryByTestId('changes-page')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('lists nothing an earlier read found when a later read fails', () => {
    git.readError = 'index.lock exists';
    git.modified = [changed('notes/mine.md')];
    render(<ChangesPage />);
    expect(screen.getByTestId('section-unavailable')).toBeTruthy();
    expect(screen.queryAllByTestId('changed-file')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Commit/ })).toBeNull();
  });

  it('offers Enable history only where a read answered that there is none', () => {
    git.isRepo = false;
    render(<ChangesPage />);
    expect(screen.getByText('This vault has no history yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable history' })).toBeTruthy();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });
});
