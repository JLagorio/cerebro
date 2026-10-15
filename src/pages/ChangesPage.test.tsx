// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ModifiedFile } from '@/engine/git';

const { git, gitIpc } = vi.hoisted(() => ({
  git: { modified: [] as ModifiedFile[] },
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
      isRepo: true,
      modified: git.modified,
      conflicts: [],
      conflictMode: 'none',
      remote: null,
      sync: 'local-changes',
      refresh: async () => undefined,
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
