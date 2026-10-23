import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  foldHandoffReads,
  HANDOFF_POLL_MS,
  handoffLines,
  handoffRunIds,
  handoffsCount,
  handoffsGoingOn,
  handoffsState,
  NO_READS,
  RAIL_HANDOFFS_WORDS,
  type HandoffLine,
  type HandoffReads,
  type RailHandoffs,
} from '@/agent/elements/railHandoffs';
import { openOutside } from '@/agent/rail/ConversationRail';
import { focusRevealed } from '@/agent/stepReveal';
import { RailSection } from '@/components/ai/Rail';
import { StepHead } from '@/components/ai/StepLine';
import { Trace } from '@/components/ai/Trace';
import { Icon } from '@/components/ui/Icon';
import { motionAllowed } from '@/components/ui/motion';
import { StateMessage } from '@/components/ui/StateMessage';
import { fleetRunDetail } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import './rail-jump.css';

/**
 * The rail's Handed off card (M92.11, §0 Q13, §2): the runs the
 * conversation's hand-offs started (`railHandoffs`), newest first, each as
 * its record in runtime.db says it went: its outcome in Rust's word and its
 * time, only as recorded (CV-05). A hand-off whose answer named no run says
 * its run is not recorded; a run whose read failed makes its own line
 * unavailable, and the card partial, or unavailable when no read answered.
 *
 * It reads the newest runs (`fleetRunDetail`) as it is shown, when the
 * conversation hands off a run it has not read, and when a turn ends; then
 * every HANDOFF_POLL_MS while one of them goes on and the rail can be seen.
 * Folded away with the rail, it reads nothing and polls nothing, and draws
 * nothing new until the rail unfolds; a streamed word is no news to it.
 *
 * A line's press stays in the canvas (§1): the rail's `jump`, and the
 * transcript brings the hand-off's own line into view and focuses it. Its
 * second action, "Open …'s run (leaves full screen)", floats the
 * conversation first (`openOutside`), since the canvas hides the run it
 * opens. Every control is a button and a tab stop of its own (WebKit), never
 * an href (CV-16).
 */

export interface HandoffsCardProps {
  /** The conversation's hand-offs (`railHandoffs`). */
  handoffs: RailHandoffs;
  /** Folded away with the rail (ConversationRail), hidden and inert: the
   *  card reads nothing, polls nothing and draws nothing new until the rail
   *  unfolds. */
  folded: boolean;
  /** The rail's primary action (ConversationRail's `jump`). */
  jump: (go: () => void) => void;
  /** Bring a transcript element into view: the host's transcript scroller,
   *  which keeps a streaming turn from pulling the reader back. Left out,
   *  the browser scrolls it into view. */
  reveal?: (element: HTMLElement) => void;
}

/** A folded card keeps what it drew; an unfolding one draws the latest. */
function stillWhileFolded(before: HandoffsCardProps, after: HandoffsCardProps): boolean {
  if (before.folded && after.folded) return true;
  return (
    before.handoffs === after.handoffs &&
    before.folded === after.folded &&
    before.jump === after.jump &&
    before.reveal === after.reveal
  );
}

/**
 * The listed runs' latest reads (§2): read as the card is shown or unfolds,
 * when a run it lists is new, and when a turn ends; then polled while one of
 * them goes on and the card is not folded. A poll that comes while the
 * window is hidden reads nothing (useGit's rule, M53.13): the shell keeps a
 * hidden window's timers running. A read's answers land only while it is
 * the latest: one a fold, a newer read or the card's unmount overtook is
 * dropped.
 */
function useHandoffReads(handoffs: RailHandoffs, folded: boolean): HandoffReads {
  const [reads, setReads] = useState<HandoffReads>(NO_READS);
  // Each turn's end, counted: it reads the runs again.
  const [turn, setTurn] = useState({ streaming: handoffs.streaming, ended: 0 });
  if (turn.streaming !== handoffs.streaming) {
    setTurn({ streaming: handoffs.streaming, ended: turn.ended + (turn.streaming ? 1 : 0) });
  }
  const key = handoffRunIds(handoffs).join('\n');
  const latest = useRef(0);
  const read = useCallback(() => {
    const ids = key === '' ? [] : key.split('\n');
    latest.current += 1;
    const asked = latest.current;
    void Promise.allSettled(ids.map((id) => fleetRunDetail(id))).then((answers) => {
      if (latest.current === asked) setReads((before) => foldHandoffReads(before, ids, answers));
    });
  }, [key]);
  useEffect(() => {
    if (folded || key === '') return;
    read();
    return () => {
      latest.current += 1;
    };
  }, [folded, key, read, turn.ended]);
  const goingOn = !folded && handoffsGoingOn(handoffs, reads);
  useEffect(() => {
    if (!goingOn) return;
    const timer = window.setInterval(() => {
      // Only `hidden` sleeps: a jsdom that is not pretending to be visual
      // says `prerender`, and that must keep polling.
      if (document.visibilityState !== 'hidden') read();
    }, HANDOFF_POLL_MS);
    return () => window.clearInterval(timer);
  }, [goingOn, read]);
  return reads;
}

