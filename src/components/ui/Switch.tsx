import React from 'react';

// Ported for Task 22 (reported deviation): the plan's FieldEditor relies on
// the DS Switch (its props are quoted in the task's "DS prop APIs relied
// on"), but Task 3's 17-primitive port did not include it. Source:
// docs/Cerebro Design System/components/core/Switch.jsx + Switch.d.ts.
//
// Both timings stay `--dur-fast` after M46.2 Task 3 and neither motion token
// applies. The thumb travels on a COMMIT, not with the pointer: 20ms would
// make the toggle look broken and 200ms would make a 14px slide feel slow, so
// the number here is chosen for this control rather than shared with the two
// kinds the tokens name. It is also why reduced motion does not reach it —
// see tokens/spacing.css on hard-coded durations opting themselves out.
const css = `
.cb-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--fs-sm);user-select:none}
.cb-switch input{position:absolute;opacity:0;width:0;height:0}
.cb-switch .cb-track{width:32px;height:18px;border-radius:var(--r-full);background:var(--n-300);position:relative;transition:background var(--dur-fast) var(--ease-out);flex:none}
.cb-switch .cb-track::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:var(--shadow-xs);transition:transform var(--dur-fast) var(--ease-out)}
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
