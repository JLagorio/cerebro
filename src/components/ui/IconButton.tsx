import React from 'react';
import { Icon } from '@/components/ui/Icon';
import { Tooltip } from '@/components/ui/Tooltip';

/* The hover wash spends `--motion-hover` (M46.2): 120ms was long enough to
 * trail the pointer across a toolbar of these, which is the lag Notion's
 * measured 20ms exists to avoid. Colour only — `background`, never `all`. */
const css = `
.cb-ibtn{display:inline-flex;align-items:center;justify-content:center;border-radius:var(--r-sm);border:1px solid transparent;background:transparent;color:var(--n-600);cursor:pointer;transition:background var(--motion-hover),color var(--motion-hover);outline:none;padding:0}
.cb-ibtn:hover:not([disabled]){background:var(--n-100);color:var(--n-800)}
.cb-ibtn:active:not([disabled]){background:var(--n-200)}
.cb-ibtn:focus-visible{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-ibtn[disabled]{opacity:.45;cursor:not-allowed}
.cb-ibtn-outline{border-color:var(--n-300);background:var(--n-0)}
.cb-ibtn-outline:hover:not([disabled]){background:var(--n-50)}
.cb-ibtn-active{background:var(--surface-selected);color:var(--cortex-600)}
.cb-ibtn-active:hover:not([disabled]){background:var(--cortex-100);color:var(--cortex-700)}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-ibtn-css')) {
  const t = document.createElement('style');
  t.id = 'cb-ibtn-css';
  t.textContent = css;
  document.head.appendChild(t);
}

/** Icon-only button with mandatory accessible label. */
export interface IconButtonProps {
  /** lucide icon name */
  icon: string;
  /** tooltip + aria-label (required) */
  label: string;
  /** "sm" 24 | "md" 28 (default) | "lg" 32 */
  size?: 'sm' | 'md' | 'lg';
  /** "ghost" (default) | "outline" */
  variant?: 'ghost' | 'outline';
  /** toggled-on state (cortex tint) */
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
  className?: string;
  /** For anchoring a Popover to this button (M16.11). A ref is an ordinary
   * prop in React 19, so no forwardRef wrapper is needed. */
  ref?: React.Ref<HTMLButtonElement>;
}

export function IconButton({
  icon,
  label,
  size = 'md',
  variant = 'ghost',
  active,
  disabled,
  onClick,
  style,
  className = '',
  ref,
}: IconButtonProps) {
  const px = size === 'sm' ? 24 : size === 'lg' ? 32 : 28;
  const ic = size === 'sm' ? 14 : 16;
  // `title` on a disabled <button> never renders, so every icon button that
  // explained why it was unavailable explained it to nobody (M16.5). Tooltip
  // clones its handlers onto this button and adds no wrapper node.
  return (
    <Tooltip label={label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={`cb-ibtn ${variant === 'outline' ? 'cb-ibtn-outline' : ''} ${active ? 'cb-ibtn-active' : ''} ${className}`}
        style={{ width: px, height: px, ...style }}
      >
        <Icon name={icon} size={ic} />
      </button>
    </Tooltip>
  );
}
