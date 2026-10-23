// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps, ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { todoCounts } from '@/engine/ai/todos';
import type { TodoItem } from '@/engine/ai/types';
import type { CollapsibleOpenProps } from './Collapsible';
import {
  TODO_STATUS_ICONS,
  UNKNOWN_TODO_ICON,
  todoStatusOf,
  todoStatusWords,
  todoTitle,
} from './Queue';
import { useStepOpen } from './StepLine';
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
import './trace-results.css';

/**
 * The agent's plan, and how far it has got (M91.9, shadcn's Plan): one line,
 * "Plan" and "2 of 5 done", that opens onto its steps. The steps are the
 * agent's own todo list (TodoWrite, Q9) as its latest readable write left it
 * (engine/ai/todos.ts); a turn with no readable write draws no Plan (CV-05),
 * and the caller leaves it out.
 *
 * A step says what is to be done, in the imperative, and says its status in
 * words before it ("To do", "In progress", "Done"); the step under way reads
 * what the agent is doing — its `activeForm` — with the working light, only
 * while the run is live. A step not yet started is fainter, as shadcn's are.
 * The plan opens while the run works through it and closes when it stops,
 * unless the reader chose.
 */

/** The plan's words, unless the caller says better. */
export const PLAN_WORDS = {
  title: 'Plan',
  /** The plan's own status while the run works through it. */
  working: 'In progress',
  noSteps: 'No steps',
  progress: (done: number, total: number) => `${done} of ${total} done`,
} as const;

/** "2 of 5 done", or "No steps" for a list the agent left empty. */
export function planProgress(todos: readonly TodoItem[]): string {
  const { done, total } = todoCounts(todos);
  return total === 0 ? PLAN_WORDS.noSteps : PLAN_WORDS.progress(done, total);
}

export type PlanStepProps = Omit<ComponentProps<'span'>, 'children'> & {
  todo: TodoItem;
  /** The run is live: the step under way is under way now. */
  isStreaming?: boolean;
};

/** One step of the plan, as a line. */
export function PlanStep({ todo, isStreaming = false, ...props }: PlanStepProps) {
  const status = todoStatusOf(todo.status);
  const traced =
    status === 'in_progress' && isStreaming
      ? 'running'
      : status === 'pending'
        ? 'pending'
        : undefined;
  return (
    <TraceLine
      data-todo={todo.status}
      {...props}
      status={traced}
      statusText={todoStatusWords(todo.status)}
    >
      <TraceIcon>
        <Icon name={status === null ? UNKNOWN_TODO_ICON : TODO_STATUS_ICONS[status]} size={16} />
      </TraceIcon>
      <TraceTitle>{todoTitle(todo, isStreaming)}</TraceTitle>
    </TraceLine>
  );
}

export type PlanProps = Omit<ComponentProps<'div'>, 'title' | 'children'> &
  CollapsibleOpenProps & {
    /** The list the agent's latest readable write left. */
    todos: readonly TodoItem[];
    /** The run is live: the plan is being worked through now. */
    isStreaming?: boolean;
    /** The line's sentence; left out, "Plan". */
    title?: ReactNode;
    /** After the title; left out, the progress ("2 of 5 done"). */
    description?: ReactNode;
    /** Above the steps: a sentence on what the plan is for. */
    children?: ReactNode;
  };

/** The plan. A list the agent left empty is a plain line, "No steps". */
export function Plan({
  todos,
  isStreaming = false,
  title = PLAN_WORDS.title,
  description,
  children,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: PlanProps) {
  const { done, total } = todoCounts(todos);
  const working = isStreaming && done < total;
  const opened = useStepOpen({ open, defaultOpen, onOpenChange }, working);
  const line = (
    <TraceLine
      status={working ? 'running' : undefined}
      statusText={working ? PLAN_WORDS.working : null}
    >
      <TraceIcon>
        <Icon name="route" size={16} />
      </TraceIcon>
      <TraceTitle>{title}</TraceTitle>
      <TraceDescription>{description ?? planProgress(todos)}</TraceDescription>
    </TraceLine>
  );
  const root = {
    'data-slot': 'plan',
    'data-status': working ? 'running' : undefined,
    ...props,
  };
  const hasChildren = children !== undefined && children !== null && children !== false;
  if (total === 0 && !hasChildren) {
    return (
      <div {...root} className={['cb-ai-plan', className].filter(Boolean).join(' ')}>
        {line}
      </div>
    );
  }
  return (
    <TraceCollapsible
      {...root}
      className={className}
      open={opened.open}
      onOpenChange={opened.onOpenChange}
    >
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted className="cb-ai-plan-content">
        {hasChildren && <div data-slot="plan-details">{children}</div>}
        {total > 0 && (
          <Trace data-slot="plan-steps">
            {todos.map((todo, index) => (
              // A list may name one todo twice; its place is its identity.
              <PlanStep key={`${index}:${todo.content}`} todo={todo} isStreaming={isStreaming} />
            ))}
          </Trace>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
