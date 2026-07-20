import React from "react";
const STATUSES = {
  idea: { label: "New idea", color: "var(--status-idea)" },
  planned: { label: "Planned", color: "var(--status-planned)" },
  progress: { label: "In progress", color: "var(--status-progress)" },
  validation: { label: "Validation", color: "var(--status-validation)" },
  released: { label: "Released", color: "var(--status-released)" },
  wontdo: { label: "Won't do", color: "var(--status-wontdo)" },
};
export function StatusFlag({ status = "idea", label, color, bare, size = "md", style, className = "" }) {
  const s = STATUSES[status] || STATUSES.idea;
  const c = color || s.color;
  const flag = (
    <svg width={size === "sm" ? 12 : 14} height={size === "sm" ? 12 : 14} viewBox="0 0 24 24" fill={c} stroke="none" style={{ flex: "none" }} aria-hidden="true">
      <path d="M6 3h13l-3.5 5L19 13H6v8H4V3h2z" />
    </svg>
  );
  if (bare) return <span title={label || s.label} className={className} style={{ display: "inline-flex", ...style }}>{flag}</span>;
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: 6, height: size === "sm" ? 20 : 24, padding: "0 8px", borderRadius: "var(--r-sm)", background: "var(--n-50)", border: "1px solid var(--n-200)", fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--n-700)", whiteSpace: "nowrap", ...style }}>
      {flag}{label || s.label}
    </span>
  );
}
