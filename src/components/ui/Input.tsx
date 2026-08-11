import React from 'react';
import { Icon } from '@/components/ui/Icon';

const css = `
.cb-input{display:inline-flex;align-items:center;gap:8px;background:var(--n-0);border:1px solid var(--n-300);border-radius:var(--r-md);padding:0 10px;transition:border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out);color:var(--n-500)}
.cb-input:hover{border-color:var(--n-400)}
.cb-input:focus-within{border-color:var(--border-focus);box-shadow:var(--ring);color:var(--n-600)}
.cb-input input{border:none;outline:none;background:transparent;font-family:var(--font-ui);font-size:var(--fs-sm);color:var(--text-primary);flex:1;min-width:0;padding:0;height:100%}
.cb-input input::placeholder{color:var(--text-disabled)}
.cb-input-disabled{background:var(--n-50);pointer-events:none}
.cb-input-disabled input{color:var(--text-disabled)}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-input-css')) {
  const t = document.createElement('style');
  t.id = 'cb-input-css';
  t.textContent = css;
  document.head.appendChild(t);
}

/** Text input with optional leading icon and suffix node. */
export interface InputProps {
  /** leading lucide icon, e.g. "search" */
  icon?: string;
  placeholder?: string;
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  /** aria-label for the inner <input> (M2 Task 16 property rows) */
  ariaLabel?: string;
  /**
   * The combobox pair, for an input that drives a list it does not contain
   * (M29.53): which option is currently marked, and where that list lives.
   * Without them a keyboard user is told nothing about what Enter will take —
   * measured on the whiteboard's record picker, which had 25 rows and no way
   * to say which one was next.
   */
  ariaActivedescendant?: string;
  ariaControls?: string;
  /** right-side node, e.g. <kbd>⌘K</kbd> */
  suffix?: React.ReactNode;
  /** "sm" 28 | "md" 32 (default) | "lg" 38 */
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  autoFocus?: boolean;
  /** css width, e.g. 280 or "100%" */
  width?: number | string;
  style?: React.CSSProperties;
  className?: string;
  /** forwarded as data-testid on the inner <input> (Task 24 smoke hooks) */
  testId?: string;
}

export function Input({
  icon,
  placeholder,
  value,
  onChange,
  onKeyDown,
  onBlur,
  ariaLabel,
  ariaActivedescendant,
  ariaControls,
  suffix,
  size = 'md',
  disabled,
  autoFocus,
  width,
  style,
  className = '',
  testId,
}: InputProps) {
  const h =
    size === 'sm'
      ? 'var(--control-h-sm)'
      : size === 'lg'
        ? 'var(--control-h-lg)'
        : 'var(--control-h)';
  return (
    <span
      className={`cb-input ${disabled ? 'cb-input-disabled' : ''} ${className}`}
      style={{ height: h, width, ...style }}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      <input
        data-testid={testId}
        aria-label={ariaLabel}
        aria-activedescendant={ariaActivedescendant}
        aria-controls={ariaControls}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      {suffix || null}
    </span>
  );
}
