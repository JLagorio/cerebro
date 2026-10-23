// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { Children, type ComponentProps, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { SubagentSummary } from '@/engine/ai/types';
import { Badge } from './Badge';
import { CodeBlock, CodeBlockContent } from './CodeBlock';
import type { CollapsibleOpenProps } from './Collapsible';
import { StepHead, formatDuration, plural, useStepOpen, type StepState } from './StepLine';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
} from './Trace';
import './trace-steps.css';

/**
 * A subagent a run started, with its steps and what it found (M91.9,
 * shadcn's Subagent): one line that says what it was asked to do, what kind
 * it is, and how many tools it used for how long — never its tokens (Q7) —
 * with what it is doing now under the line while it runs. The line opens onto
 * the steps it took, which the caller draws, and its answer.
 *
 * A Cerebro hand-off is not a subagent of the run: `hand_to` returns at once
 * and the agent it named works in a run of its own. `SubagentHandoff` says
 * "Handed to …" and opens that run; it never says the work is done.
 */

/** A subagent as this element draws it: what the run reported of it, and,
 *  while it runs, what it is doing now ("Reading hello.txt"). */
export interface SubagentView extends SubagentSummary {
  progress?: string;
}

/** Its tool uses and its time, each only as recorded (CV-05). */
export function subagentFacts(run: Pick<SubagentSummary, 'toolUses' | 'durationMs'>) {
  const facts = [
    run.toolUses !== undefined && plural(run.toolUses, 'tool use', 'tool uses'),
    run.durationMs !== undefined && formatDuration(run.durationMs),
  ].filter(Boolean);
  return facts.length === 0 ? undefined : facts.join(' · ');
}

/** What the steps say when there are none to draw: none yet while it runs,
 *  none if it used no tools, and otherwise that nobody kept them. A
 *  subagent that never ran says nothing. */
function noSteps(run: SubagentView): string | null {
  if (run.status === 'running') return null;
  if (run.toolUses === 0) return 'It used no tools';
  const ran = run.status === 'done' || run.status === 'failed' || run.status === 'interrupted';
  return ran ? 'Steps not recorded' : null;
}

export type SubagentProps = Omit<ComponentProps<'div'>, 'title' | 'children'> &
  CollapsibleOpenProps & {
    run: SubagentView;
    /** The line's sentence; left out, what it was asked to do. */
    title?: ReactNode;
    /** The state in words; left out, the state's own, and "Done" once it is. */
    statusText?: string | null;
    /** What went wrong, in Claude Code's words: its own failure, or why its
     *  call was refused. Its first lines show under the line while it is
     *  closed, and the whole of it inside. */
    error?: string | null;
    /** Its steps, drawn by the caller as trace rows. */
    children?: ReactNode;
  };

/**
 * One subagent. It opens while it runs and closes when it ends, unless the
 * reader chose; `defaultOpen` keeps a finished one open. A kind nobody named
 * draws no badge, never an empty one.
 */
