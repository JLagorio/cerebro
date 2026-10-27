import { useRef, useState, type ReactElement } from 'react';
import type { CodeTheme } from '@/components/ai/CodeBlock';
import { Plan } from '@/components/ai/Plan';
import { Reasoning } from '@/components/ai/Reasoning';
import { StackTrace } from '@/components/ai/StackTrace';
import { formatDuration, StepHead } from '@/components/ai/StepLine';
import { Subagent, SubagentHandoff, handoffTitle } from '@/components/ai/Subagent';
import { Terminal } from '@/components/ai/Terminal';
import { TestResults } from '@/components/ai/TestResults';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
} from '@/components/ai/Trace';
import { ViewSuggestionCard } from './ViewSuggestionCard';
import { MessageText } from './MessageMarkdown';
import {
  actionAttributes,
  AiActionCard,
  CallTarget,
  toolIcon,
  toolPath,
  type GitHistory,
} from '@/agent/AiActionCard';
import { latestTodo, subagentItems, type TurnItem } from '@/agent/elements/turn';
import {
  callDuration,
  callWords,
  handoffRunId,
  inputField,
  isShellCall,
  outputOf,
  shellCommand,
  stepStateOf,
  subagentWords,
} from '@/agent/elements/turnTitles';
import type { ToolGroupRow as GroupRow, ToolRow, ToolStatus } from '@/agent/transcriptRows';
import { unwrapToolError } from '@/agent/errorText';
import { openOutside } from '@/agent/rail/ConversationRail';
import { useRevealedStep } from '@/agent/stepReveal';
import type { ToolCall } from '@/agent/types';
import { parseStackTrace } from '@/engine/ai/stackFrames';
import { testReportOf } from '@/engine/ai/testReport';
import { latestTodos } from '@/engine/ai/todos';
import { toolRenderer } from '@/engine/tools';
import { resolveTarget } from '@/engine/wikilink';
import type { Renderer } from '@/lib/policy/tools';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import './chat-turn.css';
import { SectionBoundary } from '@/components/ui/SectionBoundary';

/**
 * Transcript rows drawn by the tool manifest's renderer (M56.8), on the AI
 * elements (M91.13).
 *
 * `step` and `change` are a Tool; a `step` that runs a command is a
 * Terminal, its test run's report a Test Results and the stack a failed one
 * printed a Stack Trace. `concept`, `handoff` and `commit` are the rows a
 * cerebro tool owns, each on its own door (tools.v1.json); `subagent` is the
 * CLI's Agent call with its own steps inside, and `todo` the plan its
 * TodoWrite left. Whatever draws it, every single row keeps
 * `data-testid="action-card"`, `data-tool`, `data-tool-id`, `data-write`,
 * `data-renderer` and `data-status` (`actionAttributes`). A connector tool,
 * or one the manifest does not know, is a step. No tool is named here: the
 * manifest says which renderer a call takes and which family it is (CV-04).
 */

/** What every renderer is handed. */
export interface RowProps {
  tool: ToolCall;
  status: ToolStatus;
  onOpenPath: (path: string) => void;
  onViewDiff?: (path: string) => void;
  history?: GitHistory;
  /** A run's record read back (the run detail, M56.9): a suggested view may
   *  be added, never placed on the page open now. */
  readOnly?: boolean;
  /** The message still streams: a subagent's calls and a live plan run. */
  streaming?: boolean;
  /** The call a card waits on (M57.1), where a subagent's rows are drawn. */
  waitingToolId?: string | null;
  /** The panel's theme, for the code a row highlights. */
  theme?: CodeTheme;
  /** The thread's latest todo list call: the plan the run works through. */
  latestTodoId?: string | null;
}

/** What a list of rows hands each one. */
export type RowContext = Omit<RowProps, 'tool' | 'status'>;

/** A frame or a failure location opens its page; the line is the caller's
 * to place, the page is the app's (CV-16). */
const opener =
  (onOpenPath: (path: string) => void) =>
  (path: string): void =>
    onOpenPath(path);

/**
 * A command (M91.13): its test run's report when the runner printed a summary
 * (engine/ai/testReport.ts), else the Terminal, with the stack a failed one
 * printed under it. Until its shell result is in, a call that is no longer
 * running is the plain card: a refused command's words are its error, not
 * its output.
 */
