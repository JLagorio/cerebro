import { describe, expect, it } from 'vitest';
import { renderMermaid } from '@/mermaid/render';
import { checkMermaidTrips, guardsMermaid } from './mermaidGuard';

describe('the mermaid guard (CV-14)', () => {
  it('guards every test file except *.mermaid.test.ts', () => {
    expect(guardsMermaid('/repo/src/pages/DocPage.test.tsx')).toBe(true);
    expect(guardsMermaid('/repo/src/mermaid/render.test.ts')).toBe(true);
    expect(guardsMermaid('/repo/src/mermaid/svgLinks.mermaid.test.ts')).toBe(false);
    expect(guardsMermaid('/repo/src/mermaid/flowchart/shapes.mermaid.test.ts')).toBe(false);
  });

  it('fails a test that reaches the real renderer, and names the fix', async () => {
    // This file does not mock '@/mermaid/render', so setup's guard is live.
    const result = await renderMermaid('flowchart TD\n  A --> B');
    // render.ts swallows the loader's throw into a value, which is why the
    // guard checks after each test instead of trusting the throw.
    expect(result.ok).toBe(false);
    const testPath = expect.getState().testPath ?? '';
    expect(() => checkMermaidTrips(testPath)).toThrow(
      /reached the real mermaid renderer \(mermaid\)\. Mock '@\/mermaid\/render'/,
    );
    // The check drains what it reported, so setup's afterEach finds nothing
    // and this test passes.
    expect(() => checkMermaidTrips(testPath)).not.toThrow();
  });
});
