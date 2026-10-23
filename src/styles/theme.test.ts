import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * index.css resets Tailwind's stock palette (`--color-*: initial`) so only
 * DS tokens yield colour utilities — and an off-DS class compiles to NOTHING,
 * silently. Measured 2026-09-28: both M49 ledger banners were written in
 * `amber-*`/`red-*` and shipped as bare black text with browser-default
 * borders; ten older call sites named steps the theme never mapped
 * (`warn-300`, `danger-300`/`-400`, `synapse-25`, and an `ok-*` ramp that is
 * really `success-*`). Nothing failed, because nothing CAN fail at build time.
 * This test is that failure.
 */
const SRC = join(__dirname, '..');
const THEME = readFileSync(join(__dirname, 'index.css'), 'utf8');
const MAPPED = new Set([...THEME.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]));

const RADII = new Set([...THEME.matchAll(/--radius-([a-z0-9]+):/g)].map((m) => m[1]));

// `rounded`, `rounded-t`, `rounded-md`, `rounded-tl-lg` … — the radius scale
// is reset the same way the palette is, so a bare `rounded` (stock: 4px)
// compiled to nothing and 77 call sites drew square corners (M50.5).
const RADIUS =
  /(?<![\w-])rounded(?:-(t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee))?(?:-([a-z0-9]+))?(?![\w[-])/g;

const UTILITY =
  /(?<![\w-])(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|fill|stroke|outline|divide|decoration|accent|caret|placeholder)-([a-z]+(?:-[a-z]+)*-\d{2,3}|n-0|surface-[a-z-]+|on-action-[a-z-]+|action-[a-z-]+|white|black)(?:\/\d+)?(?![\w-])/g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [path] : [];
  });
}

describe('DS colour utilities', () => {
  it('every colour class in src/ names a token the theme maps', () => {
    const unmapped: string[] = [];
    for (const file of sources(SRC)) {
      // Comments may name a class to say never to use it.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const m of code.matchAll(UTILITY)) {
        if (!MAPPED.has(m[1])) unmapped.push(`${file.slice(SRC.length + 1)}: ${m[0]}`);
      }
    }
    expect(unmapped).toEqual([]);
  });

  it('every radius class names a step the theme maps', () => {
    const unmapped: string[] = [];
    for (const file of sources(SRC)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const m of code.matchAll(RADIUS)) {
        const at = m.index ?? 0;
        const before = code[at - 1] ?? '';
        const after = code[at + m[0].length] ?? '';
        // Only a word in a class list: bounded by spaces or quotes. A string
        // that IS the word (a mermaid node shape, `'rounded'`) is a value,
        // and `rounded =` / `rounded:` is an identifier or a key.
        if (!/[\s'"`]/.test(before) || !/[\s'"`]/.test(after)) continue;
        if (/['"`]/.test(before) && /['"`]/.test(after)) continue;
        if (/^\s*[=:(,.)\]}]/.test(code.slice(at + m[0].length))) continue;
        const size = m[2];
        if (size === undefined || !(RADII.has(size) || size === 'none')) {
          unmapped.push(`${file.slice(SRC.length + 1)}: ${m[0]}`);
        }
      }
    }
    expect(unmapped).toEqual([]);
  });

  it('every size utility names a mapped step or explicit product role', () => {
    const sizes = new Set([...THEME.matchAll(/--text-([a-z0-9-]+):/g)].map((m) => m[1]));
    const used =
      /(?<![\w-])text-(base|(?:[2-9])?xl|2xs|xs|sm|md|lg|ui|metadata|page-title|workspace-title|section-title|prose)(?![\w-])/g;
    const unmapped: string[] = [];
    for (const file of sources(SRC)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const match of code.matchAll(used)) {
        if (!sizes.has(match[1])) unmapped.push(`${file.slice(SRC.length + 1)}: ${match[0]}`);
      }
    }
    expect(unmapped).toEqual([]);
    expect(sizes.has('base')).toBe(true);
  });

  it('the scan sees the classes it guards', () => {
    expect(MAPPED.has('warn-300')).toBe(true);
    expect('rounded rounded-t rounded-md rounded-tl-lg'.match(RADIUS)).toEqual([
      'rounded',
      'rounded-t',
      'rounded-md',
      'rounded-tl-lg',
    ]);
    expect(MAPPED.has('amber-50')).toBe(false);
    expect(MAPPED.has('surface-base')).toBe(false);
    expect('bg-surface-base text-on-action-primary'.match(UTILITY)).toEqual([
      'bg-surface-base',
      'text-on-action-primary',
    ]);
    expect('border-l-2 text-n-0'.match(UTILITY)).toEqual(['text-n-0']);
    expect('hover:bg-amber-100 border-n-200/40'.match(UTILITY)).toEqual([
      'bg-amber-100',
      'border-n-200/40',
    ]);
  });
});
