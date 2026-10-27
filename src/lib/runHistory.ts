import type { FleetRun } from './mockIpc';

/** Paths are app-selected registry inputs, never runtime vault IDs. */
export type RunHistoryScope =
  | { kind: 'agent'; vault: string; actor: string }
  | { kind: 'construct'; actor: string; vault: 'all_registered' };
export interface RunCursor {
  startedAt: string;
  runId: string;
}
export interface RunHistoryPage {
  runs: FleetRun[];
  nextCursor: RunCursor | null;
  effectiveVaultIds: string[];
}
export interface RunLineage {
  runs: FleetRun[];
  truncated: boolean;
}
export type RunOrigin =
  { kind: 'registered'; vault: string } | { kind: 'unavailable' } | { kind: 'not_recorded' };
