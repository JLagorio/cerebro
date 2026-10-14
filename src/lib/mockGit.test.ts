import { beforeEach, describe, expect, it } from 'vitest';
import { getFileHistory, getVaultPulse, resetMockGit } from '@/lib/mockGit';

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
    expect(history.map((c) => c.hash)).toEqual(['c2c2c2c2']);
    // A file history is plain commits, as Rust's GitCommit is.
    expect(history[0]).not.toHaveProperty('changes');
  });

  it('leaves a commit whose files are unknown out of every file history', async () => {
    const [head] = resetMockGit().commits;
    resetMockGit({ commits: [{ ...head, changes: null }] });
    expect(await getFileHistory('/v', SEEDED)).toEqual([]);
  });
});
