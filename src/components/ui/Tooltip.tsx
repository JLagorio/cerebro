import React from 'react';

const css = `
.cb-tip{position:relative;display:inline-flex}
.cb-tip .cb-tip-bubble{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%) translateY(2px);background:var(--n-800);color:#fff;font-family:var(--font-ui);font-size:var(--text-2xs);line-height:16px;font-weight:500;padding:4px 8px;border-radius:var(--r-sm);white-space:nowrap;pointer-events:none;opacity:0;transition:opacity var(--dur-fast) var(--ease-out),transform var(--dur-fast) var(--ease-out);z-index:900}
.cb-tip:hover .cb-tip-bubble,.cb-tip:focus-within .cb-tip-bubble{opacity:1;transform:translateX(-50%) translateY(0)}
.cb-tip-bottom .cb-tip-bubble{bottom:auto;top:calc(100% + 6px)}
.cb-tip .cb-tip-kbd{font-family:var(--font-mono);opacity:.7;margin-left:6px}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-tip-css')) {
  const t = document.createElement('style');
  t.id = 'cb-tip-css';
  t.textContent = css;
  document.head.appendChild(t);
}

/** Hover tooltip: ink bubble, optional kbd hint. */
export interface TooltipProps {
  content: React.ReactNode;
  /** keyboard hint, e.g. "⌘K" */
  kbd?: string;
  /** "top" (default) | "bottom" */
  side?: 'top' | 'bottom';
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export function Tooltip({
  content,
  kbd,
  side = 'top',
  children,
  style,
  className = '',
}: TooltipProps) {
  return (
    <span
      className={`cb-tip ${side === 'bottom' ? 'cb-tip-bottom' : ''} ${className}`}
      style={style}
    >
      {children}
      <span className="cb-tip-bubble" role="tooltip">
        {content}
        {kbd ? <span className="cb-tip-kbd">{kbd}</span> : null}
      </span>
    </span>
  );
}
