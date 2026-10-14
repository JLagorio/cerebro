import { afterEach, vi } from 'vitest';

/**
 * The setup guard behind CV-14 (M53.20): a test file that reaches the real
 * mermaid renderer fails, and the failure names the fix.
 *
 * Lint keeps `import mermaid` to render.ts and *.mermaid.test.ts, but a
 * component test can still reach the renderer through what it renders. So
 * every other test file gets mermaid and its ELK layouts mocked by factories
 * that record the module and throw. The throw alone would pass silently:
 * render.ts turns a loader failure into `{ ok: false }`, which a component
 * shows as a banner nobody asserts on. An afterEach fails the test instead.
 *
 * A file's own `vi.mock('mermaid', …)` registers after setup and wins, which
 * render.test.ts relies on.
 */

const GUARDED = ['mermaid', '@mermaid-js/layout-elk'];

/** Modules the guard refused since the last check, in order. */
const tripped: string[] = [];

/** *.mermaid.test.ts files exist to measure the real renderer; every other
 * test file is guarded. */
export function guardsMermaid(testPath: string): boolean {
  return !testPath.endsWith('.mermaid.test.ts');
}

export function installMermaidGuard(testPath: string): void {
  if (!guardsMermaid(testPath)) return;
  for (const id of GUARDED) {
    vi.doMock(id, () => {
      tripped.push(id);
      throw new Error(`the mermaid guard refused ${id} in ${testPath}`);
    });
  }
  afterEach(() => checkMermaidTrips(testPath));
}

/** Throws if the guard refused anything since the last check, and forgets it. */
export function checkMermaidTrips(testPath: string): void {
  if (tripped.length === 0) return;
  const ids = [...new Set(tripped.splice(0))];
  throw new Error(
    `${testPath} reached the real mermaid renderer (${ids.join(', ')}). Mock '@/mermaid/render' ` +
      'with a fixture svg, as src/mermaid/flowchart/StructuralEditor.test.tsx does, or measure ' +
      'the renderer in a *.mermaid.test.ts file (AGENTS.md CV-14).',
  );
}
