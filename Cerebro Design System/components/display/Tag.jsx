import React from "react";
import { Icon } from "../core/Icon.jsx";
const css = `
.cb-tag{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:var(--r-sm);border:1px solid var(--n-200);background:var(--n-50);font-size:var(--text-xs);font-weight:500;color:var(--n-700);white-space:nowrap;max-width:100%}
.cb-tag i.cb-tag-dot{width:8px;height:8px;border-radius:3px;flex:none}
.cb-tag .cb-tag-x{display:inline-flex;border:none;background:none;padding:0;margin-left:2px;color:var(--n-500);cursor:pointer;border-radius:2px}
.cb-tag .cb-tag-x:hover{color:var(--n-800)}
.cb-tag span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;
if (typeof document !== "undefined" && !document.getElementById("cb-tag-css")) { const t = document.createElement("style"); t.id = "cb-tag-css"; t.textContent = css; document.head.appendChild(t); }
export function Tag({ children, color, icon, onRemove, style, className = "" }) {
  return (
    <span className={`cb-tag ${className}`} style={style}>
      {color ? <i className="cb-tag-dot" style={{ background: color }}></i> : icon ? <Icon name={icon} size={12} /> : null}
      <span>{children}</span>
      {onRemove ? <button className="cb-tag-x" onClick={onRemove} aria-label="Remove"><Icon name="x" size={12} /></button> : null}
    </span>
  );
}
