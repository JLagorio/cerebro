import React from "react";
const CFG = {
  on: { label: "On track", bg: "var(--success-50)", fg: "var(--success-700)", dot: "var(--health-on)" },
  risk: { label: "At risk", bg: "var(--warn-50)", fg: "var(--warn-700)", dot: "var(--health-risk)" },
  off: { label: "Off track", bg: "var(--danger-50)", fg: "var(--danger-700)", dot: "var(--health-off)" },
  none: { label: "No status", bg: "var(--n-50)", fg: "var(--n-500)", dot: "var(--health-none)" },
};
export function HealthChip({ health = "none", label, size = "md", style, className = "" }) {
  const c = CFG[health] || CFG.none;
  const h = size === "sm" ? 20 : 24;
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: 6, height: h, padding: "0 10px", borderRadius: "var(--r-full)", background: c.bg, color: c.fg, fontSize: "var(--text-xs)", fontWeight: 500, whiteSpace: "nowrap", ...style }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.dot, flex: "none" }}></span>
      {label || c.label}
    </span>
  );
}
