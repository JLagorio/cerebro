import { memo, useLayoutEffect, useRef, type Ref, type RefObject } from 'react';
import type { RailContext } from '@/agent/elements/contextCard';
import type { RailChanges } from '@/agent/elements/conversationChanges';
import type { RailHandoffs } from '@/agent/elements/railHandoffs';
import type { RailPlan } from '@/agent/elements/railPlan';
import type { RailSources } from '@/agent/elements/railSources';
import type { RailSubagents } from '@/agent/elements/railSubagents';
import type { RailWaiting } from '@/agent/elements/railWaiting';
import { ChangesCard } from '@/agent/rail/ChangesCard';
import { ConnectorsCard } from '@/agent/rail/ConnectorsCard';
import { ContextCard } from '@/agent/rail/ContextCard';
import { EnvironmentCard } from '@/agent/rail/EnvironmentCard';
import { HandoffsCard } from '@/agent/rail/HandoffsCard';
import { PlanCard } from '@/agent/rail/PlanCard';
import { SourcesCard } from '@/agent/rail/SourcesCard';
import { SubagentsCard } from '@/agent/rail/SubagentsCard';
import { WaitingCard } from '@/agent/rail/WaitingCard';
import type { RunReach } from '@/agent/types';
import type { TranscriptStatus } from '@/agent/useConversations';
import type { MessageScrollerCommands } from '@/components/ai/MessageScroller';
import { Rail } from '@/components/ai/Rail';
import { useMergedRefs } from '@/components/ai/mergeRefs';
import { leaveGhost, useArrival } from '@/components/ui/motion';
import { useUiStore } from '@/stores/uiStore';
import { SectionBoundary } from '@/components/ui/SectionBoundary';

/**
 * A rail row's secondary action, "Open … (leaves full screen)" (M92.1, §1).
 * The canvas hides the page and the record peek, so the conversation floats
 * first, and then `open` runs, so what it opens is on screen.
 */
export function openOutside(open: () => void): void {
  useUiStore.getState().setAiPanelPresentation('floating');
  open();
}

/** The class a drawer's copy leaves under (agent/chat.css). */
const DRAWER_LEAVE = 'cb-chat-rail-leave';

/**
 * Mounted inside the rail while it is a drawer, for the moment it stops
 * being one and folds away, still mounted: a child's unmount runs before
 * the rail's own update is written, so the copy taken is still the drawer,
 * and it is placed only once the rail has folded (the sidebar drawer's way
 * out, app/shellMotion.ts). A drawer let go because the rail fits again is
 * the docked rail now, and needs no copy. The rail is read as this goes,
 * not as it came: a rail that mounts as a drawer holds no element yet when
 * its children's effects run. A drawer that leaves with the rail itself
 * lets go of the element first, and Presence plays its exit instead.
 */
function DrawerExit({ rail }: { rail: RefObject<HTMLElement | null> }) {
  useLayoutEffect(
    () => () => {
      const el = rail.current;
      const parent = el?.parentNode ?? null;
      leaveGhost(el, DRAWER_LEAVE, {
        left: (gone) =>
          gone.isConnected &&
          gone.parentNode === parent &&
          !gone.hasAttribute('data-overlay') &&
          getComputedStyle(gone).display === 'none',
      });
    },
    [rail],
  );
  return null;
}

export interface ConversationRailProps {
  /** The region's id, which the header toggle's `aria-controls` names. */
  id: string;
  /** Drawn as a drawer over the transcript: the canvas has no room to dock
   *  it, and a person asked for it. */
  drawer: boolean;
  /** Folded away: the canvas has no room to dock it and no drawer is open.
   *  CSS hides it, and this keeps focus and the reader out of it. */
  folded: boolean;
  /** Shown, but the canvas's width is not measured yet, so CSS may have
   *  folded it away: its cards read nothing, as folded ones, until the
   *  width says it docks (M92.1). */
  measuring?: boolean;
  /** Turned off, and on its way out (`Presence`, components/ui/motion.ts):
   *  it plays its exit and takes nothing. */
  closing: boolean;
  /** The heading, which takes focus when a person opens the rail. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** The host's hold on it while it leaves. */
  ref?: Ref<HTMLElement>;
  /**
   * A row's primary action: it stays in the canvas. From the drawer it
   * closes the drawer without handing focus back to the drawer's opener,
   * then runs `go`, which scrolls to the row's target and focuses it.
   */
  jump: (go: () => void) => void;
  /** Waiting on you: the call the thread's turn waits on (`railWaiting`). */
  waiting: RailWaiting | null;
  /** The open vault: the book Waiting on you checks while none waits, the
   *  connector list Connectors reads, and what Environment names. */
  vault: string | null;
  /** The conversation the rail is open on. */
  thread: string;
  /** The transcript's scroll commands (Chat's `scrollerRef`). */
  scroller: RefObject<MessageScrollerCommands | null>;
  /** Plan: the conversation's latest todo list (`railPlan`). */
  plan: RailPlan;
  /** The agent is at it now: a turn runs, not waiting and not stopping. */
  working: boolean;
  /** A turn is in flight, a wait on the person included: its end reads
   *  Connectors again. */
  streaming: boolean;
  /** Subagents: every subagent the conversation started (`railSubagents`). */
  subagents: RailSubagents;
  /** What reading the thread's transcript back found. */
  transcript: TranscriptStatus['state'];
  /** Changes: what the conversation changed (`railChanges`). */
  changes: RailChanges;
  /** Handed off: the runs the conversation handed work to (`railHandoffs`). */
  handoffs: RailHandoffs;
  /** Context: the composer's own pull, read into the card (`railContext`). */
  context: RailContext;
  /** Sources: what the conversation drew on (`railSources`). */
  sources: RailSources;
  /** What the conversation's latest run said it reaches
   *  (`conversations.threadReach`), which Connectors and Environment read;
   *  null when none has. */
  reach: RunReach | null;
  /** A row's second action, a vault page; `openOutside` floats first. */
  onOpenPath: (path: string) => void;
  /** A deleted file's diff at its commit; absent where diffs cannot show. */
  onViewDiff?: (path: string, commit: string) => void;
  /** Brings a transcript element into view, through the transcript's
   *  scroller. */
  reveal: (element: HTMLElement) => void;
}

