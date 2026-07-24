import React from "react";
import { Icon } from "../core/Icon.jsx";
const css = `
.cb-ask{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;background:var(--n-0);border:1px solid var(--n-300);border-radius:var(--r-lg);cursor:text;transition:border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)}
.cb-ask:hover{border-color:var(--n-400)}
.cb-ask:focus-within{border-color:var(--border-focus);box-shadow:var(--ring)}
.cb-ask input{border:none;outline:none;background:transparent;flex:1;min-width:0;font-family:var(--font-ui);font-size:var(--text-sm);color:var(--text-primary)}
.cb-ask input::placeholder{color:var(--n-500)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-ask-css")) { const t = document.createElement("style"); t.id = "cb-ask-css"; t.textContent = css; document.head.appendChild(t); }
export function AskBar({ placeholder = "Search or ask Cerebro", value, onChange, onSubmit, width = 520, style, className = "" }) {
  const [inner, setInner] = React.useState("");
  const v = value != null ? value : inner;
  return (
    <div className={`cb-ask ${className}`} style={{ width, ...style }}>
      <Icon name="sparkles" size={15} color="var(--synapse-500)" />
      <input placeholder={placeholder} value={v}
        onChange={(e) => { onChange ? onChange(e) : setInner(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter" && onSubmit) onSubmit(v); }} />
      <kbd>⌘K</kbd>
    </div>
  );
}
