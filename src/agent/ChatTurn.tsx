import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { readGenerationObservation } from '@/agent/generationObservation';
import { ChainOfThought, chainTitle } from '@/components/ai/ChainOfThought';
import { Checkpoint } from '@/components/ai/Checkpoint';
import {
  Bubble,
  BubbleContent,
  Message as TurnMessage,
  MessageContent,
  MessageToolbar,
} from '@/components/ai/Message';
import { Sources } from '@/components/ai/Sources';
import { STEP_STATUS_WORDS, formatDuration } from '@/components/ai/StepLine';
import { Arrival, useArrival, useDrawn } from '@/components/ui/motion';
import type { GitHistory } from '@/agent/AiActionCard';
import {
  chainOpens,
  latestTodo,
  turnItems,
  turnLines,
  type ChainStep,
} from '@/agent/elements/turn';
import { turnSources } from '@/agent/elements/turnSources';
import { StepItem, type RowContext } from '@/agent/toolRenderers';
import { TurnChangeset } from '@/agent/TurnChangeset';
import { FailureNoticeCard } from '@/agent/FailureNoticeCard';
import { TurnError } from '@/agent/TurnError';
import { AnswerSaveDialog, ArtifactActions } from '@/agent/ArtifactActions';
import type { AnswerPreview } from '@/agent/artifacts';
import { MessageText } from '@/agent/MessageMarkdown';
import { suspendedOn } from '@/agent/transcript';
import type { ChatMessage } from '@/agent/types';
import type { StepSummary } from '@/engine/ai/steps';
import type { SourceRef } from '@/engine/ai/types';
import type { Entry } from '@/engine/types';
import { useTheme } from '@/hooks/useTheme';
import { useVaultStore } from '@/stores/vaultStore';
import './chat-turn.css';
import { SectionBoundary } from '@/components/ui/SectionBoundary';

/**
 * One turn of the conversation (M91.13): the person's message, or the
 * assistant's reply with what it did on the way, drawn with the AI elements.
 * The panel draws one per message, so every presentation of the
 * conversation draws a turn alike.
 *
 * A reply's pieces come in the order the reducer kept them (M91.4,
 * elements/turn.ts): its reasoning and its folded reads inside the one chain
 * of thought, every other call a line of its own, so nothing it changed and
 * nothing that went wrong is ever folded out of sight, and each message's
 * words where they came, the last its answer. What it drew on is listed under
 * the answer once the turn is done. Between a reply and the turn after it,
 * the panel can draw the marker a new conversation branches from
 * (`TurnCheckpoint`, M91.12c).
 */

/** Past this, a prompt is a wall rather than a question, so it is collapsed
 * to a predictable slice of the transcript with a way to see the rest. */
const LONG_PROMPT = 400;

export interface MessageProps {
  message: ChatMessage;
  /** A send appended it while the conversation was open: it comes in, from
   *  where it was written (chat-turn.css). History is simply there. */
  arriving?: boolean;
  /** The conversation's latest turn, whose chain of thought starts open.
   *  Left out, a turn watched as it was written is, and history is not. */
  latest?: boolean;
  onOpen: (t: string) => void;
  onOpenPath: (p: string) => void;
  /** Open a file's diff: at `commit` when this reply's run committed it
   * (M58.3), else in the working tree. */
  onViewDiff?: (p: string, commit: string | null) => void;
  /** The call a card waits on in this message (M57.1), whose row reads
   * waiting. */
  waitingToolId?: string | null;
  /** Whether the vault keeps git history, so a write card can say it has no
   * revert (M55.5); undefined until git status is read. */
  history?: GitHistory;
  /** Inspect local recorded facts without resending. The explicit opener
   *  lets the owning panel restore focus when its read-only view closes. */
  onReviewRecovery?: (messageId: string, opener: HTMLButtonElement) => void;
  /** What a failure card's fix does, by action (M56.4). */
  noticeActions?: Partial<Record<string, () => void>>;
}

/** Memoized: a streamed delta replaces only the message it grows, so with
 *  stable handlers from the panel every earlier turn skips the redraw. */
