import React from 'react';

// Colour follows the hover token; the thumb is movement, on the arrival
// duration with a little spring at the end of its travel (thought-desk's
// knob), and respects the user's reduced-motion preference through it.
const css = `
.cb-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--fs-sm);user-select:none}
.cb-switch input{position:absolute;opacity:0;width:0;height:0}
.cb-switch .cb-track{width:32px;height:18px;border-radius:var(--r-full);background:var(--n-300);position:relative;transition:background var(--motion-hover);flex:none}
.cb-switch .cb-track::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:var(--shadow-xs);transition:transform var(--motion-spring)}
.cb-switch-on .cb-track{background:var(--accent)}
.cb-switch-on .cb-track::after{transform:translateX(14px)}
.cb-switch input:focus-visible+.cb-track{box-shadow:var(--ring)}
.cb-switch-disabled{opacity:.45;cursor:not-allowed}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-switch-css')) {
  const t = document.createElement('style');
  t.id = 'cb-switch-css';
  t.textContent = css;
  document.head.appendChild(t);
}

/** 32×18 toggle switch. */
export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  /** aria-label for the inner checkbox when no visible label is given. */
  ariaLabel?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled,
  style,
  className = '',
}: SwitchProps) {
  return (
    <label
      className={`cb-switch ${checked ? 'cb-switch-on' : ''} ${disabled ? 'cb-switch-disabled' : ''} ${className}`}
      style={style}
    >
      <input
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange && onChange(e.target.checked)}
      />
      <span className="cb-track"></span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
