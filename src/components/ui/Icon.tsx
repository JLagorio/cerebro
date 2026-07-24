import React from 'react';
import { icons } from 'lucide-react';

/** Lucide line icon (bundled via lucide-react), 1.75 stroke, currentColor. */
export interface IconProps {
  /** lucide icon name, kebab-case, e.g. "target", "layout-grid" */
  name: string;
  /** px, default 16 */
  size?: number;
  /** default 1.75 */
  strokeWidth?: number;
  /** css color; defaults to currentColor */
  color?: string;
  style?: React.CSSProperties;
  className?: string;
}

const pascal = (n: string) =>
  n
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join('');

export function Icon({ name, size = 16, strokeWidth = 1.75, color, style, className }: IconProps) {
  const baseStyle: React.CSSProperties = {
    flex: 'none',
    display: 'inline-block',
    verticalAlign: 'middle',
    color,
    ...style,
  };
  const Lucide = icons[pascal(name) as keyof typeof icons];
  if (!Lucide) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={baseStyle}
        aria-hidden="true"
      />
    );
  }
  return (
    <Lucide
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={baseStyle}
      aria-hidden="true"
    />
  );
}
