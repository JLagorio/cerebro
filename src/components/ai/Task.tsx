// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps, ReactNode } from 'react';
import { Badge } from './Badge';
import type { CollapsibleOpenProps } from './Collapsible';
import { StepHead, useStepOpen, type StepState } from './StepLine';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger } from './Trace';
import './trace-steps.css';

/**
 * A piece of work and the steps it took (M91.9, shadcn's Task): a titled line
 * — what the agent is doing, then what it did — that opens onto its steps.
 * The assistant folds a run of reads into one ("Read 5 notes", M56.8): the
 * steps are those calls, kept in the document while folded, so each is still
 * the row it was.
 */

export type TaskProps = Omit<ComponentProps<'div'>, 'title' | 'children'> &
  CollapsibleOpenProps & {
    /** What the work is, in its state's tense: "Reading 5 notes", "Read 5 notes". */
    title: ReactNode;
    status?: StepState;
    /** The state in words; see StepLine's `stepWords`. Pass null when the
     *  title already says it ("Reading 5 notes"). */
    statusText?: string | null;
    /** An icon name; left out, the state's own. */
    icon?: string;
    description?: ReactNode;
    /** The steps: trace rows the caller draws. */
    children?: ReactNode;
  };

/** The work. It opens while it runs and closes once it is done, unless the
 *  reader chose. */
export function Task({
  title,
  status = 'done',
  statusText,
  icon,
  description,
  children,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: TaskProps) {
  const opened = useStepOpen({ open, defaultOpen, onOpenChange }, status === 'running');
  return (
    <TraceCollapsible
      data-slot="task"
      data-status={status}
      {...props}
      className={className}
      open={opened.open}
      onOpenChange={opened.onOpenChange}
    >
      <TraceCollapsibleTrigger>
        <StepHead
          status={status}
          statusText={statusText}
          icon={icon}
          title={title}
          description={description}
        />
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted>
        <Trace data-slot="task-steps">{children}</Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

export type TaskItemProps = Omit<ComponentProps<'div'>, 'children'> & {
  status?: StepState;
  statusText?: string | null;
  icon?: string;
  /** The step, in its state's tense: "Searched notes for release". */
  children: ReactNode;
};

/** One step of a task, as a plain line. */
export function TaskItem({
  status = 'done',
  statusText,
  icon,
  children,
  className,
  ...props
}: TaskItemProps) {
  return (
    <div
      data-slot="task-item"
      data-status={status}
      {...props}
      className={['cb-ai-step', className].filter(Boolean).join(' ')}
    >
      <StepHead status={status} statusText={statusText} icon={icon} title={children} />
    </div>
  );
}

/** A file a step names, as a chip. */
export function TaskItemFile({ className, ...props }: ComponentProps<'span'>) {
  return (
    <Badge
      variant="outline"
      data-slot="task-item-file"
      {...props}
      className={['cb-ai-mono', className].filter(Boolean).join(' ')}
    />
  );
}
