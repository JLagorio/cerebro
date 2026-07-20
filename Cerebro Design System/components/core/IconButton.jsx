import React from "react";
import { Icon } from "./Icon.jsx";
const css = `
.cb-ibtn{display:inline-flex;align-items:center;justify-content:center;border-radius:var(--r-sm);border:1px solid transparent;background:transparent;color:var(--n-600);cursor:pointer;transition:background var(--dur-fast) var(--ease-out);outline:none;padding:0}
.cb-ibtn:hover:not([disabled]){background:var(--n-100);color:var(--n-800)}
.cb-ibtn:active:not([disabled]){background:var(--n-200)}
.cb-ibtn:focus-visible{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-ibtn[disabled]{opacity:.45;cursor:not-allowed}
.cb-ibtn-outline{border-color:var(--n-300);background:var(--n-0)}
.cb-ibtn-outline:hover:not([disabled]){background:var(--n-50)}
.cb-ibtn-active{background:var(--surface-selected);color:var(--cortex-600)}
.cb-ibtn-active:hover:not([disabled]){background:var(--cortex-100);color:var(--cortex-700)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-ibtn-css")) { const t = document.createElement("style"); t.id = "cb-ibtn-css"; t.textContent = css; document.head.appendChild(t); }
export function IconButton({ icon, label, size = "md", variant = "ghost", active, disabled, onClick, style, className = "" }) {
  const px = size === "sm" ? 24 : size === "lg" ? 32 : 28;
  const ic = size === "sm" ? 14 : 16;
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}
      className={`cb-ibtn ${variant === "outline" ? "cb-ibtn-outline" : ""} ${active ? "cb-ibtn-active" : ""} ${className}`}
      style={{ width: px, height: px, ...style }}>
      <Icon name={icon} size={ic} />
    </button>
  );
}