function ShellRow(props: RowProps) {
  const { tool, status } = props;
  const result = tool.result?.type === 'shell' ? tool.result : null;
  if (result === null && status !== 'running') return <AiActionCard {...props} />;
  const attributes = actionAttributes(tool, status);
  const report = result === null ? null : testReportOf(result);
  const open = opener(props.onOpenPath);
  if (report !== null) return <TestResults {...attributes} report={report} onOpenPath={open} />;
  const step = stepStateOf(tool, status);
  const words = callWords(tool, step);
  const command = shellCommand(tool);
  const duration = callDuration(tool);
  const stack =
    step === 'failed' && result !== null && parseStackTrace(result.stderr) !== null
      ? result.stderr
      : null;
  return (
    <Terminal
      {...attributes}
      status={step}
      title={
        command === null ? (
          words.title
        ) : (
          <>
            {words.title} <CallTarget text={command} />
          </>
        )
      }
      statusText={words.statusText}
      icon={toolIcon(tool.name)}
      description={duration === undefined ? undefined : formatDuration(duration)}
      command={command}
      result={result}
    >
      {stack !== null && <StackTrace trace={stack} title="Stack trace" onOpenPath={open} />}
    </Terminal>
  );
}

function StepRow(props: RowProps) {
  return isShellCall(props.tool) ? <ShellRow {...props} /> : <AiActionCard {...props} />;
}

function ViewRow(props: RowProps) {
  return props.status === 'done' && !props.tool.failed ? (
    <ViewSuggestionCard tool={props.tool} readOnly={props.readOnly} />
  ) : (
    <AiActionCard {...props} />
  );
}

/** A concept write: the card, and the way to the concept's review bar. */
function ConceptRow(props: RowProps) {
  const path = toolPath(props.tool.input);
  const reviewable = props.status === 'done' && path !== null;
  return (
    <AiActionCard {...props}>
      {reviewable && (
        <button
          type="button"
          data-testid="action-open-review"
          onClick={() => props.onOpenPath(path)}
          className="motion-hover rounded-md border border-cortex-200 bg-n-0 px-1.5 py-0.5 text-2xs text-cortex-700 hover:border-cortex-400"
        >
          Open to review
        </button>
      )}
    </AiActionCard>
  );
}

/**
 * A handoff: who the work went to, and the run it started there, or why it
 * could not go. It returns at once and its work goes on in a run of its own,
 * so it never says the work is done: "Handed to X", the line opening that
 * run. A refusal, `hand_to`'s own or Claude Code's, is the card, its first
 * lines under the line and the whole of it inside. Until it has answered
 * either way (running, interrupted, or held by a hook, M57.1), it is the
 * plain card, which says which.
 *
 * In the canvas the run's page would open behind the conversation, so the
 * line floats the conversation first, as the rail's opens do (`openOutside`,
 * M92.1); floating or docked, the page opens beside it.
 */
function HandoffRow(props: RowProps) {
  const navigate = useNavStore((s) => s.navigate);
  const agent = inputField(props.tool, 'agent');
  const step = stepStateOf(props.tool, props.status);
  if (agent === null || (step !== 'done' && step !== 'failed' && step !== 'denied')) {
    return <AiActionCard {...props} />;
  }
  if (step === 'failed' || step === 'denied') {
    // A call Claude Code refused says why in its denial, not its output.
    const why = props.tool.denied ?? outputOf(props.tool);
    return (
      <AiActionCard {...props} summary={handoffTitle(agent, step)}>
        {why !== null && (
          <div data-testid="action-handoff-refusal" className="text-2xs text-danger-700">
            {/* The clamp clips at its own box's padding edge, so it sits
                inside the padding: no sliver of a fourth line shows under it. */}
            <span className="line-clamp-3 [overflow-wrap:anywhere]">
              {unwrapToolError(why).trim()}
            </span>
          </div>
        )}
      </AiActionCard>
    );
  }
  const run = handoffRunId(outputOf(props.tool));
  const openRun = (id: string) => {
    const open = () => navigate({ kind: 'knowledge', nav: { tab: 'runs', run: id } });
    if (useUiStore.getState().aiPanelPresentation === 'canvas') openOutside(open);
    else open();
  };
  return (
    <SubagentHandoff
      {...actionAttributes(props.tool, props.status)}
      agent={agent}
      status={step}
      icon={toolIcon(props.tool.name)}
      onOpenRun={run === null ? undefined : () => openRun(run)}
    />
  );
}

