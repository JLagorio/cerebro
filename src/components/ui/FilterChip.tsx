import React from 'react';
import { Icon } from '@/components/ui/Icon';

const css = `
.cb-fchip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--r-full);border:1px solid var(--n-300);background:var(--n-0);font-family:var(--font-ui);font-size:var(--text-xs);font-weight:500;color:var(--n-700);cursor:pointer;white-space:nowrap;transition:background var(--dur-fast) var(--ease-out);outline:none}
.cb-fchip:hover{background:var(--n-50)}
.cb-fchip:focus-visible{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-fchip-on{background:var(--surface-selected);border-color:var(--cortex-200);color:var(--cortex-700)}
.cb-fchip-on:hover{background:var(--cortex-100)}
.cb-fchip b{font-weight:600}
.cb-fchip .cb-fchip-x{display:inline-flex;border:none;background:none;padding:0;color:inherit;opacity:.6;cursor:pointer}
.cb-fchip .cb-fchip-x:hover{opacity:1}
.cb-fchip-dot{width:6px;height:6px;border-radius:50%;background:var(--success-500);flex:none;margin-left:2px}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-fchip-css')) {
  const t = document.createElement('style');
  t.id = 'cb-fchip-css';
  t.textContent = css;
  document.head.appendChild(t);
}

/** Toolbar filter/scope pill ("My items", "Filtered by: Owner"). */
export interface FilterChipProps {
  label: string;
  /** bolded value after a colon */
  value?: string;
  icon?: string;
  /** selected state (cortex tint) */
  active?: boolean;
  /** green "modified" dot */
  dot?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  style?: React.CSSProperties;
  className?: string;
}

export function FilterChip({ label, value, icon, active, dot, onClick, onRemove, style, className = '' }: FilterChipProps) {
  return (
    <button type="button" className={`cb-fchip ${active ? 'cb-fchip-on' : ''} ${className}`} onClick={onClick} style={style}>
      {icon ? <Icon name={icon} size={13} /> : null}
      <span>
        {label}
        {value ? (
          <>
            : <b>{value}</b>
          </>
        ) : null}
      </span>
      {dot ? <span className="cb-fchip-dot"></span> : null}
      {onRemove ? (
        <span
          className="cb-fchip-x"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="x" size={12} />
        </span>
      ) : null}
    </button>
  );
}
