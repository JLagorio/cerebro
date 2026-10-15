// @vitest-environment node
import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { pdfAssetFiles, pdfAssetPath, pdfjsAssets } from './pdfjsAssets';
it('serves exactly the shipped support folders and refuses URL traversal', async () => {
  const files = await pdfAssetFiles();
  expect(files.size).toBeGreaterThan(100);
  for (const path of files.keys())
    expect(path).toMatch(/^\/pdfjs\/(cmaps|standard_fonts|wasm)\/[^/]+$/);
  const first = [...files.keys()][0];
  expect(pdfAssetPath(`${first}?v=1`, files)).toBe(files.get(first));
  for (const url of [
    '/pdfjs/../package.json',
    '/pdfjs/cmaps/%2e%2e/package.json',
    '/pdfjs/cmaps/%2fetc/passwd',
    '/pdfjs/cmaps/%',
    '/pdfjs/build/pdf.mjs',
  ])
    expect(pdfAssetPath(url, files)).toBeNull();
});
it('emits the same paths and bytes it serves', async () => {
  const files = await pdfAssetFiles();
  const emitted = new Map<string, Uint8Array>();
  const hook = pdfjsAssets().generateBundle;
  const run = typeof hook === 'function' ? hook : hook!.handler;
  await Reflect.apply(
    run,
    {
      emitFile: (asset: { fileName: string; source: Uint8Array }) =>
        emitted.set(asset.fileName, asset.source),
    },
    [],
  );
  expect([...emitted.keys()].sort()).toEqual([...files.keys()].map((key) => key.slice(1)).sort());
  const first = [...files.entries()][0];
  expect(emitted.get(first[0].slice(1))).toEqual(await readFile(first[1]));
});
