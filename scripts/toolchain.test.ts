import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * One toolchain (M53.3). rust-toolchain.toml and package.json hold the only
 * Rust, Node and pnpm versions in the repo: CI installs what they name, and
 * pre-push warns when this machine runs something else. Where the workflow or
 * the hook decides something in shell, that shell runs here against stub
 * tools, so a pin that changes shape fails on the machine that changed it
 * instead of on a runner.
 */

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  'runs-on'?: string;
  steps?: Step[];
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const toml = read('rust-toolchain.toml');
const pkg = JSON.parse(read('package.json')) as {
  packageManager?: string;
  engines?: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const hook = read('.husky/pre-push');
const workflowText = read('.github/workflows/mac-app.yml');
const jobs = (parse(workflowText) as { jobs: Record<string, Job> }).jobs;

// Each pin in the exact shape the sed in CI and in the hook reads.
const CHANNEL = /^channel = "(\d+\.\d+\.\d+)"$/m.exec(toml)?.[1] ?? '';
const NODE_MAJOR = /^(\d+)\.x$/.exec(pkg.engines?.node ?? '')?.[1] ?? '';
const PNPM = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? '')?.[1] ?? '';

const scratch = mkdtempSync(join(tmpdir(), 'cerebro-toolchain-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fresh directory of stub executables, one shell body each. */
function stubs(tools: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, 'bin-'));
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/**
 * Runs a script under `-e`, as husky runs a hook (`sh -e`) and GitHub runs a
 * step (`bash -e`), with only the stubs and the system bins on PATH.
 */
function sh(
  shell: '/bin/sh' | '/bin/bash',
  script: string,
  bin: string,
  opts: { cwd?: string; input?: string } = {},
) {
  const result = spawnSync(shell, ['-e', '-c', script], {
    cwd: opts.cwd ?? ROOT,
    env: { PATH: `${bin}:/usr/bin:/bin` },
    input: opts.input,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout };
}

describe('the pins', () => {
  it('rust-toolchain.toml names one exact channel, with rustfmt and clippy', () => {
    expect(toml.match(/^\[.*\]$/gm)).toEqual(['[toolchain]']);
    expect(toml.match(/^channel\b.*$/gm)).toHaveLength(1);
    // Exact, never `stable`: a moving channel is the float this replaced, and
    // the ledger's fsync and flock claims name the compiler they were checked on.
    expect(CHANNEL).toMatch(/^\d+\.\d+\.\d+$/);
    const components = /^components = (\[.*\])$/m.exec(toml)?.[1] ?? '[]';
    expect(JSON.parse(components)).toEqual(expect.arrayContaining(['rustfmt', 'clippy']));
    expect(toml).toMatch(/^profile = "minimal"$/m);
  });

  it('package.json pins pnpm exactly and Node by major', () => {
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(pkg.engines?.node).toMatch(/^\d+\.x$/);
  });

  it('the locked Tauri crate and JS API share a minor, as do both dialog halves', () => {
    const cargo = read('src-tauri/Cargo.lock');
    const lockedCrate = (name: string) => {
      const versions = [
        ...cargo.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g),
      ]
        .filter((match) => match[1] === name)
        .map((match) => match[2]);
      expect(versions, `one locked ${name}`).toHaveLength(1);
      return versions[0];
    };
    const lock = parse(read('pnpm-lock.yaml')) as {
      importers: Record<
        string,
        {
          dependencies: Record<string, { version: string }>;
          devDependencies: Record<string, { version: string }>;
        }
      >;
    };
    const minor = (version: string) => version.split('.').slice(0, 2).join('.');
    const js = lock.importers['.'];
    expect(minor(lockedCrate('tauri'))).toBe(minor(js.dependencies['@tauri-apps/api'].version));
    expect(minor(lockedCrate('tauri-plugin-dialog'))).toBe(
      minor(js.dependencies['@tauri-apps/plugin-dialog'].version),
    );
    expect(pkg.dependencies['@tauri-apps/api']).toBe('~2.12.0');
    expect(pkg.devDependencies['@tauri-apps/cli']).toBe('~2.12.0');
    expect(minor(js.devDependencies['@tauri-apps/cli'].version)).toBe('2.12');
    for (const name of [
      'tauri-build',
      'tauri-codegen',
      'tauri-macros',
      'tauri-plugin',
      'tauri-runtime',
      'tauri-runtime-wry',
      'tauri-utils',
      'wry',
    ])
      lockedCrate(name);
  });
});

describe('mac-app.yml reads the pins', () => {
  const steps = Object.entries(jobs).flatMap(([job, { steps = [] }]) =>
    steps.map((step) => ({ job, step })),
  );
  const using = (action: string) => steps.filter(({ step }) => step.uses?.startsWith(action));

  it('writes no toolchain version of its own', () => {
    expect([CHANNEL, PNPM]).not.toContain('');
    expect(workflowText).not.toMatch(/^\s*node-version:/m);
    expect(workflowText).not.toContain(CHANNEL);
    expect(workflowText).not.toContain(PNPM);
    expect(using('dtolnay/')).toEqual([]);
  });

  it('gives every job its Node from engines.node', () => {
    const setupNode = using('actions/setup-node@');
    expect(setupNode.map(({ job }) => job).sort()).toEqual(['build', 'e2e', 'quality']);
    for (const { job, step } of setupNode) {
      expect(step.with?.['node-version-file'], job).toBe('package.json');
    }
  });

  it('gives every job its pnpm from packageManager', () => {
    const setupPnpm = using('pnpm/action-setup@');
    expect(setupPnpm.map(({ job }) => job).sort()).toEqual(['build', 'e2e', 'quality']);
    for (const { job, step } of setupPnpm) {
      expect(step.with ?? {}, job).not.toHaveProperty('version');
    }
  });

  it('runs every job on a named runner image, never a -latest one', () => {
    for (const [job, { 'runs-on': image }] of Object.entries(jobs)) {
      expect(image, job).toMatch(/^[a-z]+-\d+(\.\d+)?$/);
    }
  });

  /** The job's one Rust install step, which must come before any Rust use. */
  function rustInstall(job: string) {
    const all = jobs[job].steps ?? [];
    const found = all.filter((step) => step.run?.includes('rustup toolchain install'));
    expect(found, job).toHaveLength(1);
    const usesRust = (step: Step) =>
      step.uses?.startsWith('Swatinem/rust-cache@') || /\bcargo\b|tauri build/.test(step.run ?? '');
    const installAt = all.indexOf(found[0]);
    expect(installAt, job).toBeLessThan(all.findIndex(usesRust));
    return found[0].run ?? '';
  }

  it.each([
    { job: 'quality', targets: [] as string[] },
    {
      job: 'build',
      targets: ['--target aarch64-apple-darwin', '--target x86_64-apple-darwin'],
    },
  ])('$job installs the channel rust-toolchain.toml names', ({ job, targets }) => {
    const bin = stubs({ rustup: 'echo "rustup $*"', rustc: `echo 'rustc ${CHANNEL} (stub)'` });
    expect(sh('/bin/bash', rustInstall(job), bin)).toEqual({
      status: 0,
      stdout: [
        [
          `rustup toolchain install ${CHANNEL} --profile minimal`,
          '--component rustfmt --component clippy',
          ...targets,
        ].join(' '),
        `rustc ${CHANNEL} (stub)`,
        '',
      ].join('\n'),
    });
  });

  it('fails the install by name, before rustup runs, when the toml has no channel', () => {
    const repo = mkdtempSync(join(scratch, 'repo-'));
    writeFileSync(join(repo, 'rust-toolchain.toml'), '[toolchain]\nprofile = "minimal"\n');
    const bin = stubs({ rustup: 'echo "rustup $*"', rustc: 'echo rustc' });
    const { status, stdout } = sh('/bin/bash', rustInstall('quality'), bin, { cwd: repo });
    expect(status).not.toBe(0);
    expect(stdout).toContain('::error file=rust-toolchain.toml::');
    expect(stdout).not.toContain('rustup');
  });
});

describe('.husky/pre-push', () => {
  const probe = /^toolchain_drift\(\) \{\n[\s\S]*?\n\}$/m.exec(hook)?.[0] ?? '';
  const drift = (tools: Record<string, string>) =>
    sh('/bin/sh', `${probe}\ntoolchain_drift`, stubs(tools));

  it('checks the toolchain before the gate starts', () => {
    expect(probe).not.toBe('');
    const lines = hook.split('\n');
    const call = lines.indexOf('toolchain_drift');
    expect(call).toBeGreaterThan(lines.indexOf('set -e'));
    expect(call).toBeLessThan(lines.indexOf('pnpm format:check'));
  });

  it('says nothing when rustc, node and pnpm match the pins', () => {
    expect(
      drift({
        rustc: `echo 'rustc ${CHANNEL} (59807616e 2026-04-14) (Homebrew)'`,
        node: `echo v${NODE_MAJOR}.3.1`,
        pnpm: `echo ${PNPM}`,
      }),
    ).toEqual({ status: 0, stdout: '' });
  });

  it('warns once for each tool that drifted, and never fails the push', () => {
    const { status, stdout } = drift({
      rustc: "echo 'rustc 0.0.1 (stub)'",
      node: 'echo v0.10.48',
      pnpm: 'echo 0.0.2',
    });
    expect(status).toBe(0);
    expect(stdout.trimEnd().split('\n')).toEqual([
      `pre-push: WARNING rustc is 0.0.1; rust-toolchain.toml pins ${CHANNEL}`,
      `pre-push: WARNING node is v0.10.48; package.json engines pins ${NODE_MAJOR}.x`,
      `pre-push: WARNING pnpm is 0.0.2; package.json packageManager pins ${PNPM}`,
    ]);
  });

  it('survives tools that fail, under the -e husky runs hooks with', () => {
    const { status, stdout } = drift({ rustc: 'exit 127', node: 'exit 127', pnpm: 'exit 1' });
    expect(status).toBe(0);
    expect(stdout.trimEnd().split('\n')).toEqual([
      `pre-push: WARNING rustc is missing; rust-toolchain.toml pins ${CHANNEL}`,
      `pre-push: WARNING node is missing; package.json engines pins ${NODE_MAJOR}.x`,
      `pre-push: WARNING pnpm is missing; package.json packageManager pins ${PNPM}`,
    ]);
  });

  const detector = /^if echo "\$changed" \| grep -qE '[^']+'; then$/m.exec(hook)?.[0] ?? '';
  const lane = (paths: string[]) =>
    sh('/bin/sh', `changed=$(cat)\n${detector}\n  echo rust\nelse\n  echo skip\nfi`, stubs({}), {
      input: paths.join('\n'),
    }).stdout.trim();

  // The Rust tests read ../shared, ../conformance and ../demo-vault, and the
  // toml decides which compiler runs them all.
  it.each([
    [['src-tauri/src/lib.rs']],
    [['shared/policy/policy.v3.json']],
    [['conformance/scan/entries.json']],
    [['demo-vault/knowledge/log.md']],
    [['rust-toolchain.toml']],
    [['src/App.tsx', 'shared/runtime/budget.v1.json']],
  ])('runs the Rust lane for %j', (paths) => {
    expect(detector).not.toBe('');
    expect(lane(paths)).toBe('rust');
  });

  it.each([
    [['src/App.tsx']],
    [['e2e/boot.ts', 'docs/superpowers/plans/plan.md', 'README.md']],
    [['scripts/rust-toolchain.toml']],
    [['shared-notes/a.md']],
    [['rust-toolchain.toml.bak']],
    [[]],
  ])('skips the Rust lane for %j', (paths) => {
    expect(detector).not.toBe('');
    expect(lane(paths)).toBe('skip');
  });

  it('keeps the whole crash skip list on a Mac, and nothing broader', () => {
    const mac = /if \[ "\$\(uname\)" = "Darwin" \]; then\n([\s\S]*?)\n\s*else\n/.exec(hook)?.[1];
    const command = (mac ?? '').replace(/\\\n\s*/g, '');
    expect(command).toContain('cargo test --manifest-path src-tauri/Cargo.toml -- ');
    // Each is a substring filter: `--skip kill` would also drop every test
    // with "skill" in its name.
    expect([...command.matchAll(/--skip (\S+)/g)].map((m) => m[1])).toEqual([
      'crash',
      'killed_',
      'kill_and_restart',
      'a_kill_',
      'kill_point',
      'interrupted_overwrite',
    ]);
  });

  it('never drops a Rust test a rule names as its enforcement', () => {
    const mac = /if \[ "\$\(uname\)" = "Darwin" \]; then\n([\s\S]*?)\n\s*else\n/.exec(hook)?.[1];
    const skips = [...(mac ?? '').matchAll(/--skip (\S+)/g)].map((m) => m[1]);
    expect(skips.length).toBeGreaterThan(0);
    const enforced = [...read('AGENTS.md').matchAll(/`src-tauri\/[^`]*\.rs::([^`]+)`/g)].map(
      (m) => m[1],
    );
    expect(enforced.length).toBeGreaterThan(0);
    // A Mac runs every test whose name holds none of the skips; a rule's
    // proof skipped there never runs on the platform the app ships on.
    expect(enforced.filter((name) => skips.some((skip) => name.includes(skip)))).toEqual([]);
  });
});