/** What commit_proposals answered, when it is the JSON it writes. */
type CommitAnswer =
  | { kind: 'committed'; count: number; transition: string | null; kept: string[] }
  | { kind: 'refused'; code: string };

function commitAnswer(output: string | null): CommitAnswer | null {
  if (output === null) return null;
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    if (value.outcome === 'refused' && typeof value.code === 'string') {
      return { kind: 'refused', code: value.code };
    }
    if (Array.isArray(value.results)) {
      return {
        kind: 'committed',
        count: value.results.length,
        transition: typeof value.transition === 'string' ? value.transition : null,
        kept: Array.isArray(value.kept_files)
          ? value.kept_files.filter((f): f is string => typeof f === 'string')
          : [],
      };
    }
  } catch {
    // Not the answer's JSON: the card shows the raw output.
  }
  return null;
}

/** A commit of proposals: how many, and how, or the refusal's code. */
function CommitRow(props: RowProps) {
  const answer = props.status === 'done' ? commitAnswer(outputOf(props.tool)) : null;
  if (answer === null) return <AiActionCard {...props} />;
  if (answer.kind === 'refused') {
    return <AiActionCard {...props} summary={`Commit refused: ${answer.code}`} />;
  }
  const noun = answer.count === 1 ? 'proposal' : 'proposals';
  return (
    <AiActionCard {...props} summary={`Committed ${answer.count} ${noun}`}>
      {(answer.transition !== null || answer.kept.length > 0) && (
        <div data-testid="action-commit-detail" className="text-2xs text-n-500">
          {answer.transition !== null && <span>{answer.transition.replace(/_/g, ' ')}</span>}
          {answer.kept.length > 0 && (
            <span className="[font-family:var(--font-mono)]">
              {answer.transition !== null && ' · '}
              {answer.kept.join(', ')}
            </span>
          )}
        </div>
      )}
    </AiActionCard>
  );
}

/**
 * The CLI's Agent call (M91.13): the subagent it started, what it was asked
 * and what kind it is, its tool uses and time as recorded and never its
 * tokens, its own steps inside, drawn as the turn's are, and its report. A
 * call Claude Code refused says "Denied …" and why; a run that failed shows
 * its own words. One read back with no steps says they were not recorded.
 * The rail's Subagents card jumps to it (M92.4, stepReveal.ts): the line
 * opens, comes into view and takes focus.
 */
function SubagentRow(props: RowProps) {
  const { tool, status, ...shared } = props;
  const line = useRef<HTMLDivElement>(null);
  const revealed = useRevealedStep(tool.id, line);
  const run = tool.subagent;
  if (run === undefined) return <AiActionCard {...props} ref={line} />;
  const denied = tool.denied !== undefined;
  const words = subagentWords(run, denied);
  const items = subagentItems(run, {
    streaming: props.streaming === true,
    waitingToolId: props.waitingToolId,
  });
  // Its own steps are live only while it works.
  const working = run.status === 'running' || run.status === 'waiting';
  const context: RowContext = {
    ...shared,
    streaming: props.streaming === true && working,
    latestTodoId: latestTodo(run.tools),
  };
  return (
    <Subagent
      ref={line}
      {...actionAttributes(tool, status)}
      run={run}
      title={words?.title}
      statusText={words?.statusText}
      error={denied ? tool.denied : run.error}
      open={revealed.open}
      onOpenChange={revealed.onOpenChange}
    >
      {items.map((item) => (
        <StepItem key={item.key} item={item} {...context} />
      ))}
    </Subagent>
  );
}

/**
 * A TodoWrite call (M91.13): the plan as that call left it, its result's
 * list before its input's (engine/ai/todos.ts). The thread's latest one is
 * the plan the run is working through while the turn streams. A call whose
 * list cannot be read is the plain card, never an empty plan (CV-05).
 */
