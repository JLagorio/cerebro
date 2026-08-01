import React from 'react';

const css = `
.cb-badge{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:var(--r-full);font-size:var(--text-2xs);font-weight:500;letter-spacing:0;white-space:nowrap}
.cb-badge-outline{background:transparent!important;border:1px solid currentColor}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-badge-css')) {
  const t = document.createElement('style');
  t.id = 'cb-badge-css';
  t.textContent = css;
  document.head.appendChild(t);
}

const TONES: Record<string, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--n-100)', fg: 'var(--n-700)' },
  info: { bg: 'var(--cortex-50)', fg: 'var(--cortex-700)' },
  success: { bg: 'var(--success-50)', fg: 'var(--success-700)' },
  warn: { bg: 'var(--warn-50)', fg: 'var(--warn-700)' },
  danger: { bg: 'var(--danger-50)', fg: 'var(--danger-700)' },
  ai: { bg: 'var(--synapse-50)', fg: 'var(--synapse-600)' },
};

/** Small tonal pill for counts and states ("Beta", "8 items"). */
export interface BadgeProps {
  /** "neutral" (default) | "info" | "success" | "warn" | "danger" | "ai" */
  tone?: 'neutral' | 'info' | 'success' | 'warn' | 'danger' | 'ai';
  /** "tint" (default) | "outline" */
  variant?: 'tint' | 'outline';
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export function Badge({
  tone = 'neutral',
  variant = 'tint',
  children,
  style,
  className = '',
}: BadgeProps) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span
      className={`cb-badge ${variant === 'outline' ? 'cb-badge-outline' : ''} ${className}`}
      style={{ background: t.bg, color: t.fg, ...style }}
    >
      {children}
    </span>
  );
}
