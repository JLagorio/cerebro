import React from "react";
const css = `
.cb-card{background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:var(--r-lg);box-shadow:var(--shadow-sm)}
.cb-card-flat{box-shadow:none}
.cb-card-hover{transition:box-shadow var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);cursor:pointer}
.cb-card-hover:hover{box-shadow:var(--shadow-md);border-color:var(--n-300)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-card-css")) { const t = document.createElement("style"); t.id = "cb-card-css"; t.textContent = css; document.head.appendChild(t); }
export function Card({ children, flat, hoverable, padding = 16, onClick, style, className = "" }) {
  return (
    <div onClick={onClick} className={`cb-card ${flat ? "cb-card-flat" : ""} ${hoverable ? "cb-card-hover" : ""} ${className}`}
      style={{ padding, ...style }}>{children}</div>
  );
}
