import type { ReactNode } from 'react';
import './pageHeader.css';

/** Shared page rhythm; each surface still owns its title controls and facts. */
export function PageHeader({
  title,
  icon,
  metadata,
  description,
  actions,
  headingTestId,
  className = '',
  variant = 'workspace',
  composition,
}: {
  title: ReactNode;
  icon?: ReactNode;
  metadata?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingTestId?: string;
  className?: string;
  variant?: 'workspace' | 'compact' | 'tool';
  /** Opt-in pane composition; the nearest .cb-composition owns its width. */
  composition?: 'collection' | 'utility';
}) {
  return (
    <header
      className={`cb-page-header cb-page-header--${variant} ${className}`}
      data-composition={composition}
    >
      <div className="cb-page-header-line">
        {icon !== undefined && <div className="cb-page-header-icon">{icon}</div>}
        <h1 className="cb-page-heading" data-testid={headingTestId}>
          {title}
        </h1>
        {metadata !== undefined && <div className="cb-page-header-meta">{metadata}</div>}
        {actions !== undefined && <div className="cb-page-header-actions">{actions}</div>}
      </div>
      {description !== undefined && <div className="cb-page-description">{description}</div>}
    </header>
  );
}
