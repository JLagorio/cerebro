import { describe, expect, it } from 'vitest';
import { buildThemeVariables, themeSignature } from './theme';

describe('buildThemeVariables', () => {
  it('uses light-palette fallbacks when tokens are absent (jsdom loads no stylesheet)', () => {
    const vars = buildThemeVariables();
    expect(vars.background).toBe('#ffffff');
    expect(vars.primaryBorderColor).toBe('#3d5bde');
    expect(vars.fontFamily).toContain('Instrument Sans');
  });

  it('reads live token values over fallbacks', () => {
    document.documentElement.style.setProperty('--n-0', '#123456');
    try {
      expect(buildThemeVariables().background).toBe('#123456');
    } finally {
      document.documentElement.style.removeProperty('--n-0');
    }
  });

  it('signature changes when the palette changes', () => {
    const light = themeSignature(buildThemeVariables());
    document.documentElement.style.setProperty('--n-0', '#15181f');
    try {
      expect(themeSignature(buildThemeVariables())).not.toBe(light);
    } finally {
      document.documentElement.style.removeProperty('--n-0');
    }
  });
});
