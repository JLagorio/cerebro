import { describe, expect, it } from 'vitest';
import { colorOf, isDurableColor, normalizeColor } from './colors';

describe('durable colours', () => {
  it.each(['1', '2', '3', '4', '5', '6', '#abc', '#ABC', '#a1b2c3', '#A1B2C3'])(
    '%s is durable',
    (value) => {
      expect(isDurableColor(value)).toBe(true);
    },
  );

  it.each(['var(--x)', 'red', '7', '0', '#12345', '#ggg', '#abcd', '', ' 1', 'abc', null, 3])(
    '%s is not',
    (value) => {
      expect(isDurableColor(value)).toBe(false);
    },
  );

  it('writes presets as given and hex as six lower-case digits', () => {
    expect(normalizeColor('4')).toBe('4');
    expect(normalizeColor('#ABC')).toBe('#aabbcc');
    expect(normalizeColor('#A1B2C3')).toBe('#a1b2c3');
    expect(normalizeColor('var(--accent)')).toBeNull();
  });

  it('sorts every value into a preset, a hex colour or undrawable', () => {
    expect(colorOf('6')).toEqual({ kind: 'preset', preset: '6' });
    expect(colorOf('#FfF')).toEqual({ kind: 'hex', hex: '#ffffff' });
    expect(colorOf('var(--x)')).toEqual({ kind: 'undrawable' });
    expect(colorOf('red')).toEqual({ kind: 'undrawable' });
    expect(colorOf(undefined)).toEqual({ kind: 'undrawable' });
  });
});
