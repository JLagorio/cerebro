import React from "react";
const css = `
.cb-check{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:var(--text-sm);color:var(--text-primary);user-select:none}
.cb-check input{position:absolute;opacity:0;width:0;height:0}
.cb-check .cb-box{width:16px;height:16px;border-radius:var(--r-xs);border:1px solid var(--n-300);background:var(--n-0);display:inline-flex;align-items:center;justify-content:center;transition:background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);flex:none}
.cb-check:hover .cb-box{border-color:var(--n-400)}
.cb-check input:focus-visible+.cb-box{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-check-on .cb-box{background:var(--accent);border-color:var(--accent)}
.cb-check-disabled{opacity:.45;cursor:not-allowed}`;
if (typeof document !== "undefined" && !document.getElementById("cb-check-css")) { const t = document.createElement("style"); t.id = "cb-check-css"; t.textContent = css; document.head.appendChild(t); }
export function Checkbox({ checked, indeterminate, onChange, label, disabled, style, className = "" }) {
  return (
    <label className={`cb-check ${checked || indeterminate ? "cb-check-on" : ""} ${disabled ? "cb-check-disabled" : ""} ${className}`} style={style}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange && onChange(e.target.checked)} />
      <span className="cb-box">
        {indeterminate
          ? <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="#fff" strokeWidth="2" strokeLinecap="round" /></svg>
          : checked
            ? <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 5.2l2.4 2.4 4.6-5" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            : null}
      </span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
