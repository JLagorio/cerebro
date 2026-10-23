import type { ActivityWrite } from '@/engine/activity';
import { PageHistory } from '@/history/PageHistory';
import { seedGitHistory, type SeedCommit } from '@/lib/mockGit';
import { __seedActivity } from '@/lib/mockIpc';
import type { LabSection } from '../presets';

/**
 * A page's History panel (M64.2b) in its five states, on the rollback risk:
 * the demo's own session on it (2026-07-27), merged with versions staged in
 * the mock repository. Recording began on 2026-07-21 (the demo's first
 * write), so a version before that draws the seam.
 */

const PAGE = 'records/risks/risk-rollback-unrehearsed.md';

function version(hash: string, day: string): SeedCommit {
  return {
    hash: hash.repeat(40),
    message: `Revise the rollback risk (${hash})`,
    date: Date.parse(`${day}T12:00:00Z`) / 1000,
    files: [{ path: PAGE, status: 'modified' }],
    snapshots: {},
  };
}

/** One write on another page, so recording began and this page has none. */
function elsewhere(): Omit<ActivityWrite, 'content'> {
  const at = '2026-07-21T10:00:00.000Z';
  const write = { kind: 'vault.write', path: 'delivery/delivery.md', to: null };
  return { ...write, actor: 'human:me', run_id: null, approved_by: null, first_at: at, at };
}

const SESSION = '[data-testid="history-session"]';
const COMMIT = '[data-testid="git-commit"]';
const SEAM = '[data-testid="page-history-seam"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'page-history',
  title: "A page's History",
  surface: 'A page · History panel',
  render: () => <PageHistory path={PAGE} />,
  states: {
    ready: {
      note: 'Your session on the page, and a version after recording began.',
      seed: () => seedGitHistory([version('a', '2026-07-25')]),
      expect: { present: [SESSION, COMMIT], absent: [UNAVAILABLE, SEAM] },
    },
    empty: {
      note: 'Recording began, and nothing touched this page: no rows, no versions.',
      seed: () => __seedActivity({ writes: [elsewhere()] }),
      expect: {
        present: ['[data-testid="page-history-empty"]'],
        absent: [SESSION, COMMIT, UNAVAILABLE],
      },
    },
    'not-recorded': {
      note: 'Cerebro never recorded an edit in this vault: its versions alone.',
      seed: () => {
        __seedActivity({ writes: [] });
        seedGitHistory([version('a', '2026-07-25')]);
      },
      expect: {
        present: ['[data-testid="page-history-not-recorded"]', COMMIT],
        absent: [SESSION, UNAVAILABLE],
      },
    },
    partial: {
      note: 'Recording began after the oldest version, so the seam shows where.',
      seed: () => seedGitHistory([version('a', '2026-07-25'), version('b', '2026-07-19')]),
      expect: { present: [SEAM, SESSION, COMMIT], absent: [UNAVAILABLE] },
    },
    unavailable: {
      note: "The page's activity read fails; its versions still show.",
      seed: () => seedGitHistory([version('a', '2026-07-25')]),
      failNext: ['page_activity'],
      expect: {
        present: [`${UNAVAILABLE}[data-lane="writes"]`, COMMIT],
        absent: [SESSION, SEAM],
      },
    },
  },
};
