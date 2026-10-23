// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps } from 'react';
import type { CollapsibleOpenProps } from './Collapsible';
import { StepHead, formatDuration, useStepOpen } from './StepLine';
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger } from './Trace';
import './trace-steps.css';

/**
 * The model's thinking (M91.9, shadcn's Reasoning): "Thinking", with the
 * working light, while it streams, and open so the thinking shows as it
 * comes; "Thought" once it is done, closing unless the reader chose. How long
 * it took is said only when it was measured (CV-05): "Thought for 12s", else
 * "Thought". Thinking Claude Code withheld says so, with nothing to open.
 * Finished thinking with no text draws no line (§3.3): Claude Code writes
 * empty thinking unless asked to show it, and a line saying only "Thought"
 * tells the reader nothing.
 */

export interface ReasoningWords {
  isStreaming?: boolean;
  /** How long it took, from the timestamps of its lines. */
  durationMs?: number;
  /** Claude Code withheld the text (a `redacted_thinking` block). */
  redacted?: boolean;
}

/** The line's sentence. */
export function reasoningTitle({ isStreaming, durationMs, redacted }: ReasoningWords): string {
  if (redacted === true) return 'Reasoning hidden by Claude Code';
  if (isStreaming === true) return 'Thinking';
  if (durationMs === undefined) return 'Thought';
  return durationMs < 1000
    ? 'Thought for under a second'
    : `Thought for ${formatDuration(durationMs)}`;
}

export type ReasoningProps = Omit<ComponentProps<'div'>, 'children'> &
  CollapsibleOpenProps &
  ReasoningWords & {
    /** The thinking, as written; empty, there is nothing to open, and once
     *  it is done nothing to draw. */
    text: string;
  };

/** One block of thinking. Several in a turn are a line each. */
export function Reasoning({
  text,
  isStreaming = false,
  durationMs,
  redacted = false,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: ReasoningProps) {
  const running = isStreaming && !redacted;
  const opened = useStepOpen({ open, defaultOpen, onOpenChange }, running);
  const head = (
    <StepHead
      status={running ? 'running' : 'done'}
      statusText={null}
      icon={redacted ? 'eye-off' : 'brain'}
      title={reasoningTitle({ isStreaming, durationMs, redacted })}
    />
  );
  const empty = text.trim() === '';
  if (empty && !running && !redacted) return null;
  if (redacted || empty) {
    return (
      <div
        data-slot="reasoning"
        data-status={running ? 'running' : 'done'}
        data-redacted={redacted ? '' : undefined}
        {...props}
        className={['cb-ai-step', className].filter(Boolean).join(' ')}
      >
        {head}
      </div>
    );
  }
  return (
    <TraceCollapsible
      data-slot="reasoning"
      data-status={running ? 'running' : 'done'}
      {...props}
      className={className}
      open={opened.open}
      onOpenChange={opened.onOpenChange}
    >
      <TraceCollapsibleTrigger>{head}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="cb-ai-reasoning-text">{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
