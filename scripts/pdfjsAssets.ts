import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { Plugin } from 'vite';

const FOLDERS = ['cmaps', 'standard_fonts', 'wasm'] as const;
const packageRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

/** Only these shipped support files are served. No URL ever becomes a disk path. */
export async function pdfAssetFiles(root = packageRoot): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const folder of FOLDERS) {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      if (entry.isFile())
        files.set(`/pdfjs/${folder}/${entry.name}`, join(root, folder, entry.name));
    }
  }
  return files;
}

export function pdfAssetPath(url: string, files: ReadonlyMap<string, string>): string | null {
  try {
    const path = decodeURIComponent(url.split('?')[0]);
    if (path.includes('\\') || path.split('/').some((part) => part === '.' || part === '..'))
      return null;
    return files.get(path) ?? null;
  } catch {
    return null;
  }
}

export function pdfjsAssets(): Plugin {
  return {
    name: 'cerebro-pdfjs-assets',
    async configureServer(server) {
      const files = await pdfAssetFiles();
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/pdfjs/')) return next();
        const path = pdfAssetPath(req.url, files);
        if (!path || !['GET', 'HEAD'].includes(req.method ?? '')) {
          res.statusCode = 404;
          res.end();
          return;
        }
        try {
          const bytes = await readFile(path);
          res.setHeader(
            'Content-Type',
            path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
          );
          res.setHeader('Content-Length', bytes.byteLength);
          res.end(req.method === 'HEAD' ? undefined : bytes);
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      for (const [url, path] of await pdfAssetFiles()) {
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: await readFile(path) });
      }
    },
  };
}
