// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The motion layer (M46.2 Task 3).
 *
 * The baseline's fourth-ranked finding was that every `transition` on every
 * surface computed to `all` — the CSS initial value, meaning none declared —
 * while Notion declares 20ms on a hover wash and 200ms on anything that moves.
 * These cases hold the two numbers, the one lever that collapses movement for
 * a reader who asked for that, and the shape of the utilities that spend them.
 *
 * The SHIPPED files, read from disk — TableCellChrome.test.tsx's rule: a test
 * that pastes in the CSS it is checking proves only that the paste agrees with
 * itself, and deleting a declaration has to fail here.
 */
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const TOKENS = read('src/styles/tokens/spacing.css');
const UTILITIES = read('src/styles/motion.css');
const APP_CSS = read('src/styles/index.css');

/** The `transition-property` list a given `@utility` block declares. */
const propsOf = (name: string): string => {
  const block = UTILITIES.slice(UTILITIES.indexOf(`@utility ${name}`));
  return block.match(/transition-property:([^;]+);/)?.[1] ?? '';
};

describe('the motion tokens', () => {
  it('carries the two measured timings, and says which is which', () => {
    // 20ms is not a fade, it is an anti-flicker guard; rounding it up to
    // something visible is the one way to get this specific number wrong.
    expect(TOKENS).toMatch(/--dur-hover:\s*20ms/);
    expect(TOKENS).toMatch(/--dur-move:\s*200ms/);
    expect(TOKENS).toMatch(/--ease-hover:\s*ease-in/);
  });

  it('offers each timing as a whole duration+easing pair', () => {
    // So a call site writes `transition: background var(--motion-hover)` and
    // never has to name a number to get the easing right too.
    expect(TOKENS).toMatch(/--motion-hover:\s*var\(--dur-hover\)\s+var\(--ease-hover\)/);
    expect(TOKENS).toMatch(/--motion-move:\s*var\(--dur-move\)\s+var\(--ease-move\)/);
  });
});

describe('prefers-reduced-motion', () => {
  const QUERY = '@media (prefers-reduced-motion: reduce)';
  const block = TOKENS.slice(TOKENS.indexOf(QUERY));

  it('collapses MOVEMENT to nothing', () => {
    // Asserted first and separately: every case below reads `block`, and a
    // missing query would make `slice(-1)` a one-character string that a
    // `not.toContain` passes vacuously.
    expect(block.startsWith(QUERY)).toBe(true);
    expect(block).toMatch(/--dur-move:\s*0s/);
  });

  it('leaves the hover guard alone, deliberately', () => {
    // The blanket `* { transition-duration: 0.01ms !important }` idiom would
    // take 20ms with it and restore the strobing it exists to stop. A 20ms
    // background swap is not motion under any reading of the preference.
    expect(block.startsWith(QUERY)).toBe(true);
    expect(block).not.toContain('--dur-hover');
  });

  it('covers the two entrances that animate rather than transition', () => {
    // `--dur-move` cannot reach a @keyframes animation, so the panel and menu
    // entrances have to be named — which is the argument for spending the
    // token wherever a transition can do the job instead.
    const app = APP_CSS.slice(APP_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(app).toContain('.cb-panel-in');
    expect(app).toContain('.cb-menu-in');
    expect(app).toMatch(/animation:\s*none/);
  });
});

describe('the motion utilities', () => {
  it('spend the tokens rather than literals', () => {
    expect(UTILITIES).toMatch(/@utility motion-hover/);
    expect(UTILITIES).toMatch(/@utility motion-move/);
    expect(UTILITIES).toContain('var(--dur-hover)');
    expect(UTILITIES).toContain('var(--dur-move)');
    // No duration is spelled here — the tokens are the only place a number
    // lives, so reduced motion has one lever and not three.
    for (const m of UTILITIES.matchAll(/transition-duration:([^;]+);/g)) {
      expect(m[1]).not.toMatch(/\d/);
    }
  });

  it('name their properties — `transition: all` is the defect, not the fix', () => {
    // `all` animates properties nobody chose, and on a drag surface it will
    // animate the very transform that has to track the pointer 1:1.
    for (const m of UTILITIES.matchAll(/transition-property:([^;]+);/g)) {
      expect(m[1]).not.toContain('all');
    }
  });

  it('keeps hover off the properties that MOVE, and movement off the wash', () => {
    // One element that both slides and washes needs two timings, which one
    // utility cannot say — so the split is what lets a call site pick.
    expect(propsOf('motion-hover')).toContain('background-color');
    expect(propsOf('motion-hover')).not.toContain('transform');
    expect(propsOf('motion-hover')).not.toContain('opacity');

    expect(propsOf('motion-move')).toContain('transform');
    expect(propsOf('motion-move')).toContain('opacity');
    expect(propsOf('motion-move')).not.toContain('background-color');
  });
});

describe('the DS primitives that already declared a hover transition', () => {
  /** The rule text each primitive injects at import — the shipped bytes. */
  const injected = async (id: string, load: () => Promise<unknown>) => {
    await load();
    return document.getElementById(id)?.textContent ?? '';
  };

  it('Button spends the hover pair, not the old 120ms', async () => {
    const css = await injected('cb-btn-css', () => import('@/components/ui/Button'));
    expect(css).toContain('transition:background var(--motion-hover)');
    expect(css).not.toContain('transition:background var(--dur-fast)');
  });

  it('IconButton spends the hover pair', async () => {
    const css = await injected('cb-ibtn-css', () => import('@/components/ui/IconButton'));
    expect(css).toContain('var(--motion-hover)');
    expect(css).not.toContain('transition:background var(--dur-fast)');
  });

  it('SegmentedControl spends the hover pair', async () => {
    const css = await injected('cb-seg-css', () => import('@/components/ui/SegmentedControl'));
    expect(css).toContain('var(--motion-hover)');
    expect(css).not.toContain('transition:background var(--dur-fast)');
  });
});
