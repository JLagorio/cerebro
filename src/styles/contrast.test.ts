import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'tokens/colors.css'), 'utf8');
const [light, dark] = css.split(":root[data-theme='dark']");

function palette(source: string): Map<string, string> {
  return new Map([...source.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
}

function resolve(tokens: Map<string, string>, key: string): string {
  const value = tokens.get(key)!;
  return value.startsWith('var(') ? resolve(tokens, value.slice(4, -1)) : value;
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((part) => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

it.each(['light', 'dark'])('keeps readable state ink and action labels at AA in %s', (theme) => {
  const tokens = palette(theme === 'dark' ? light + dark : light);
  const pairs = ['primary', 'danger'].flatMap((kind) =>
    ['', '-hover', '-press'].map((state) => [`--on-action-${kind}`, `--action-${kind}${state}`]),
  );
  for (const kind of ['warn', 'danger', 'success']) pairs.push([`--${kind}-700`, `--${kind}-50`]);
  for (const ink of ['--text-primary', '--text-secondary', '--text-meta', '--text-placeholder']) {
    for (const ground of [
      '--surface-app',
      '--surface-board',
      '--surface-sunken',
      '--surface-raised',
    ]) {
      pairs.push([ink, ground]);
    }
  }
  for (const [ink, ground] of pairs) {
    const values = [luminance(resolve(tokens, ink)), luminance(resolve(tokens, ground))];
    const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
    expect(ratio, `${theme}: ${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
  }
});

// A hue's 600 step is its text ink on the neutral surfaces (`text-warn-600`,
// the link ink `text-cortex-600`, AI ink `text-synapse-600`), and the brand
// ramps pair 700 ink with their own 50 ground (M100.2).
it.each(['light', 'dark'])('keeps every hue text step at AA on neutral surfaces in %s', (theme) => {
  const tokens = palette(theme === 'dark' ? light + dark : light);
  const pairs: [string, string][] = [
    ['--cortex-700', '--cortex-50'],
    ['--synapse-700', '--synapse-50'],
  ];
  for (const ink of [
    '--warn-600',
    '--success-600',
    '--danger-600',
    '--cortex-600',
    '--synapse-600',
  ]) {
    for (const ground of [
      '--surface-app',
      '--surface-board',
      '--surface-sunken',
      '--surface-raised',
      '--surface-navigation',
      '--surface-selected',
    ]) {
      pairs.push([ink, ground]);
    }
  }
  for (const [ink, ground] of pairs) {
    const values = [luminance(resolve(tokens, ink)), luminance(resolve(tokens, ground))];
    const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
    expect(ratio, `${theme}: ${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
  }
});
