import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';
import { StateMessage } from './StateMessage';

interface SectionBoundaryProps {
  /** What stopped drawing, as the fallback names it: "This page". */
  label: string;
  /** A new value starts the section over: the place a pane shows, say. */
  resetKey?: unknown;
  /** Told once per fault, after React caught it. The owner decides what to save. */
  onCatch?: (error: unknown, info: ErrorInfo) => void;
  /** The way out, when the owner has one. */
  onBack?: () => void;
  compact?: boolean;
  /** Wraps the fallback, for a section that must fill its frame. */
  fallbackClassName?: string;
  /** Mounted only while the section is down: what must keep answering then. */
  whileFailed?: ReactNode;
  children: ReactNode;
}

interface SectionBoundaryState {
  failed: boolean;
  /** Keys the children, so Retry draws them fresh. */
  attempt: number;
  resetKey: unknown;
}

/**
 * Keeps a render fault inside one section (M93.12): the rest of the window
 * stays mounted, with its drafts, decisions and streams. Presentation only,
 * like the AI elements (CV-64): it reads no store and writes nothing, and the
 * owner injects what a fault should save. Retry only draws the section again;
 * nothing here reloads the window or clears browser storage.
 */
export class SectionBoundary extends Component<SectionBoundaryProps, SectionBoundaryState> {
  state: SectionBoundaryState = { failed: false, attempt: 0, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<SectionBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: SectionBoundaryProps,
    state: SectionBoundaryState,
  ): Partial<SectionBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey)
      ? null
      : { failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onCatch?.(error, info);
  }

  private retry = (): void => {
    this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }));
  };

  render() {
    const { label, onBack, compact, fallbackClassName, whileFailed, children } = this.props;
    if (!this.state.failed) return <Fragment key={this.state.attempt}>{children}</Fragment>;
    const message = (
      <StateMessage
        state="unavailable"
        title={`${label} stopped drawing`}
        compact={compact}
        action={
          <>
            <Button size="sm" onClick={this.retry} testId="section-retry">
              Retry
            </Button>
            {onBack && (
              <Button size="sm" variant="ghost" onClick={onBack}>
                Back
              </Button>
            )}
          </>
        }
      >
        Retry draws it again. It changes nothing on disk.
      </StateMessage>
    );
    return (
      <>
        {fallbackClassName === undefined ? (
          message
        ) : (
          <div className={fallbackClassName}>{message}</div>
        )}
        {whileFailed}
      </>
    );
  }
}
