import { HistoryFeedSection } from '@/history/ActivityFeed';
import { resetMockGit } from '@/lib/mockGit';
import { __seedActivity, __seedFleet } from '@/lib/mockIpc';
import type { LabSection } from '../presets';
import type { ActivityWrite, AppSessionSpan } from '@/engine/activity';

/**
 * History's feed (M64.2) in its five states: sessions, runs and checkpoints
 * by day, over the demo's activity and the mock repository.
 */

/** One write before the year began, so every day in it is recording. */
function anOldWrite(): Omit<ActivityWrite, 'content'> {
  const at = '2025-01-01T12:00:00.000Z';
  const write = { kind: 'vault.write', path: 'delivery/delivery.md', to: null };
  return { ...write, actor: 'human:me', run_id: null, approved_by: null, first_at: at, at };
}

/** Cerebro open since before the year began, and open still. */
function openAllYear(): AppSessionSpan[] {
  const at = '2025-01-01T08:00:00.000Z';
  return [{ opened_at: at, until: at, precision: 'open' }];
}

const SESSION = '[data-testid="history-session"]';
const RUN = '[data-testid="history-run"]';
const COMMIT = '[data-testid="pulse-commit"]';
const GAP = '[data-testid="history-gap"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

/** No runs and no checkpoints, so the activity lanes alone decide. */
function quiet(): void {
  __seedFleet([]);
  resetMockGit({ commits: [] });
}

export const section: LabSection = {
  id: 'history-feed',
  title: 'History feed',
  surface: 'History',
  render: () => <HistoryFeedSection />,
  states: {
    ready: {
      note: "The demo's sessions, runs and checkpoints.",
      expect: {
        present: [SESSION, RUN, COMMIT, '[data-testid="history-outside"]'],
        absent: [UNAVAILABLE],
      },
    },
    empty: {
      note: 'Every day recorded and none edited, no runs, no checkpoints.',
      seed: () => {
        quiet();
        __seedActivity({
          writes: [anOldWrite()],
          sessions: openAllYear(),
        });
      },
      expect: {
        present: [`${GAP}[data-state="empty"]`],
        absent: [SESSION, RUN, COMMIT, UNAVAILABLE, `${GAP}[data-state="not-recorded"]`],
      },
    },
    'not-recorded': {
      note: 'No app session, no write, no run: nothing was recorded.',
      seed: () => {
        quiet();
        __seedActivity({ writes: [], sessions: [] });
      },
      expect: {
        present: [`${GAP}[data-state="not-recorded"]`],
        absent: [SESSION, RUN, UNAVAILABLE, `${GAP}[data-state="empty"]`],
      },
    },
    partial: {
      note: 'The runs lane fails: sessions still show, and no gap is said.',
      seed: () => __seedFleet(null),
      expect: {
        present: [SESSION, `${UNAVAILABLE}[data-lane="runs"]`],
        absent: [RUN, GAP],
      },
    },
    unavailable: {
      note: 'The activity read fails; checkpoints still show.',
      failNext: ['vault_activity'],
      expect: {
        present: [`${UNAVAILABLE}[data-lane="all"]`, COMMIT],
        absent: [SESSION, RUN, GAP],
      },
    },
  },
};
