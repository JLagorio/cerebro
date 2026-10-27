import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildCorpus,
  createOutputDirectory,
  reliabilityMatrix,
  type BenchmarkCase,
  type Corpus,
} from './corpus';
import { PHASES, measurement, renderReport, type BenchmarkResult } from './report';

export type Options = {
  output: string;
  samples: number;
  preflight: boolean;
  cases: string[];
  fixtureMs: number;
  overallMs: number;
  seed: number;
};
export function parseOptions(args: readonly string[]): Options {
  const result: Options = {
    output: '',
    samples: 20,
    preflight: false,
    cases: [],
    fixtureMs: 45000,
    overallMs: 240000,
    seed: 93,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') continue;
    if (arg === '--preflight') {
      result.preflight = true;
      continue;
    }
    if (
      ![
        '--output',
        '--samples',
        '--matrix',
        '--case',
        '--fixture-ms',
        '--overall-ms',
        '--seed',
      ].includes(arg)
    )
      throw new Error(`Unknown option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--output') result.output = value;
    if (arg === '--case') result.cases.push(value);
    if (arg === '--matrix' && value !== 'reliability')
      throw new Error('Only the reliability matrix is declared');
    const numeric: Partial<
      Record<string, ['samples' | 'fixtureMs' | 'overallMs' | 'seed', number, number]>
    > = {
      '--samples': ['samples', 1, 50],
      '--fixture-ms': ['fixtureMs', 1000, 120000],
      '--overall-ms': ['overallMs', 1000, 1800000],
      '--seed': ['seed', 0, 0xffffffff],
    };
    const bound = numeric[arg];
    if (bound) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < bound[1] || n > bound[2])
        throw new Error(`${arg} must be an integer from ${bound[1]} to ${bound[2]}`);
      result[bound[0]] = n;
    }
  }
  if (!result.output) throw new Error('--output <new-absolute-temporary-directory> is required');
  const ids = new Set(reliabilityMatrix(result.seed).map((fixture) => fixture.id));
  if (result.cases.some((id) => !ids.has(id)))
    throw new Error('Unknown case; use a declared reliability case');
  result.cases = [...new Set(result.cases)];
  return result;
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms} ms`);
    this.name = 'TimeoutError';
  }
}
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (signal?.aborted) throw signal.reason;
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
      ...(signal
        ? [
            new Promise<never>((_, reject) => {
              onAbort = () => reject(signal.reason);
              signal.addEventListener('abort', onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** The outer watchdog covers even a driver stalled before its own timer starts. */
export async function measureWithinBudget(
  driver: {
    measure(fixture: BenchmarkCase, corpus: Corpus, options: Options): Promise<BenchmarkResult>;
    interrupt(reason: Error): BenchmarkResult | null;
    close(): Promise<void>;
  },
  fixture: BenchmarkCase,
  corpus: Corpus,
  options: Options,
  remainingMs: number,
): Promise<BenchmarkResult> {
  try {
    return await withDeadline(
      driver.measure(fixture, corpus, options),
      remainingMs,
      'Overall matrix budget',
    );
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error;
    const snapshot = driver.interrupt(error);
    const result =
      snapshot ??
      ({
        caseId: fixture.id,
        runtime: 'browser-mock',
        correctness: 'failed',
        failure: error.message,
        observations: PHASES.map((phase) =>
          measurement(phase, [], error.message, phase === 'readiness' ? 'timeout' : 'unavailable'),
        ),
      } satisfies BenchmarkResult);
    try {
      await withDeadline(driver.close(), 10000, 'Overall budget browser cleanup');
    } catch {
      result.failure = `${result.failure ?? error.message}; browser cleanup did not finish normally`;
    }
    return result;
  }
}

export type Bundle = {
  files: { name: string; bytes: number; sha256: string }[];
  fingerprint: string;
  resources: Map<string, Buffer>;
};
export async function readBundle(dist: string): Promise<Bundle> {
  const files: Bundle['files'] = [];
  const resources = new Map<string, Buffer>();
  let total = 0;
  async function visit(folder: string, prefix = ''): Promise<void> {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('Production bundle contains a symlink');
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        await visit(join(folder, entry.name), `${name}/`);
        continue;
      }
      if (!entry.isFile()) throw new Error('Production bundle contains a non-file resource');
      const size = (await stat(join(folder, entry.name))).size;
      total += size;
      if (files.length >= 10000 || total > 512 * 1024 * 1024)
        throw new Error('Production bundle exceeds runner bounds');
      const bytes = await readFile(join(folder, entry.name));
      resources.set(`/${name}`, bytes);
      files.push({
        name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  await visit(dist);
  const index = resources.get('/index.html')?.toString('utf8');
  if (!index || !/\/assets\/[^"']+\.js/.test(index) || /@vite\/client|\/src\/main/.test(index)) {
    throw new Error('Build the production bundle first; a development entry is not accepted');
  }
  return {
    files,
    resources,
    fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
}

/** Serve frozen build bytes on an ephemeral loopback port; never attach to somebody's dev server. */
async function serve(bundle: Bundle) {
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const bytes = bundle.resources.get(pathname === '/' ? '/index.html' : pathname);
    if (request.method !== 'GET' || !bytes) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type':
        mime[extname(pathname === '/' ? '.html' : pathname)] ??
        (pathname === '/' ? 'text/html' : 'application/octet-stream'),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(bytes);
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function command(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
function machine() {
  return { at: new Date().toISOString(), load: loadavg(), freeMemoryBytes: freemem() };
}

async function runnerIdentity(repo: string) {
  const files = await Promise.all(
    ['corpus.ts', 'report.ts', 'measure.ts', 'browser.ts'].map(async (name) => ({
      name,
      sha256: createHash('sha256')
        .update(await readFile(join(repo, 'scripts/performance', name)))
        .digest('hex'),
    })),
  );
  return { files, fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

export async function run(options: Options): Promise<void> {
  const repo = process.cwd();
  const output = await createOutputDirectory(options.output, repo);
  const matrix = reliabilityMatrix(options.seed).filter(
    (fixture) => !options.cases.length || options.cases.includes(fixture.id),
  );
  const results: BenchmarkResult[] = matrix.map((fixture) => ({
    caseId: fixture.id,
    runtime: 'browser-mock',
    correctness: 'not-run',
    observations: PHASES.map((phase) => measurement(phase, [], 'Case not attempted')),
  }));
  const diff = command('git', ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD']);
  const report = {
    schemaVersion: 1,
    environment: {
      purpose: options.preflight
        ? 'Correctness preflight; timing values withheld'
        : 'Production browser diagnostic',
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpu: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
      pnpm: command('pnpm', ['--version']),
      rust: command('rustc', ['--version']),
      sourceHeadAtRun: command('git', ['rev-parse', 'HEAD']),
      sourceStatusAtRun: command('git', ['status', '--porcelain=v1', '--untracked-files=no']),
      sourceDiffSha256: diff === null ? null : createHash('sha256').update(diff).digest('hex'),
      buildProvenance:
        'Fingerprint identifies served bytes; a source HEAD does not attest when those bytes were built. Build immediately before running in a stable checkout.',
      browser: null as string | null,
      viewport: { width: 1440, height: 900 },
      inputSemantics:
        'Synthetic ArrowDown on focused real grid to two animation frames; composite UI timings include automation delivery. Not native input-to-photon.',
      network:
        'Only frozen production resources at the exact temporary loopback origin; service workers blocked; no live CLI or provider calls.',
    },
    options,
    runner: await runnerIdentity(repo),
    runnerAfter: null as { fingerprint: string; unchanged: boolean } | null,
    matrix,
    fixtures: [] as { caseId: string; manifest: ReturnType<typeof buildCorpus>['manifest'] }[],
    bundle: null as { fingerprint: string; files: Bundle['files'] } | null,
    bundleAfter: null as { fingerprint: string; unchanged: boolean } | null,
    machine: { before: machine(), after: null as ReturnType<typeof machine> | null },
    results,
    stopReason: null as string | null,
  };
  const persist = async () => {
    await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    await writeFile(join(output, 'report.md'), renderReport(results), { mode: 0o600 });
  };
  await persist();
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  let driver: Awaited<ReturnType<(typeof import('./browser'))['launchDriver']>> | undefined;
  try {
    const bundle = await readBundle(join(repo, 'dist'));
    report.bundle = { fingerprint: bundle.fingerprint, files: bundle.files };
    server = await serve(bundle);
    const { launchDriver } = await import('./browser');
    driver = await launchDriver(server.url);
    report.environment.browser = driver.version;
    const start = Date.now();
    for (const [index, fixture] of matrix.entries()) {
      const remaining = options.overallMs - (Date.now() - start);
      if (remaining <= 0) {
        report.stopReason = 'Overall budget reached; remaining cases unavailable';
        break;
      }
      const corpus = buildCorpus(fixture);
      report.fixtures.push({ caseId: fixture.id, manifest: corpus.manifest });
      const loadBefore = loadavg();
      results[index] = await measureWithinBudget(
        driver,
        fixture,
        corpus,
        {
          ...options,
          fixtureMs: Math.min(options.fixtureMs, remaining),
        },
        remaining,
      );
      results[index].loadBefore = loadBefore;
      results[index].loadAfter = loadavg();
      await persist();
      console.log(
        `${fixture.id}: ${results[index].correctness}; ${results[index].observations.filter((row) => row.status === 'measured').length} measured phases`,
      );
      if (results[index].correctness === 'failed') {
        report.stopReason = 'Correctness failure or fixture timeout; remaining cases unavailable';
        break;
      }
    }
    const after = await readBundle(join(repo, 'dist'));
    report.bundleAfter = {
      fingerprint: after.fingerprint,
      unchanged: after.fingerprint === bundle.fingerprint,
    };
    if (!report.bundleAfter.unchanged)
      report.stopReason =
        'Build directory changed during run; frozen served bytes remain identified, comparison to current source is invalid';
  } catch (error) {
    report.stopReason =
      error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 1000) : 'Runner failed';
  } finally {
    try {
      await driver?.close();
    } catch {
      report.stopReason ??= 'Browser cleanup did not complete normally';
    }
    await server?.close();
    report.machine.after = machine();
    const runnerAfter = await runnerIdentity(repo);
    report.runnerAfter = {
      fingerprint: runnerAfter.fingerprint,
      unchanged: runnerAfter.fingerprint === report.runner.fingerprint,
    };
    if (!report.runnerAfter.unchanged)
      report.stopReason ??= 'Runner source changed during this run; repeat after source freeze';
    await persist();
  }
  console.log(`Evidence: ${join(output, 'results.json')}`);
  if (report.stopReason) {
    console.error(report.stopReason);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Performance runner failed');
    process.exitCode = 1;
  });
}
