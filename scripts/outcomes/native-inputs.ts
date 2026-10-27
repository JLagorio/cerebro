import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeInputIdentity {
  version: 1;
  aggregateDigest: string;
  fileCount: number;
  totalBytes: number;
}
export interface NativeInputArtifacts {
  paths: string[];
  json: string;
  rust: string;
}
export const NATIVE_INPUT_SCOPE = 'cerebro-native-producer-inputs-v1';
export const NATIVE_INPUT_LIMITS = {
  files: 2048,
  fileBytes: 4 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  pathBytes: 512,
  depth: 16,
  entries: 8192,
  jsonBytes: 512 * 1024,
  rustBytes: 1024 * 1024,
} as const;
const TREE_ROOTS = [
  'src-tauri/src',
  'shared',
  'src-tauri/fixtures',
  'conformance',
  'src-tauri/build_support',
  'src-tauri/capabilities',
];
const FIXED_PATHS = [
  'src-tauri/build.rs',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'src-tauri/native-read-smoke/tauri.conf.json',
  'src-tauri/icons/32x32.png',
  'src-tauri/icons/icon.icns',
  'src-tauri/clippy.toml',
  'src-tauri/Info.plist',
  'rust-toolchain.toml',
  'conformance/outcomes/native.rs',
  'scripts/outcomes/native-inputs.ts',
  'scripts/outcomes/native-capture.ts',
  'scripts/outcomes/retrieval.ts',
  'scripts/native-credential-smoke/run.py',
  'scripts/native-quit-smoke/run.py',
  'scripts/native-quit-smoke/test_run.py',
];
const GENERATED_PATHS = [
  'conformance/outcomes/native-inputs.v1.json',
  'conformance/outcomes/native-inputs.generated.rs',
] as const;
const SECRET_NAMES = new Set(['credentials', 'id_rsa', 'id_ed25519', 'token', 'tokens', 'secrets']);
interface Inventory {
  root: string;
  files: Map<string, number>;
}

