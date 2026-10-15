/**
 * Durable colours (M68.1). A board stores a JSON Canvas preset `1`–`6` or a
 * hex colour, nothing else: no `var(--…)`, no colour names. The renderer maps
 * presets to theme colours when it draws, never into the board. A loaded
 * colour that is neither stays on its item and is reported (board.ts
 * `problemsOf`); commands only ever write durable ones.
 */

export type ColorPreset = '1' | '2' | '3' | '4' | '5' | '6';

export type ColorClass =
  | { readonly kind: 'preset'; readonly preset: ColorPreset }
  | { readonly kind: 'hex'; readonly hex: string }
  | { readonly kind: 'undrawable' };

const PRESET = /^[1-6]$/;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isDurableColor(value: unknown): value is string {
  return typeof value === 'string' && (PRESET.test(value) || HEX.test(value));
}

/**
 * What a command writes for `value`: a preset as given, a hex colour as six
 * lower-case digits (`#ABC` becomes `#aabbcc`), or null when it isn't durable.
 */
export function normalizeColor(value: unknown): string | null {
  if (!isDurableColor(value)) return null;
  if (PRESET.test(value)) return value;
  const digits = value.slice(1).toLowerCase();
  if (digits.length === 6) return `#${digits}`;
  return `#${[...digits].map((d) => d + d).join('')}`;
}

/** Sorts a stored value into a preset, a hex colour (normalized) or undrawable. */
export function colorOf(value: unknown): ColorClass {
  const normal = normalizeColor(value);
  if (normal === null) return { kind: 'undrawable' };
  if (PRESET.test(normal)) return { kind: 'preset', preset: normal as ColorPreset };
  return { kind: 'hex', hex: normal };
}
