import React from 'react';
import { Icon } from '@/components/ui/Icon';

/** Centered empty state: icon well, headline, one helper line, one action. */
export interface EmptyStateProps {
  /** lucide icon, default "inbox" */
  icon?: string;
  title: string;
  description?: string;
  /** action node, typically a <Button> */
  action?: React.ReactNode;
  /** tighter paddings for panels */
  compact?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

export function EmptyState({
  icon = 'inbox',
  title,
  description,
  action,
  compact,
  style,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: compact ? '24px 16px' : '56px 24px',
        gap: 4,
        ...style,
      }}
    >
      <div
        style={{
          width: compact ? 36 : 48,
          height: compact ? 36 : 48,
          borderRadius: 'var(--r-lg)',
          background: 'var(--n-50)',
          border: '1px solid var(--n-100)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
        }}
      >
        <Icon name={icon} size={compact ? 16 : 20} color="var(--n-400)" strokeWidth={1.5} />
      </div>
      <div
        style={{
          fontSize: compact ? 'var(--text-sm)' : 'var(--text-lg)',
          fontWeight: 600,
          letterSpacing: 'var(--track-tight)',
          color: 'var(--n-800)',
        }}
      >
        {title}
      </div>
      {description ? (
        <div
          style={{
            fontSize: compact ? 'var(--text-xs)' : 'var(--text-sm)',
            color: 'var(--text-muted)',
            maxWidth: 340,
            lineHeight: 1.5,
          }}
        >
          {description}
        </div>
      ) : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}
