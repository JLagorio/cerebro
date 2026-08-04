import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTION_COLORS, resolveOptionColor, swatchColor } from './swatch';

describe('swatchColor', () => {
  it('passes hex colors through', () => {
    expect(swatchColor('#3D8BE8')).toBe('#3D8BE8');
  });

  it('passes css variables through', () => {
    expect(swatchColor('var(--cortex-500)')).toBe('var(--cortex-500)');
  });

  it('maps DS swatch names to swatch variables', () => {
    expect(swatchColor('teal')).toBe('var(--swatch-teal)');
  });

  it('falls back to cortex for missing values', () => {
    expect(swatchColor(null)).toBe('var(--cortex-500)');
    expect(swatchColor('')).toBe('var(--cortex-500)');
    expect(swatchColor(42)).toBe('var(--cortex-500)');
  });
});

/**
 * The option/status colour resolver (M16.12).
 *
 * Two shapes coexist forever: the names the pickers write from now on, and
 * every raw value already sitting in a vault on disk.
 */
describe('resolveOptionColor', () => {
  it('resolves a name to its token triple', () => {
    expect(resolveOptionColor('blue')).toEqual({
      name: 'blue',
      solid: 'var(--opt-blue)',
      tint: 'var(--opt-blue-bg)',
      ink: 'var(--opt-blue-ink)',
    });
  });

  it('gives every name in the catalog a triple', () => {
    for (const name of OPTION_COLORS) {
      const sw = resolveOptionColor(name);
      expect(sw.solid).not.toBe('');
      expect(sw.tint).not.toBe('');
      expect(sw.ink).not.toBe('');
    }
  });

  it('treats default and nothing-at-all the same', () => {
    const neutral = resolveOptionColor('default');
    expect(resolveOptionColor(null)).toEqual(neutral);
    expect(resolveOptionColor(undefined)).toEqual(neutral);
    expect(resolveOptionColor('')).toEqual(neutral);
    expect(neutral.name).toBe('default');
  });

  // Every colour in the demo vault, and in every user vault, is a raw hex.
  it('passes a hex straight through as the solid', () => {
    const sw = resolveOptionColor('#DE3B4E');
    expect(sw.name).toBeNull();
    expect(sw.solid).toBe('#DE3B4E');
  });

  // The bug this replaces: `${color}22` turned #fff into #fff22, an invalid
  // declaration the browser drops, so a 3-digit hex rendered a clear pill.
  it('tints a three-digit hex to something a browser will accept', () => {
    const sw = resolveOptionColor('#fff');
    expect(sw.tint).toBe('color-mix(in srgb, #fff 14%, var(--n-0))');
    expect(sw.tint).not.toContain('#fff22');
  });

  it('tints a functional colour, which string concatenation could never do', () => {
    const sw = resolveOptionColor('rgb(61 139 232)');
    expect(sw.solid).toBe('rgb(61 139 232)');
    expect(sw.tint).toBe('color-mix(in srgb, rgb(61 139 232) 14%, var(--n-0))');
  });

  // Painting the label in the option's own hue over a 14% tint of that hue
  // is ~1.8:1 for amber. The ink is never the raw value.
  it('never inks a tag in its own colour', () => {
    for (const raw of ['#EFB428', 'var(--x)', 'blue', 'default', null]) {
      expect(resolveOptionColor(raw).ink).not.toBe(raw);
    }
  });

  // Routing unknown words to swatchColor would ship two different blues —
  // `blue` from --opt-* and `teal` from --swatch-* — and pair a coloured dot
  // with a neutral pill.
  it('does not fall through to the older swatch palette', () => {
    const teal = resolveOptionColor('teal');
    expect(teal.solid).not.toContain('--swatch-');
    expect(teal.tint).toContain('teal');
  });

  it('gives a word it cannot use the neutral triple rather than a dropped declaration', () => {
    expect(resolveOptionColor('not a colour 42')).toEqual(resolveOptionColor(null));
  });

  it('leaves swatchColor alone', () => {
    expect(swatchColor('teal')).toBe('var(--swatch-teal)');
  });
});

/**
 * CSS injection from vault metadata (M16.35).
 *
 * The resolver used to accept anything containing a paren as a "legacy
 * colour" and interpolate it into `background`, into a `border` shorthand and
 * into `color-mix(…)`. A vault is not trusted input — it gets synced, cloned
 * and sent — so `color: url(https://…)` on one option fired an outbound
 * request from the renderer the moment the record was opened: it confirms the
 * file was read and turns the app into a blind network probe. `image-set(…)`
 * fetches the same way; `var()` and `attr()` expand to tokens nobody checked.
 */
