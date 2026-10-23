import { useState, type ReactNode, type Ref } from 'react';
import { Badge } from '@/components/ai/Badge';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockTitle,
  type CodeTheme,
} from '@/components/ai/CodeBlock';
import {
  STEP_STATUS_WORDS,
  StepExtra,
  StepIcon,
  stepTraceStatus,
  stepWords,
  type StepState,
} from '@/components/ai/StepLine';
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from '@/components/ai/Trace';
import {
  callSubject,
  callWords,
  landedPath,
  laidOut,
  payloadPart,
  stepStateOf,
  toolPath,
} from '@/agent/elements/turnTitles';
import { unwrapToolError } from '@/agent/errorText';
import type { ToolCall } from '@/agent/types';
import { toolStatus, type ToolStatus } from '@/agent/transcriptRows';
import { showsAsChange, toolDisplay, toolIconName, toolRenderer } from '@/engine/tools';

export { formatSize, toolPath } from '@/agent/elements/turnTitles';

/**
 * One thing the agent did (M9.5), drawn as the AI elements' Tool (M91.13): a
 * line that says what the call did, in its state's tense and words, and
 * opens onto its input and its result.
 *
 * The agent has write access to this vault, and the panel's job is to make
 * that legible. Consecutive reads fold into one row before they reach a call
 * (transcriptRows.ts, M56.8); a WRITE keeps its path in view on its line,
 * because that is the thing you might want to undo. Undo needs git history:
 * a turn that wrote becomes its own commit (M9.4), which View diff reads. A
 * vault with no git history has no revert for an agent's write, and an open
 * write says so (M55.5) rather than leave it implied.
 *
 * Every row keeps the card's test ids and `data-*`, whichever element draws
 * it (`actionAttributes`): the conversation's specs and its run detail read
 * them.
 */

/** What an opened write says when the vault keeps no git history. */
export const NO_REVERT =
  "Cerebro found no git history for this vault, so it can't revert this change.";

/** Whether the vault keeps git history, as the panel last read it. */
export type GitHistory = 'git' | 'none';

/** The vault's history from `useGit`'s state: undefined until a git read has
 * told (`isRepo` null while none could, M92.9), so a card never claims
 * either way on a guess. */
export function historyOf(ready: boolean, isRepo: boolean | null): GitHistory | undefined {
  if (!ready || isRepo === null) return undefined;
  return isRepo ? 'git' : 'none';
}

/** Compact attribution for text-only callers such as an interaction card.
 * Action cards render the same facts as a label and a server chip. */
export function toolLabel(name: string): string {
  const { label, server } = toolDisplay(name);
  return server === null ? label : `${server} · ${label}`;
}

/** A state's words, as StepLine says them: the one vocabulary. */
const said = (state: StepState): string => STEP_STATUS_WORDS[state] ?? '';

/** What an unfinished call on a stopped turn says (M56.8): the turn ended
 * before its result came back, so it may have run all the same. A call a
 * hook deferred (M57.1) is never that: it did not run, and says why
 * (`DEFERRED`). */
export const INTERRUPTED = said('interrupted');

/** What a deferred call says, by its status (M57.1). */
export const DEFERRED: Readonly<Record<'waiting' | 'cancelled' | 'not_run' | 'paused', string>> = {
  waiting: said('waiting'),
  cancelled: said('cancelled'),
  not_run: said('not_run'),
  paused: said('paused'),
};

/** Manifest icons for local calls, a connector plug for foreign calls. */
export const toolIcon = toolIconName;

/** A write card: the manifest draws this call as a change or a concept, so
 * its path stays visible while collapsed and it offers a diff. */
export const isWrite = showsAsChange;

/**
 * The card's test ids and facts, on the root of whichever element draws a
 * call: `action-card`, its tool and its call's id (what a rail row jumps to,
 * M92.4), whether it is a connector's, whether it writes, whether it failed,
 * its renderer and its status.
 */
export function actionAttributes(tool: ToolCall, status: ToolStatus) {
  const { server } = toolDisplay(tool.name);
  return {
    'data-testid': 'action-card',
    'data-tool': tool.name,
    'data-tool-id': tool.id,
    'data-external': server !== null ? 'true' : undefined,
    'data-server': server ?? undefined,
    'data-write': isWrite(tool.name) ? 'true' : 'false',
    'data-failed': tool.failed ? 'true' : 'false',
    'data-renderer': toolRenderer(tool.name),
    'data-status': status,
  };
}

/** The states whose sentence is drawn under the line as well as read. */
const NOTED: ReadonlySet<StepState> = new Set<StepState>([
  'interrupted',
  'waiting',
  'cancelled',
  'not_run',
  'paused',
]);

/** What a call was aimed at, on its line: the mono face, a size under the
 * title's, and a write's in the brand ink, since it is what you might undo. */
export function CallTarget({ text, write = false }: { text: string; write?: boolean }) {
  return (
    <span
      className={`text-2xs [font-family:var(--font-mono)] ${write ? 'text-cortex-700' : 'text-n-500'}`}
    >
      {text}
    </span>
  );
}

/** A button under an opened call. */
const ACTION =
  'motion-hover rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-metadata text-n-600 hover:border-n-400';

/** Past this many characters a block is drawn plain: highlighting a whole
 * 256 KB payload would hold the panel up for nothing anyone reads (the Tool
 * element's limit). */
const HIGHLIGHT_LIMIT = 20_000;

/** A block's code: JSON highlighted for the panel's theme, anything else
 * plain. */
