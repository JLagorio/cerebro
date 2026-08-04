import React from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';

const CFG: Record<string, { icon: string; color: string }> = {
  neutral: { icon: 'info', color: 'var(--n-600)' },
  success: { icon: 'circle-check', color: 'var(--success-500)' },
  warn: { icon: 'triangle-alert', color: 'var(--warn-500)' },
  danger: { icon: 'circle-alert', color: 'var(--danger-500)' },
  ai: { icon: 'sparkles', color: 'var(--synapse-500)' },
};

/** Notification card (position it fixed bottom-left in app shells). */
export interface ToastProps {
  /** "neutral" (default) | "success" | "warn" | "danger" | "ai" */
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'ai';
  title: string;
  description?: string;
  action?: { label: string; onClick?: () => void };
  onDismiss?: () => void;
  style?: React.CSSProperties;
  className?: string;
}

export function Toast({
  tone = 'neutral',
  title,
  description,
  action,
  onDismiss,
  style,
  className = '',
}: ToastProps) {
  const c = CFG[tone] || CFG.neutral;
  return (
    <div
      className={className}
      // No role="status" here: ToastHost owns one live region that pre-exists
      // the toast. A second live region on the node being inserted double-
      // announces at best, and on its own is usually missed entirely.
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        width: 360,
        background: 'var(--n-0)',
        border: '1px solid var(--n-200)',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--shadow-lg)',
        padding: '12px 12px 12px 14px',
        ...style,
      }}
    >
      <Icon name={c.icon} size={16} color={c.color} style={{ marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--n-900)' }}>
          {title}
        </div>
        {description ? (
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginTop: 2 }}>
            {description}
          </div>
        ) : null}
        {action ? (
          <button
            onClick={action.onClick}
            style={{
              marginTop: 8,
              border: 'none',
              background: 'none',
              padding: 0,
              fontFamily: 'var(--font-ui)',
              fontSize: 'var(--fs-xs)',
              fontWeight: 600,
              color: 'var(--text-link)',
              cursor: 'pointer',
            }}
          >
            {action.label}
          </button>
        ) : null}
      </div>
      {onDismiss ? <IconButton icon="x" label="Dismiss" size="sm" onClick={onDismiss} /> : null}
    </div>
  );
}
