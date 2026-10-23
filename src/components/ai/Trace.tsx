// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { createContext, useContext, type ComponentProps } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  type CollapsibleContentProps,
  type CollapsibleProps,
  type CollapsibleTriggerProps,
} from './Collapsible';
import './trace.css';

/**
 * The building block for what an agent did (M91.7): a reasoning step, a tool
 * call, a subagent, a source — each one line, an icon and a sentence, that
 * may open onto its detail. shadcn's Trace, kept part for part, on Cerebro's
 * Collapsible, Icon and tokens. It adds no roles: a line is text, and the
 * element that wraps it — a trigger, a link — gives it its keyboard and focus.
 */

/** The work a line reports: under way, failed, or not started. Done work
 *  has no status. */
export type TraceStatus = 'running' | 'error' | 'pending';

/**
 * A status as words, for a title that does not already say it. TraceIcon is
 * hidden, and colour and the running light say nothing to a screen reader, so
 * a line with a status always carries its words (§3.3 status words); a
 * caller with better words passes them as `statusText` — "Waiting for your
 * answer", "To do".
 */
export const TRACE_STATUS_WORDS: Readonly<Record<TraceStatus, string>> = {
  running: 'Running',
  error: 'Failed',
  pending: 'Not started',
};

/** The words a line speaks before its title, or null when it speaks none. */
export function traceStatusWords(
  status: TraceStatus | undefined,
  statusText: string | null | undefined,
): string | null {
  const words = statusText === undefined ? status && TRACE_STATUS_WORDS[status] : statusText;
  return words ? words : null;
}

/** The status of the line a title sits in, which it shimmers under. */
const TraceLineStatus = createContext<TraceStatus | undefined>(undefined);

/** A list of lines. A link or a trigger placed straight in it is the row. */
export function Trace({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="trace"
      {...props}
      className={['cb-ai-trace', className].filter(Boolean).join(' ')}
    />
  );
}

export type TraceLineProps = ComponentProps<'span'> & {
  status?: TraceStatus;
  /**
   * The status in words, read before the title. Left out, a line with a
   * status speaks its own (`TRACE_STATUS_WORDS`); `null` when the title
   * already says it ("Running pnpm build", "Failed to read notes.md"). Words
   * with no status are fine too: a finished step's "Done".
   */
  statusText?: string | null;
};

/** One line: an icon and a title. A span, not a tab stop; wrap it in a
 *  trigger or a link to make it do something. */
export function TraceLine({ status, statusText, className, children, ...props }: TraceLineProps) {
  const words = traceStatusWords(status, statusText);
  return (
    <TraceLineStatus value={status}>
      <span
        data-slot="trace-line"
        {...props}
        data-status={status}
        className={['cb-ai-trace-line', className].filter(Boolean).join(' ')}
      >
        {words !== null && <span className="sr-only">{`${words}: `}</span>}
        {children}
      </span>
    </TraceLineStatus>
  );
}

/** A decorative icon, hidden from assistive tech. Before the title it names
 *  the action; after it, it is the indicator. */
export function TraceIcon({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-icon"
      {...props}
      aria-hidden="true"
      className={['cb-ai-trace-icon', className].filter(Boolean).join(' ')}
    />
  );
}

/** One sentence on one line. It truncates, and the light passes through it
 *  while its line runs (`cb-ai-shimmer`, stilled under reduced motion). */
export function TraceTitle({ className, ...props }: ComponentProps<'span'>) {
  const status = useContext(TraceLineStatus);
  return (
    <span
      data-slot="trace-title"
      {...props}
      className={['cb-ai-trace-title', status === 'running' && 'cb-ai-shimmer', className]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

/** Secondary text after the title — a count, a duration. It never
 *  truncates; an unrecorded number is words, never 0 (CV-05). */
export function TraceDescription({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-description"
      {...props}
      className={['cb-ai-trace-description', className].filter(Boolean).join(' ')}
    />
  );
}

/** A row that expands. A controlled `open` hears the reader through
 *  `onOpenChange`; to open a row while it streams and let the reader's click
 *  win, pass `open ?? running`. */
export function TraceCollapsible({ className, ...props }: CollapsibleProps) {
  return (
    <Collapsible
      data-slot="trace-collapsible"
      {...props}
      className={['cb-ai-trace-collapsible', className].filter(Boolean).join(' ')}
    />
  );
}

/** The button that opens and closes the row: a TraceLine inside, and a
 *  chevron after it that turns as the row opens. */
export function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: CollapsibleTriggerProps) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      {...props}
      className={['cb-ai-trace-trigger', className].filter(Boolean).join(' ')}
    >
      {children}
      <TraceIcon className="cb-ai-trace-chevron">
        <Icon name="chevron-right" size={16} />
      </TraceIcon>
    </CollapsibleTrigger>
  );
}

/** The row's detail, ruled down from the line's icon. Its `className` lands
 *  on the inner block, as shadcn's does; `keepMounted` keeps it, `hidden`,
 *  while the row is closed. */
export function TraceCollapsibleContent({
  className,
  children,
  ...props
}: CollapsibleContentProps) {
  return (
    <CollapsibleContent
      data-slot="trace-collapsible-content"
      {...props}
      className="cb-ai-trace-panel"
    >
      <div
        data-slot="trace-collapsible-content-inner"
        className={['cb-ai-trace-content', className].filter(Boolean).join(' ')}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}
