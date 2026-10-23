// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps, ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { StepSummary } from '@/engine/ai/steps';
import { Badge, type BadgeProps } from './Badge';
import type {
  CollapsibleContentProps,
  CollapsibleOpenProps,
  CollapsibleTriggerProps,
} from './Collapsible';
import { StepHead, plural, useStepOpen, type StepState } from './StepLine';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './Trace';
import './trace-steps.css';

/**
 * A turn's working, folded into one line (M91.9, shadcn's Chain of Thought):
 * "Working" while it goes on, then how many steps it took and how many
 * failed, opening onto the steps inside.
 *
 * The caller decides what goes inside, and the rule is narrow (§3.3): only
 * what the transcript already folds — runs of finished reads — and reasoning
 * lines. A change, a concept, a hand-off, a commit or a view, and any step
 * that failed, was interrupted, waits, was cancelled, never ran or is paused,
 * stays a line of its own beside the chain, where the reader sees it without
 * opening anything.
 */

/** What the summary line counts: `summarizeSteps` (engine/ai/steps.ts) over
 *  the steps the caller counts. */
export type ChainSummary = Pick<StepSummary, 'running' | 'total' | 'failed'>;

/** The chain's state, for its line. */
function chainState(summary: ChainSummary): StepState {
  if (summary.running) return 'running';
  return summary.failed > 0 ? 'failed' : 'done';
}

/** "Working" while a step runs; then "5 steps", or "5 steps, 1 failed". */
export function chainTitle(summary: ChainSummary): string {
  if (summary.running) return 'Working';
  const steps = plural(summary.total, 'step', 'steps');
  return summary.failed > 0 ? `${steps}, ${summary.failed} failed` : steps;
}

/** The summary line: a trigger, to sit in a TraceCollapsible. */
export function ChainOfThoughtHeader({
  summary,
  title,
  icon,
  ...props
}: Omit<CollapsibleTriggerProps, 'title' | 'children'> & {
  summary: ChainSummary;
  /** The line's sentence; left out, the counts (`chainTitle`). */
  title?: ReactNode;
  icon?: string;
}) {
  return (
    <TraceCollapsibleTrigger {...props}>
      <StepHead
        status={chainState(summary)}
        // The counts say the state: "Working", "1 failed".
        statusText={title === undefined ? null : undefined}
        icon={icon}
        title={title ?? chainTitle(summary)}
      />
    </TraceCollapsibleTrigger>
  );
}

/** The steps inside, kept in the document while the chain is closed so each
 *  keeps its own open state. */
export function ChainOfThoughtContent({
  keepMounted = true,
  children,
  ...props
}: CollapsibleContentProps) {
  return (
    <TraceCollapsibleContent keepMounted={keepMounted} {...props}>
      <Trace>{children}</Trace>
    </TraceCollapsibleContent>
  );
}

export type ChainOfThoughtProps = Omit<ComponentProps<'div'>, 'title' | 'children'> &
  CollapsibleOpenProps & {
    summary: ChainSummary;
    /** The line's sentence; left out, the counts (`chainTitle`). */
    title?: ReactNode;
    icon?: string;
    /** The steps inside: only folded reads and reasoning lines (see above).
     *  The caller draws them, with Task and Reasoning. */
    children?: ReactNode;
  };

/**
 * The chain. It opens while a step runs and when one failed, and the reader's
 * choice wins from then on; the caller opens the latest turn's with
 * `defaultOpen`.
 */
export function ChainOfThought({
  summary,
  title,
  icon,
  children,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: ChainOfThoughtProps) {
  const opened = useStepOpen(
    { open, defaultOpen, onOpenChange },
    summary.running || summary.failed > 0,
  );
  return (
    <TraceCollapsible
      data-slot="chain-of-thought"
      data-status={chainState(summary)}
      {...props}
      className={className}
      open={opened.open}
      onOpenChange={opened.onOpenChange}
    >
      <ChainOfThoughtHeader summary={summary} title={title} icon={icon} />
      <ChainOfThoughtContent>{children}</ChainOfThoughtContent>
    </TraceCollapsible>
  );
}

export type ChainOfThoughtStepProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** An icon name; a dot by default. */
  icon?: string;
  label: ReactNode;
  description?: ReactNode;
  /** AI SDK Elements' words: `active` runs, `pending` has not started. */
  status?: 'complete' | 'active' | 'pending';
};

/** A step of the caller's own, as a plain line. */
export function ChainOfThoughtStep({
  icon = 'dot',
  label,
  description,
  status = 'complete',
  ...props
}: ChainOfThoughtStepProps) {
  return (
    <TraceLine
      {...props}
      status={status === 'active' ? 'running' : status === 'pending' ? 'pending' : undefined}
    >
      <TraceIcon>
        <Icon name={icon} />
      </TraceIcon>
      <TraceTitle>{label}</TraceTitle>
      {description !== undefined && description !== null && (
        <TraceDescription>{description}</TraceDescription>
      )}
    </TraceLine>
  );
}

/** The hosts a search step found, as chips. */
export function ChainOfThoughtSearchResults({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="chain-of-thought-search-results"
      {...props}
      className={['cb-ai-chips', className].filter(Boolean).join(' ')}
    />
  );
}

export function ChainOfThoughtSearchResult(props: BadgeProps) {
  return <Badge variant="secondary" data-slot="chain-of-thought-search-result" {...props} />;
}
