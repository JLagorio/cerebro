import React from 'react';

const PALETTE = [
  '#7BA8E0',
  '#7CC5A8',
  '#D9A46B',
  '#C08FD6',
  '#E08F9F',
  '#77BFCF',
  '#A3B06F',
  '#9099D9',
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
        color: '#fff',
        fontFamily: 'var(--font-ui)',
        fontWeight: 600,
        fontSize: Math.round(size * 0.4),
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
            color: 'var(--n-600)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: Math.round(size * 0.38),
            fontWeight: 600,
            boxShadow: '0 0 0 2px var(--n-0)',
          }}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