function inputPath(path: string): string {
  const parts = path.split('/');
  if (
    Buffer.byteLength(path) > NATIVE_INPUT_LIMITS.pathBytes ||
    parts.length > NATIVE_INPUT_LIMITS.depth ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/.test(part) ||
        SECRET_NAMES.has(part.toLowerCase()) ||
        /\.(pem|key)$/i.test(part),
    )
  )
    throw new Error('Unsupported native input path.');
  return path;
}
function repositoryRoot(path: string): string {
  const root = realpathSync(resolve(path));
  if (!lstatSync(root).isDirectory()) throw new Error('Native inventory root is unavailable.');
  return root;
}
/** No input root, path or file list comes from the capture being imported. */
function inventory(repository: string): Inventory {
  const root = repositoryRoot(repository);
  const files = new Map<string, number>();
  let visited = 0;
  let bytes = 0;
  function add(path: string, size: number) {
    inputPath(path);
    if (size > NATIVE_INPUT_LIMITS.fileBytes)
      throw new Error('Native input file size cap exceeded.');
    if (!files.has(path)) {
      files.set(path, size);
      bytes += size;
    }
    if (files.size > NATIVE_INPUT_LIMITS.files)
      throw new Error('Native input file count cap exceeded.');
    if (bytes > NATIVE_INPUT_LIMITS.totalBytes)
      throw new Error('Native input total bytes cap exceeded.');
  }
  function walk(path: string) {
    inputPath(path);
    if (++visited > NATIVE_INPUT_LIMITS.entries)
      throw new Error('Native input entry cap exceeded.');
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error('Native input symlinks are not permitted.');
    if (stat.isFile()) {
      add(path, stat.size);
      return;
    }
    if (!stat.isDirectory()) throw new Error('Native inputs must be regular files or directories.');
    const directory = opendirSync(join(root, path), { bufferSize: 32 });
    try {
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        // Finder's regular metadata file is not a compile input. Unknown
        // hidden files, directories and symlinks still refuse below.
        if (entry.name === '.DS_Store' && entry.isFile()) {
          if (++visited > NATIVE_INPUT_LIMITS.entries)
            throw new Error('Native input entry cap exceeded.');
          continue;
        }
        walk(`${path}/${entry.name}`);
      }
    } finally {
      directory.closeSync();
    }
  }
  for (const path of TREE_ROOTS) {
    checkParents(root, path);
    let stat;
    try {
      stat = lstatSync(join(root, path));
    } catch {
      throw new Error('Missing native input inventory root.');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Native input inventory root must be a regular directory.');
    walk(path);
  }
  for (const path of FIXED_PATHS) {
    checkParents(root, path);
    const stat = lstatSync(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Native input must be a regular file.');
    add(path, stat.size);
  }
  return { root, files };
}
function checkParents(root: string, path: string) {
  const parts = inputPath(path).split('/');
  let prefix = root;
  for (const part of parts.slice(0, -1)) {
    prefix = join(prefix, part);
    const stat = lstatSync(prefix);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Native input parent must be a regular directory.');
  }
  const parent = realpathSync(dirname(join(root, path)));
  const rel = relative(root, parent);
  if (rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('Native input path escapes repository root.');
}
function fileDescriptor(root: string, path: string, limit: number): number {
  checkParents(root, path);
  const fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Native input must be a regular file.');
    if (stat.size > limit) throw new Error('Native input file size cap exceeded.');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function readHash(root: string, path: string): { sha256: string; size: number } {
  const fd = fileDescriptor(root, path, NATIVE_INPUT_LIMITS.fileBytes);
  try {
    const before = fstatSync(fd);
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      size += count;
      if (size > NATIVE_INPUT_LIMITS.fileBytes)
        throw new Error('Native input file size cap exceeded.');
      digest.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size)
      throw new Error('Native input changed while being read.');
    return { sha256: digest.digest('hex'), size };
  } finally {
    closeSync(fd);
  }
}
function readArtifact(root: string, path: string, limit: number): string {
  const fd = fileDescriptor(root, path, limit);
  try {
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new Error('Native generated inventory size cap exceeded.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}
function rendered(current: Inventory): NativeInputArtifacts {
  // Insert both output paths even on bootstrap. The artifacts contain paths and
  // include expressions only, never their own hashes; no digest cycle exists.
  const paths = [...new Set([...current.files.keys(), ...GENERATED_PATHS])].sort();
  if (paths.length > NATIVE_INPUT_LIMITS.files)
    throw new Error('Native input file count cap exceeded.');
  const json = `${JSON.stringify({ version: 1, scope: NATIVE_INPUT_SCOPE, paths }, null, 2)}\n`;
  const entries = paths.map(
    (path) => `    (${JSON.stringify(path)}, include_bytes!(${JSON.stringify(`../../${path}`)})),`,
  );
  const rust = [
    '// @generated by scripts/outcomes/native-inputs.ts --write; do not edit or format.',
    '// Paths and bytes are captured at native test-binary compilation time.',
    'const NATIVE_PRODUCER_INPUTS: &[(&str, &[u8])] = &[',
    ...entries,
    '];',
    '',
  ].join('\n');
  const sizes = [Buffer.byteLength(json), Buffer.byteLength(rust)];
  if (sizes[0] > NATIVE_INPUT_LIMITS.jsonBytes || sizes[1] > NATIVE_INPUT_LIMITS.rustBytes)
    throw new Error('Generated native inventory artifact size cap exceeded.');
  let total = [...current.files].reduce(
    (sum, [path, size]) =>
      GENERATED_PATHS.some((generated) => generated === path) ? sum : sum + size,
    0,
  );
  total += sizes[0] + sizes[1];
  if (total > NATIVE_INPUT_LIMITS.totalBytes)
    throw new Error('Native input total bytes cap exceeded.');
  return { paths, json, rust };
}
export function nativeInputArtifacts(repository: string): NativeInputArtifacts {
  return rendered(inventory(repository));
}
function requireParity(root: string, artifacts: NativeInputArtifacts) {
  for (const [index, path] of GENERATED_PATHS.entries()) {
    const expected = index === 0 ? artifacts.json : artifacts.rust;
    const limit = index === 0 ? NATIVE_INPUT_LIMITS.jsonBytes : NATIVE_INPUT_LIMITS.rustBytes;
    let actual: string;
    try {
      actual = readArtifact(root, path, limit);
    } catch {
      throw new Error('Missing or unavailable generated native input inventory.');
    }
    if (actual !== expected) throw new Error('Native input inventory generation parity mismatch.');
  }
}
export function nativeInputIdentity(repository: string): NativeInputIdentity {
  const current = inventory(repository);
  const artifacts = rendered(current);
  requireParity(current.root, artifacts);
  const digest = createHash('sha256').update(`${NATIVE_INPUT_SCOPE}\n`);
  let totalBytes = 0;
  for (const path of artifacts.paths) {
    const input = readHash(current.root, path);
    totalBytes += input.size;
    if (totalBytes > NATIVE_INPUT_LIMITS.totalBytes)
      throw new Error('Native input total bytes cap exceeded.');
    digest.update(`${path}\0${input.size}\0${input.sha256}\n`);
  }
  const after = rendered(inventory(current.root));
  if (JSON.stringify(after.paths) !== JSON.stringify(artifacts.paths))
    throw new Error('Native input inventory paths changed during capture.');
  requireParity(current.root, after);
  return {
    version: 1,
    aggregateDigest: digest.digest('hex'),
    fileCount: artifacts.paths.length,
    totalBytes,
  };
}
/** Explicit reversible regeneration. All source and projected-output budgets are
 * checked before either committed artifact is replaced. No outside tree is read.
 */
export function generateNativeInputs(repository: string): void {
  const current = inventory(repository);
  const artifacts = rendered(current);
  let actualBytes = 0;
  for (const path of current.files.keys()) {
    if (GENERATED_PATHS.some((generated) => generated === path)) continue;
    actualBytes += readHash(current.root, path).size;
    if (actualBytes > NATIVE_INPUT_LIMITS.totalBytes)
      throw new Error('Native input total bytes cap exceeded.');
  }
  if (
    actualBytes + Buffer.byteLength(artifacts.json) + Buffer.byteLength(artifacts.rust) >
    NATIVE_INPUT_LIMITS.totalBytes
  )
    throw new Error('Native input total bytes cap exceeded.');
  const pending: { target: string; temporary: string }[] = [];
  try {
    for (const [index, path] of GENERATED_PATHS.entries()) {
      checkParents(current.root, path);
      const target = join(current.root, path);
      const temporary = `${target}.tmp-${process.pid}`;
      writeFileSync(temporary, index === 0 ? artifacts.json : artifacts.rust, {
        flag: 'wx',
        mode: 0o600,
      });
      pending.push({ target, temporary });
    }
    for (const row of pending) renameSync(row.temporary, row.target);
  } finally {
    for (const row of pending) {
      try {
        unlinkSync(row.temporary);
      } catch {
        /* Already renamed or never created. */
      }
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2] ?? '--check';
    if (process.argv.length > 3 || !['--write', '--check'].includes(mode))
      throw new Error('Invalid inventory command.');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    if (mode === '--write') generateNativeInputs(root);
    else nativeInputIdentity(root);
  } catch {
    process.stderr.write(
      'Native producer inventory is unavailable, stale, or exceeds its bounds.\n',
    );
    process.exitCode = 2;
  }
}
