import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
interface Pins {
  cargo: string;
  lock: string;
  npm: string;
  pnpm: string;
}
const read = (): Pins => ({
  cargo: readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8'),
  lock: readFileSync(resolve(root, 'src-tauri/Cargo.lock'), 'utf8'),
  npm: readFileSync(resolve(root, 'package.json'), 'utf8'),
  pnpm: readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8'),
});

function pinProblems(files: Pins): string[] {
  const problems: string[] = [];
  const npm = JSON.parse(files.npm) as { devDependencies: Record<string, string> };
  const version = npm.devDependencies['@ironcalc/wasm'];
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push('npm must pin an exact registry version');
  for (const section of ['dependencies', 'dev-dependencies']) {
    const text = files.cargo.split(`[${section}]`)[1]?.split(/\n\[/, 1)[0] ?? '';
    const entry = text.match(/^ironcalc_base\s*=\s*(.+)$/m)?.[1] ?? '';
    const pin = entry.startsWith('"')
      ? entry.match(/^"([^"]+)"$/)?.[1]
      : entry.match(/version\s*=\s*"([^"]+)"/)?.[1];
    if (pin !== `=${version}` || /\b(?:git|path)\s*=/.test(entry))
      problems.push(`${section} must use the same exact registry version`);
    if (section === 'dev-dependencies' && !entry.includes('"mock_time"'))
      problems.push('tests need the upstream mock clock');
  }
  const xlsxEntry = files.cargo
    .split('[dependencies]')[1]
    ?.split(/\n\[/, 1)[0]
    ?.match(/^ironcalc\s*=\s*(.+)$/m)?.[1];
  if (xlsxEntry !== `"=${version}"`) problems.push('XLSX must pin the same exact registry release');
  const xlsxLocks = files.lock
    .split('[[package]]')
    .filter((row) => /^name = "ironcalc"$/m.test(row));
  if (
    xlsxLocks.length !== 1 ||
    !xlsxLocks[0].includes(`version = "${version}"`) ||
    !xlsxLocks[0].includes('source = "registry+https://github.com/rust-lang/crates.io-index"')
  )
    problems.push('XLSX lock must have one matching crates.io release');
  const locked =
    files.lock.split('[[package]]').find((row) => /^name = "ironcalc_base"$/m.test(row)) ?? '';
  if (
    !locked.includes(`version = "${version}"`) ||
    !locked.includes('source = "registry+https://github.com/rust-lang/crates.io-index"') ||
    !/^checksum = "[a-f0-9]{64}"$/m.test(locked)
  )
    problems.push('Cargo.lock must pin the matching crates.io release');
  const pnpm = parse(files.pnpm) as {
    importers: Record<
      string,
      { devDependencies: Record<string, { specifier: string; version: string }> }
    >;
    packages: Record<string, { resolution: { integrity?: string; tarball?: string } }>;
  };
  const spec = pnpm.importers['.'].devDependencies['@ironcalc/wasm'];
  const resolution = pnpm.packages[`@ironcalc/wasm@${version}`]?.resolution;
  if (
    spec?.specifier !== version ||
    spec.version.split('(')[0] !== version ||
    !resolution?.integrity?.startsWith('sha512-') ||
    resolution.tarball
  )
    problems.push('pnpm lock must pin the matching registry integrity');
  return problems;
}

