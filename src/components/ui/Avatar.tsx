import React from 'react';

/**
 * Eight DS tokens rather than eight raw hexes (M15). The old palette was a
 * private set of pastels that duplicated the role of --swatch-* while sharing
 * none of their values, and every one of them left white initials below 2.5:1.
 */
const PALETTE = [
  'var(--avatar-1)',
  'var(--avatar-2)',
  'var(--avatar-3)',
  'var(--avatar-4)',
  'var(--avatar-5)',
  'var(--avatar-6)',
  'var(--avatar-7)',
  'var(--avatar-8)',
];
const hash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};
const initials = (n: string): string =>
  n
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

/** Initials avatar with deterministic muted background; AvatarGroup overlaps with +N. */
export interface AvatarProps {
  /** full name; initials derived */
  name: string;
  /** px, default 24 (use 20 in table rows, 28 in headers) */
  size?: number;
  /** optional image url */
  src?: string;
  style?: React.CSSProperties;
  className?: string;
}
export interface AvatarGroupProps {
  names: string[];
  size?: number;
  /** max shown before +N, default 3 */
  max?: number;
  style?: React.CSSProperties;
  className?: string;
}

export function Avatar({ name = '?', size = 24, src, style, className = '' }: AvatarProps) {
  const bg = PALETTE[hash(name) % PALETTE.length];
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    verticalAlign: 'middle',
    ...style,
  };
  if (src)
    return (
      <img
        src={src}
        alt={name}
        title={name}
        className={className}
        style={{ ...base, objectFit: 'cover' }}
      />
    );
  return (
    <span
      title={name}
      className={className}
      style={{
        ...base,
        background: bg,
        color: 'var(--text-inverse)',
        fontFamily: 'var(--font-ui)',
        fontWeight: 700,
        // Floor of 10px: at size 20 (table rows) the old 0.4 ratio produced 8px
        // initials, which is below the point where two letters are legible.
        fontSize: Math.max(10, Math.round(size * 0.42)),
        letterSpacing: '0.02em',
        userSelect: 'none',
      }}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarGroup({
  names = [],
  size = 24,
  max = 3,
  style,
  className = '',
}: AvatarGroupProps) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', ...style }}>
      {shown.map((n, i) => (
        <Avatar
          key={n + i}
          name={n}
          size={size}
          style={{ marginLeft: i ? -size * 0.3 : 0, boxShadow: '0 0 0 2px var(--n-0)' }}
        />
      ))}
      {rest > 0 ? (
        <span
          style={{
            marginLeft: -size * 0.3,
            width: size,
            height: size,
            borderRadius: '50%',
            background: 'var(--n-100)',
            color: 'var(--n-700)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: Math.max(10, Math.round(size * 0.4)),
            fontWeight: 700,
            boxShadow: '0 0 0 2px var(--n-0)',
          }}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