/**
 * The canvas conversation's details (M92.1): a rail beside the transcript,
 * docked where the canvas has room, folded away where it has not, and a
 * drawer over the transcript when a person opens it there. AiPanel decides
 * what it is asked to be, and chat.css draws it. It holds §0 Q5's cards, in
 * that order, one line each: what waits on the person, what is planned, what
 * happened, then the setup. It takes memoized, derived props only, never the
 * messages, which change with every streamed word: a turn's stream never
 * draws it again.
 */
export const ConversationRail = memo(function ConversationRail({
  id,
  drawer,
  folded,
  measuring = false,
  closing,
  headingRef,
  ref,
  jump,
  waiting,
  vault,
  thread,
  scroller,
  plan,
  working,
  streaming,
  subagents,
  transcript,
  changes,
  handoffs,
  context,
  sources,
  reach,
  onOpenPath,
  onViewDiff,
  reveal,
}: ConversationRailProps) {
  const own = useRef<HTMLElement | null>(null);
  // What the cards are told: folded away, or not yet known to dock. Either
  // way they read nothing.
  const quiet = folded || measuring;
  const setRail = useMergedRefs(own, ref);
  // It arrives once, as it mounts (chat.css): docked, beside the transcript;
  // as a drawer, over it. A drawer opened from the fold comes in as one.
  const arrival = useArrival(true);
  // Leaving or folding away, it lets go of focus first (DocSidePanel's
  // rule): a drawer's scrim hands focus back to the drawer's opener only
  // when it finds it on nothing.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (
      (closing || folded) &&
      focused instanceof HTMLElement &&
      own.current?.contains(focused) === true
    ) {
      focused.blur();
    }
  }, [closing, folded]);
  return (
    <Rail
      ref={setRail}
      id={id}
      title="Conversation details"
      headingRef={headingRef}
      className="cb-chat-rail"
      data-testid="conversation-rail"
      data-state={closing ? 'closed' : 'open'}
      // A drawer is what DrawerScrim finds an Escape's target in, and what
      // takes focus when Escape leaves a field inside it.
      data-drawer={drawer || undefined}
      data-overlay={drawer || undefined}
      tabIndex={drawer ? -1 : undefined}
      inert={closing || folded || undefined}
      {...arrival}
    >
      {drawer && <DrawerExit rail={own} />}
      {/* The cards, in §0 Q5's order. */}
      {/* M93.12: each card faults alone, outside components/ai/ (CV-64). */}
      <SectionBoundary label="Waiting on you" compact>
        <WaitingCard
          waiting={waiting}
          vault={vault}
          thread={thread}
          folded={quiet}
          jump={jump}
          scroller={scroller}
        />
      </SectionBoundary>
      <SectionBoundary label="Plan" compact>
        <PlanCard plan={plan} working={working} folded={quiet} />
      </SectionBoundary>
      <SectionBoundary label="Subagents" compact>
        <SubagentsCard subagents={subagents} transcript={transcript} folded={quiet} jump={jump} />
      </SectionBoundary>
      <SectionBoundary label="Changes" compact>
        <ChangesCard
          changes={changes}
          folded={quiet}
          jump={jump}
          onOpenPath={onOpenPath}
          onViewDiff={onViewDiff}
          reveal={reveal}
        />
      </SectionBoundary>
      <SectionBoundary label="Handed off" compact>
        <HandoffsCard handoffs={handoffs} folded={quiet} jump={jump} reveal={reveal} />
      </SectionBoundary>
      <SectionBoundary label="Context" compact>
        <ContextCard context={context} folded={quiet} />
      </SectionBoundary>
      <SectionBoundary label="Sources" compact>
        <SourcesCard
          sources={sources}
          folded={quiet}
          jump={jump}
          onOpenPath={onOpenPath}
          reveal={reveal}
        />
      </SectionBoundary>
      <SectionBoundary label="Connectors" compact>
        <ConnectorsCard vault={vault} reach={reach} streaming={streaming} folded={quiet} />
      </SectionBoundary>
      <SectionBoundary label="Environment" compact>
        <EnvironmentCard vault={vault} reach={reach} folded={quiet} />
      </SectionBoundary>
    </Rail>
  );
});
