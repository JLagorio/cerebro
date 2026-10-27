// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { measureWithinBudget, parseOptions, readBundle, withDeadline } from './measure';
import { buildCorpus, reliabilityMatrix } from './corpus';
import { measurement, type BenchmarkResult } from './report';
import { vi } from 'vitest';

const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('bounded measurement runner', () => {
  it('requires deliberate output, validates case names and bounds every run budget', () => {
    expect(() => parseOptions([])).toThrow(/output/i);
    expect(
      parseOptions([
        '--',
        '--output',
        '/tmp/cerebro-perf',
        '--matrix',
        'reliability',
        '--preflight',
        '--case',
        'document-64k',
      ]),
    ).toMatchObject({
      output: '/tmp/cerebro-perf',
      preflight: true,
      samples: 20,
      cases: ['document-64k'],
    });
    expect(() => parseOptions(['--output', '/tmp/x', '--samples', '1000000'])).toThrow(/samples/i);
    expect(() => parseOptions(['--output', '/tmp/x', '--fixture-ms', '0'])).toThrow(/fixture/i);
    expect(() => parseOptions(['--output', '/tmp/x', '--case', 'made-up'])).toThrow(/case/i);
    expect(() => parseOptions(['--output', '/tmp/x', '--url', 'https://example.com'])).toThrow(
      /unknown/i,
    );
  });

  it('serves only a frozen production bundle and detects changed bytes without source imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cerebro-perf-bundle-'));
    owned.push(root);
    await mkdir(join(root, 'assets'));
    await writeFile(
      join(root, 'index.html'),
      '<script type="module" src="/assets/app.js"></script>',
    );
    await writeFile(join(root, 'assets/app.js'), 'export const version = 1;');
    const first = await readBundle(root);
    expect(first.files.map((row) => row.name)).toEqual(['assets/app.js', 'index.html']);
    expect((await readBundle(root)).fingerprint).toBe(first.fingerprint);
    await writeFile(join(root, 'assets/app.js'), 'export const version = 2;');
    expect((await readBundle(root)).fingerprint).not.toBe(first.fingerprint);
    // A bundle must not serve files outside dist through a symlink.
    await symlink(join(root, 'index.html'), join(root, 'escape.html'));
    await expect(readBundle(root)).rejects.toThrow(/symlink/i);
  });

  it('classifies a real elapsed deadline without waiting forever and clears successful timers', async () => {
    await expect(withDeadline(Promise.resolve('done'), 100, 'fixture')).resolves.toBe('done');
    await expect(withDeadline(new Promise(() => undefined), 5, 'fixture')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('interrupts a pending measure at the overall budget and closes only its driver', async () => {
    vi.useFakeTimers();
    try {
      const fixture = reliabilityMatrix()[0];
      const snapshot: BenchmarkResult = {
        caseId: fixture.id,
        runtime: 'browser-mock',
        correctness: 'failed',
        observations: [measurement('filter', [10], 'Overall deadline reached', 'timeout')],
      };
      const driver = {
        measure: vi.fn(() => new Promise<BenchmarkResult>(() => undefined)),
        interrupt: vi.fn(() => snapshot),
        close: vi.fn(async () => undefined),
      };
      const pending = measureWithinBudget(
        driver,
        fixture,
        buildCorpus(fixture),
        parseOptions(['--output', '/tmp/not-written']),
        1000,
      );
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toEqual(snapshot);
      expect(driver.interrupt).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'TimeoutError' }),
      );
      expect(driver.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the affected timeout row even if browser shutdown rejects', async () => {
    vi.useFakeTimers();
    try {
      const fixture = reliabilityMatrix()[0];
      const snapshot: BenchmarkResult = {
        caseId: fixture.id,
        runtime: 'browser-mock',
        correctness: 'failed',
        observations: [measurement('input', [20], 'Overall deadline reached', 'timeout')],
      };
      const pending = measureWithinBudget(
        {
          measure: () => new Promise<BenchmarkResult>(() => undefined),
          interrupt: () => snapshot,
          close: async () => {
            throw new Error('shutdown refused');
          },
        },
        fixture,
        buildCorpus(fixture),
        parseOptions(['--output', '/tmp/not-written']),
        1000,
      );
      const outcome = pending.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(1001);
      expect(await outcome).toMatchObject({
        result: {
          correctness: 'failed',
          observations: [{ phase: 'input', status: 'timeout', samples: [20] }],
          failure: expect.stringContaining('cleanup'),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