function TodoRow(props: RowProps) {
  const { tool, status } = props;
  const list = latestTodos([
    { input: tool.payload?.input ?? tool.input, result: tool.result ?? null, failed: tool.failed },
  ]);
  if (list === null) return <AiActionCard {...props} />;
  const live = props.streaming === true && props.latestTodoId === tool.id;
  return <Plan {...actionAttributes(tool, status)} todos={list.todos} isStreaming={live} />;
}

/** One renderer per value the manifest's vocabulary holds. */
export const RENDERERS: Record<Renderer, (props: RowProps) => ReactElement> = {
  step: StepRow,
  view: ViewRow,
  change: StepRow,
  concept: ConceptRow,
  handoff: HandoffRow,
  commit: CommitRow,
  subagent: SubagentRow,
  todo: TodoRow,
};

/** One call, drawn by its manifest renderer. */
export function ToolRowView({ row, ...rest }: RowContext & { row: ToolRow }) {
  const Render = RENDERERS[toolRenderer(row.tool.name)];
  return <Render tool={row.tool} status={row.status} {...rest} />;
}

/**
 * Consecutive reads folded into one row (M56.8), drawn as the AI elements'
 * Task: "Reading 5 notes" while one runs and "Read 5 notes" once done,
 * opening onto their rows. It is open while it reads and folds once done,
 * unless the reader chose; folded, its rows stay in the document, hidden:
 * each is still the call it was, for anything that counts them.
 */
export function ToolGroupRow({ group, ...rest }: RowContext & { group: GroupRow }) {
  const [choice, setChoice] = useState<boolean | undefined>(undefined);
  const first = group.members[0].tool;
  const running = group.running;
  const said = running && group.runningLabel !== null;
  return (
    <TraceCollapsible
      data-testid="action-group"
      data-count={group.members.length}
      data-status={running ? 'running' : 'done'}
      className="cb-action-group"
      open={choice ?? running}
      onOpenChange={setChoice}
    >
      <TraceCollapsibleTrigger data-testid="action-group-toggle">
        <StepHead
          status={running ? 'running' : 'done'}
          // Its running words say that it runs: "Reading 5 notes".
          statusText={said ? null : undefined}
          // While it reads, the state's own icon turns; done, the tool's.
          icon={running ? undefined : toolIcon(first.name)}
          title={said ? group.runningLabel : group.label}
        />
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted>
        <Trace data-slot="task-steps">
          {group.members.map((member) => (
            <ToolRowView key={member.key} row={member} {...rest} />
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** A subagent's own words: its narration, drawn quiet. Its links open the
 * page they name, as the reply's do. */
function StepText({
  text,
  onOpenPath,
  theme,
}: {
  text: string;
  onOpenPath: (path: string) => void;
  theme?: CodeTheme;
}) {
  const entries = useVaultStore((s) => s.entries);
  const onOpen = (target: string) => {
    const entry = resolveTarget(target, entries);
    if (entry !== null) onOpenPath(entry.path);
  };
  return (
    <div data-slot="step-text" className="cb-chat-step-text">
      <MessageText text={text} onOpen={onOpen} theme={theme} />
    </div>
  );
}

/**
 * One piece of a thread (elements/turn.ts): a reasoning line, a folded run of
 * reads, a call, or a subagent's words. The conversation's turn (ChatTurn)
 * and the run detail's replayed turn (RunTranscript) draw every piece through
 * this. The reasoning says how long it took only when both its times were
 * recorded (CV-05).
 */
export function StepItem(props: RowContext & { item: TurnItem }) {
  // M93.12: one malformed tool result draws this step unavailable, not the turn.
  return (
    <SectionBoundary label="This step" compact resetKey={props.item.key}>
      <StepBody {...props} />
    </SectionBoundary>
  );
}

function StepBody({ item, ...context }: RowContext & { item: TurnItem }) {
  switch (item.kind) {
    case 'reasoning':
      return (
        <Reasoning
          text={item.part.text}
          isStreaming={item.part.streaming === true}
          durationMs={item.part.durationMs}
          redacted={item.part.redacted === true}
        />
      );
    case 'group':
      return <ToolGroupRow group={item.group} {...context} />;
    case 'row':
      return <ToolRowView row={item.row} {...context} />;
    case 'text':
      return <StepText text={item.text} onOpenPath={context.onOpenPath} theme={context.theme} />;
  }
}
