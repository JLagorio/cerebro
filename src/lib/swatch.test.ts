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

  it('tints a css var, which string concatenation could never do', () => {
    const sw = resolveOptionColor('var(--cortex-500)');
    expect(sw.solid).toBe('var(--cortex-500)');
    expect(sw.tint).toBe('color-mix(in srgb, var(--cortex-500) 14%, var(--n-0))');
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
