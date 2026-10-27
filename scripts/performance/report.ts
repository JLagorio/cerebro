export const PHASES = [
  'scan',
  'readable-corpus',
  'tokenization',
  'derivation',
  'render',
  'first-content',
  'editor-parse',
  'editor-apply',
  'readiness',
  'input',
  'scroll',
  'filter',
  'save-to-visible',
  'memory',
] as const;
export type Phase = (typeof PHASES)[number];
export type Observation = {
  phase: Phase;
  status: 'measured' | 'timeout' | 'unavailable';
  unit: 'ms' | 'bytes';
  samples: number[];
  sampleCount: number;
  p50: number | null;
  p95: number | null;
  reason: string | null;
};
export type BenchmarkResult = {
  caseId: string;
  runtime: 'browser-mock' | 'packaged-native';
  correctness: 'passed' | 'failed' | 'not-run';
  observations: Observation[];
  failure?: string;
  loadBefore?: number[];
  loadAfter?: number[];
  diagnostics?: {
    pageErrors: string[];
    failedResources: string[];
    stage?: string;
    renderedRows?: number;
    seeded?: boolean;
    visibleText?: string;
    inputs?: { label: string; value: string }[];
    typeSource?: string;
    longTasks?: { at: number; duration: number }[] | null;
    longTasksTruncated?: boolean;
  };
};

export function measurement(
  phase: Phase,
  samples: readonly number[],
  reason?: string,
  status?: Observation['status'],
  unit: Observation['unit'] = phase === 'memory' ? 'bytes' : 'ms',
): Observation {
  if (samples.some((value) => !Number.isFinite(value))) throw new Error('Samples must be finite');
  if (samples.some((value) => value < 0)) throw new Error('Samples must be nonnegative');
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  const resolved = status ?? (samples.length ? 'measured' : 'unavailable');
  if (resolved === 'measured' && !samples.length) throw new Error('A measured phase needs samples');
  if (resolved === 'unavailable' && samples.length)
    throw new Error('Unavailable phases cannot carry samples');
  return {
    phase,
    status: resolved,
    unit,
    samples: [...samples],
    sampleCount: samples.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    reason: reason ?? (resolved === 'unavailable' ? 'No observation recorded' : null),
  };
}

const HISTORICAL: Record<string, number | null> = {
  'table-1000x12': 398.8,
  'table-1000x24': 1376.2,
  'table-5000x12': null,
  'table-5000x24': null,
};
export function historicalComparison(caseId: string, input: Observation) {
  if (!(caseId in HISTORICAL) || input.phase !== 'input') return null;
  return {
    historicalP95Ms: HISTORICAL[caseId],
    currentP95Ms: input.p95,
    comparableEnvironment: false,
    caveat:
      'Historical shared-machine Chromium diagnostic; hardware/load/build differ. No regression or native input-to-photon verdict follows from this comparison.',
    historicalStatus:
      caseId === 'table-5000x12'
        ? 'navigation timeout'
        : caseId === 'table-5000x24'
          ? 'not measured'
          : 'measured',
  };
}

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
export function renderReport(results: readonly BenchmarkResult[]): string {
  const lines = [
    '# Performance observations',
    '',
    'Browser mock measurements do not establish packaged native performance. Missing observations remain unavailable. Percentiles use nearest rank; timeout percentiles describe partial samples only.',
    '',
  ];
  for (const result of results) {
    lines.push(
      `## ${cell(result.caseId)}`,
      '',
      `${result.runtime === 'browser-mock' ? 'Browser mock (headless Chromium)' : 'Packaged native'}; correctness: ${result.correctness}.`,
      '',
      '| Phase | Status | Samples | p50 | p95 | Unit | Note |',
      '| --- | --- | ---: | ---: | ---: | --- | --- |',
    );
    for (const row of result.observations) {
      lines.push(
        `| ${row.phase} | ${row.status} | ${row.sampleCount} | ${row.p50?.toFixed(2) ?? '—'} | ${row.p95?.toFixed(2) ?? '—'} | ${row.unit} | ${cell(row.reason ?? '')} |`,
      );
    }
    const input = result.observations.find((row) => row.phase === 'input');
    const comparison = input && historicalComparison(result.caseId, input);
    if (comparison)
      lines.push(
        '',
        `Historical input p95: ${comparison.historicalP95Ms ?? comparison.historicalStatus}; current: ${comparison.currentP95Ms ?? 'unavailable'}. ${comparison.caveat}`,
      );
    if (result.failure) lines.push('', `Failure: ${cell(result.failure)}`);
    lines.push('');
  }
  return lines.join('\n');
}
