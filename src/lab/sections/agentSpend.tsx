import { demoFleetRuns } from '@/lib/demoOperational';
import type { FleetRun } from '@/lib/ipc';
import { __seedFleet } from '@/lib/mockIpc';
import { AgentRoster } from '@/status/AgentRoster';
import type { LabSection } from '../presets';

/**
 * What each agent has spent, on the Agents roster (M33b.3), in its five
 * states (M64.1). The release scout carries every state: the knowledge agent
 * beside it has no runs in any preset but the demo's, and reads "nothing
 * spent" throughout.
 */

const SCOUT = 'process:release-scout';

/** The demo's metered scout run: 12,060 in + 880 out = 12,940 tokens. */
function meteredRun(): FleetRun {
  const run = demoFleetRuns().find((r) => r.run_id === 'run-scout-1');
  if (run === undefined) throw new Error('state lab: the demo fleet lost run-scout-1');
  return run;
}

/** A scout run whose CLI died before reporting usage: its zeros are not a
 * measurement. */
function unmeteredRun(): FleetRun {
  return {
    ...meteredRun(),
    run_id: 'run-scout-unmetered',
    started_at: '2026-07-28T07:30:00Z',
    ended_at: '2026-07-28T07:41:00Z',
    outcome: 'abandoned_usage_unknown',
    usage_state: 'unknown',
    input_tokens: 0,
    output_tokens: 0,
    cli_session_id: null,
  };
}

const ROW = `[data-testid="agent-row"][data-actor="${SCOUT}"]`;
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'agent-spend',
  title: 'Agent spend',
  surface: 'Agents › roster',
  render: () => <AgentRoster vaultPath="/demo-vault" focus={null} onFocus={() => {}} />,
  states: {
    ready: {
      note: 'One metered run of the release scout.',
      seed: () => __seedFleet([meteredRun()]),
      expect: { present: [ROW], absent: [UNAVAILABLE], text: '12,940 tokens' },
    },
    empty: {
      note: 'No runs at all: no measurement, so no number.',
      seed: () => __seedFleet([]),
      expect: { present: [ROW], absent: [UNAVAILABLE], text: 'nothing spent — no runs yet' },
    },
    'not-recorded': {
      note: 'One run that lost its usage: not recorded, never 0.',
      seed: () => __seedFleet([unmeteredRun()]),
      expect: { present: [ROW], absent: [UNAVAILABLE], text: 'not recorded — 1 run unmetered' },
    },
    partial: {
      note: 'One metered run and one unmetered: the total says what it skipped.',
      seed: () => __seedFleet([meteredRun(), unmeteredRun()]),
      expect: { present: [ROW], absent: [UNAVAILABLE], text: '12,940 tokens · 1 run unmetered' },
    },
    unavailable: {
      note: 'The run summaries fail to read.',
      failNext: ['fleet_actor_summaries'],
      expect: { present: [UNAVAILABLE], text: 'The run history could not be read' },
    },
  },
};
