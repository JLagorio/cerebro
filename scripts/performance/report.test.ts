// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PHASES,
  measurement,
  renderReport,
  historicalComparison,
  typingSamples,
  type BenchmarkResult,
} from './report';

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

  it('declares the typing and readiness phases, counting what is a count', () => {
    expect(PHASES).toEqual(
      expect.arrayContaining([
        'frontend-ready',
        'editor-ready',
        'keystroke',
        'serialize',
        'serialize-calls',
        'writes',
      ]),
    );
    expect(measurement('writes', [1, 2])).toMatchObject({ unit: 'count', p95: 2 });
    expect(measurement('serialize-calls', [11])).toMatchObject({ unit: 'count' });
    expect(measurement('keystroke', [3])).toMatchObject({ unit: 'ms' });
    // A milestone that never came is a timeout row with no number, never a zero.
    expect(
      measurement('editor-ready', [], 'No editor_ready mark within 15000 ms', 'timeout'),
    ).toMatchObject({ status: 'timeout', samples: [], p50: null, p95: null });
    expect(
      renderReport([
        {
          caseId: 'document-256k',
          runtime: 'browser-mock',
          correctness: 'passed',
          observations: [measurement('writes', [1])],
        },
      ]),
    ).toContain('| writes | measured | 1 | 1.00 | 1.00 | count |');
  });

  it('reports serializer time per change, keeping a real zero and every keystroke', () => {
    expect(
      typingSamples({ keystrokes: [5, 6, 7, 8], serializations: [40, 40, 40, 40, 40], writes: 1 }),
    ).toEqual({ keystroke: [5, 6, 7, 8], serializeMsPerChange: 50, serializeCalls: 5, writes: 1 });
    expect(typingSamples({ keystrokes: [5, 6], serializations: [], writes: 0 })).toMatchObject({
      serializeMsPerChange: 0,
      serializeCalls: 0,
      writes: 0,
    });
    expect(() => typingSamples({ keystrokes: [], serializations: [1], writes: 1 })).toThrow(
      /keystroke/,
    );
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
