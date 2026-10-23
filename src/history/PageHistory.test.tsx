// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, pageAttribution: vi.fn(actual.pageAttribution) };
});
vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return {
    ...actual,
    getFileHistory: vi.fn(actual.getFileHistory),
    commitRuns: vi.fn(actual.commitRuns),
  };
});

import type { ActivityWrite } from '@/engine/activity';
import { resetGitState } from '@/git/useGit';
import { LAB_NOW } from '@/lab/clock';
import { applyPreset, LAB_STATES, labSections, unmetExpectations } from '@/lab/presets';
import { commitRuns, getFileHistory } from '@/lib/gitIpc';
import { pageAttribution } from '@/lib/ipc';
import { failNext, resetFaults } from '@/lib/mockFaults';
import { resetMockGit, seedGitHistory, type SeedCommit } from '@/lib/mockGit';
import { demoFleetDetails, demoFleetRuns } from '@/lib/demoOperational';
import {
  __seedActivity,
  __seedConceptHistory,
  __seedFleet,
  resetMockFs,
  saveNote,
} from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { PAGE_HISTORY_KEEP, PAGE_HISTORY_WORDS, PageHistory } from './PageHistory';

/**
 * A page's History panel (M64.2b), over the browser mock: the demo's rows,
 * versions staged in the mock repository, and the seeded Knowledge lane.
 */

const PAGE = 'records/risks/risk-rollback-unrehearsed.md';
const CUTOVER = 'knowledge/playbooks/warehouse-cutover.md';

function version(hash: string, day: string, path = PAGE): SeedCommit {
  return {
    hash: hash.repeat(40),
    message: `Version ${hash}`,
    date: Date.parse(`${day}T12:00:00Z`) / 1000,
    files: [{ path, status: 'modified' }],
    snapshots: {},
  };
}

