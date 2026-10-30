import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildTokens, colorValue, readVars, type TokenNotes } from './tokens';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

const NO_NOTES: TokenNotes = {
  color: {},
  spacing: {},
  radius: {},
  shadow: {},
  size: {},
  fontWeight: {},
  letterSpacing: {},
  type: { fonts: [], groups: [] },
};

describe('design-system tokens (M100.1)', () => {
  it('reads the first block a selector opens, skipping comments and nested blocks', () => {
    const vars = readVars(
      `:root { /* --gone: 1px; */ --a: #FFF; --b: var(--a); }
       @media (x) { :root { --a: 0s; } }`,
      ':root {',
    );
    expect([...vars]).toEqual([
      ['a', '#FFF'],
      ['b', 'var(--a)'],
    ]);
  });

  it('turns a var() colour into an alias and lowercases hex', () => {
    expect(colorValue('var(--n-0)')).toBe('{n-0}');
    expect(colorValue('#2E48C2')).toBe('#2e48c2');
    expect(colorValue('rgba(22, 26, 36, 0.4)')).toBe('rgba(22, 26, 36, 0.4)');
  });

  it('names every token with no note and every note with no token', () => {
    const { problems } = buildTokens(
      {
        colors: `:root { --ink: #000; } :root[data-theme='dark'] { --ink: #fff; --stray: #111; }`,
        spacing: ':root { --sp-1: 4px; --r-sm: 6px; --shadow-xs: none; --dur-hover: 20ms; }',
        typography: ':root { --font-ui: a; --font-mono: b; }',
      },
      { ...NO_NOTES, radius: { 'r-gone': 'x' } },
      {},
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'color token ink has no usage note',
        'dark-only colour stray has no light value',
        'spacing token sp-1 has no usage note',
        'radius note r-gone names no token',
        'shadow token shadow-xs has no usage note',
      ]),
    );
    // Motion is not a token family the artifact reads.
    expect(problems.join('\n')).not.toContain('dur-hover');
  });

  it('takes every value from the app stylesheets', () => {
    const notes = JSON.parse(read('design-system/tokens.notes.json')) as TokenNotes;
    const { tokens } = buildTokens(
      {
        colors: read('src/styles/tokens/colors.css'),
        spacing: read('src/styles/tokens/spacing.css'),
        typography: read('src/styles/tokens/typography.css'),
      },
      notes,
      {},
    );
    const json = JSON.parse(JSON.stringify(tokens));
    const color = (name: string) =>
      json.color.tokens.find((t: { name: string }) => t.name === name).value;
    const css = readVars(read('src/styles/tokens/colors.css'), ':root {');
    expect(color('n-0').light).toBe(css.get('n-0'));
    expect(color('surface-app')).toEqual({ light: '{n-0}', dark: '{n-0}' });
    expect(color('surface-raised').dark).toBe('{n-100}');
    const shadow = json.shadow.tokens.find((t: { name: string }) => t.name === 'shadow-lg');
    expect(shadow.value.dark).toContain('rgba(0, 0, 0');
    const pageTitle = json.type.groups[0].styles.find(
      (s: { name: string }) => s.name === 'page-title',
    );
    expect(pageTitle.fontSize).toBe(
      readVars(read('src/styles/tokens/typography.css'), ':root {').get('fs-page-title'),
    );
  });
});
