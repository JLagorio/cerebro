import { demoFleetRuns } from '@/lib/demoOperational';
import { __seedFleet } from '@/lib/mockIpc';
import { AgentRunHistory } from '@/status/AgentRunHistory';
import type { LabSection } from '../presets';

const actor = 'process:release-scout';
const row = () => demoFleetRuns().find((run) => run.actor === actor)!;
const unrecorded = () => ({
  ...row(),
  run_id: 'legacy-scout',
  cause: null,
  usage_state: 'unknown',
  proposals_submitted: null,
  applied: null,
  rejected: null,
});
const ROW = '[data-testid="agent-run"]';
const EMPTY = '[data-testid="agent-runs-empty"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'agent-run-history',
  title: 'Agent run history',
  surface: 'Agent page › Runs',
  render: () => (
    <AgentRunHistory actor={actor} scope={{ kind: 'agent', vault: '/demo-vault', actor }} />
  ),
  states: {
    ready: {
      note: 'A recorded run in the selected registered vault.',
      seed: () => __seedFleet([row()]),
      expect: { present: [ROW], absent: [EMPTY, UNAVAILABLE] },
    },
    empty: {
      note: 'The scoped history read found no matching runs.',
      seed: () => __seedFleet([]),
      expect: { present: [EMPTY], absent: [ROW, UNAVAILABLE] },
    },
    'not-recorded': {
      note: 'A historical run with no recorded cause or usage.',
      seed: () => __seedFleet([unrecorded()]),
      expect: { present: [ROW], absent: [EMPTY, UNAVAILABLE], text: 'usage unknown' },
    },
    partial: {
      note: 'Recorded and unrecorded runs together, without treating missing usage as zero.',
      seed: () => __seedFleet([row(), unrecorded()]),
      expect: {
        present: [`${ROW}[data-run="run-scout-1"]`, `${ROW}[data-run="legacy-scout"]`],
        absent: [EMPTY, UNAVAILABLE],
        text: 'usage unknown',
      },
    },
    unavailable: {
      note: 'The scoped history read failed and offers a local Retry.',
      failNext: ['fleet_runs_page'],
      expect: { present: [UNAVAILABLE], absent: [ROW, EMPTY], text: 'Retry history' },
    },
  },
};