export const Message = memo(function Message(props: MessageProps) {
  // M93.12: one malformed turn draws unavailable; the others, the draft and
  // any waiting decision stay.
  return (
    <SectionBoundary label="This turn" compact>
      {props.message.role === 'user' ? (
        <UserMessage
          message={props.message}
          arriving={props.arriving}
          onOpenPath={props.onOpenPath}
        />
      ) : (
        <AssistantMessage {...props} />
      )}
    </SectionBoundary>
  );
});

function UserMessage({
  message,
  arriving = false,
  onOpenPath,
}: {
  message: ChatMessage;
  arriving?: boolean;
  onOpenPath: (path: string) => void;
}) {
  const arrival = useArrival(arriving);
  const [expanded, setExpanded] = useState(false);
  const { text, addressed } = message;
  const long = text.length > LONG_PROMPT;
  return (
    <TurnMessage from="user" className="cb-chat-user" data-testid="chat-message" {...arrival}>
      <MessageContent>
        <Bubble>
          {/* The bubble keeps the person's line breaks (M15): a Shift+Enter
              multi-line question used to come back as one run-on line. */}
          <BubbleContent
            className={[
              'cb-chat-user-bubble',
              long && !expanded ? 'max-h-[112px] overflow-hidden' : '',
            ].join(' ')}
          >
            {text}
          </BubbleContent>
        </Bubble>
        {/* M33b.6 — who this turn went to, said once, under the bubble it
            belongs to. Only ever drawn when the person typed an `@`: a mention
            affordance is theirs to invoke, and an app that volunteered agents
            at someone would be the counting chrome M8 forbids. */}
        {addressed !== undefined && (
          <span data-testid="turn-addressed" className="text-2xs text-n-400">
            {addressed.title === null
              ? `No agent called @${addressed.handle} — ${addressed.answeredBy ?? 'the assistant'} took this one.`
              : `To ${addressed.title}`}
          </span>
        )}
        {message.archiveAttachmentRefs !== undefined &&
          message.archiveAttachmentRefs.length > 0 && (
            <ul className="m-0 list-none p-0 text-xs text-n-500">
              {message.archiveAttachmentRefs.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="motion-hover border-0 bg-transparent p-0 text-inherit underline"
                    onClick={() => onOpenPath(path)}
                  >
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          )}
        <ArchivePersistence message={message} />
        {long && (
          <button
            type="button"
            data-testid="prompt-toggle"
            onClick={() => setExpanded(!expanded)}
            className="motion-hover border-0 bg-transparent p-0 text-2xs text-n-500 hover:text-n-800"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {message.streaming !== true && text.trim() !== '' && (
          <MessageToolbar aria-label="Question actions" copy={text} />
        )}
      </MessageContent>
    </TurnMessage>
  );
}

function AssistantMessage({
  message,
  arriving = false,
  latest,
  onOpen,
  onOpenPath,
  onViewDiff,
  history,
  onReviewRecovery,
  noticeActions,
  waitingToolId = null,
}: MessageProps) {
  const arrival = useArrival(arriving);
  // What a reply gains once it is on screen — its first words, its calls,
  // a failure, what its run changed — comes in on its own; what it was
  // drawn with, restored or new, came in with it.
  const live = useDrawn();
  // A chosen answer copy outlives regeneration, waiting and gap restoration.
  // Eligibility can remove the action without discarding its open preview.
  const [artifact, setArtifact] = useState<AnswerPreview | null>(null);
  // Code is highlighted in the panel's own theme, handed to the elements as
  // a prop (CV-64).
  const theme = useTheme();
  const entries = useVaultStore((s) => s.entries);
  const streaming = message.streaming === true;
  const generationObservation = readGenerationObservation(message.generationObservation);
  // A turn watched as it was written is the one being read.
  const [watched] = useState(streaming);
  const lines = useMemo(
    () => turnLines(turnItems(message, { streaming, waitingToolId })),
    [message, streaming, waitingToolId],
  );
  // Once the turn is done: links half-typed mid-stream are no sources.
  const sources = useMemo(
    () => (streaming ? [] : titled(turnSources(message), entries)),
    [message, streaming, entries],
  );
  // M58.3: a card's View diff opens the file at the commit this reply's run
  // made of it, so it still shows the run's change after the commit lands.
  const cardDiff =
    onViewDiff === undefined ? undefined : (p: string) => onViewDiff(p, commitOf(message, p));
  const reviewRecovery =
    onReviewRecovery === undefined
      ? undefined
      : (opener: HTMLButtonElement) => onReviewRecovery(message.id, opener);
  // At work, and not waiting on the person: the card it waits on says that.
  const working = streaming && waitingToolId === null;
  const waiting = waitingToolId !== null;
  const settled = !streaming && !waiting && message.gap !== true && suspendedOn(message) === null;
  // M92.2: the run's own clock runs from when its Init reached the reply
  // until the turn ends or a hook holds it; once the reply has settled and
  // waits on nobody, Claude Code's own count says how long it worked.
  const startedAt = useRunStart(message.seq, streaming);
  const ticking = message.live?.ended !== true && suspendedOn(message) === null;
  const worked =
    !streaming && !waiting && typeof message.workedMs === 'number' ? message.workedMs : undefined;
  const context: RowContext = {
    onOpenPath,
    onViewDiff: cardDiff,
    history,
    streaming,
    waitingToolId,
    theme,
    latestTodoId: latestTodo(message.tools),
  };
  return (
    <TurnMessage
      from="assistant"
      className="cb-chat-assistant"
      data-testid="chat-message"
      {...arrival}
    >
      <MessageContent>
        {/* Its pieces in order: the chain of thought where its first step
            came, every call it did not fold, and each message's words. M15:
            the words and the error are not mutually exclusive, so a turn
            that wrote three paragraphs and then failed keeps them. */}
        {lines.map((line) => (
          <Arrival key={line.key} when={live}>
            {line.kind === 'text' ? (
              <div className={line.answer ? 'cb-chat-answer' : 'cb-chat-narration'}>
                <MessageText text={line.text} onOpen={onOpen} arrive={live} theme={theme} />
                {line.answer && settled && line.text.trim() !== '' && (
                  <ArtifactActions
                    attemptId={message.id}
                    text={line.text}
                    onPreview={setArtifact}
                  />
                )}
              </div>
            ) : (
              <div className="cb-chat-row">
                {line.kind === 'chain' ? (
                  <TurnChain
                    steps={line.steps}
                    summary={line.summary}
                    latest={latest ?? watched}
                    context={context}
                    worked={worked}
                  />
                ) : (
                  <StepItem item={line} {...context} />
                )}
              </div>
            )}
          </Arrival>
        ))}
        {artifact !== null && (
          <AnswerSaveDialog
            preview={artifact}
            onClose={() => setArtifact(null)}
            onOpenPath={onOpenPath}
          />
        )}
        {sources.length > 0 && (
          <Arrival when={live}>
            <div className="cb-chat-row">
              <Sources data-testid="turn-sources" sources={sources} onOpenPath={onOpenPath} />
            </div>
          </Arrival>
        )}
        {generationObservation !== null && (
          <p role="status" aria-label="Response status" className="m-0 text-sm text-n-500">
            This response was already started. Last reported status: {generationObservation.state}.
            {!streaming && ' Live progress is not connected here.'}
          </p>
        )}
        {/* M56.4: a failure Rust could type is a card with its fix; one it
            could not keeps the red box and Claude Code's own words. */}
        {message.error !== undefined && message.notice !== undefined && (
          <FailureNoticeCard
            notice={message.notice}
            raw={message.error}
            actions={noticeActions}
            onReviewRecovery={reviewRecovery}
            onOpenPath={onOpenPath}
            arrive={live}
          />
        )}
        {message.error !== undefined && message.notice === undefined && (
          <TurnError
            error={message.error}
            onReviewRecovery={reviewRecovery}
            onOpenPath={onOpenPath}
            arrive={live}
          />
        )}
        {streaming && lines.length === 0 && message.error === undefined ? (
          // Nothing of the turn has come yet: it is thinking.
          <span className="cb-chat-working text-sm text-n-400">
            {working && <WorkingDots />}
            <span className={working ? 'cb-working-text' : undefined}>Thinking…</span>
          </span>
        ) : (
          // Words or calls on screen and the turn still going, or waiting on
          // the person: the line stays under them, so a pause between calls
          // never reads as the end.
          (working || waiting) &&
          message.error === undefined && (
            <WorkingLine startedAt={startedAt} ticking={ticking} waiting={waiting} />
          )
        )}
        {message.childTraceUnavailable === true && (
          <p role="status" data-testid="child-trace-unavailable" className="text-sm text-n-500">
            Some subagent details are unavailable. The details shown may be incomplete.
          </p>
        )}
        {/* M57.6: the journal dropped some of this turn's live events while the
            panel was closed, so what shows is partial until the turn ends and
            its reply is read back from the session file. */}
        {message.gap === true && (
          <Arrival when={live}>
            <span data-testid="turn-gap" className="text-sm text-n-400">
              {GAP_LINE}
            </span>
          </Arrival>
        )}
        <ArchivePersistence message={message} />
        {/* M58.3: what each of this reply's runs changed, from its own commit. */}
        {message.changesets !== undefined && message.changesets.length > 0 && (
          <TurnChangeset
            changesets={message.changesets}
            onViewDiff={onViewDiff}
            onOpenPath={onOpenPath}
            arrive={live}
          />
        )}
        {/* M57.5: a turn a person stopped (Stop, or Steer past it) says so,
            under whatever it wrote first. */}
        {message.cancelled === true && !streaming && (
          <Arrival when={live}>
            <span data-testid="turn-cancelled" className="text-sm text-n-400">
              Cancelled
            </span>
          </Arrival>
        )}
        {/* M56.3: a turn stopped or cut off before it said or did anything
            says so, rather than leaving an empty reply. */}
        {message.cancelled !== true &&
          message.interrupted === true &&
          !streaming &&
          lines.length === 0 &&
          message.error === undefined && (
            <Arrival when={live}>
              <span data-testid="turn-stopped" className="text-sm text-n-400">
                Stopped before it replied.
              </span>
            </Arrival>
          )}
      </MessageContent>
    </TurnMessage>
  );
}

function ArchivePersistence({ message }: { message: ChatMessage }) {
  const record = message.archiveRecord;
  if (record === undefined) return null;
  return (
    <span className="text-xs text-n-500" data-testid="archive-persistence">
      Archive: {record.persistence}
      {record.origin === 'browser_cache' && (
        <>
          {' '}
          · Imported from recent history
          {record.completedAt === undefined
            ? ' · Completion time unavailable here'
            : record.completedAt === null
              ? ' · Completion time not recorded'
              : ''}
        </>
      )}
      {record.persistence === 'retained' ? (
        record.expiresAt === null ? (
          ' · No expiry'
        ) : (
          <>
            {' '}
            · Expires{' '}
            <time dateTime={record.expiresAt}>{new Date(record.expiresAt).toLocaleString()}</time>
          </>
        )
      ) : null}
    </span>
  );
}

/**
 * The turn's chain of thought (§3.3): "Working" while a step runs, then how
 * many steps the turn took and how many failed, opening onto its reasoning
 * and its folded reads; led, once the turn has settled, by how long Claude
 * Code counted it worked, when every run counted (M92.2): "Worked for 4m 12s
 * · 5 steps". The latest turn's starts open, and so does one at work or
 * holding a failure; the reader's choice wins from then on. Its steps stay
 * in the document while it is closed, each keeping its own state.
 */
function TurnChain({
  steps,
  summary,
  latest,
  context,
  worked,
}: {
  steps: ChainStep[];
  summary: StepSummary;
  latest: boolean;
  context: RowContext;
  /** How long Claude Code worked on the settled turn, in ms. */
  worked?: number;
}) {
  const [choice, setChoice] = useState<boolean | undefined>(undefined);
  const drawn = useDrawn();
  return (
    <ChainOfThought
      data-testid="turn-chain"
      summary={summary}
      title={
        worked === undefined || summary.running
          ? undefined
          : `Worked for ${formatDuration(worked)} · ${chainTitle(summary)}`
      }
      open={choice ?? chainOpens(summary, latest)}
      onOpenChange={setChoice}
    >
      {steps.map((step) => (
        <Arrival key={step.key} when={drawn}>
          <div className="cb-chat-row">
            <StepItem item={step} {...context} />
          </div>
        </Arrival>
      ))}
    </ChainOfThought>
  );
}

/**
 * Branch from here (M91.12c, Q8): the marker the conversation draws between
 * a reply and the turn after it. Its button names the turn it follows and
 * opens a new conversation holding the thread up to there, whose next turn
 * forks the session at that reply; the files later turns changed stay as
 * they are, which the marker says. Which replies offer one is the panel's to
 * decide (elements/panelCheckpoints.ts).
 */
export function TurnCheckpoint({
  turn,
  onBranch,
  disabled = false,
}: {
  /** The turn it follows, as its button's name ends: "your message “…”". */
  turn: string;
  onBranch: () => void;
  /** A send in this thread is still starting, and leaving would cancel it. */
  disabled?: boolean;
}) {
  return (
    <Checkpoint
      data-testid="turn-checkpoint"
      triggerTestId="branch-from-here"
      turn={turn}
      onBranch={onBranch}
      disabled={disabled}
    />
  );
}

/** A turn at work, as Macro's working line draws it: three dots rippling on
 *  the working light's period (chat-turn.css). Decoration only: the
 *  composer's footer and the minimized button's status say it in words. */
export function WorkingDots() {
  return (
    <span className="cb-chat-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * The line under a reply at work (M92.2): "Working for 1m 5s", by whole
 * seconds on the run's own clock, or "Waiting for your answer" while a card
 * waits, with no figure; the clock keeps counting under it, since Claude
 * Code's own count takes in a live ask's wait. With no start, a re-attach's
 * or a reload's, it reads "Working…", never 0s. The clock stops where the
 * turn ends or a hook holds it, so the count the turn settles on, which
 * Claude Code started before the Init that started this clock, is never
 * below the last figure shown. Decoration, as the dots are: the composer's
 * footer and the minimized button's status say it in words, so the line and
 * its ticking figure stay hidden from assistive tech.
 */
function WorkingLine({
  startedAt,
  ticking,
  waiting,
}: {
  startedAt: number | null;
  ticking: boolean;
  waiting: boolean;
}) {
  const elapsed = useElapsed(startedAt, ticking);
  const words = waiting
    ? STEP_STATUS_WORDS.waiting
    : elapsed === null || elapsed < 1000
      ? 'Working…'
      : `Working for ${formatDuration(Math.floor(elapsed / 1000) * 1000)}`;
  return (
    <span
      data-testid="turn-working"
      className="cb-chat-working text-sm text-n-400"
      aria-hidden="true"
    >
      {!waiting && <WorkingDots />}
      <span className={waiting ? undefined : 'cb-working-text'}>{words}</span>
    </span>
  );
}

/**
 * When the run writing a reply began, on this panel's clock (M92.2): when
 * its first event, its Init, reached the reply. Each run counts its events
 * from 1 (the journal's `seq`), so the reply's cursor starts over with every
 * run, a send's or the one an answer resumes, and only then. Memory only,
 * never saved: null with no run seen to begin here, and once the reply
 * stops streaming.
 */
function useRunStart(seq: number | undefined, streaming: boolean): number | null {
  const [start, setStart] = useState<number | null>(null);
  const cursor = useRef(seq);
  useEffect(() => {
    const before = cursor.current;
    cursor.current = seq;
    if (!streaming) setStart(null);
    else if (seq !== undefined && (before === undefined || seq < before)) setStart(Date.now());
  }, [seq, streaming]);
  return streaming ? start : null;
}

/** The time since `start`, read on each whole second after it while
 * `ticking` and held where it stood once it stops; null with no start. */
function useElapsed(start: number | null, ticking: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (start === null || !ticking) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      timer = setTimeout(tick, 1000 - (Math.max(0, at - start) % 1000));
    };
    tick();
    return () => clearTimeout(timer);
  }, [start, ticking]);
  return start === null || now === null || now < start ? null : now - start;
}

/** Each vault page a reply drew on, named by its title where the vault has
 * the page. */
function titled(sources: SourceRef[], entries: Entry[]): SourceRef[] {
  return sources.map((source) => {
    if (source.kind !== 'vault' || source.title !== undefined) return source;
    const entry = entries.find((e) => e.path === source.path);
    return entry === undefined ? source : { ...source, title: entry.title };
  });
}

/** The commit this reply's run made of `path` (M58.3), the latest first, or
 * null when no run of it committed that file. */
function commitOf(message: ChatMessage, path: string): string | null {
  for (const changeset of [...(message.changesets ?? [])].reverse()) {
    if (changeset.state === 'committed' && changeset.files.some((f) => f.path === path)) {
      return changeset.commit;
    }
  }
  return null;
}

/** What a reply whose live events were dropped says under it (M57.6). */
const GAP_LINE =
  "Live updates from while the panel was closed weren't kept. The full reply appears when this turn finishes.";
