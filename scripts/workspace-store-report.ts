/** Orchestrates the actual Rust disposable comparison; contains no store implementation. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { cpus, freemem, loadavg, platform, release, totalmem } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function parseReportArgs(args: string[]): {
  fixture: string;
  out: string;
  nativeBinary: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!['--fixture', '--out', '--native-binary'].includes(flag))
      throw new Error(`Unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Value required for ${flag}`);
    values.set(flag, value);
  }
  const fixture = values.get('--fixture');
  const out = values.get('--out');
  const nativeBinary = values.get('--native-binary');
  if (!fixture || !out || !nativeBinary)
    throw new Error('--fixture, --out and --native-binary are required');
  return { fixture, out, nativeBinary };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolVersion(program: string, args: string[]) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 });
  return result.status === 0
    ? { status: 'recorded', output: result.stdout.trim() }
    : { status: 'unavailable', reason: result.error?.message ?? result.stderr.trim() };
}

function main(args: string[]): void {
  const options = parseReportArgs(args);
  const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const binary = realpathSync(options.nativeBinary);
  const artifactBase = realpathSync(resolve(repo, 'src-tauri/target/debug/deps'));
  const artifactPath = relative(artifactBase, binary);
  if (
    isAbsolute(artifactPath) ||
    artifactPath.startsWith('..') ||
    !/^cerebro_lib-[a-f0-9]+$/.test(artifactPath)
  )
    throw new Error('Native binary must be the already-built repository test executable');
  const fixture = realpathSync(options.fixture);
  if (!statSync(fixture).isDirectory()) throw new Error('Fixture must be a disposable directory');
  const out = resolve(options.out);
  if (existsSync(out)) throw new Error('Report output already exists; choose a new output path');
  const context = {
    node: process.version,
    rustcOnPath: toolVersion('rustc', ['--version', '--verbose']),
    cargoOnPath: toolVersion('cargo', ['--version']),
    platform: platform(),
    release: release(),
    cpuModel: cpus()[0]?.model ?? 'unavailable',
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    loadAverage: loadavg(),
    startedAt: new Date().toISOString(),
    build: 'debug test executable; offline pinned workspace build',
    concurrency: 'shared machine with concurrent agents; decision-grade performance unavailable',
  };
  const result = spawnSync(
    binary,
    [
      'workspace_migration::comparison::tests::write_report',
      '--exact',
      '--ignored',
      '--test-threads=1',
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        CEREBRO_M99_FIXTURE: fixture,
        CEREBRO_M99_REPORT: out,
        CEREBRO_M99_CONTEXT: JSON.stringify(context),
      },
      encoding: 'utf8',
      timeout: 60 * 60 * 1000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Native comparison unavailable: ${result.error?.message ?? `${result.stderr}\n${result.stdout}`}`,
    );
  checkRustReport(readFileSync(out, 'utf8'), repo);
  console.log(`Validated native comparison: ${out} (contended samples only)`);
}

// Version-1 emitter inventory, held against the retained actual Rust report in tests.
// This is the native harness's declared inventory, not all transitive crate inputs.
const REPORT_SOURCES = [
  'shared/workspace/values.v1.json',
  'src-tauri/src/vault/link.rs',
  'src-tauri/src/workspace_migration/comparison.rs',
  'src-tauri/src/workspace_migration/identity.rs',
  'src-tauri/src/workspace_migration/inventory.rs',
  'src-tauri/src/workspace_migration/sidecar.rs',
  'src-tauri/src/workspace_migration/sqlite.rs',
  'src-tauri/src/workspace_migration/syntax.rs',
  'src-tauri/src/workspace_service/query.rs',
  'src-tauri/src/workspace_service/types.rs',
  'src-tauri/src/workspace_service/value.rs',
];
const STORE_TIMINGS = [
  'all_query_pages_us',
  'backup_restore_us',
  'create_delete_us',
  'external_edit_probe_us',
  'initialize_us',
  'patch_us',
  'read_one_us',
  'recovery_boundaries_us',
  'restart_us',
];

function requireReport(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Rust comparison report: ${message}`);
}
function fields(value: unknown, required: string[], label: string, optional: string[] = []) {
  requireReport(object(value), `${label} must be an object`);
  requireReport(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
    `${label} has missing or unexpected fields`,
  );
  return value;
}
function nonempty(value: unknown, label: string): string {
  requireReport(typeof value === 'string' && value.trim().length > 0, `${label} must be recorded`);
  return value;
}
function quantity(value: unknown, label: string): number {
  requireReport(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    `${label} must be a finite nonnegative safe integer, not unavailable`,
  );
  return value;
}
function timings(value: unknown, keys: string[], label: string) {
  const measured = fields(value, keys, label);
  for (const key of keys) quantity(measured[key], `${label}.${key}`);
}
function sha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function relativePath(value: unknown): string {
  const path = nonempty(value, 'source path');
  requireReport(
    !isAbsolute(path) &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    'invalid source path',
  );
  return path;
}
function toolEvidence(value: unknown) {
  requireReport(object(value), 'tool context must be recorded or explicitly unavailable');
  if (value.status === 'recorded') {
    const tool = fields(value, ['status', 'output'], 'tool context');
    nonempty(tool.output, 'tool version');
  } else {
    const tool = fields(value, ['status', 'reason'], 'tool context');
    requireReport(tool.status === 'unavailable', 'unknown tool context status');
    nonempty(tool.reason, 'tool unavailability reason');
  }
}

export function checkRustReport(raw: string, repo: string): void {
  const report = fields(
    JSON.parse(raw),
    [
      'format',
      'measurementQuality',
      'performanceDecision',
      'scenario',
      'requestedRecords',
      'convertedRecords',
      'retainedRecords',
      'conversionDispositions',
      'inventoryCoverage',
      'ledgerEvidence',
      'archiveHashes',
      'originalBytesUnchanged',
      'commonTimingsMicros',
      'stores',
      'semanticDifferences',
      'context',
      'toolchainPin',
      'compileRustupToolchain',
      'sourceDigests',
      'limitations',
    ],
    'version-1 report',
  );
  requireReport(
    report.format === 1 &&
      report.measurementQuality === 'contended_samples_only' &&
      report.performanceDecision === 'unavailable_pending_quiet_repeats',
    'unsupported format or measurement qualifier',
  );
  const requested = quantity(report.requestedRecords, 'requested records');
  const converted = quantity(report.convertedRecords, 'converted records');
  const retained = quantity(report.retainedRecords, 'retained records');
  requireReport(converted > 0 && converted + retained === requested, 'inconsistent record counts');
  requireReport(
    (report.scenario === 'ordinary' && [1000, 5000].includes(requested) && retained === 0) ||
      (report.scenario === 'adversarial' && requested === 138),
    'unsupported scenario or record count',
  );
  requireReport(report.originalBytesUnchanged === true, 'original bytes were not proven unchanged');
  requireReport(
    Array.isArray(report.semanticDifferences) && report.semanticDifferences.length === 0,
    'unavailable or unexplained semantic differences',
  );

  const coverage = fields(
    report.inventoryCoverage,
    ['kind', 'requested_paths', 'whole_vault', 'conversion_attempted'],
    'inventory coverage',
  );
  requireReport(
    coverage.kind === 'requested_paths' &&
      coverage.whole_vault === false &&
      coverage.conversion_attempted === false &&
      Array.isArray(coverage.requested_paths),
    'invalid inventory coverage claims',
  );
  const paths = coverage.requested_paths.map(relativePath);
  requireReport(
    paths.length === requested && new Set(paths).size === requested,
    'requested paths disagree with counts or repeat',
  );
  const archived = fields(report.archiveHashes, paths, 'archive checksums');
  requireReport(Object.values(archived).every(sha256), 'invalid original archive checksum');
  requireReport(
    Array.isArray(report.conversionDispositions) &&
      report.conversionDispositions.length === requested,
    'missing conversion dispositions',
  );
  const dispositions = new Set<string>();
  let convertedDispositions = 0;
  for (const value of report.conversionDispositions) {
    const row = fields(value, ['path', 'disposition', 'reason'], 'conversion disposition');
    const path = relativePath(row.path);
    requireReport(
      paths.includes(path) && !dispositions.has(path),
      'unknown or repeated disposition path',
    );
    dispositions.add(path);
    requireReport(
      row.disposition === 'converted' || row.disposition === 'retained_unchanged',
      'unknown conversion disposition',
    );
    if (row.disposition === 'converted') convertedDispositions += 1;
    nonempty(row.reason, 'conversion reason');
  }
  requireReport(
    convertedDispositions === converted,
    'conversion dispositions disagree with counts',
  );
  const ledger = fields(
    report.ledgerEvidence,
    [
      'store_id',
      'store_identity_in_scope',
      'projection_codec',
      'projection_codec_sha256',
      'projection_manifest_in_scope',
    ],
    'ledger evidence',
  );
  requireReport(
    typeof ledger.store_identity_in_scope === 'boolean' &&
      typeof ledger.projection_manifest_in_scope === 'boolean' &&
      sha256(ledger.projection_codec_sha256),
    'invalid ledger evidence',
  );
  nonempty(ledger.projection_codec, 'retained projection codec');
  requireReport(
    ledger.store_id === null ||
      (typeof ledger.store_id === 'string' &&
        ledger.store_id.length > 0 &&
        ledger.store_identity_in_scope),
    'invalid retained ledger identity',
  );

  timings(report.commonTimingsMicros, ['inventory', 'conversion'], 'common timings');
  requireReport(
    Array.isArray(report.stores) && report.stores.length === 2,
    'both native stores required',
  );
  const backends = new Set<string>();
  const expectedRecovery = [
    ['AfterIntent', 'old_coherent'],
    ['AfterVisible', 'old_coherent'],
    ['AfterMetadata', 'new_coherent'],
  ];
  for (const value of report.stores) {
    const store = fields(
      value,
      [
        'backend',
        'timingsMicros',
        'queriedRecords',
        'backupRestore',
        'externalEdit',
        'recovery',
        'metadataPlacement',
      ],
      'native store',
    );
    const backend = nonempty(store.backend, 'backend');
    requireReport(
      ['sidecar', 'sqlite'].includes(backend) && !backends.has(backend),
      'exactly one result per native backend required',
    );
    backends.add(backend);
    requireReport(
      quantity(store.queriedRecords, 'queried records') === converted,
      'queried records disagree with converted records',
    );
    requireReport(
      store.backupRestore === 'passed_with_post_conversion_edit' &&
        store.externalEdit === 'refused_without_adoption',
      'required store exercises did not pass',
    );
    timings(store.timingsMicros, STORE_TIMINGS, `${backend} timings`);
    requireReport(
      Array.isArray(store.recovery) && store.recovery.length === 3,
      'all three recovery boundaries required',
    );
    for (const [index, [boundary, outcome]] of expectedRecovery.entries()) {
      const recovery = fields(store.recovery[index], ['boundary', 'outcome'], 'recovery result');
      requireReport(
        recovery.boundary === boundary && recovery.outcome === outcome,
        'recovery boundary missing, repeated, out of order or failed',
      );
    }
    requireReport(
      store.metadataPlacement ===
        (backend === 'sidecar'
          ? 'vault-local immutable record sidecars plus atomic manifest'
          : 'separate sibling SQLite metadata database'),
      'metadata placement disagrees with backend',
    );
  }

  const context = fields(
    report.context,
    [
      'node',
      'platform',
      'release',
      'cpuModel',
      'logicalCpus',
      'totalMemoryBytes',
      'freeMemoryBytes',
      'loadAverage',
      'startedAt',
      'build',
      'concurrency',
    ],
    'measurement context',
    ['rustcOnPath', 'cargoOnPath'],
  );
  for (const key of ['node', 'platform', 'release', 'cpuModel'])
    nonempty(context[key], `context.${key}`);
  requireReport(quantity(context.logicalCpus, 'logical CPUs') > 0, 'logical CPUs must be recorded');
  const total = quantity(context.totalMemoryBytes, 'total memory');
  requireReport(
    total > 0 && quantity(context.freeMemoryBytes, 'free memory') <= total,
    'invalid memory context',
  );
  requireReport(
    Array.isArray(context.loadAverage) &&
      context.loadAverage.length === 3 &&
      context.loadAverage.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0),
    'three finite nonnegative load observations required',
  );
  const started = nonempty(context.startedAt, 'measurement start');
  requireReport(Number.isFinite(Date.parse(started)), 'invalid measurement start');
  requireReport(
    context.build === 'debug test executable; offline pinned workspace build' &&
      context.concurrency ===
        'shared machine with concurrent agents; decision-grade performance unavailable',
    'missing debug/contended measurement context',
  );
  // Earlier version-1 artifacts predate on-path tool observations. Either both
  // are absent or both are explicit evidence; absence never invents a version.
  requireReport(
    Object.hasOwn(context, 'rustcOnPath') === Object.hasOwn(context, 'cargoOnPath'),
    'incomplete on-path tool context',
  );
  if (Object.hasOwn(context, 'rustcOnPath')) {
    toolEvidence(context.rustcOnPath);
    toolEvidence(context.cargoOnPath);
  }
  nonempty(report.toolchainPin, 'toolchain pin');
  requireReport(
    report.compileRustupToolchain === null ||
      (typeof report.compileRustupToolchain === 'string' &&
        report.compileRustupToolchain.trim().length > 0),
    'compiled rustup context must be recorded or null',
  );
  requireReport(
    Array.isArray(report.limitations) && report.limitations.length > 0,
    'measurement limitations required',
  );
  report.limitations.forEach((value) => nonempty(value, 'measurement limitation'));

  const sources = fields(report.sourceDigests, REPORT_SOURCES, 'compiled source inventory');
  const base = realpathSync(repo);
  for (const path of REPORT_SOURCES) {
    const expected = sources[path];
    requireReport(sha256(expected), `invalid compiled source digest: ${path}`);
    const actualPath = realpathSync(resolve(base, path));
    const inside = relative(base, actualPath);
    requireReport(
      !isAbsolute(inside) && inside !== '..' && !inside.startsWith('../'),
      `compiled source path leaves repository: ${path}`,
    );
    const actual = createHash('sha256').update(readFileSync(actualPath)).digest('hex');
    if (expected !== actual) throw new Error(`Stale native comparison binary: ${path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
