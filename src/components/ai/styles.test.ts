// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The AI elements' styles (M91.7), read from the shipped files — a test that
 * pasted the CSS it checks would prove only that the paste agrees with
 * itself. Motion spends the tokens, so reduced motion stills it with
 * everything else (styles/tokens/spacing.css), and the running light is
 * named where index.css stills the working light.
 */

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const APP = read('../../styles/index.css');
const SHEETS = ['foundation.css', 'trace.css', 'code-block.css'].map(
  (name) => [name, read(name)] as const,
);

/** The block a rule or at-rule opens at `start`, braces balanced. */
function blockAt(css: string, start: number): string {
  let depth = 0;
  for (let at = css.indexOf('{', start); at < css.length; at++) {
    if (css[at] === '{') depth++;
    if (css[at] === '}' && --depth === 0) return css.slice(start, at + 1);
  }
  throw new Error(`unbalanced block at ${start}`);
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.search(new RegExp(`(^|\\n)${selector.replace(/[.[\]()']/g, '\\$&')} \\{`));
  expect(start, selector).toBeGreaterThan(-1);
  return blockAt(css, start);
}

/** A duration written as a number rather than spent from a token. */
const LITERAL_DURATION = /(?<![\w-])\d*\.?\d+m?s\b/;

describe('the running light (cb-ai-shimmer)', () => {
  it('moves only the band, never a transform', () => {
    const keyframes = blockAt(APP, APP.indexOf('@keyframes cb-ai-shimmer '));
    expect(keyframes).toContain('background-position');
    expect(keyframes).not.toMatch(/\btransform:/);
  });

  it('times its period from the movement token, so reduced motion stills it too', () => {
    const animation = rule(APP, '.cb-ai-shimmer').match(/animation:([^;]+);/)?.[1] ?? '';
    expect(animation).toContain('cb-ai-shimmer');
    expect(animation).toContain('var(--dur-move)');
    expect(animation).not.toMatch(LITERAL_DURATION);
  });

  it('is stilled where index.css stills the working light, keeping its ink', () => {
    const query = '@media (prefers-reduced-motion: reduce)';
    const still = blockAt(APP, APP.indexOf(query, APP.indexOf('.cb-ai-shimmer {')));
    expect(still).toMatch(/\.cb-working-text,\s*\.cb-ai-shimmer \{\s*animation: none;/);
    expect(still).toMatch(
      /\n {2}\.cb-ai-shimmer \{\s*background-image: none;\s*-webkit-text-fill-color: currentColor;\s*\}/,
    );
  });

  it('brightens its band on the dark theme, from the DS ink', () => {
    expect(rule(APP, ":root[data-theme='dark'] .cb-ai-shimmer")).toContain('var(--n-900)');
  });
});

describe.each(SHEETS)('%s', (_, css) => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('spends motion tokens, never a duration of its own', () => {
    const motion = [...code.matchAll(/(?:transition|animation)[\w-]*:([^;]+);/g)].map((m) => m[1]);
    expect(motion.length).toBeGreaterThan(0);
    for (const value of motion) {
      expect(value).toMatch(/var\(--(?:motion|dur)-/);
      expect(value).not.toMatch(LITERAL_DURATION);
      expect(value).not.toMatch(/\ball\b/);
    }
  });

  it('paints with DS tokens only', () => {
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
  });
});
