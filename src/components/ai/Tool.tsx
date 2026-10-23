// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import type { ComponentProps, ReactNode } from 'react';
import { Badge } from './Badge';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockTitle,
  type CodeTheme,
} from './CodeBlock';
import type { CollapsibleOpenProps } from './Collapsible';
import { StepExtra, StepHead, useStepOpen, type StepState } from './StepLine';
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger } from './Trace';
import './trace-steps.css';

/**
 * A tool call, from input to output (M91.9, shadcn's Tool): one line that
 * says what the call did in its state's tense, and opens onto its input and
 * its result — the error, on a danger ground, when it failed. A call with
 * nothing to show is a plain line. The base step: Terminal, Subagent, Test
 * Results and Stack Trace draw their lines the way this does.
 *
 * Its words are the caller's: the manifest's phrases in the state's tense
 * ("Reading notes.md", "Read notes.md", "Failed to read notes.md"); the line
 * adds the state's own words when the title does not say it (StepLine.tsx).
 * A call a stopped turn left unfinished keeps the transcript's "Interrupted,
 * may have completed", never shadcn's "Failed to run".
 */

/** Past this many characters a block is drawn plain: Shiki on a whole
 *  256 KB payload would hold the panel up for nothing anyone reads. */
const HIGHLIGHT_LIMIT = 20_000;

/** A block's text: a JSON object or array laid out, anything else as it
 *  came. */
function laidOut(text: string): { text: string; json: boolean } {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null) {
      return { text: JSON.stringify(value, null, 2), json: true };
    }
  } catch {
    // Not JSON: a shell's output, a refusal's words.
  }
  return { text, json: false };
}

/** A block's code: JSON highlighted when the caller names a theme, and
 *  everything else plain. */
function ToolCode({ text, json, theme }: { text: string; json: boolean; theme?: CodeTheme }) {
  if (json && theme !== undefined && text.length <= HIGHLIGHT_LIMIT) {
    return (
      <CodeBlockContent
        wrap
        className="cb-ai-step-code"
        code={text}
        language="json"
        theme={theme}
      />
    );
  }
  return (
    <CodeBlockContent wrap className="cb-ai-step-code">
      {text}
    </CodeBlockContent>
  );
}

interface ToolBlockProps {
  /** A line under the block: that a payload was cut, say. */
  note?: ReactNode;
  /** Highlight JSON for this theme; left out, it is drawn plain. */
  theme?: CodeTheme;
  className?: string;
}

/** The call's input, laid out when it is JSON. */
export function ToolInput({ input, note, theme, className }: ToolBlockProps & { input: string }) {
  const code = laidOut(input);
  return (
    <CodeBlock size="sm" data-slot="tool-input" className={className}>
      <CodeBlockHeader>
        <CodeBlockTitle>Input</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code.text} label="Copy the input" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <ToolCode {...code} theme={theme} />
      {note !== undefined && note !== null && <CodeBlockFooter>{note}</CodeBlockFooter>}
    </CodeBlock>
  );
}

/** The call's result, or its error on a danger ground. An error arrives as
 *  its words: the caller unwraps Claude Code's `<tool_use_error>` tags. */
export function ToolOutput({
  output,
  failed = false,
  note,
  theme,
  className,
}: ToolBlockProps & { output: string; failed?: boolean }) {
  const code = laidOut(output);
  return (
    <CodeBlock
      size="sm"
      variant={failed ? 'destructive' : 'default'}
      data-slot="tool-output"
      className={className}
    >
      <CodeBlockHeader>
        <CodeBlockTitle>{failed ? 'Error' : 'Result'}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton
            value={code.text}
            label={failed ? 'Copy the error' : 'Copy the result'}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      <ToolCode {...code} theme={theme} />
      {note !== undefined && note !== null && <CodeBlockFooter>{note}</CodeBlockFooter>}
    </CodeBlock>
  );
}

/** The connector a foreign call ran on, after the title. */
export function ToolServer({ server }: { server: string }) {
  return (
    <Badge
      variant="outline"
      data-slot="tool-server"
      title={`Ran on the ${server} connector, outside this vault`}
    >
      <span className="sr-only">on </span>
      {server}
    </Badge>
  );
}

export type ToolProps = Omit<ComponentProps<'div'>, 'title' | 'children'> &
  CollapsibleOpenProps & {
    status: StepState;
    /** One sentence in the state's tense: "Ran git status", "Denied git push". */
    title: ReactNode;
    /** The state in words; see StepLine's `stepWords`. */
    statusText?: string | null;
    /** The tool's icon, by name: the manifest's. */
    icon?: string;
    /** A count or a duration after the title. */
    description?: ReactNode;
    /** The connector a foreign call ran on. */
    server?: string | null;
    input?: string | null;
    /** Under the input: that the payload was cut. */
    inputNote?: ReactNode;
    /** The result, or the error's words when `status` is `failed`. */
    output?: string | null;
    outputNote?: ReactNode;
    /** Highlight JSON for this theme; left out, blocks are drawn plain. */
    theme?: CodeTheme;
    /** Buttons under the detail — Open, View diff — never inside the line. */
    actions?: ReactNode;
    /** Lines under the line, shown while it is closed too: a renderer's own. */
    children?: ReactNode;
  };

/** One call. It starts closed; a caller opens a failed one with
 *  `defaultOpen`. Every other attribute lands on its root. */
export function Tool({
  status,
  title,
  statusText,
  icon = 'wrench',
  description,
  server,
  input,
  inputNote,
  output,
  outputNote,
  theme,
  actions,
  children,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: ToolProps) {
  const opened = useStepOpen({ open, defaultOpen, onOpenChange }, false);
  const head = (
    <StepHead
      status={status}
      statusText={statusText}
      icon={icon}
      title={title}
      after={server ? <ToolServer server={server} /> : undefined}
      description={description}
    />
  );
  const hasInput = input !== undefined && input !== null && input !== '';
  const hasOutput = output !== undefined && output !== null && output !== '';
  const hasActions = actions !== undefined && actions !== null && actions !== false;
  if (!hasInput && !hasOutput && !hasActions) {
    return (
      <div
        data-slot="tool"
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
      data-slot="tool"
      data-status={status}
      {...props}
      className={className}
      open={opened.open}
      onOpenChange={opened.onOpenChange}
    >
      <TraceCollapsibleTrigger>{head}</TraceCollapsibleTrigger>
      <StepExtra>{children}</StepExtra>
      <TraceCollapsibleContent className="cb-ai-step-detail">
        {hasInput && <ToolInput input={input} note={inputNote} theme={theme} />}
        {hasOutput && (
          <ToolOutput
            output={output}
            failed={status === 'failed'}
            note={outputNote}
            theme={theme}
          />
        )}
        {hasActions && (
          <div data-slot="tool-actions" className="cb-ai-step-actions">
            {actions}
          </div>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
