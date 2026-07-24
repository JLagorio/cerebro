import React from "react";
import { Icon } from "./Icon.jsx";
const css = `
.cb-input{display:inline-flex;align-items:center;gap:8px;background:var(--n-0);border:1px solid var(--n-300);border-radius:var(--r-md);padding:0 10px;transition:border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out);color:var(--n-500)}
.cb-input:hover{border-color:var(--n-400)}
.cb-input:focus-within{border-color:var(--border-focus);box-shadow:var(--ring);color:var(--n-600)}
.cb-input input{border:none;outline:none;background:transparent;font-family:var(--font-ui);font-size:var(--text-sm);color:var(--text-primary);flex:1;min-width:0;padding:0;height:100%}
.cb-input input::placeholder{color:var(--text-disabled)}
.cb-input-disabled{background:var(--n-50);pointer-events:none}
.cb-input-disabled input{color:var(--text-disabled)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-input-css")) { const t = document.createElement("style"); t.id = "cb-input-css"; t.textContent = css; document.head.appendChild(t); }
export function Input({ icon, placeholder, value, onChange, onKeyDown, suffix, size = "md", disabled, autoFocus, width, style, className = "" }) {
  const h = size === "sm" ? "var(--control-h-sm)" : size === "lg" ? "var(--control-h-lg)" : "var(--control-h)";
  return (
    <span className={`cb-input ${disabled ? "cb-input-disabled" : ""} ${className}`} style={{ height: h, width, ...style }}>
      {icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      <input placeholder={placeholder} value={value} onChange={onChange} onKeyDown={onKeyDown} disabled={disabled} autoFocus={autoFocus} />
      {suffix || null}
    </span>
  );
}
