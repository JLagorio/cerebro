import React from "react";
import { Icon } from "../core/Icon.jsx";
export function AISummary({ title = "AI summary", children, sources, onRegenerate, style, className = "" }) {
  return (
    <div className={className} style={{ background: "var(--surface-ai)", border: "1px solid var(--synapse-200)", borderRadius: "var(--r-lg)", padding: "12px 14px", ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <Icon name="sparkles" size={13} color="var(--synapse-500)" />
        <span style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-ai)" }}>{title}</span>
        {onRegenerate ? (
          <button onClick={onRegenerate} title="Regenerate" style={{ marginLeft: "auto", border: "none", background: "none", padding: 2, color: "var(--synapse-400)", cursor: "pointer", display: "inline-flex", borderRadius: 4 }}>
            <Icon name="refresh-cw" size={12} />
          </button>
        ) : null}
      </div>
      <div style={{ fontSize: "var(--text-xs)", lineHeight: "18px", color: "var(--n-700)" }}>{children}</div>
      {sources ? <div style={{ marginTop: 8, fontSize: "var(--text-2xs)", color: "var(--synapse-600)" }}>{sources}</div> : null}
    </div>
  );
}