const originalTz = process.env.TZ;
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(LAB_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(async () => {
  process.env.TZ = 'UTC';
  vi.clearAllMocks();
  resetMockFs();
  resetMockGit();
  resetFaults();
  resetGitState();
  useUiStore.setState({ diffView: null });
  await useVaultStore.getState().openVault('/demo-vault');
});
afterEach(() => {
  cleanup();
  resetFaults();
  process.env.TZ = originalTz;
});

const history = () => screen.findByTestId('page-history');
const lane = (name: string) =>
  document.querySelector(`[data-testid="section-unavailable"][data-lane="${name}"]`);

describe('PageHistory', () => {
  it('merges the sessions and the versions into one timeline, newest first', async () => {
    seedGitHistory([version('a', '2026-07-27'), version('b', '2026-07-25')]);
    render(<PageHistory path={PAGE} />);
    const tab = await history();
    await waitFor(() => expect(within(tab).getAllByTestId('git-commit')).toHaveLength(2));
    const rows = within(tab)
      .getByTestId('git-history')
      .querySelectorAll('[data-testid="history-session"], [data-testid="git-commit"]');
    // Your session (14:00–14:12Z) is newer than that day's version (12:00Z).
    expect([...rows].map((r) => r.getAttribute('data-testid'))).toEqual([
      'history-session',
      'git-commit',
      'git-commit',
    ]);
    expect(within(tab).getByTestId('history-session').textContent).toBe('You edited it');
    expect(
      within(tab)
        .getAllByTestId('page-history-day')
        .map((d) => d.textContent),
    ).toEqual(['Jul 27', 'Jul 25']);
  });

  it('opens the lens from a commit row, with one batched attribution read', async () => {
    seedGitHistory([version('a', '2026-07-27'), version('b', '2026-07-25')]);
    render(<PageHistory path={PAGE} />);
    const tab = await history();
    await waitFor(() => expect(within(tab).getAllByTestId('git-commit')).toHaveLength(2));
    await waitFor(() =>
      expect(within(tab).getAllByTestId('commit-author')[0].dataset.attributed).not.toBe('pending'),
    );
    expect(commitRuns).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commitRuns).mock.calls[0][1].map((q) => q.hash)).toEqual([
      'a'.repeat(40),
      'b'.repeat(40),
    ]);
    fireEvent.click(
      within(within(tab).getAllByTestId('git-commit')[0]).getByRole('button', {
        name: 'Version a',
      }),
    );
    expect(useUiStore.getState().diffView).toEqual({ path: PAGE, commit: 'a'.repeat(40) });
  });

  describe('each lane fails alone', () => {
    it('edits: says so while the versions render', async () => {
      seedGitHistory([version('a', '2026-07-27')]);
      failNext('page_activity');
      render(<PageHistory path={PAGE} />);
      const tab = await history();
      await waitFor(() => expect(lane('writes')?.textContent).toBe(PAGE_HISTORY_WORDS.writes));
      expect(within(tab).getAllByTestId('git-commit')).toHaveLength(1);
      expect(within(tab).queryByTestId('history-session')).toBeNull();
      expect(within(tab).queryByTestId('page-history-empty')).toBeNull();
    });

    it('versions: says so while the sessions render', async () => {
      vi.mocked(getFileHistory).mockRejectedValueOnce(new Error('git log exited 128'));
      render(<PageHistory path={PAGE} />);
      const tab = await history();
      await waitFor(() => expect(lane('versions')).not.toBeNull());
      expect(lane('versions')?.textContent).toBe("This page's history could not be read.");
      expect(within(tab).getByTestId('history-session')).toBeTruthy();
    });

    it('outside Cerebro: says it could not tell while the rest renders', async () => {
      vi.mocked(pageAttribution).mockRejectedValueOnce(new Error('no runtime db'));
      render(<PageHistory path={PAGE} />);
      const tab = await history();
      expect(lane('attribution')?.textContent).toBe(PAGE_HISTORY_WORDS.attribution);
      expect(within(tab).getByTestId('history-session')).toBeTruthy();
      expect(within(tab).queryByTestId('page-history-outside')).toBeNull();
    });

    it('Knowledge: says so while the concept file still shows the run that wrote it', async () => {
      __seedConceptHistory(CUTOVER, null);
      render(<PageHistory path={CUTOVER} />);
      const tab = await history();
      expect(lane('knowledge')?.textContent).toBe(PAGE_HISTORY_WORDS.knowledge);
      expect(within(tab).getByTestId('history-run').textContent).toContain(
        'Knowledge agent wrote it ·',
      );
    });
  });

  it('draws a run as a trace line that says how it ended before it (M91.14)', async () => {
    __seedFleet(
      demoFleetRuns().map((run) =>
        run.run_id === 'run-ingest-2' ? { ...run, outcome: 'failed' } : run,
      ),
      demoFleetDetails(),
    );
    // With no ledger to stand in for them, the concept's runs are its rows.
    __seedConceptHistory(CUTOVER, null);
    render(<PageHistory path={CUTOVER} />);
    const run = await within(await history()).findByTestId('history-run');
    expect(run.textContent).toMatch(/^Failed: Knowledge agent wrote it ·/);
    expect(run.querySelector('[data-slot="trace-line"]')?.getAttribute('data-status')).toBe(
      'error',
    );
  });

  it("lists a concept's ledger events in place of its file's writes", async () => {
    render(<PageHistory path={CUTOVER} />);
    const tab = await history();
    const events = within(tab).getAllByTestId('history-concept');
    expect(events.map((e) => e.textContent)).toEqual([
      'Created by Knowledge agent',
      'Knowledge agent proposed a change · applied',
    ]);
    expect(within(tab).queryByTestId('history-session')).toBeNull();
  });

  it('says the page changed outside Cerebro at the top', async () => {
    await saveNote('/demo-vault', PAGE, '# Rollback\n\nMine.\n');
    (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.set(
      PAGE,
      '# Rollback\n\nFrom elsewhere.\n',
    );
    render(<PageHistory path={PAGE} />);
    const tab = await history();
    const outside = within(tab).getByTestId('page-history-outside');
    expect(outside.textContent).toBe(
      'This page changed outside Cerebro after its last recorded edit, so who changed it is unattributed.',
    );
    expect(tab.firstElementChild).toBe(outside);
  });

  it('folds to the newest eight, pins the oldest, and shows the rest on asking', async () => {
    const days = Array.from({ length: 11 }, (_, i) => `2026-07-${String(10 + i).padStart(2, '0')}`);
    seedGitHistory(days.reverse().map((day, i) => version(String.fromCharCode(97 + i), day)));
    render(<PageHistory path={PAGE} />);
    const tab = await history();
    // Eleven versions, the seam and your session: thirteen rows.
    const more = await within(tab).findByTestId('page-history-more');
    expect(more.textContent).toBe(`Show ${13 - PAGE_HISTORY_KEEP - 1} more`);
    const shown = () => within(tab).getAllByTestId('git-commit');
    expect(shown().at(-1)?.textContent).toContain('Version k');
    fireEvent.click(more);
    expect(shown()).toHaveLength(11);
    expect(within(tab).queryByTestId('page-history-more')).toBeNull();
  });

  it('says No history yet for a page nothing touched', async () => {
    const at = '2026-07-21T10:00:00.000Z';
    const elsewhere: Omit<ActivityWrite, 'content'> = {
      kind: 'vault.write',
      path: 'delivery/delivery.md',
      to: null,
      actor: 'human:me',
      run_id: null,
      approved_by: null,
      first_at: at,
      at,
    };
    __seedActivity({ writes: [elsewhere] });
    render(<PageHistory path={PAGE} />);
    const tab = await history();
    expect(within(tab).getByTestId('page-history-empty').textContent).toBe(
      'No history yet for this page.',
    );
  });

  it('says when Cerebro has recorded no edit, above the versions', async () => {
    __seedActivity({ writes: [] });
    seedGitHistory([version('a', '2026-07-27')]);
    render(<PageHistory path={PAGE} />);
    const tab = await history();
    await waitFor(() => expect(within(tab).getAllByTestId('git-commit')).toHaveLength(1));
    expect(within(tab).getByTestId('page-history-not-recorded').textContent).toBe(
      "Cerebro hasn't recorded an edit in this vault yet; the versions below are the only record.",
    );
  });

  it('keeps the recorded edits in a vault that keeps no history, with the git line', async () => {
    resetMockGit({ isRepo: false, commits: [] });
    resetGitState();
    render(<PageHistory path={PAGE} />);
    const tab = await history();
    await waitFor(() => expect(within(tab).getByTestId('page-history-git-off')).toBeTruthy());
    expect(within(tab).getByTestId('page-history-git-off').textContent).toBe(
      PAGE_HISTORY_WORDS.gitOff,
    );
    expect(within(tab).getByTestId('history-session').textContent).toBe('You edited it');
    expect(within(tab).queryByTestId('page-history-empty')).toBeNull();
  });

  describe('the five states, through both lab sections', () => {
    const sections = labSections().filter((s) =>
      ['page-history', 'concept-history'].includes(s.id),
    );
    it('has both sections', () => {
      expect(sections.map((s) => s.id)).toEqual(['concept-history', 'page-history']);
    });
    for (const section of sections) {
      for (const state of LAB_STATES) {
        it(`${section.id}: ${state}`, async () => {
          await applyPreset(section, state);
          const { container } = render(<div>{section.render()}</div>);
          await waitFor(() =>
            expect(unmetExpectations(container, section.states[state].expect)).toEqual([]),
          );
        });
      }
    }
  });
});