function CallCode({ text, theme, testId }: { text: string; theme?: CodeTheme; testId: string }) {
  const code = laidOut(text);
  if (code.json && theme !== undefined && code.text.length <= HIGHLIGHT_LIMIT) {
    return (
      <CodeBlockContent
        wrap
        data-testid={testId}
        className="cb-ai-step-code"
        code={code.text}
        language="json"
        theme={theme}
      />
    );
  }
  return (
    <CodeBlockContent wrap data-testid={testId} className="cb-ai-step-code">
      {code.text}
    </CodeBlockContent>
  );
}

/** A call's input or its result, its copy button in its header. */
function CallBlock({
  kind,
  text,
  cut,
  failed = false,
  theme,
}: {
  kind: 'input' | 'output';
  text: string;
  cut: string | null;
  failed?: boolean;
  theme?: CodeTheme;
}) {
  const title = kind === 'input' ? 'Input' : failed ? 'Error' : 'Result';
  return (
    <CodeBlock
      size="sm"
      variant={failed ? 'destructive' : 'default'}
      data-slot={kind === 'input' ? 'tool-input' : 'tool-output'}
    >
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton
            value={laidOut(text).text}
            label={`Copy the ${title.toLowerCase()}`}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CallCode text={text} theme={theme} testId={`action-${kind}`} />
      {cut !== null && <CodeBlockFooter data-testid="action-cut">{cut}</CodeBlockFooter>}
    </CodeBlock>
  );
}

export function AiActionCard({
  tool,
  onOpenPath,
  onViewDiff,
  history,
  status,
  summary,
  theme,
  children,
  ref,
}: {
  /** The card's root, for a renderer that brings its row into view. */
  ref?: Ref<HTMLDivElement>;
  tool: ToolCall;
  onOpenPath: (path: string) => void;
  /** M9.4 present: review what this write changed. */
  onViewDiff?: (path: string) => void;
  /** Whether the vault keeps git history; unknown says nothing (M55.5). */
  history?: GitHistory;
  /** The row's status (M56.8, transcriptRows.ts). Absent, it is read off the
   * call alone, which cannot tell a running call from an interrupted one. */
  status?: ToolStatus;
  /** What the line says in place of the call's own words and its target: a
   * renderer's own words ("Committed 3 proposals"). */
  summary?: ReactNode;
  /** Highlight a JSON input or result for this theme; left out, plain. */
  theme?: CodeTheme;
  /** A renderer's own line under the card's, shown collapsed too. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const display = toolDisplay(tool.name);
  const path = landedPath(tool) ?? toolPath(tool.input);
  const subject = callSubject(tool);
  const write = isWrite(tool.name);
  const state = status ?? toolStatus(tool, !tool.done);
  const step = stepStateOf(tool, state);
  const payload = tool.payload;
  const input = payloadPart(
    tool.input,
    payload?.input,
    payload?.inputTruncated,
    payload?.inputBytes,
  );
  const output = payloadPart(
    tool.output,
    payload?.output,
    payload?.outputTruncated,
    payload?.outputBytes,
  );
  const hasDetail = input.text !== null || output.text !== null;
  const noRevert = write && history === 'none' && !tool.failed;
  const words = summary === undefined ? callWords(tool, step) : null;
  const title = words === null ? summary : words.title;
  const spoken = stepWords(step, words?.statusText, title);

  const head = (
    <span data-slot="step-head" data-status={step} className="cb-ai-step-head">
      <TraceLine status={stepTraceStatus(step)} statusText={spoken}>
        <StepIcon state={step} icon={toolIcon(tool.name)} />
        <TraceTitle>
          {title}
          {/* A write keeps its path visible on its line — it is the thing
              you might want to undo. */}
          {summary === undefined && subject !== null && (
            <>
              {' '}
              <CallTarget text={subject} write={write} />
            </>
          )}
        </TraceTitle>
        {display.server !== null && (
          <Badge
            variant="outline"
            data-testid="action-server"
            title={`Ran on the ${display.server} connector, outside this vault`}
          >
            {display.server}
          </Badge>
        )}
      </TraceLine>
      {spoken !== null && NOTED.has(step) && (
        <span
          data-testid={step === 'interrupted' ? 'action-interrupted' : 'action-deferred'}
          aria-hidden="true"
          className="cb-ai-step-note"
        >
          {spoken}
        </span>
      )}
    </span>
  );
  const root = { ...actionAttributes(tool, state), className: 'cb-action-card' };

  if (!hasDetail) {
    return (
      <div {...root} ref={ref} className="cb-action-card cb-ai-step">
        {head}
        <StepExtra>{children}</StepExtra>
      </div>
    );
  }
  return (
    <TraceCollapsible {...root} ref={ref} open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{head}</TraceCollapsibleTrigger>
      <StepExtra>{children}</StepExtra>
      <TraceCollapsibleContent className="cb-ai-step-detail">
        {input.text !== null && (
          <CallBlock kind="input" text={input.text} cut={input.cut} theme={theme} />
        )}
        {output.text !== null && (
          <CallBlock
            kind="output"
            // A refused call's words come wrapped in Claude Code's
            // `<tool_use_error>` tags: the words are the error.
            text={tool.failed ? unwrapToolError(output.text).trim() : output.text}
            cut={output.cut}
            failed={tool.failed}
            theme={theme}
          />
        )}
        {noRevert && (
          <p data-testid="action-no-revert" className="cb-ai-step-quiet">
            {NO_REVERT}
          </p>
        )}
        {path !== null && (
          <div className="cb-ai-step-actions">
            <button type="button" onClick={() => onOpenPath(path)} className={ACTION}>
              Open
            </button>
            {/* Only for writes, and only when there is a history to diff
                against — the payoff for having built M9.4 first. */}
            {write && onViewDiff !== undefined && history !== 'none' && (
              <button
                type="button"
                data-testid="action-view-diff"
                onClick={() => onViewDiff(path)}
                className={ACTION}
              >
                View diff
              </button>
            )}
          </div>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
