import React from "react";
import { IconButton } from "../core/IconButton.jsx";
import { Button } from "../core/Button.jsx";
const css = `
.cb-dlg-scrim{position:fixed;inset:0;background:var(--scrim);display:flex;align-items:flex-start;justify-content:center;padding:64px 24px;z-index:1000;animation:cbFade var(--dur-med) var(--ease-out)}
.cb-dlg{background:var(--n-0);border-radius:var(--r-xl);box-shadow:var(--shadow-lg);width:100%;display:flex;flex-direction:column;max-height:calc(100vh - 128px);animation:cbUp var(--dur-med) var(--ease-out)}
.cb-dlg-hd{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 0 24px}
.cb-dlg-hd h2{margin:0;font-size:var(--text-lg);line-height:var(--leading-lg);font-weight:600;letter-spacing:var(--track-tight);color:var(--n-900)}
.cb-dlg-bd{padding:16px 24px;overflow:auto;font-size:var(--text-sm);color:var(--n-800)}
.cb-dlg-ft{display:flex;align-items:center;gap:8px;padding:14px 24px;border-top:1px solid var(--n-100)}
.cb-dlg-ft .cb-dlg-note{font-size:var(--text-xs);color:var(--text-muted);margin-right:auto}
@keyframes cbFade{from{opacity:0}to{opacity:1}}
@keyframes cbUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`;
if (typeof document !== "undefined" && !document.getElementById("cb-dlg-css")) { const t = document.createElement("style"); t.id = "cb-dlg-css"; t.textContent = css; document.head.appendChild(t); }
export function Dialog({ open, onClose, title, children, width = 560, primaryAction, secondaryAction, footerNote, style }) {
  if (!open) return null;
  return (
    <div className="cb-dlg-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div className="cb-dlg" role="dialog" aria-modal="true" style={{ maxWidth: width, ...style }}>
        <div className="cb-dlg-hd"><h2>{title}</h2><IconButton icon="x" label="Close" onClick={onClose} /></div>
        <div className="cb-dlg-bd">{children}</div>
        {(primaryAction || secondaryAction || footerNote) ? (
          <div className="cb-dlg-ft">
            {footerNote ? <span className="cb-dlg-note">{footerNote}</span> : <span className="cb-dlg-note"></span>}
            {secondaryAction ? <Button onClick={secondaryAction.onClick}>{secondaryAction.label}</Button> : null}
            {primaryAction ? <Button variant="primary" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>{primaryAction.label}</Button> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
