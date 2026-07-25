import { describe, expect, it } from 'vitest';
import { swatchColor } from './swatch';

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
