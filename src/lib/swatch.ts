const FALLBACK = 'var(--cortex-500)';

/** Resolve a frontmatter color value (hex, css var, or DS swatch name) to a CSS color. */
export function swatchColor(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return FALLBACK;
  const value = raw.trim();
  if (value.startsWith('#') || value.startsWith('var(')) return value;
  return `var(--swatch-${value})`;
}
