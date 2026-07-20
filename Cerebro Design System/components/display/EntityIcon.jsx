import React from "react";
import { Icon } from "../core/Icon.jsx";
const MAP = {
  objective: { icon: "target", color: "var(--ent-objective)" },
  keyResult: { icon: "trending-up", color: "var(--ent-keyresult)" },
  initiative: { icon: "diamond", color: "var(--ent-initiative)" },
  product: { icon: "package", color: "var(--ent-product)" },
  component: { icon: "layout-grid", color: "var(--ent-component)" },
  release: { icon: "flag", color: "var(--ent-release)" },
  releaseGroup: { icon: "flag", color: "var(--ent-releasegroup)" },
  company: { icon: "building-2", color: "var(--ent-company)" },
  user: { icon: "circle-user", color: "var(--ent-user)" },
  signal: { icon: "message-square-text", color: "var(--n-600)" },
  finding: { icon: "radar", color: "var(--synapse-500)" },
  opportunity: { icon: "lightbulb", color: "var(--synapse-600)" },
  ai: { icon: "sparkles", color: "var(--synapse-500)" },
};
export function EntityIcon({ type, size = 16, swatch, style, className = "" }) {
  if (type === "feature") {
    const s = Math.round(size * 0.7);
    return <span className={className} title="Feature" style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", verticalAlign: "middle", ...style }}><span style={{ width: s, height: s, borderRadius: Math.max(2, s * 0.28), background: swatch || "var(--ent-feature)" }}></span></span>;
  }
  if (type === "subfeature") {
    const s = Math.round(size * 0.5);
    return <span className={className} title="Subfeature" style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", verticalAlign: "middle", ...style }}><span style={{ width: s, height: s, borderRadius: "50%", background: swatch || "var(--ent-subfeature)" }}></span></span>;
  }
  const m = MAP[type] || { icon: "circle", color: "var(--n-500)" };
  return <Icon name={m.icon} size={size} color={swatch || m.color} strokeWidth={2} className={className} style={style} />;
}
