import React from "react";
const css = `
.cb-radio{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--text-sm);color:var(--text-primary);user-select:none}
.cb-radio input{position:absolute;opacity:0;width:0;height:0}
.cb-radio .cb-dot{width:16px;height:16px;border-radius:50%;border:1px solid var(--n-300);background:var(--n-0);display:inline-flex;align-items:center;justify-content:center;transition:border-color var(--dur-fast) var(--ease-out);flex:none}
.cb-radio:hover .cb-dot{border-color:var(--n-400)}
.cb-radio input:focus-visible+.cb-dot{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-radio-on .cb-dot{border:5px solid var(--accent)}
.cb-radio-disabled{opacity:.45;cursor:not-allowed}`;
if (typeof document !== "undefined" && !document.getElementById("cb-radio-css")) { const t = document.createElement("style"); t.id = "cb-radio-css"; t.textContent = css; document.head.appendChild(t); }
export function Radio({ checked, onChange, label, name, disabled, style, className = "" }) {
  return (
    <label className={`cb-radio ${checked ? "cb-radio-on" : ""} ${disabled ? "cb-radio-disabled" : ""} ${className}`} style={style}>
      <input type="radio" name={name} checked={!!checked} disabled={disabled} onChange={() => onChange && onChange(true)} />
      <span className="cb-dot"></span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
