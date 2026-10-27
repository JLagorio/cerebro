// @vitest-environment node
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOutcome } from './outcomes/assert';
import { readNativeCapture } from './outcomes/native-capture';
import {
  generateNativeInputs,
  nativeInputArtifacts,
  nativeInputIdentity,
} from './outcomes/native-inputs';

import { loadManifest, parseArguments, runCli, runOutcome } from './outcomes/run';
import type { OutcomeCase, OutcomeObservations } from './outcomes/report';

const roots: string[] = [];
function disposable(): string {
  const root = mkdtempSync(join(tmpdir(), 'cerebro-outcomes-test-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const manifestPath = resolve('conformance/outcomes/manifest.v1.json');
function fixture(id: string): OutcomeCase {
  return loadManifest(manifestPath).cases.find((item) => item.id === id)!;
}
function observed(id: string): OutcomeObservations {
  return runOutcome(fixture(id), {
    root: disposable(),
    clock: () => '2026-10-24T12:00:00.000Z',
  }).observations;
}
function failedGate(c: OutcomeCase, observations: OutcomeObservations, gate: string) {
  expect(assertOutcome(c, observations)).toContainEqual(
    expect.objectContaining({ id: gate, status: 'failed' }),
  );
}

describe('M97 outcome causal hard gates', () => {
  // Removing the allowlist check would let an undeclared external effect pass.
  it('rejects a forbidden effect despite otherwise valid source evidence', () => {
    const c = fixture('repeated');
    const observations = observed(c.id);
    observations.effects.push({ kind: 'send', target: 'fixture:message', actor: 'agent' });
    failedGate(c, observations, 'forbidden_effect');
  });

  // Removing independent source disclosure checking would leak a foreign vault.
  it('rejects disclosure after the real resolver refused a foreign source', () => {
    const c = fixture('abstain');
    const observations = observed(c.id);
    const foreign = observations.sources.find(
      (source) => source.id === 'foreign vault hides locator',
    )!;
    foreign.disclosed = true;
    failedGate(c, observations, 'source_disclosure');
  });

  // Letting an agent attest a concept must fail even if all quoted sources exist.
  it('rejects an agent Verify effect separately from source quality', () => {
    const c = fixture('repeated');
    const observations = observed(c.id);
    observations.effects.push({ kind: 'verify', target: 'knowledge/fixture.md', actor: 'agent' });
    failedGate(c, observations, 'false_verify');
  });

  // Relabeling a changed source as exact must not hide the actual current hash.
  it('rejects exact-source claims for stale bytes', () => {
    const c = fixture('stale');
    const observations = observed(c.id);
    observations.sources[0].status = 'exact';
    failedGate(c, observations, 'stale_content');
  });

  // Hoisting a child error into the parent must fail regardless of the final text.
  it('rejects a failed child contaminating its parent transcript', () => {
    const c = fixture('failed-child');
    const observations = observed(c.id);
    expect(observations.children[0].status).toBe('failed');
    expect(observations.children[0].parentError).toBe(false);
    observations.children[0].parentError = true;
    failedGate(c, observations, 'failed_child_isolation');
  });

  // An extra submission after an unknown outcome is a hard failure, not a retry score.
  it('rejects an unacknowledged retry after an unknown remote outcome', () => {
    const c = fixture('lost-response');
    const observations = observed(c.id);
    observations.broker = {
      stateBefore: 'outcome_unknown',
      stateAfter: 'succeeded',
      submissions: 2,
      attempts: 2,
      retryAcknowledged: false,
      retryRefusal: null,
      producer: 'negative-control',
    };
    failedGate(c, observations, 'unknown_outcome_retry');
  });
});

describe('M97 real producers and unavailable outcomes', () => {
  it('preserves the exact second occurrence through the production resolver', () => {
    const report = runOutcome(fixture('repeated'), { root: disposable(), clock: () => 'fixed' });
    expect(report.status).toBe('passed');
    expect(report.observations.sources).toContainEqual(
      expect.objectContaining({
        id: 'same hash exact repeated occurrence',
        status: 'exact',
        range: { start: 14, end: 19 },
      }),
    );
  });

  it('reports the actual counterevidence retained by the Rust-parity TS reducer', () => {
    const report = runOutcome(fixture('counterevidence'), {
      root: disposable(),
      clock: () => 'fixed',
    });
    expect(report.observations.artifacts).toContainEqual({
      id: 'contradiction:f658658f3698ca746745ece26f381a11',
      state: 'open',
    });
    expect(report.status).toBe('unavailable');
  });

  it('does not copy expected artifacts into observed state', () => {
    const c = fixture('counterevidence');
    c.expectedArtifacts = [{ id: 'invented-artifact', state: 'open' }];
    const report = runOutcome(c, { root: disposable(), clock: () => 'fixed' });
    expect(report.observations.artifacts).not.toContainEqual(c.expectedArtifacts[0]);
    expect(report.status).toBe('failed');
  });

  it('keeps imported instructions inert and refuses deleted or unproven moved sources', () => {
    const passage = runOutcome(fixture('passage'), { root: disposable(), clock: () => 'fixed' });
    expect(passage.observations.sources).toContainEqual(
      expect.objectContaining({
        id: 'imported prompt injection stays source text',
        status: 'exact',
      }),
    );
    expect(passage.observations.effects).toEqual([]);
    const stale = runOutcome(fixture('stale'), { root: disposable(), clock: () => 'fixed' });
    for (const id of ['deleted source', 'moved source needs proven identity']) {
      expect(stale.observations.sources).toContainEqual(
        expect.objectContaining({ id, status: 'unavailable', disclosed: false }),
      );
    }
  });

  it('never reports unavailable mail or unknown CLI/model/cost as a passed zero', () => {
    const report = runOutcome(fixture('mail-draft'), { root: disposable(), clock: () => 'fixed' });
    expect(report.status).toBe('unavailable');
    expect(report.identity.cli.observed).toBeNull();
    expect(report.identity.model.observed).toBeNull();
    expect(report.observations.usage.costUsd).toBeNull();
    expect(report.observations.effects).toEqual([]);
    expect(report.dimensions).toContainEqual(
      expect.objectContaining({ id: 'approved_mail_draft', status: 'unavailable' }),
    );
  });

  it('reuses immutable fixture input bytes and does not retain reasoning', () => {
    const before = readFileSync(resolve('conformance/contradiction.json'), 'utf8');
    const report = runOutcome(fixture('counterevidence'), {
      root: disposable(),
      clock: () => 'fixed',
    });
    expect(readFileSync(resolve('conformance/contradiction.json'), 'utf8')).toBe(before);
    expect(JSON.stringify(report)).not.toContain('Thinking');
    expect(report.identity.sourceDigests['src/lib/epistemic/reduce.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(report.identity.sourceDigests['conformance/contradiction.json']).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});

describe('M97 offline input boundaries', () => {
  function manifestWithCase(scenario: unknown, cases = ['case.json']): string {
    const root = disposable();
    writeFileSync(join(root, 'case.json'), JSON.stringify(scenario));
    writeFileSync(
      join(root, 'manifest.json'),
      JSON.stringify({ version: 1, clock: '2026-10-24T12:00:00.000Z', cases }),
    );
    return join(root, 'manifest.json');
  }

  it('rejects escaping fixture paths before reading them', () => {
    expect(() => loadManifest(manifestWithCase(fixture('repeated'), ['../outside.json']))).toThrow(
      /path/i,
    );
  });

  it('rejects unknown producer fields and adapters before replay', () => {
    expect(() =>
      loadManifest(manifestWithCase({ ...fixture('repeated'), adapter: 'shell' })),
    ).toThrow(/adapter/i);
    expect(() =>
      loadManifest(manifestWithCase({ ...fixture('repeated'), command: 'arbitrary' })),
    ).toThrow(/field/i);
  });

  it('rejects duplicate scenario identities rather than overwriting a report', () => {
    expect(() =>
      loadManifest(manifestWithCase(fixture('repeated'), ['case.json', 'case.json'])),
    ).toThrow(/duplicate/i);
  });

  it('bounds input bytes before JSON materialization', () => {
    const path = manifestWithCase(fixture('repeated'));
    writeFileSync(path, ' '.repeat(262145));
    expect(() => loadManifest(path)).toThrow(/size|large|limit/i);
  });

  it('does not accept deeply nested injections', () => {
    const c = fixture('repeated');
    let nested: unknown = 'value';
    for (let i = 0; i < 20; i++) nested = { child: nested };
    c.inputs = { nested };
    expect(() => loadManifest(manifestWithCase(c))).toThrow(/depth/i);
  });

  it.each(['other files', 'combined vectors'] as const)(
    'refuses excessive %s before creating any disposable source files',
    (kind) => {
      const c = fixture('repeated');
      const variant = {
        id: 'bounded fixture',
        original: 'hello',
        current: 'hello',
        vaultId: 'vault',
        path: 'source.md',
        readable: true,
        range: { start: 0, end: 5 },
        ...(kind === 'other files'
          ? {
              otherFiles: Object.fromEntries(
                Array.from({ length: 129 }, (_, i) => [`extra-${i}.md`, 'x']),
              ),
            }
          : {}),
      };
      c.inputs = {
        vectors:
          kind === 'combined vectors'
            ? Array.from({ length: 128 }, () => 'same hash exact repeated occurrence')
            : [],
        variants: [variant],
      };
      const root = disposable();
      let failure: unknown;
      try {
        runOutcome(c, { root, clock: () => 'fixed' });
      } catch (error) {
        failure = error;
      }
      expect(readdirSync(root)).toEqual([]);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/limit|many|cap/i);
    },
  );

  it('returns unavailable independently from passing hard gates and writes a report', () => {
    const out = join(disposable(), 'report');
    const path = manifestWithCase(fixture('mail-draft'));
    expect(runCli(['--mode', 'offline', '--manifest', path, '--out', out])).toBe(3);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as {
      status: string;
      counts: { passed: number; unavailable: number };
    };
    expect(report.status).toBe('unavailable');
    expect(report.counts).toMatchObject({ passed: 0, unavailable: 1 });
  });

  it('returns hard failure for violated source expectations, even with unavailable quality', () => {
    const c = fixture('passage');
    c.expectedSources[0].status = 'unavailable';
    const out = join(disposable(), 'report');
    expect(runCli(['--mode', 'offline', '--manifest', manifestWithCase(c), '--out', out])).toBe(1);
  });

  it('refuses to write into an existing nonempty directory', () => {
    const out = disposable();
    writeFileSync(join(out, 'ordinary-page.md'), 'Keep these bytes.');
    expect(runCli(['--mode', 'offline', '--manifest', manifestPath, '--out', out])).toBe(2);
    expect(readFileSync(join(out, 'ordinary-page.md'), 'utf8')).toBe('Keep these bytes.');
  });

  it.each([
    ['--mode', 'live', '--manifest', manifestPath, '--out', '/tmp/out'],
    ['--mode', 'offline', '--manifest', manifestPath],
    ['--mode', 'offline', '--manifest', manifestPath, '--out', '/tmp/out', '--unknown'],
  ])('refuses incomplete or unsupported invocation %j', (...args) => {
    expect(() => parseArguments(args)).toThrow();
  });
});

// Replacement-contract RED: these probes use synthetic receipts, not native execution.
function nativeFixtureRepository(): string {
  const root = disposable();
  for (const directory of [
    'src-tauri/src/runtime',
    'src-tauri/fixtures',
    'src-tauri/build_support',
    'src-tauri/capabilities',
    'shared/policy',
    'conformance/outcomes',
    'scripts/outcomes',
  ])
    mkdirSync(join(root, directory), { recursive: true });
  // This real previously omitted dependency is copied, never modified in the repo.
  const runtime = 'src-tauri/src/runtime/action_invocations.rs';
  copyFileSync(resolve(runtime), join(root, runtime));
  for (const file of [
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'rust-toolchain.toml',
    'src-tauri/build.rs',
    'src-tauri/tauri.conf.json',
    'src-tauri/native-read-smoke/tauri.conf.json',
    'src-tauri/icons/32x32.png',
    'src-tauri/icons/icon.icns',
    'src-tauri/clippy.toml',
    'src-tauri/Info.plist',
    'src-tauri/capabilities/default.json',
    'conformance/outcomes/native.rs',
    'scripts/outcomes/native-inputs.ts',
    'scripts/outcomes/native-capture.ts',
    'scripts/outcomes/retrieval.ts',
    'scripts/native-credential-smoke/run.py',
    'scripts/native-quit-smoke/run.py',
    'scripts/native-quit-smoke/test_run.py',
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(resolve(file), join(root, file));
  }
  writeFileSync(join(root, 'shared/policy/probe.json'), '{"synthetic":true}\n');
  writeFileSync(join(root, 'src-tauri/fixtures/probe.json'), '{"synthetic":true}\n');
  writeFileSync(join(root, 'src-tauri/build_support/probe.rs'), '// synthetic\n');
  generateNativeInputs(root);
  return root;
}
function nativeProbeCapture(root: string): string {
  const path = join(disposable(), 'native-probe.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      scenario: 'lost-response',
      producer: 'actions::service::test_support::Harness',
      observedAt: '2026-10-24T12:00:00.000Z',
      clock: 'wall_clock_not_injected',
      nativeInputs: nativeInputIdentity(root),
      broker: {
        stateBefore: 'outcome_unknown',
        stateAfter: 'succeeded',
        submissions: 1,
        attempts: 1,
        retryAcknowledged: false,
        retryRefusal: 'denied',
        producer: 'actions::service::test_support::Harness',
      },
      effects: [
        { kind: 'external_mutation', target: 'fixture:issue-create', actor: 'human:fixture' },
      ],
      artifacts: [{ id: 'broker:lost-response', state: 'succeeded' }],
      limits: ['Synthetic importer probe; not evidence that a native producer ran.'],
    }),
  );
  return path;
}

describe('native producer capture input provenance', () => {
  it('accepts a matching synthetic importer probe with its complete input identity', () => {
    const root = nativeFixtureRepository();
    const path = nativeProbeCapture(root);
    expect(readNativeCapture(path, root).broker.stateAfter).toBe('succeeded');
  });

  // Removing runtime dependencies from the input set would accept stale SQLite semantics.
  it('refuses a capture after actual runtime store input bytes change', () => {
    const root = nativeFixtureRepository();
    const path = nativeProbeCapture(root);
    expect(readNativeCapture(path, root).broker.stateAfter).toBe('succeeded');
    const dependency = join(root, 'src-tauri/src/runtime/action_invocations.rs');
    writeFileSync(dependency, `${readFileSync(dependency, 'utf8')}\n// disposable changed store\n`);
    expect(() => readNativeCapture(path, root)).toThrow(/stale|identity|digest/i);
  });

  it.each(['added', 'removed'] as const)(
    'refuses %s compile-input paths before accepting evidence',
    (change) => {
      const root = nativeFixtureRepository();
      const path = nativeProbeCapture(root);
      if (change === 'added')
        writeFileSync(join(root, 'src-tauri/src/new_dependency.rs'), '// new\n');
      else rmSync(join(root, 'src-tauri/src/runtime/action_invocations.rs'));
      expect(() => readNativeCapture(path, root)).toThrow(/inventory|path|generation|missing/i);
    },
  );

  it('requires exact generated Rust/JSON inventory parity', () => {
    const root = nativeFixtureRepository();
    const path = nativeProbeCapture(root);
    writeFileSync(
      join(root, 'conformance/outcomes/native-inputs.generated.rs'),
      '// stale entries\n',
    );
    expect(() => readNativeCapture(path, root)).toThrow(/generation|inventory|parity/i);
  });

  it('never reads a symlinked producer input', () => {
    const root = nativeFixtureRepository();
    const path = nativeProbeCapture(root);
    const dependency = join(root, 'src-tauri/src/runtime/action_invocations.rs');
    rmSync(dependency);
    symlinkSync(resolve('src-tauri/src/runtime/action_invocations.rs'), dependency);
    expect(() => readNativeCapture(path, root)).toThrow(/symlink|regular|input/i);
  });

  it('enforces input file-size bounds before replacing generated artifacts', () => {
    const root = nativeFixtureRepository();
    const artifact = join(root, 'conformance/outcomes/native-inputs.v1.json');
    const before = readFileSync(artifact);
    writeFileSync(join(root, 'src-tauri/src/oversized.rs'), Buffer.alloc(4 * 1024 * 1024 + 1));
    expect(() => generateNativeInputs(root)).toThrow(/size|limit|cap/i);
    expect(readFileSync(artifact)).toEqual(before);
  });

  it.each(['file count', 'total bytes'] as const)(
    'enforces %s before replacing generated artifacts',
    (budget) => {
      const root = nativeFixtureRepository();
      const artifact = join(root, 'conformance/outcomes/native-inputs.v1.json');
      const before = readFileSync(artifact);
      const count = budget === 'file count' ? 2048 : 17;
      for (let i = 0; i < count; i++) {
        const file = join(root, `src-tauri/src/budget-${i}.rs`);
        writeFileSync(file, '');
        if (budget === 'total bytes') truncateSync(file, 4 * 1024 * 1024);
      }
      expect(() => generateNativeInputs(root)).toThrow(/count|total|limit|cap/i);
      expect(readFileSync(artifact)).toEqual(before);
    },
  );

  it('ignores only Finder directory metadata while refusing other hidden inputs', () => {
    const root = nativeFixtureRepository();
    const before = nativeInputIdentity(root);
    writeFileSync(join(root, 'shared/.DS_Store'), 'Synthetic Finder metadata');
    expect(nativeInputIdentity(root)).toEqual(before);
    rmSync(join(root, 'shared/.DS_Store'));
    mkdirSync(join(root, 'shared/.DS_Store'));
    expect(() => nativeInputIdentity(root)).toThrow(/input path/i);
    rmSync(join(root, 'shared/.DS_Store'), { recursive: true });
    writeFileSync(join(root, 'shared/.hidden-input'), 'Synthetic unknown hidden input');
    expect(() => nativeInputIdentity(root)).toThrow(/input path/i);
  });

  it('commits exactly the complete current generated inventory', () => {
    const generated = nativeInputArtifacts(resolve('.'));
    expect(readFileSync('conformance/outcomes/native-inputs.v1.json', 'utf8')).toBe(generated.json);
    expect(readFileSync('conformance/outcomes/native-inputs.generated.rs', 'utf8')).toBe(
      generated.rust,
    );
    expect(generated.paths).toContain('src-tauri/src/runtime/action_invocations.rs');
    expect(generated.paths).toContain('src-tauri/Cargo.lock');
    expect(generated.paths).toContain('src-tauri/native-read-smoke/tauri.conf.json');
    expect(generated.paths).toContain('src-tauri/icons/32x32.png');
    expect(generated.paths).toContain('src-tauri/icons/icon.icns');
    expect(generated.paths).toContain('conformance/outcomes/native.rs');
  });
});
