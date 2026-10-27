// Root-only local asset build. No server; refuses external module inputs.
import { build } from 'vite';
import {
  QUIT_ENTRY_FILE,
  QUIT_ENTRY_EXPORT,
  QUIT_ENTRY_SIGNATURES,
  assertQuitEntryChunk,
  assertQuitEntryAst,
  assertQuitAsset,
} from './quit-build-contract.mjs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const repo = await realpath(resolve(here, '../..'));
const out = resolve(here, 'web');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bundleLimits = JSON.parse(await readFile(resolve(here, 'bundle-limits.v1.json'), 'utf8'));
if (bundleLimits.version !== 1 || Object.keys(bundleLimits).sort().join(',') !== 'inputFiles,manifestBytes,version' || ![bundleLimits.inputFiles, bundleLimits.manifestBytes].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid bundle limits');
const files = new Map();
const virtual = [];
async function pin(name) {
  const canonical = await realpath(name);
  const rel = relative(repo, canonical).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || isAbsolute(rel) || /[\r\n\0]/.test(rel))
    throw new Error('Nonlocal build input');
  const stat = await lstat(canonical);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Build input cap/type');
  const bytes = await readFile(canonical);
  const row = { path: rel, bytes: bytes.length, sha256: sha(bytes) };
  if (files.has(rel) && JSON.stringify(files.get(rel)) !== JSON.stringify(row))
    throw new Error('Build input changed while bundling');
  files.set(rel, row);
}
// CSS URL assets bypass Rollup's module load hooks. Pin the closed local font
// directory before generation and again at the emitted-byte comparison boundary.
let initialFontNames;
async function pinFonts() {
  const names = (await readdir(resolve(repo, 'src/assets/fonts'))).filter((name) => name.endsWith('.ttf')).sort();
  if (names.length > 32) throw new Error('Local font input cap');
  if (initialFontNames !== undefined && JSON.stringify(names) !== JSON.stringify(initialFontNames))
    throw new Error('Local font input set changed while bundling');
  initialFontNames ??= names;
  for (const name of names) await pin(resolve(repo, 'src/assets/fonts', name));
}
await build({
  configFile: false,
  root: repo,
  publicDir: false,
  base: './',
  resolve: { alias: { '@': resolve(repo, 'src') } },
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: out,
    emptyOutDir: false,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      preserveEntrySignatures: QUIT_ENTRY_SIGNATURES,
      input: resolve(here, 'quit.tsx'),
      output: {
        entryFileNames: 'quit.js',
        chunkFileNames: 'quit-[hash].js',
        assetFileNames: 'quit-[hash][extname]',
      },
    },
  },
  plugins: [
    {
      name: 'pin-quit-inputs',
      enforce: 'pre',
      async buildStart() {
        await pinFonts();
        for (const name of [
          'package.json',
          'pnpm-lock.yaml',
          'conformance/native-read-smoke/build.mjs',
          'conformance/native-read-smoke/bundle-limits.v1.json',
          'conformance/native-read-smoke/quit-build-contract.mjs',
        ])
          await pin(resolve(repo, name));
      },
      async load(id) {
        if (!id.startsWith('\0') && isAbsolute(id.split('?')[0])) await pin(id.split('?')[0]);
        return null;
      },
      generateBundle: {
        order: 'post',
        async handler(_, bundle) {
          const entry = bundle[QUIT_ENTRY_FILE];
          assertQuitEntryChunk(entry, resolve(here, 'quit.tsx'));
          // Check the generated code as well as Rollup's export metadata. This parser is
          // the existing Rollup plugin parser; no new dependency or browser execution.
          assertQuitEntryAst(this.parse(entry.code));
          const entryContract = {
            fileName: QUIT_ENTRY_FILE,
            requiredExport: QUIT_ENTRY_EXPORT,
            entrySignatures: QUIT_ENTRY_SIGNATURES,
            exports: entry.exports,
            generatedSha256: sha(Buffer.from(entry.code)),
          };
          for (const id of this.getModuleIds()) {
            const info = this.getModuleInfo(id);
            if (info?.isExternal) throw new Error('External build module refused: ' + id);
            if (id.startsWith('\0')) {
              // Rollup/Vite internal modules have no source file; pin the exact transformed
              // code and identity as well as all their concrete local input files.
              if (!id.includes('commonjs') && !id.includes('vite'))
                throw new Error('Unknown virtual module');
              virtual.push({ id, transformedSha256: sha(info?.code ?? '') });
            } else {
              if (!isAbsolute(id.split('?')[0])) throw new Error('Unresolved/nonlocal input');
              await pin(id.split('?')[0]);
            }
          }
          for (const name of [
            'package.json',
            'pnpm-lock.yaml',
            'conformance/native-read-smoke/build.mjs',
            'conformance/native-read-smoke/bundle-limits.v1.json',
            'conformance/native-read-smoke/quit-build-contract.mjs',
          ])
            await pin(resolve(repo, name));
          await pinFonts();
          const assets = Object.entries(bundle).map(([name, entry]) => {
            const bytes = Buffer.from(entry.type === 'chunk' ? entry.code : entry.source);
            let kind;
            try {
              kind = assertQuitAsset(name, entry.type, bytes.length);
            } catch (error) {
              throw new Error(`Refused generated asset ${name} (${entry.type}, ${bytes.length} bytes)`, { cause: error });
            }
            const sha256 = sha(bytes);
            const source =
              kind === 'wasm' || kind === 'font'
                ? [...files.values()].find(
                    (input) =>
                      (kind === 'wasm' ? input.path.endsWith('.wasm') : input.path.startsWith('src/assets/fonts/') && input.path.endsWith('.ttf')) &&
                      input.bytes === bytes.length &&
                      input.sha256 === sha256,
                  )
                : null;
            if ((kind === 'wasm' || kind === 'font') && !source)
              throw new Error('Binary asset is not a pinned local input');
            return {
              path: 'conformance/native-read-smoke/web/' + name,
              bytes: bytes.length,
              sha256,
              ...(source ? { sourcePath: source.path } : {}),
            };
          });
          if (files.size > bundleLimits.inputFiles || assets.length > 64 || virtual.length > 512)
            throw new Error(`Build closure cap: inputs=${files.size}, assets=${assets.length}, virtual=${virtual.length}`);
          const manifest = {
            format: 1,
            entry: 'conformance/native-read-smoke/quit.tsx',
            entryContract,
            inputs: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
            virtual: virtual.sort((a, b) => a.id.localeCompare(b.id)),
            assets,
          };
          const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
          if (bytes.length > bundleLimits.manifestBytes) throw new Error('Build manifest cap');
          // Emitting via Rollup makes this the same build's artifact, not a predicted hash.
          this.emitFile({ type: 'asset', fileName: 'quit-build.json', source: bytes });
        },
      },
      async writeBundle(_, bundle) {
        const entry = bundle[QUIT_ENTRY_FILE];
        assertQuitEntryChunk(entry, resolve(here, 'quit.tsx'));
        const written = await readFile(resolve(out, QUIT_ENTRY_FILE));
        assertQuitEntryAst(this.parse(written.toString('utf8')));
        const manifest = JSON.parse(await readFile(resolve(out, 'quit-build.json'), 'utf8'));
        if (
          sha(written) !== sha(Buffer.from(entry.code)) ||
          manifest.entryContract?.generatedSha256 !== sha(written)
        ) {
          throw new Error('Written quit entry differs from validated generated bytes');
        }
      },
    },
  ],
});
