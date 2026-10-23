import type { ReactNode } from 'react';
import { Icon } from './Icon';

type ReadState = 'loading' | 'empty' | 'not-recorded' | 'partial' | 'unavailable';

const STATE_ICON: Record<ReadState, string> = {
  loading: 'clock',
  empty: 'inbox',
  'not-recorded': 'info',
  partial: 'info',
  unavailable: 'circle-alert',
};

/** Presentation only: the owning read decides what is known and supplies copy.
 * An unavailable read never passes through an empty-state branch here. */
export function StateMessage({
  state,
  title,
  children,
  action,
  compact = false,
  testId,
}: {
  state: ReadState;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={`cb-state-message${compact ? ' cb-state-message--compact' : ''}`}
      data-state={state}
      data-testid={testId ?? (state === 'unavailable' ? 'section-unavailable' : undefined)}
      role={state === 'loading' ? 'status' : undefined}
    >
      <Icon name={STATE_ICON[state]} size={16} className="cb-state-message-icon" />
      <div className="cb-state-message-content">
        <p className="cb-state-message-title">{title}</p>
        {children && <div className="cb-state-message-description">{children}</div>}
        {action && <div className="cb-state-message-action">{action}</div>}
      </div>
    </div>
  );
}