describe('resolveOptionColor only emits values that are colours', () => {
  const neutral = resolveOptionColor(null);

  const attacks = [
    'url(https://evil.example/pixel.png)',
    "url('https://evil.example/pixel.png')",
    'URL(https://evil.example/pixel.png)',
    'image-set(url(https://evil.example/1x.png) 1x)',
    'var(--n-500)',
    'var(--x, url(https://evil.example/pixel.png))',
    'attr(data-secret)',
    'element(#app)',
    // The nested-payload shapes: a real colour function wrapping, trailing or
    // preceding something that fetches.
    'rgb(0, 0, 0), url(https://evil.example/pixel.png)',
    'rgb(calc(1 * 2) 0 0)',
    'color-mix(in srgb, red 50%, url(https://evil.example/pixel.png))',
    // Escaping the declaration itself.
    'red; background-image: url(https://evil.example/pixel.png)',
    '#fff; background: url(https://evil.example/pixel.png)',
    'rgb(0 0 0) }] * { background: url(https://evil.example/pixel.png) }',
  ];

  it.each(attacks)('falls back to the default swatch for %s', (raw) => {
    expect(resolveOptionColor(raw)).toEqual(neutral);
  });

  it('never lets a fetching token reach a declaration', () => {
    for (const raw of attacks) {
      const sw = resolveOptionColor(raw);
      const emitted = `${sw.solid} ${sw.tint} ${sw.ink}`.toLowerCase();
      expect(emitted).not.toContain('url(');
      expect(emitted).not.toContain('image-set');
      expect(emitted).not.toContain('attr(');
      expect(emitted).not.toContain('element(');
      expect(emitted).not.toContain('evil.example');
    }
  });

  // The allowlist is a list, not a heuristic: an unknown function that merely
  // looks colour-ish is still not a colour.
  it('rejects a function that is not on the allowlist', () => {
    expect(resolveOptionColor('hwb(200 30% 20%)')).toEqual(neutral);
    expect(resolveOptionColor('lightdark(#fff, #000)')).toEqual(neutral);
  });

  it('rejects a hex that is not a hex', () => {
    expect(resolveOptionColor('#')).toEqual(neutral);
    expect(resolveOptionColor('#12345')).toEqual(neutral);
    expect(resolveOptionColor('#nothex')).toEqual(neutral);
  });

  // The point of an allowlist is that it does not cost anyone a real colour.
  it.each([
    '#fff',
    '#ffff',
    '#DE3B4E',
    '#DE3B4E80',
    'crimson',
    'REBECCAPURPLE',
    'transparent',
    'rgb(61, 139, 232)',
    'rgb(61 139 232 / 0.5)',
    'rgba(61, 139, 232, 0.5)',
    'hsl(210, 60%, 55%)',
    'hsl(210deg 60% 55% / 50%)',
    'hsla(210, 60%, 55%, 0.5)',
    'lab(52% 40 59)',
    'lch(52% 72 40deg)',
    'oklab(0.62 0.15 0.11)',
    'oklch(0.7 0.15 210 / none)',
    'color(display-p3 0.24 0.55 0.91)',
    'color(srgb 0.24 0.55 0.91 / 0.5)',
  ])('keeps resolving %s as its own colour', (raw) => {
    const sw = resolveOptionColor(raw);
    expect(sw.name).toBeNull();
    expect(sw.solid).toBe(raw);
    expect(sw.tint).toBe(`color-mix(in srgb, ${raw} 14%, var(--n-0))`);
  });
});

/**
 * The golden corpus is the regression test. Tightening the resolver is only
 * safe if every colour already written to disk still renders, so read the
 * vault rather than trusting a list copied out of it.
 */
describe('resolveOptionColor against the demo vault', () => {
  // `import.meta.url` is an http: URL under Vite's transform, so resolve from
  // the vitest root instead — which is the repo root (see vite.config.ts).
  const vault = resolve(process.cwd(), 'demo-vault');

  /** Every `color:` value in the corpus — quoted or bare, top level or inside
   * an inline `{ id: …, color: … }` mapping. */
  function vaultColors(): string[] {
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, item.name);
        if (item.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(md|ya?ml)$/.test(item.name)) continue;
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(/\bcolor:\s*(?:'([^']*)'|"([^"]*)"|([^,}\r\n]+))/g)) {
          const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
          if (raw !== '' && raw !== 'null') found.add(raw);
        }
      }
    };
    walk(vault);
    return [...found];
  }

  it('finds colours to check at all', () => {
    expect(vaultColors().length).toBeGreaterThan(0);
  });

  it('still resolves every colour format the vault ships', () => {
    for (const raw of vaultColors()) {
      const sw = resolveOptionColor(raw);
      expect(sw, `demo-vault colour ${raw} lost its swatch`).not.toEqual(resolveOptionColor(null));
      // A named colour reads as a token triple; anything else is emitted raw.
      if (sw.name === null) expect(sw.solid).toBe(raw);
    }
  });
});
