import React from 'react';

/** 4px work-progress bar with optional mono % label. */
export interface ProgressBarProps {
  /** 0–100 */
  value: number;
  /** track width px, default 120 */
  width?: number;
  /** "default" cortex | "success" | "warn" | "danger" */
  tone?: 'default' | 'success' | 'warn' | 'danger';
  showLabel?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

export function ProgressBar({ value = 0, width = 120, tone = 'default', showLabel, style, className = '' }: ProgressBarProps) {
  const v = Math.max(0, Math.min(100, value));
  const fill =
    tone === 'success'
      ? 'var(--success-500)'
      : tone === 'warn'
        ? 'var(--warn-500)'
        : tone === 'danger'
          ? 'var(--danger-500)'
          : 'var(--cortex-400)';
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, ...style }}>
      <span style={{ width, height: 4, borderRadius: 'var(--r-full)', background: 'var(--n-100)', overflow: 'hidden', flex: 'none' }}>
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${v}%`,
            borderRadius: 'var(--r-full)',
            background: fill,
            transition: 'width var(--dur-med) var(--ease-out)',
          }}
        ></span>
      </span>
      {showLabel ? (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--text-secondary)',
            minWidth: 30,
            textAlign: 'right',
          }}
        >
          {v}%
        </span>
      ) : null}
    </span>
  );
}
