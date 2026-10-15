// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitRun, GitCommit } from '@/engine/git';
import { CommitAuthor } from '@/git/CommitAuthor';
import type { GitRead } from '@/git/useGit';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

const COMMIT: GitCommit = {
  hash: 'a'.repeat(40),
  shortHash: 'aaaaaaa',
  message: 'release-scout: refresh the brief\n\nCerebro-Run: run-scout-1',
  author: 'Ana Rios',
  date: 1_753_700_000,
};

const run = (patch: Partial<CommitRun> = {}): CommitRun => ({
  hash: COMMIT.hash,
  run_id: 'run-scout-1',
  actor: 'process:release-scout',
  with_person: false,
  also_by: [],
  ...patch,
});

const show = (runs: GitRead<CommitRun[]>) =>
  render(<CommitAuthor commit={COMMIT} runs={runs} />).getByTestId('commit-author');

// M58.4 (CV-35): a commit names a run only from its record, and the three
// other answers are three different sentences.
describe('CommitAuthor', () => {
  beforeEach(() => {
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'records/agents/release-scout.md',
          title: 'Release scout',
          type: 'Agent',
          properties: { slug: 'release-scout' },
        }),
      ],
    });
  });
  afterEach(cleanup);

  it('makes no claim while the record is being read', () => {
    const author = show({ kind: 'loading' });
    expect(author.textContent).toBe('');
    expect(author.dataset.attributed).toBe('pending');
  });

  it('says attribution unknown when the record could not be read', () => {
    const author = show({ kind: 'unavailable' });
    expect(author.textContent).toBe('attribution unknown');
    expect(author.getAttribute('title')).toBe(
      "Cerebro couldn't read which runs made these commits.",
    );
  });

  it('says unattributed with no record, whatever the message says, the git author only in the title', () => {
    const author = show({ kind: 'ready', data: [] });
    expect(author.textContent).toBe('unattributed');
    expect(author.getAttribute('title')).toBe('Ana Rios');
    expect(author.textContent).not.toContain('Ana Rios');
  });

  it('names an agent from its record and opens it', () => {
    const navigate = vi.fn();
    useNavStore.setState({ navigate });
    const author = show({ kind: 'ready', data: [run()] });
    expect(author.textContent).toBe('Release scout');
    fireEvent.click(screen.getByTestId('commit-author-agent'));
    expect(navigate).toHaveBeenCalledWith({ kind: 'agents', actor: 'process:release-scout' });
  });

  it('reads the attended assistant as Assistant', () => {
    const author = show({ kind: 'ready', data: [run({ actor: 'claude-code' })] });
    expect(author.textContent).toBe('Assistant');
  });

  it('says your edits rode along, and names another run that wrote the page', () => {
    const author = show({
      kind: 'ready',
      data: [run({ with_person: true, also_by: ['claude-code'] })],
    });
    expect(author.textContent).toBe('Release scout with your edits · also edited by Assistant');
  });
});
