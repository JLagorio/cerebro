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
  /** names the tablist for screen readers, e.g. "View mode" */
  ariaLabel?: string;
  style?: React.CSSProperties;
  className?: string;
}

export function SegmentedControl({
  options = [],
  value,
  onChange,
  size = 'sm',
  ariaLabel,
  style,
  className = '',
}: SegmentedControlProps) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const selectedIndex = options.findIndex((o) => o.value === value);
  // Roving tabindex: the strip is ONE tab stop and arrows move within it. Fall
  // back to the first option so the control stays reachable when `value`
  // matches nothing.
  const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const move = (next: number) => {
    if (options.length === 0) return;
    const i = ((next % options.length) + options.length) % options.length;
    if (onChange) onChange(options[i].value);
    // Selection follows focus, so the newly selected button is the tab stop.
    ref.current?.querySelectorAll('button')[i]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Home') return move(0);
    if (e.key === 'End') return move(options.length - 1);
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    move(focusIndex + delta);
  };

  return (
    <span
      ref={ref}
      className={`cb-seg ${size === 'md' ? 'cb-seg-md' : ''} ${className}`}
      style={style}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          tabIndex={i === focusIndex ? 0 : -1}
          data-testid={o.testId}
          className={o.value === value ? 'cb-seg-on' : ''}
          onClick={() => onChange && onChange(o.value)}
        >
          {o.icon ? <Icon name={o.icon} size={14} /> : null}
          {o.label}
        </button>
      ))}
    </span>
  );
}
