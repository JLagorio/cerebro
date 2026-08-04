import React from 'react';
import { Icon } from '@/components/ui/Icon';

const css = `
.cb-btn{font-family:var(--font-ui);font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:var(--r-md);border:1px solid transparent;cursor:pointer;white-space:nowrap;transition:background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);outline:none}
.cb-btn:focus-visible{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-btn[disabled]{cursor:not-allowed;opacity:.45}
.cb-btn-md{height:var(--control-h);padding:0 12px;font-size:var(--fs-sm)}
.cb-btn-sm{height:var(--control-h-sm);padding:0 10px;font-size:var(--fs-xs)}
.cb-btn-lg{height:var(--control-h-lg);padding:0 16px;font-size:var(--fs-md)}
.cb-btn-primary{background:var(--accent);color:#fff}
.cb-btn-primary:hover:not([disabled]){background:var(--accent-hover)}
.cb-btn-primary:active:not([disabled]){background:var(--accent-press)}
.cb-btn-secondary{background:var(--n-0);color:var(--n-800);border-color:var(--n-300)}
.cb-btn-secondary:hover:not([disabled]){background:var(--n-50)}
.cb-btn-secondary:active:not([disabled]){background:var(--n-100)}
.cb-btn-ghost{background:transparent;color:var(--n-600)}
.cb-btn-ghost:hover:not([disabled]){background:var(--n-50);color:var(--n-800)}
.cb-btn-ghost:active:not([disabled]){background:var(--n-100)}
.cb-btn-danger{background:var(--danger-500);color:#fff}
.cb-btn-danger:hover:not([disabled]){background:var(--danger-600)}
.cb-btn-danger:active:not([disabled]){background:var(--danger-700)}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-btn-css')) {
  const t = document.createElement('style');
  t.id = 'cb-btn-css';
  t.textContent = css;
  document.head.appendChild(t);
}

/** Action button. */
export interface ButtonProps {
  /** "primary" | "secondary" (default) | "ghost" | "danger" */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** "sm" 28px | "md" 32px (default) | "lg" 38px */
  size?: 'sm' | 'md' | 'lg';
  /** optional leading lucide icon name */
  icon?: string;
  children?: React.ReactNode;
  fullWidth?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  style?: React.CSSProperties;
  className?: string;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  fullWidth,
  disabled,
  onClick,
  type = 'button',
  style,
  className = '',
}: ButtonProps) {
  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`cb-btn cb-btn-${size} cb-btn-${variant} ${className}`}
      style={{ width: fullWidth ? '100%' : undefined, ...style }}
    >
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
    </button>
  );
}
