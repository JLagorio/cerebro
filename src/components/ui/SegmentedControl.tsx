import React from 'react';
import { Icon } from '@/components/ui/Icon';

const css = `
.cb-seg{display:inline-flex;background:var(--n-100);border-radius:var(--r-md);padding:2px;gap:2px}
.cb-seg button{font-family:var(--font-ui);font-size:var(--text-xs);font-weight:500;color:var(--n-600);background:transparent;border:none;border-radius:var(--r-sm);height:24px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;transition:background var(--dur-fast) var(--ease-out);outline:none;white-space:nowrap}
.cb-seg button:hover{color:var(--n-800)}
.cb-seg button:focus-visible{box-shadow:var(--ring)}
.cb-seg .cb-seg-on{background:var(--n-0);color:var(--n-900);box-shadow:var(--shadow-xs)}
.cb-seg-md button{height:28px;font-size:var(--text-sm);padding:0 12px}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-seg-css')) {
  const t = document.createElement('style');
  t.id = 'cb-seg-css';
  t.textContent = css;
  document.head.appendChild(t);
}

/** Inline segmented control (2–5 options). */
export interface SegmentOption {
  value: string;
  label: string;
  icon?: string;
  /** forwarded as data-testid on the segment button (Task 24 smoke hooks) */
  testId?: string;
}
export interface SegmentedControlProps {
  options: SegmentOption[];
  value?: string;
  onChange?: (value: string) => void;
  /** "sm" 28 total (default) | "md" 32 total */
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
  className?: string;
}

export function SegmentedControl({
  options = [],
  value,
  onChange,
  size = 'sm',
  style,
  className = '',
}: SegmentedControlProps) {
  return (
    <span className={`cb-seg ${size === 'md' ? 'cb-seg-md' : ''} ${className}`} style={style} role="tablist">
      {options.map((o) => (
        <button key={o.value} data-testid={o.testId} className={o.value === value ? 'cb-seg-on' : ''} onClick={() => onChange && onChange(o.value)}>
          {o.icon ? <Icon name={o.icon} size={14} /> : null}
          {o.label}
        </button>
      ))}
    </span>
  );
}