export function Subagent({
  run,
  title,
  statusText,
  error,
  children,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: SubagentProps) {
  const running = run.status === 'running';
  const opened = useStepOpen({ open, defaultOpen, onOpenChange }, running);
  const steps = Children.toArray(children);
  const why = error?.trim() ?? '';
  // What went wrong says why there are no steps; nothing else is claimed.
  const empty = steps.length === 0 && why === '' ? noSteps(run) : null;
  const kind = run.type.trim();
  const head = (
    <StepHead
      status={run.status}
      // The description says what it was asked, not how it went.
      statusText={
        statusText !== undefined ? statusText : run.status === 'done' ? 'Done' : undefined
      }
      title={title ?? (run.description.trim() === '' ? 'Subagent' : run.description)}
      after={
        kind === '' ? undefined : (
          <Badge variant="secondary" data-slot="subagent-type">
            <span className="sr-only">by the </span>
            {kind}
          </Badge>
        )
      }
      description={subagentFacts(run)}
      progress={running ? run.progress : undefined}
    />
  );
  const hasSummary = run.summary !== undefined && run.summary !== '';
  if (
    steps.length === 0 &&
    empty === null &&
    !hasSummary &&
    run.model === undefined &&
    why === ''
  ) {
    return (
      <div
        data-slot="subagent"
        data-status={run.status}
        {...props}
        className={['cb-ai-step', className].filter(Boolean).join(' ')}
      >
        {head}
      </div>
    );
  }
  return (
    <TraceCollapsible
      data-slot="subagent"
      data-status={run.status}
      {...props}
      className={className}
      open={opened.open}
      onOpenChange={opened.onOpenChange}
    >
      <TraceCollapsibleTrigger>{head}</TraceCollapsibleTrigger>
      {why !== '' && (
        // Its first lines while closed; open, the whole of it says them.
        <p data-slot="subagent-error" hidden={opened.open} className="cb-ai-handoff-refusal">
          {why}
        </p>
      )}
      <TraceCollapsibleContent keepMounted className="cb-ai-step-detail">
        {why !== '' && (
          <CodeBlock size="sm" variant="destructive" data-slot="subagent-error-detail">
            <CodeBlockContent wrap className="cb-ai-step-code">
              {why}
            </CodeBlockContent>
          </CodeBlock>
        )}
        {run.model !== undefined && (
          <div className="cb-ai-subagent-meta">
            <Badge variant="outline" data-slot="subagent-model">
              <span className="sr-only">Model: </span>
              {run.model}
            </Badge>
          </div>
        )}
        {steps.length > 0 ? (
          <Trace data-slot="subagent-steps">{children}</Trace>
        ) : (
          empty !== null && (
            <p data-slot="subagent-no-steps" className="cb-ai-step-quiet">
              {empty}
            </p>
          )
        )}
        {hasSummary && (
          <p data-slot="subagent-result" className="cb-ai-subagent-result">
            {run.summary}
          </p>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** A hand-off's sentence in its state: "Handed to scout" once it went,
 *  which is all a hand-off's return says — the work goes on in its own run. */
export function handoffTitle(agent: string, status: StepState): string {
  switch (status) {
    case 'done':
      return `Handed to ${agent}`;
    case 'running':
      return `Handing to ${agent}`;
    case 'failed':
      return `Couldn't hand to ${agent}`;
    case 'denied':
      return `Denied the hand-off to ${agent}`;
    default:
      return `Hand to ${agent}`;
  }
}

export type SubagentHandoffProps = Omit<ComponentProps<'div'>, 'title' | 'children'> &
  CollapsibleOpenProps & {
    /** The agent the work went to. */
    agent: string;
    status: StepState;
    /** The tool's icon, by name: the manifest's. */
    icon?: string;
    /** Why it could not go, as `hand_to` answered. */
    refusal?: string | null;
    /** Opens the run the hand-off started; offered once it went. */
    onOpenRun?: () => void;
    /** An explicit tab stop for the line's control, the button that opens
     *  the run or the fold over a refusal: WebKit leaves a native button
     *  without one out of the Tab order, so a caller that wants it reached
     *  says so. A line with no control takes none. */
    tabIndex?: number;
  };

/**
 * A Cerebro hand-off (`hand_to`). Once it went, the line opens the agent's
 * own run; refused, it shows the first lines of why under the line and the
 * whole of it inside. Its words are always the hand-off's, never a run's.
 */
export function SubagentHandoff({
  agent,
  status,
  icon = 'forward',
  refusal,
  onOpenRun,
  tabIndex,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: SubagentHandoffProps) {
  const opened = useStepOpen({ open, defaultOpen, onOpenChange }, false);
  const title = handoffTitle(agent, status);
  // Its title says how it went; the five unfinished states keep their words.
  const said =
    status === 'done' || status === 'running' || status === 'failed' || status === 'denied';
  const why =
    status === 'failed' && refusal !== undefined && refusal !== null ? refusal.trim() : '';
  const root = {
    'data-slot': 'subagent-handoff',
    'data-status': status,
    ...props,
  };
  if (status === 'done' && onOpenRun !== undefined) {
    return (
      <div {...root} className={['cb-ai-step', className].filter(Boolean).join(' ')}>
        <button
          type="button"
          data-slot="subagent-handoff-run"
          tabIndex={tabIndex}
          className="cb-ai-step-link"
          onClick={onOpenRun}
        >
          <StepHead
            status={status}
            statusText={null}
            icon={icon}
            title={
              <>
                {title}
                <span className="sr-only"> (opens its run)</span>
              </>
            }
            after={
              <TraceIcon>
                <Icon name="arrow-up-right" />
              </TraceIcon>
            }
          />
        </button>
      </div>
    );
  }
  const head = (
    <StepHead status={status} statusText={said ? null : undefined} icon={icon} title={title} />
  );
  if (why === '') {
    return (
      <div {...root} className={['cb-ai-step', className].filter(Boolean).join(' ')}>
        {head}
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
      <TraceCollapsibleTrigger tabIndex={tabIndex}>{head}</TraceCollapsibleTrigger>
      {/* Its first lines while closed; open, the whole of it says them. */}
      <p
        data-slot="subagent-handoff-refusal"
        hidden={opened.open}
        className="cb-ai-handoff-refusal"
      >
        {why}
      </p>
      <TraceCollapsibleContent>
        <CodeBlock size="sm" variant="destructive">
          <CodeBlockContent wrap className="cb-ai-step-code">
            {why}
          </CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
