import type { NativeInputIdentity } from './native-inputs';

export type OutcomeStatus = 'passed' | 'failed' | 'unavailable';
export interface OutcomeDimension {
  id: string;
  status: OutcomeStatus;
  reason: string;
}
export interface OutcomeCase {
  version: 1;
  id: string;
  title: string;
  adapter:
    'source_location' | 'ledger_conformance' | 'transcript' | 'native_broker' | 'unavailable';
  inputs: Record<string, unknown>;
  allowedEffects: string[];
  forbiddenEffects: string[];
  expectedSources: { id: string; status: string; range?: { start: number; end: number } }[];
  expectedArtifacts: { id: string; state: string }[];
  injections: string[];
  requiredCapabilities: string[];
}
export interface OutcomeObservations {
  capabilities: { id: string; available: boolean; reason: string }[];
  sources: {
    id: string;
    vaultId: string;
    path: string;
    status: string;
    recordedHash: string;
    currentHash: string | null;
    disclosed: boolean;
    admitted: boolean;
    reads: number;
    range?: { start: number; end: number };
  }[];
  files: { path: string; beforeHash: string | null; afterHash: string | null }[];
  refusals: { eventId: string; code: string }[];
  coverage: { effectsObserved: boolean; limitations: string[] };
  nativeCapture: {
    observedAt: string;
    clock: string;
    nativeInputs: NativeInputIdentity;
  } | null;
  effects: { kind: string; target: string; actor: string | null }[];
  artifacts: { id: string; state: string }[];
  children: {
    id: string;
    status: string;
    parentError: boolean;
    parentToolIds: string[];
    childToolIds: string[];
  }[];
  broker: {
    stateBefore: string;
    stateAfter: string;
    submissions: number;
    attempts: number;
    retryAcknowledged: boolean;
    retryRefusal: string | null;
    producer: string;
  } | null;
  usage: { costUsd: number | null; durationMs: number | null; reason: string };
}
export interface OutcomeReport {
  version: 1;
  id: string;
  status: OutcomeStatus;
  dimensions: OutcomeDimension[];
  observations: OutcomeObservations;
  identity: {
    evaluatedAt: string;
    node: string;
    cli: { observed: string | null; reason: string };
    model: { observed: string | null; reason: string };
    sourceDigests: Record<string, string>;
    build: { kind: 'source_snapshot'; binaryHash: null; reason: string };
  };
}
export interface OutcomeAdapters {
  root: string;
  clock: () => string;
  nativeReport?: string;
}

export function outcomeStatus(dimensions: OutcomeDimension[]): OutcomeStatus {
  if (dimensions.some((row) => row.status === 'failed')) return 'failed';
  if (dimensions.some((row) => row.status === 'unavailable')) return 'unavailable';
  return 'passed';
}

export function summarize(reports: OutcomeReport[]) {
  const counts = { passed: 0, failed: 0, unavailable: 0 };
  for (const report of reports) counts[report.status]++;
  return {
    version: 1,
    status: counts.failed > 0 ? 'failed' : counts.unavailable > 0 ? 'unavailable' : 'passed',
    counts,
    cases: reports,
    usage: {
      costUsd: null,
      unrecordedCostCases: reports.filter((report) => report.observations.usage.costUsd === null)
        .length,
      reason: 'Offline replay does not measure model cost.',
    },
  };
}
