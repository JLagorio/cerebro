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
  { ok: true; svg: string } | { ok: false; message: string; line: number | null };

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
  try {
    return await mermaidPromise;
  } catch (err) {
    // A chunk-load failure is transient (network blip, dropped CDN
    // connection); the memoized promise is a rejected one at this point, so
    // clear it or every future render would inherit this one failure
    // forever. The next call gets a fresh dynamic import to retry.
    mermaidPromise = null;
    throw err;
  }
}

const CACHE_MAX = 50;
const cache = new Map<string, RenderResult>();
const inflight = new Map<string, Promise<RenderResult>>();
let seq = 0;

// Serializes initialize()+render() pairs: mermaid mutates shared global
// state during a render and has historically not been safe to call
// reentrantly, so a doc with several fences must render them one at a time
// even though renderMermaid() itself may be invoked concurrently for them.
let renderChain: Promise<unknown> = Promise.resolve();

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = renderChain.then(fn, fn);
  // Swallow so one failed render doesn't poison the chain for the next.
  renderChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function renderUncached(
  code: string,
  vars: Record<string, string>,
): Promise<{ result: RenderResult; cacheable: boolean }> {
  let mermaid: typeof import('mermaid').default;
  try {
    mermaid = await loadMermaid();
  } catch (err) {
    // The failure came from the loader, not from mermaid parsing/rendering
    // the diagram — it says nothing about whether this code is valid, so it
    // must not be cached under the diagram's key.
    const message = err instanceof Error ? err.message : String(err);
    return { result: { ok: false, message, line: extractErrorLine(message) }, cacheable: false };
  }

  const result = await runSerialized(async (): Promise<RenderResult> => {
    try {
      // initialize() before every render: it is a cheap config assign, and
      // the theme may have flipped since the last call. The palette is
      // app-global, so interleaved renders still agree on the variables.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: vars,
      });
      const { svg } = await mermaid.render(`cerebro-mermaid-${++seq}`, code);
      return { ok: true, svg };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message, line: extractErrorLine(message) };
    }
  });
  return { result, cacheable: true };
}

export async function renderMermaid(code: string): Promise<RenderResult> {
  const vars = buildThemeVariables();
  const key = `${themeSignature(vars)} ${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  // Dedup in-flight calls: concurrent callers asking for the same code under
  // the same theme await one render instead of racing mermaid.
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;

  const promise = (async () => {
    const { result, cacheable } = await renderUncached(code, vars);
    if (cacheable) {
      if (cache.size >= CACHE_MAX) {
        // FIFO, not LRU: Map iteration order is insertion order, so this
        // evicts the oldest entry. Simpler than tracking access recency and
        // plenty for a diagram cache this size.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, result);
    }
    return result;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}
