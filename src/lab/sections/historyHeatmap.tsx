import type { ActivityWrite, AppSessionSpan } from '@/engine/activity';
import { HistoryHeatmapSection } from '@/history/ActivityHeatmap';
import { demoActivity } from '@/lib/demoOperational';
import { __seedActivity } from '@/lib/mockIpc';
import type { LabSection } from '../presets';

/**
 * History's year heatmap (M64.2) in its five states. The clock is the lab's,
 * 2026-07-28, so the year runs from 2025-07-23.
 */

type Row = Omit<ActivityWrite, 'content'>;

function labWrite(path: string, at: string, actor: string | null = 'human:me'): Row {
  return {
    kind: 'vault.write',
    path,
    to: null,
    actor,
    run_id: null,
    approved_by: null,
    first_at: at,
    at,
  };
}

/** Cerebro open since before the window began, and open still. */
function openAllYear(): AppSessionSpan[] {
  return [
    {
      opened_at: '2025-01-01T08:00:00.000Z',
      until: '2025-01-01T08:00:00.000Z',
      precision: 'open',
    },
  ];
}

/** An edit at noon every third day of the year, and one before it began. */
function aYearOfEdits(): Row[] {
  const rows: Row[] = [labWrite('delivery/delivery.md', '2025-01-01T12:00:00.000Z')];
  for (let day = 0; day <= 370; day += 3) {
    const at = new Date(Date.UTC(2025, 6, 23 + day, 12)).toISOString();
    rows.push(labWrite('delivery/how-we-schedule.md', at));
  }
  return rows;
}

const CELL = '[data-testid="heatmap-day"]';
const RECORDED = `${CELL}[data-state="recorded"]`;
const NOT_RECORDED = `${CELL}[data-state="not-recorded"]`;
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'history-heatmap',
  title: 'History heatmap',
  surface: 'History',
  render: () => <HistoryHeatmapSection />,
  states: {
    ready: {
      note: 'A year recorded, with an editing session every third day.',
      seed: () => __seedActivity({ writes: aYearOfEdits(), sessions: openAllYear() }),
      expect: {
        present: [`${RECORDED}[data-sessions="1"]`, '[data-testid="heatmap-legend"]'],
        absent: [NOT_RECORDED, UNAVAILABLE],
      },
    },
    empty: {
      note: 'Every day recorded and none edited: the one write came before the year.',
      seed: () =>
        __seedActivity({
          writes: [labWrite('delivery/delivery.md', '2025-01-01T12:00:00.000Z')],
          sessions: openAllYear(),
        }),
      expect: {
        present: [`${RECORDED}[data-sessions="0"]`],
        absent: [`${CELL}:not([data-sessions="0"])`, UNAVAILABLE],
      },
    },
    'not-recorded': {
      note: 'No app session and no write: nothing was recorded.',
      seed: () => __seedActivity({ writes: [], sessions: [] }),
      expect: {
        present: [NOT_RECORDED],
        absent: [RECORDED, UNAVAILABLE],
        text: "Cerebro hasn't recorded an edit in this vault yet.",
      },
    },
    partial: {
      note: 'Recording began 2026-07-20: the demo week, and nothing before it.',
      seed: () => {
        const demo = demoActivity();
        __seedActivity({
          writes: [
            ...demo.writes,
            labWrite('delivery/how-we-schedule.md', '2026-07-20T10:00:00.000Z', null),
          ],
          sessions: demo.sessions,
        });
      },
      expect: {
        present: [RECORDED, NOT_RECORDED],
        absent: [UNAVAILABLE],
        text: 'Cerebro began recording edits here on Mon, Jul 20, 2026.',
      },
    },
    unavailable: {
      note: 'The activity read fails.',
      failNext: ['vault_activity'],
      expect: { present: [`${UNAVAILABLE}[data-lane="all"]`], absent: [CELL] },
    },
  },
};
