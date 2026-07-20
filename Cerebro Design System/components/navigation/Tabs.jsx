import React from "react";
import { Icon } from "../core/Icon.jsx";
const css = `
.cb-tabs{display:flex;gap:2px;border-bottom:1px solid var(--n-200)}
.cb-tab{font-family:var(--font-ui);font-size:var(--text-sm);font-weight:500;color:var(--n-600);background:none;border:none;border-bottom:2px solid transparent;height:34px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;outline:none;margin-bottom:-1px;transition:color var(--dur-fast) var(--ease-out)}
.cb-tab:hover{color:var(--n-900)}
.cb-tab:focus-visible{box-shadow:var(--ring);border-radius:var(--r-xs)}
.cb-tab-on{color:var(--n-900);border-bottom-color:var(--accent)}
.cb-tab .cb-tab-count{font-size:var(--text-2xs);font-weight:500;background:var(--n-100);color:var(--n-600);border-radius:var(--r-full);padding:0 6px;line-height:16px}`;
if (typeof document !== "undefined" && !document.getElementById("cb-tabs-css")) { const t = document.createElement("style"); t.id = "cb-tabs-css"; t.textContent = css; document.head.appendChild(t); }
export function Tabs({ items = [], active, onChange, style, className = "" }) {
  return (
    <div className={`cb-tabs ${className}`} style={style} role="tablist">
      {items.map((it) => (
        <button key={it.id} role="tab" aria-selected={it.id === active} className={`cb-tab ${it.id === active ? "cb-tab-on" : ""}`} onClick={() => onChange && onChange(it.id)}>
          {it.icon ? <Icon name={it.icon} size={14} /> : null}
          {it.label}
          {it.count != null ? <span className="cb-tab-count">{it.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
