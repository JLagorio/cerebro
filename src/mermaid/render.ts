import { buildThemeVariables, themeSignature } from './theme';

/**
 * The one mermaid entry point (M29.2). Everything that renders a diagram —
 * doc blocks, knowledge concepts, the lightbox — goes through here, so
 * security level, theme, layout engines, and caching are decided exactly once.
 *
 * Errors are values, never throws — the store-layer ethos applied to a
 * renderer. `line` is best-effort: mermaid's parse errors carry
 * "Parse error on line N:" and nothing else structured.
 */
export type RenderResult =
  | { ok: true; svg: string }
  | { ok: false; message: string; line: number | null };

export function extractErrorLine(message: string): number | null {
  const m = message.match(/error on line (\d+)/i);
  return m === null ? null : Number(m[1]);
}

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

async function loadMermaid(): Promise<typeof import('mermaid').default> {
  // Lazy: mermaid is ~1MB and only needed when a diagram is on screen. ELK
  // loaders are registered up front but the elk engine itself is a further
  // lazy chunk mermaid pulls only when a diagram asks for `layout: elk`.
  mermaidPromise ??= (async () => {
    const mermaid = (await import('mermaid')).default;
    const { default: elkLayouts } = await import('@mermaid-js/layout-elk');
    mermaid.registerLayoutLoaders(elkLayouts);
    return mermaid;
  })();
  return mermaidPromise;
}

const CACHE_MAX = 50;
const cache = new Map<string, RenderResult>();
let seq = 0;

export async function renderMermaid(code: string): Promise<RenderResult> {
  const vars = buildThemeVariables();
  const key = `${themeSignature(vars)} ${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let result: RenderResult;
  try {
    const mermaid = await loadMermaid();
    // initialize() before every render: it is a cheap config assign, and the
    // theme may have flipped since the last call. The palette is app-global,
    // so interleaved renders still agree on the variables.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: vars,
    });
    const { svg } = await mermaid.render(`cerebro-mermaid-${++seq}`, code);
    result = { ok: true, svg };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = { ok: false, message, line: extractErrorLine(message) };
  }

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, result);
  return result;
}
