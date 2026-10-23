// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps, ReactNode } from 'react';
import { terminalLines } from '@/engine/ai/terminalText';
import type { ShellResultData } from '@/engine/ai/types';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
} from './CodeBlock';
import type { CollapsibleOpenProps } from './Collapsible';
import { StepExtra, StepHead, useStepOpen, type StepState } from './StepLine';
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger } from './Trace';
import './trace-steps.css';

/**
 * A command the agent ran, and what it printed (M91.9, shadcn's Terminal):
 * the line says the command in its state's tense, and opens onto the
 * command as typed, its output, and its error output ruled off in danger
 * ink. Output arrives whole when the call returns — nothing streams from a
 * shell mid-run — so a running command says it has no output yet rather
 * than draw a cursor that pretends otherwise. The fold keeps the last part of
 * each stream, since runners print their summary last; a cut head says so.
 */

/** A stream as the lines a person reads: escape codes and carriage-return
 *  rewrites resolved, and the blank lines around it dropped. */
function streamText(text: string | null | undefined): string {
  if (text === undefined || text === null) return '';
  const lines = terminalLines(text);
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

export type TerminalProps = Omit<ComponentProps<'div'>, 'title' | 'children'> &
  CollapsibleOpenProps & {
    status: StepState;
    /** One sentence in the state's tense: "Running pnpm test", "Ran pnpm
     *  test", "pnpm lint exited with code 1". */
    title: ReactNode;
    /** The state in words; see StepLine's `stepWords`. */
    statusText?: string | null;
    icon?: string;
    description?: ReactNode;
    /** The command as the call ran it. */
    command?: string | null;
    /** What the shell returned: the last part of each stream (§3.1). */
    result?: ShellResultData | null;
    /** Output as plain text, for a call with no shell result; ignored when
     *  `result` is given. */
    output?: string | null;
    /** Buttons under the output, never inside the line. */
    actions?: ReactNode;
    /** Lines under the line, shown while it is closed too. */
    children?: ReactNode;
  };

/** One command. It opens by itself only while it runs with output to show,
 *  and the reader's choice wins from then on. */
export function Terminal({
  status,
  title,
  statusText,
  icon = 'terminal',
  description,
  command,
  result,
  output,
  actions,
  children,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: TerminalProps) {
  const stdout = streamText(result != null ? result.stdout : output);
  const stderr = streamText(result?.stderr);
  const hasOutput = stdout !== '' || stderr !== '';
  const running = status === 'running';
  const opened = useStepOpen({ open, defaultOpen, onOpenChange }, running && hasOutput);
  const typed = command !== undefined && command !== null && command.trim() !== '';
  const truncated = result?.truncated === true;
  const interrupted = result?.interrupted === true;
  const hasActions = actions !== undefined && actions !== null && actions !== false;
  // What an empty output means: none yet, none at all, or none anyone kept.
  // A call that never ran (it waited, or was refused) has no output to speak of.
  const recorded = result != null || (output !== undefined && output !== null);
  const ran = status === 'done' || status === 'failed' || status === 'interrupted';
  const empty = hasOutput
    ? null
    : running
      ? 'No output yet'
      : recorded
        ? 'No output'
        : ran
          ? 'Output not recorded'
          : null;
  const head = (
    <StepHead
      status={status}
      statusText={statusText}
      icon={icon}
      title={title}
      description={description}
    />
  );
  // While it runs, "no output yet" alone is nothing to open.
  const detail = typed || hasOutput || interrupted || hasActions || (empty !== null && !running);
  if (!detail) {
    return (
      <div
        data-slot="terminal"
        data-status={status}
        {...props}
        className={['cb-ai-step', className].filter(Boolean).join(' ')}
      >
        {head}
        <StepExtra>{children}</StepExtra>
      </div>
    );
  }
  return (
    <TraceCollapsible
      data-slot="terminal"
      data-status={status}
      {...props}
      className={className}
      open={opened.open}
      onOpenChange={opened.onOpenChange}
    >
      <TraceCollapsibleTrigger>{head}</TraceCollapsibleTrigger>
      <StepExtra>{children}</StepExtra>
      <TraceCollapsibleContent className="cb-ai-step-detail">
        {/* A failed call's words with no streams are an error's: on a danger
            ground. A failed command's own output stays on the plain one,
            its error output ruled off inside it. */}
        <CodeBlock
          size="sm"
          variant={status === 'failed' && result == null && hasOutput ? 'destructive' : 'default'}
          data-slot="terminal-output"
        >
          {hasOutput && (
            <CodeBlockActions>
              <CodeBlockCopyButton
                value={[stdout, stderr].filter((text) => text !== '').join('\n')}
                label="Copy the output"
              />
            </CodeBlockActions>
          )}
          <CodeBlockContent wrap className="cb-ai-step-code">
            {typed && (
              <span data-slot="terminal-command" className="cb-ai-terminal-command">
                <span aria-hidden="true" className="cb-ai-terminal-prompt">
                  ${' '}
                </span>
                {command}
              </span>
            )}
            {truncated && hasOutput && (
              <span data-slot="terminal-truncated" className="cb-ai-terminal-note">
                Showing the last part of the output
              </span>
            )}
            {stdout !== '' && <span data-slot="terminal-stdout">{stdout}</span>}
            {stderr !== '' && (
              <span data-slot="terminal-stderr" className="cb-ai-terminal-stderr">
                <span className="sr-only">Error output: </span>
                {stderr}
              </span>
            )}
            {empty !== null && (
              <span data-slot="terminal-empty" className="cb-ai-terminal-note">
                {empty}
              </span>
            )}
          </CodeBlockContent>
          {interrupted && (
            <CodeBlockFooter data-slot="terminal-interrupted" className="cb-ai-terminal-marker">
              Interrupted before it finished
            </CodeBlockFooter>
          )}
        </CodeBlock>
        {hasActions && (
          <div data-slot="terminal-actions" className="cb-ai-step-actions">
            {actions}
          </div>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