/** The transcript's line for the call `toolId`: a row of a reply
 *  (MessageScrollerItem's `data-message-id`), never the rail's own. */
function lineIn(scope: ParentNode, toolId: string): HTMLElement | null {
  for (const line of scope.querySelectorAll<HTMLElement>(
    '[data-message-id] [data-testid="action-card"]',
  )) {
    if (line.dataset.toolId === toolId) return line;
  }
  return null;
}

/** Bring a hand-off's line into view and focus it, once: the button that
 *  opens its run where it has one, else the line. */
function revealLine(
  scope: ParentNode,
  toolId: string,
  reveal: ((element: HTMLElement) => void) | undefined,
): void {
  const line = lineIn(scope, toolId);
  if (line === null) return;
  if (reveal !== undefined) reveal(line);
  // jsdom has no scrollIntoView.
  else line.scrollIntoView?.({ block: 'center', behavior: motionAllowed() ? 'smooth' : 'auto' });
  focusRevealed(line.querySelector<HTMLElement>('[data-slot="subagent-handoff-run"]') ?? line);
}

export const HandoffsCard = memo(function HandoffsCard({
  handoffs,
  folded,
  jump,
  reveal,
}: HandoffsCardProps) {
  const reads = useHandoffReads(handoffs, folded);
  const navigate = useNavStore((s) => s.navigate);
  const state = handoffsState(handoffs, reads);
  if (state === null) return null;
  const lines = handoffLines(handoffs, reads);
  // The rail is the panel's aside's third area (M92.1): the transcript a
  // hand-off is shown in is the aside's own.
  const show = (from: HTMLElement, toolId: string) => {
    const scope: ParentNode = from.closest('aside') ?? from.ownerDocument;
    jump(() => revealLine(scope, toolId, reveal));
  };
  const openRun = (run: string) =>
    openOutside(() => navigate({ kind: 'knowledge', nav: { tab: 'runs', run } }));
  const shown = handoffs.rows.length;
  return (
    <RailSection
      data-testid="rail-handoffs"
      title={RAIL_HANDOFFS_WORDS.title}
      icon="forward"
      count={handoffsCount(handoffs, reads)}
      state={state}
    >
      {state === 'unavailable' && (
        <StateMessage compact state="unavailable" title={RAIL_HANDOFFS_WORDS.unavailable} />
      )}
      {state === 'partial' && (
        <StateMessage
          compact
          state="partial"
          title={RAIL_HANDOFFS_WORDS.partial}
          testId="rail-handoffs-partial"
        />
      )}
      <Trace role="list">
        {lines.map((line) => (
          <HandoffItem
            key={line.toolId}
            line={line}
            // Said once, above, where no run could be read.
            quiet={state === 'unavailable'}
            show={show}
            openRun={openRun}
          />
        ))}
      </Trace>
      {handoffs.earlier > 0 && (
        <p data-testid="rail-handoffs-earlier" className="m-0 pt-1 text-2xs text-n-500">
          {RAIL_HANDOFFS_WORDS.earlier(shown, shown + handoffs.earlier)}
        </p>
      )}
    </RailSection>
  );
}, stillWhileFolded);

/** One hand-off: its words and its run's, which show its line in the
 *  transcript; the run it opens beside it. */
function HandoffItem({
  line,
  quiet,
  show,
  openRun,
}: {
  line: HandoffLine;
  /** The card already says no run could be read. */
  quiet: boolean;
  show: (from: HTMLElement, toolId: string) => void;
  openRun: (run: string) => void;
}) {
  const { runId } = line;
  const note = quiet && line.state === 'unavailable' ? undefined : line.note;
  const open = RAIL_HANDOFFS_WORDS.open(line.agent);
  return (
    <div
      role="listitem"
      data-testid="rail-handoff"
      data-tool-id={line.toolId}
      data-run-id={runId ?? undefined}
      data-state={line.state}
      data-outcome={line.outcome ?? undefined}
      className="flex min-w-0 items-start gap-1"
    >
      <button
        type="button"
        // WebKit leaves a native button without one out of the Tab order.
        tabIndex={0}
        data-testid="rail-handoff-show"
        className="cb-ai-step-link cb-rail-jump"
        onClick={(event) => show(event.currentTarget, line.toolId)}
      >
        <StepHead
          status={line.status}
          // The outcome is in its words, after the title.
          statusText={null}
          icon={line.icon}
          title={line.title}
          description={line.facts}
          progress={note}
        />
        <span className="sr-only">{RAIL_HANDOFFS_WORDS.show}</span>
      </button>
      {runId !== null && (
        <button
          type="button"
          tabIndex={0}
          data-testid="rail-handoff-open"
          aria-label={open}
          title={open}
          onClick={() => openRun(runId)}
          className="motion-hover ml-auto inline-flex flex-none rounded-xs border-0 bg-transparent p-0.5 text-n-400 hover:text-n-800"
        >
          <Icon name="arrow-up-right" size={14} />
        </button>
      )}
    </div>
  );
}
