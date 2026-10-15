/** JSON Canvas stores a digit; the current theme supplies its paint. Loaded
 * unknown colours remain in the file but never become CSS or a class. */
export function presetPaint(color: string | undefined): string | null {
  if (color === undefined) return null;
  if (/^[1-6]$/.test(color)) return `var(--canvas-${color})`;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}
