import { demoFleetRuns } from '@/lib/demoOperational';
import type { FleetRun } from '@/lib/ipc';
import { __seedFleet } from '@/lib/mockIpc';
import { FleetSection } from '@/status/FleetSection';
import type { LabSection } from '../presets';

/**
 * The run history under the Agents roster (M33.7, M56.7), in its five states
 * (M64.1). Every run comes from the demo fleet, with overrides.
 */

/** The demo runs that recorded everything: usage, proposal counters, a cause. */
function meteredRuns(): FleetRun[] {
  return demoFleetRuns().filter(
    (run) => run.usage_state === 'exact' && run.applied !== null && run.cause !== null,
  );
}

/** A run-legacy-1-shaped row that also lost its usage: no cause, no proposal
 * counters, no tokens. Each absence reads in words. */
function unrecordedRun(): FleetRun {
  const legacy = demoFleetRuns().find((run) => run.run_id === 'run-legacy-1');
  if (legacy === undefined) throw new Error('state lab: the demo fleet lost run-legacy-1');
  return { ...legacy, usage_state: 'unknown', input_tokens: 0, output_tokens: 0 };
}

const ROW = '[data-testid="fleet-row"]';
const UNKNOWN = '[data-testid="usage-unknown"]';
const UNRECORDED = '[data-testid="proposals-unrecorded"]';
const EMPTY = '[data-testid="section-empty"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'fleet-runs',
  title: 'Run history',
  surface: 'Agents › runs',
  render: () => <FleetSection />,
  states: {
    ready: {
      note: 'The demo runs that recorded their usage, counters and cause.',
      seed: () => __seedFleet(meteredRuns()),
      expect: { present: [ROW], absent: [UNKNOWN, UNRECORDED, EMPTY, UNAVAILABLE] },
    },
    empty: {
      note: 'The read came back with no runs.',
      seed: () => __seedFleet([]),
      expect: { present: [EMPTY], absent: [ROW, UNAVAILABLE] },
    },
    'not-recorded': {
      note: 'One pre-M56.7 run: no usage, no counters, no cause.',
      seed: () => __seedFleet([unrecordedRun()]),
      expect: {
        present: [ROW, UNKNOWN, UNRECORDED],
        absent: [EMPTY, UNAVAILABLE],
        text: 'why not recorded',
      },
    },
    partial: {
      note: 'A metered run beside an unrecorded one.',
      seed: () => __seedFleet([...meteredRuns().slice(0, 1), unrecordedRun()]),
      expect: {
        present: [`${ROW}[data-run="run-assembly-1"]`, `${ROW}[data-run="run-legacy-1"]`, UNKNOWN],
        absent: [EMPTY, UNAVAILABLE],
      },
    },
    unavailable: {
      note: 'The run history fails to read.',
      failNext: ['fleet_runs'],
      expect: { present: [UNAVAILABLE], absent: [ROW, EMPTY] },
    },
  },
};