describe('the upstream spreadsheet engine pins', () => {
  it('both engines pin one release', () => expect(pinProblems(read())).toEqual([]));
  it('rejects carets, git sources, mismatched locks and a mismatched dev entry', () => {
    const pins = read();
    const changes: Partial<Pins>[] = [
      { cargo: pins.cargo.replace('ironcalc = "=0.8.3"', 'ironcalc = "^0.8.3"') },
      { npm: pins.npm.replace('"@ironcalc/wasm": "0.8.3"', '"@ironcalc/wasm": "^0.8.3"') },
      {
        cargo: pins.cargo.replace(
          'ironcalc_base = "=0.8.3"',
          'ironcalc_base = { version = "=0.8.3", git = "https://example.invalid/engine" }',
        ),
      },
      { lock: pins.lock.replace(/(name = "ironcalc_base"\nversion = ")[^"]+/, '$10.0.0') },
      {
        cargo: pins.cargo.replace(
          'version = "=0.8.3", features = ["mock_time"]',
          'version = "=0.8.4", features = ["mock_time"]',
        ),
      },
      { pnpm: pins.pnpm.replace('specifier: 0.8.3', 'specifier: 0.8.4') },
    ];
    for (const change of changes)
      expect(pinProblems({ ...pins, ...change }), JSON.stringify(change)).not.toEqual([]);
  });
  it('the packaging repair adds only upstream timezone glue and its files-list entry', () => {
    const patch = readFileSync(resolve(root, 'patches/@ironcalc__wasm@0.8.3.patch'), 'utf8');
    const files = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((match) => match[1]);
    expect(files).toEqual(['package.json', 'snippets/ironcalc_base-aa721fe913c88060/inline0.js']);
    expect(patch).toContain('export function ic_tz_validate');
    expect(patch).toContain('export function ic_tz_parts');
    expect(patch).toContain('export function ic_tz_all');
    expect(
      parse(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')).patchedDependencies[
        '@ironcalc/wasm@0.8.3'
      ],
    ).toBe('patches/@ironcalc__wasm@0.8.3.patch');
  });
  it('Dependabot never moves either engine by itself', () => {
    const config = parse(readFileSync(resolve(root, '.github/dependabot.yml'), 'utf8')) as {
      updates: { 'package-ecosystem': string; ignore?: { 'dependency-name': string }[] }[];
    };
    const ignored = (ecosystem: string) =>
      config.updates
        .find((row) => row['package-ecosystem'] === ecosystem)
        ?.ignore?.map((row) => row['dependency-name']);
    expect(ignored('npm')).toContain('@ironcalc/wasm');
    expect(ignored('cargo')).toEqual(expect.arrayContaining(['ironcalc', 'ironcalc_base']));
  });
  it('the cached-value facade pins the same engine and its generated artifact has exact source provenance', () => {
    const provenance = JSON.parse(
      readFileSync(resolve(root, 'src/lib/sheetValues/provenance.json'), 'utf8'),
    ) as {
      engine: string;
      carrier: string;
      compiler: string;
      target: string;
      files: Record<string, string>;
    };
    const npm = JSON.parse(read().npm) as { devDependencies: Record<string, string> };
    const version = npm.devDependencies['@ironcalc/wasm'];
    expect(provenance.engine).toBe(`ironcalc_base@${version}`);
    expect(provenance.compiler).toMatch(/^rustc 1\.95\.0 /);
    expect(provenance.target).toBe('wasm32-unknown-unknown');
    const cargo = readFileSync(resolve(root, 'scripts/sheet-values/Cargo.toml'), 'utf8');
    expect(cargo).toContain(`ironcalc_base = "=${version}"`);
    const lock = readFileSync(resolve(root, 'scripts/sheet-values/Cargo.lock'), 'utf8');
    const pinned = lock.split('[[package]]').find((row) => /^name = "ironcalc_base"$/m.test(row))!;
    expect(pinned).toContain(`version = "${version}"`);
    expect(pinned).toContain('registry+https://github.com/rust-lang/crates.io-index');
    expect(Object.keys(provenance.files)).toEqual([
      'scripts/sheet-values/Cargo.toml',
      'scripts/sheet-values/Cargo.lock',
      'scripts/sheet-values/src/lib.rs',
      'src/lib/sheetValues/values.wasm',
    ]);
    for (const [path, hash] of Object.entries(provenance.files))
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest('hex'),
        path,
      ).toBe(hash);
  });
});
