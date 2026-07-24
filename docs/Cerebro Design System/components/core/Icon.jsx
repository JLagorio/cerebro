import React from "react";
const CDN = "https://unpkg.com/lucide@0.462.0/dist/umd/lucide.min.js";
function loadLucide() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.lucide) return Promise.resolve(window.lucide);
  if (!window.__cbLucideP) {
    window.__cbLucideP = new Promise((res) => {
      const s = document.createElement("script");
      s.src = CDN; s.onload = () => res(window.lucide); s.onerror = () => res(null);
      document.head.appendChild(s);
    });
  }
  return window.__cbLucideP;
}
const pascal = (n) => String(n).split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join("");
export function Icon({ name, size = 16, strokeWidth = 1.75, color, style, className }) {
  const [, force] = React.useReducer((x) => x + 1, 0);
  const lib = typeof window !== "undefined" ? window.lucide : null;
  React.useEffect(() => { if (!lib) loadLucide().then(() => force()); }, [lib]);
  const raw = lib && lib.icons ? lib.icons[pascal(name)] : null;
  const kids = Array.isArray(raw) ? (raw.length === 3 && Array.isArray(raw[2]) ? raw[2] : raw) : null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      className={className} style={{ flex: "none", display: "inline-block", verticalAlign: "middle", color, ...style }} aria-hidden="true">
      {kids ? kids.map((k, i) => (Array.isArray(k) ? React.createElement(k[0], { ...k[1], key: i }) : null)) : null}
    </svg>
  );
}
