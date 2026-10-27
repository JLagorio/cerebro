// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { measurement, renderReport, historicalComparison, type BenchmarkResult } from './report';

describe('performance evidence', () => {
  it('preserves unavailable observations instead of creating zero measurements', () => {
    expect(measurement('scan', [], 'Native scanner not instrumented')).toMatchObject({
      status: 'unavailable',
      samples: [],
      p50: null,
      p95: null,
    });
    expect(measurement('input', [0, 1, 9, 10])).toMatchObject({
      status: 'measured',
      sampleCount: 4,
      p50: 1,
      p95: 10,
    });
    expect(() => measurement('input', [NaN])).toThrow(/finite/i);
    expect(() => measurement('input', [-1])).toThrow(/nonnegative/i);
    expect(measurement('memory', [])).toMatchObject({ unit: 'bytes', p95: null });
  });

  it('keeps partial samples separate from a timeout and does not fill missing samples', () => {
    expect(measurement('input', [20, 30], 'Deadline reached', 'timeout')).toMatchObject({
      status: 'timeout',
      samples: [20, 30],
      sampleCount: 2,
      p50: 20,
      p95: 30,
    });
    expect(measurement('input', [], 'Deadline reached', 'timeout')).toMatchObject({
      status: 'timeout',
      sampleCount: 0,
      p50: null,
      p95: null,
    });
  });

  it('labels browser mock evidence distinctly from packaged native evidence', () => {
    const result: BenchmarkResult = {
      caseId: 'table-1000x12',
      runtime: 'browser-mock',
      correctness: 'passed',
      observations: [
        measurement('input', [100, 200]),
        measurement('scan', [], 'Rust scan is not available in Chromium'),
      ],
    };
    const browser = renderReport([result]);
    expect(browser).toContain('Browser mock (headless Chromium)');
    expect(browser).toContain('scan | unavailable | 0 | — | —');
    expect(browser).not.toContain('Native acceptance passed');
    expect(renderReport([{ ...result, runtime: 'packaged-native' }])).toContain('Packaged native');
  });

  it('compares only the retained synthetic input metric, with hardware caveats and absent values', () => {
    expect(historicalComparison('table-1000x12', measurement('input', [100, 200]))).toMatchObject({
      historicalP95Ms: 398.8,
      currentP95Ms: 200,
      comparableEnvironment: false,
    });
    expect(historicalComparison('table-1000x24', measurement('input', []))).toMatchObject({
      historicalP95Ms: 1376.2,
      currentP95Ms: null,
    });
    expect(historicalComparison('table-5000x24', measurement('input', []))).toMatchObject({
      historicalP95Ms: null,
      currentP95Ms: null,
    });
    expect(historicalComparison('document-256k', measurement('readiness', [10]))).toBeNull();
  });
});
