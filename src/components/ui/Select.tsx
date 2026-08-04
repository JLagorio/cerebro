import React from 'react';
import { Icon } from '@/components/ui/Icon';

const css = `
.cb-select{position:relative;display:inline-flex;align-items:center}
.cb-select select{appearance:none;-webkit-appearance:none;font-family:var(--font-ui);font-size:var(--fs-sm);color:var(--text-primary);background:var(--n-0);border:1px solid var(--n-300);border-radius:var(--r-md);padding:0 28px 0 10px;outline:none;cursor:pointer;width:100%;transition:border-color var(--dur-fast) var(--ease-out)}
.cb-select select:hover{background:var(--n-50)}
.cb-select select:focus-visible{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-select select:disabled{background:var(--n-50);color:var(--text-disabled);cursor:not-allowed}
.cb-select .cb-select-chev{position:absolute;right:8px;pointer-events:none;color:var(--n-500)}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-select-css')) {
  const t = document.createElement('style');
  t.id = 'cb-select-css';
  t.textContent = css;
  document.head.appendChild(t);
}

/** Native select styled to system controls. */
export interface SelectOption {
  value: string;
  label: string;
}
export interface SelectProps {
  options: SelectOption[];
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
  /** "sm" 28 | "md" 32 (default) */
  size?: 'sm' | 'md';
  disabled?: boolean;
  width?: number | string;
  style?: React.CSSProperties;
  className?: string;
}

export function Select({
  options = [],
  value,
  onChange,
  size = 'md',
  disabled,
  width,
  style,
  className = '',
}: SelectProps) {
  const h = size === 'sm' ? 'var(--control-h-sm)' : 'var(--control-h)';
  return (
    <span className={`cb-select ${className}`} style={{ width, ...style }}>
      <select value={value} onChange={onChange} disabled={disabled} style={{ height: h }}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon className="cb-select-chev" name="chevron-down" size={14} />
    </span>
  );
}
