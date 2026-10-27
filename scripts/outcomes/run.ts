import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOutcome } from './assert';
import { hash, identity, observe } from './adapters';
import { loadManifest, parseCase } from './parse';
import { negativeControls } from './negative-controls';
import {
  outcomeStatus,
  summarize,
  type OutcomeAdapters,
  type OutcomeCase,
  type OutcomeReport,
} from './report';

export { loadManifest } from './parse';
export function parseArguments(args: string[]): {
  mode: 'offline';
  manifest: string;
  out: string;
  nativeReport?: string;
} {
  const values = new Map<string, string>();
  const allowed = ['--mode', '--manifest', '--out', '--native-report'];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !allowed.includes(flag) ||
      values.has(flag) ||
      value === undefined ||
      value.startsWith('--') ||
      value.length === 0
    )
      throw new Error('Invalid offline runner arguments.');
    values.set(flag, value);
  }
  if (values.get('--mode') !== 'offline' || !values.has('--manifest') || !values.has('--out'))
    throw new Error('Offline mode, manifest and output directory are required.');
  return {
    mode: 'offline',
    manifest: resolve(values.get('--manifest')!),
    out: resolve(values.get('--out')!),
    ...(values.has('--native-report')
      ? { nativeReport: resolve(values.get('--native-report')!) }
      : {}),
  };
}

export function runOutcome(scenario: OutcomeCase, adapters: OutcomeAdapters): OutcomeReport {
  // The direct programmatic boundary is validated too; callers cannot bypass
  // the manifest loader by selecting an arbitrary adapter or source filename.
  const checked = parseCase(scenario);
  const observations = observe({ adapter: checked.adapter, inputs: checked.inputs }, adapters);
  const dimensions = assertOutcome(checked, observations);
  const usedIdentity = identity(adapters.clock);
  usedIdentity.sourceDigests[`case:${checked.id}`] = hash(JSON.stringify(checked));
  return {
    version: 1,
    id: checked.id,
    status: outcomeStatus(dimensions),
    dimensions,
    observations,
    identity: usedIdentity,
  };
}

/** Runs no CLI, network, account discovery or provider process. */
export function runCli(args: string[]): number {
  try {
    const options = parseArguments(args);
    const manifest = loadManifest(options.manifest);
    if (existsSync(options.out)) {
      const stat = lstatSync(options.out);
      if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(options.out).length !== 0)
        throw new Error('Output directory must be new or empty.');
    } else {
      // Creating only the final directory prevents a mistyped path from making
      // an arbitrary tree; the caller chooses its existing disposable parent.
      if (!lstatSync(dirname(options.out)).isDirectory())
        throw new Error('Output parent is unavailable.');
      mkdirSync(options.out, { mode: 0o700 });
    }
    const output = realpathSync(options.out);
    const work = join(output, 'work');
    mkdirSync(work, { mode: 0o700 });
    const reports = manifest.cases.map((scenario) => {
      const root = join(work, scenario.id);
      mkdirSync(root, { mode: 0o700 });
      return runOutcome(scenario, {
        root,
        clock: () => manifest.clock,
        nativeReport: options.nativeReport,
      });
    });
    const summary = summarize(reports);
    const controls = negativeControls(manifest.cases, reports);
    const status =
      summary.status === 'failed' || controls.some((row) => row.status === 'failed')
        ? 'failed'
        : summary.status === 'unavailable' || controls.some((row) => row.status === 'unavailable')
          ? 'unavailable'
          : 'passed';
    const report = { ...summary, status, negativeControls: controls };
    writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return report.status === 'failed' ? 1 : report.status === 'unavailable' ? 3 : 0;
  } catch {
    return 2;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = runCli(process.argv.slice(2));
  if (code === 2)
    process.stderr.write('Outcome runner refused input or could not produce the report.\n');
  process.exitCode = code;
}
