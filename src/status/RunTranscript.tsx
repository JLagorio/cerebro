import { useState } from 'react';
import { latestTodo, type ChainStep } from '@/agent/elements/turn';
import { replayedTurn } from '@/agent/elements/runsTranscript';
import { MessageText } from '@/agent/MessageMarkdown';
import { StepItem, type RowContext } from '@/agent/toolRenderers';
import { replayTranscript } from '@/agent/transcript';
import { TurnError } from '@/agent/TurnError';
import type { ChatMessage } from '@/agent/types';
import { ChainOfThought } from '@/components/ai/ChainOfThought';
import type { CodeTheme } from '@/components/ai/CodeBlock';
import { Bubble, BubbleContent, Message, MessageContent } from '@/components/ai/Message';
import { Icon } from '@/components/ui/Icon';
import type { StepSummary } from '@/engine/ai/steps';
import { resolveTarget } from '@/engine/wikilink';
import { useTheme } from '@/hooks/useTheme';
import { fleetRunTranscript, type RunTranscript as Transcript } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import './runs.css';

/**
 * A run's transcript, folded from Claude Code's own session file (M56.9, D5).
 *
 * **Collapsed until asked for.** The file lives outside the vault, so it is
 * read only when someone opens this section, once, and never again while the
 * panel is open (Q22). What comes back stays in this component: no store, no
 * localStorage, no copy anywhere. A run with no session never asks at all.
 *
 * **One reducer, the panel's turn.** The events go through the reducer the
 * panel uses (`replayTranscript`) and each turn draws as the conversation
 * draws one (M91.14, elements/runsTranscript.ts): its prompt, then its
 * reasoning and folded reads in one chain of thought, every other call by
 * its manifest renderer, read-only, so five reads in a row are one row here
 * too, and its words as the chat's markdown, the last its answer. A run that
 * is still going is drawn live, so its open turn reads as going rather than
 * interrupted.
 *
 * **Every state says what it is.** Gone after Claude Code's sweep, gone
 * before it, not recorded, and could-not-read are four different sentences;
 * a failed read is `section-unavailable`, never an empty thread (CV-05).
 */

type Loaded =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; transcript: Transcript };

const NOT_RECORDED = 'Transcript not recorded for this run.';
const UNREADABLE =
  "Couldn't read this run's transcript, so nothing here is a statement about what it said.";

/** The footnote, naming the retention Claude Code is configured with, or no
 * period at all when it never sweeps. */
function retentionText(days: number | null): string {
  return days === null
    ? "Read from Claude Code's own session file, outside your vault. Cerebro keeps no copy."
    : "Read from Claude Code's own session file, outside your vault. Claude Code deletes these " +
        `files ${days} days after their last turn (30 by default), and Cerebro keeps no copy.`;
}

function Muted({ testId, children }: { testId?: string; children: string }) {
  return (
    <p data-testid={testId} className="text-2xs text-n-500">
      {children}
    </p>
  );
}

/**
 * A replayed turn's chain of thought: its reasoning and folded reads, open
 * as `replayedTurn` says until the reader chooses.
 */
function Chain({
  steps,
  summary,
  defaultOpen,
  context,
}: {
  steps: ChainStep[];
  summary: StepSummary;
  defaultOpen: boolean;
  context: RowContext;
}) {
  const [choice, setChoice] = useState<boolean | undefined>(undefined);
  return (
    <ChainOfThought summary={summary} open={choice ?? defaultOpen} onOpenChange={setChoice}>
      {steps.map((step) => (
        <StepItem key={step.key} item={step} {...context} />
      ))}
    </ChainOfThought>
  );
}

/** One replayed reply, as the conversation draws a reply, read-only. */
function Turn({
  message,
  live,
  latest,
  theme,
  onOpen,
  onOpenPath,
}: {
  message: ChatMessage;
  /** Its run is still writing it: an unfinished call runs. */
  live: boolean;
  /** The run's last reply, whose chain of thought starts open. */
  latest: boolean;
  theme: CodeTheme;
  onOpen: (target: string) => void;
  onOpenPath: (path: string) => void;
}) {
  const turn = replayedTurn(message, { live, latest });
  // A record of what the run did: no View diff, no word about reverting, and
  // no suggestion placed on the page open now.
  const context: RowContext = {
    onOpenPath,
    readOnly: true,
    streaming: live,
    waitingToolId: null,
    theme,
    latestTodoId: latestTodo(message.tools),
  };
  return (
    <Message from="assistant" data-testid="run-transcript-turn">
      <MessageContent>
        {turn.lines.map((line) => {
          switch (line.kind) {
            case 'text':
              return (
                <div key={line.key} className={line.answer ? 'cb-run-answer' : 'cb-run-narration'}>
                  <MessageText text={line.text} onOpen={onOpen} theme={theme} />
                </div>
              );
            case 'chain':
              return (
                <Chain
                  key={line.key}
                  steps={line.steps}
                  summary={line.summary}
                  defaultOpen={turn.chainOpen}
                  context={context}
                />
              );
            default:
              return <StepItem key={line.key} item={line} {...context} />;
          }
        })}
        {turn.failure !== null &&
          (turn.failure.typed ? (
            <p className="m-0 text-2xs text-danger-700">{turn.failure.text}</p>
          ) : (
            <TurnError error={turn.failure.text} onOpenPath={onOpenPath} />
          ))}
        {turn.interrupted && (
          <Muted testId="run-transcript-interrupted">Interrupted before it finished.</Muted>
        )}
      </MessageContent>
    </Message>
  );
}

/** The turns, drawn as the panel draws them. */
function Turns({
  messages,
  running,
  onOpenPath,
}: {
  messages: ChatMessage[];
  running: boolean;
  onOpenPath: (path: string) => void;
}) {
  const theme = useTheme();
  const entries = useVaultStore((s) => s.entries);
  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
  if (messages.length === 0) return <Muted>The session file holds no turns.</Muted>;
  // A link in the words opens the page it names, as the reply's do.
  const onOpen = (target: string) => {
    const entry = resolveTarget(target, entries);
    if (entry !== null) onOpenPath(entry.path);
  };
  return (
    <div className="cb-run-transcript">
      {messages.map((message, i) =>
        message.role === 'user' ? (
          // What the run was asked: often its schedule's words, not a
          // person's, so a quiet bubble at the start rather than the
          // person's own.
          <Message key={message.id} from="user" align="start" data-testid="run-transcript-prompt">
            <MessageContent>
              <Bubble variant="muted">
                <BubbleContent>{message.text}</BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
        ) : (
          <Turn
            key={message.id}
            message={message}
            // Only a running run's last turn is still going; the file ends
            // it as cut off, and that is not true yet.
            live={running && i === lastAssistant}
            latest={i === lastAssistant}
            theme={theme}
            onOpen={onOpen}
            onOpenPath={onOpenPath}
          />
        ),
      )}
    </div>
  );
}

function Body({
  loaded,
  sessionId,
  running,
  onOpenPath,
}: {
  loaded: Loaded;
  sessionId: string;
  running: boolean;
  onOpenPath: (path: string) => void;
}) {
  if (loaded.kind === 'idle' || loaded.kind === 'loading') {
    return <Muted>Reading…</Muted>;
  }
  if (loaded.kind === 'failed') {
    return (
      <p data-testid="section-unavailable" className="text-2xs text-n-500">
        {UNREADABLE}
      </p>
    );
  }
  const { read, runs_in_session: runs, retention_days: days } = loaded.transcript;
  const footnote = <Muted testId="run-transcript-retention">{retentionText(days)}</Muted>;
  if (read.state === 'unavailable') {
    switch (read.reason) {
      case 'not_recorded':
        return <Muted testId="run-transcript-state">{NOT_RECORDED}</Muted>;
      case 'expired':
        return (
          <>
            <Muted testId="run-transcript-state">
              {read.retention_days === null
                ? 'Cleared by Claude Code.'
                : `Cleared by Claude Code, which deletes session files ${read.retention_days} days after their last turn.`}
            </Muted>
            {footnote}
          </>
        );
      case 'cleared':
        return (
          <>
            <Muted testId="run-transcript-state">
              Cleared: this vault&apos;s Claude Code session files were deleted.
            </Muted>
            {footnote}
          </>
        );
      default:
        // Unreadable, or a reason this build does not name: Rust is the one
        // classifier, and either way nothing was read.
        return (
          <p data-testid="section-unavailable" className="text-2xs text-n-500">
            {UNREADABLE}
          </p>
        );
    }
  }
  const { messages } = replayTranscript(read.events, sessionId, { open: running });
  return (
    <>
      {runs > 1 && (
        <Muted testId="run-transcript-shared">
          {`This Claude Code session holds ${runs} runs; all of it is shown.`}
        </Muted>
      )}
      {running && (
        <Muted testId="run-transcript-running">
          The run is still going; this is what its session file holds so far.
        </Muted>
      )}
      <div
        data-testid="run-transcript-body"
        className="max-h-96 overflow-y-auto rounded-md border border-n-200 bg-n-0 p-2"
      >
        <Turns messages={messages} running={running} onOpenPath={onOpenPath} />
      </div>
      {footnote}
    </>
  );
}

export function RunTranscript({
  runId,
  sessionId,
  running,
}: {
  runId: string;
  sessionId: string | null;
  running: boolean;
}) {
  const navigate = useNavStore((s) => s.navigate);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'idle' });

  if (sessionId === null) {
    return (
      <section data-testid="run-transcript" className="flex flex-col gap-1">
        <h5 className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
          Transcript
        </h5>
        <Muted testId="run-transcript-state">{NOT_RECORDED}</Muted>
      </section>
    );
  }

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // The first expand reads the file; every later one shows what came back.
    if (next && loaded.kind === 'idle') {
      setLoaded({ kind: 'loading' });
      fleetRunTranscript(runId).then(
        (transcript) => setLoaded({ kind: 'ready', transcript }),
        () => setLoaded({ kind: 'failed' }),
      );
    }
  };

  return (
    <section data-testid="run-transcript" className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="run-transcript-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="flex items-center gap-1.5 self-start border-0 bg-transparent p-0 text-left"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} color="var(--n-400)" />
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
          Transcript
        </span>
        <span className="text-2xs text-n-400">from Claude Code&apos;s session file</span>
      </button>
      {open && (
        <Body
          loaded={loaded}
          sessionId={sessionId}
          running={running}
          onOpenPath={(path) => navigate({ kind: 'doc', path })}
        />
      )}
    </section>
  );
}
