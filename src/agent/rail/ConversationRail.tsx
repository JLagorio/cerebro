import { memo, useLayoutEffect, useRef, type Ref, type RefObject } from 'react';
import type { RailChanges } from '@/agent/elements/conversationChanges';
import type { RailPlan } from '@/agent/elements/railPlan';
import type { RailSources } from '@/agent/elements/railSources';
import type { RailSubagents } from '@/agent/elements/railSubagents';
import type { RailWaiting } from '@/agent/elements/railWaiting';
import { ChangesCard } from '@/agent/rail/ChangesCard';
import { PlanCard } from '@/agent/rail/PlanCard';
import { SourcesCard } from '@/agent/rail/SourcesCard';
import { SubagentsCard } from '@/agent/rail/SubagentsCard';
import { WaitingCard } from '@/agent/rail/WaitingCard';
import type { TranscriptStatus } from '@/agent/useConversations';
import type { MessageScrollerCommands } from '@/components/ai/MessageScroller';
import { Rail } from '@/components/ai/Rail';
import { useMergedRefs } from '@/components/ai/mergeRefs';
import { leaveGhost, useArrival } from '@/components/ui/motion';
import { useUiStore } from '@/stores/uiStore';

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
  /** The open vault, whose book Waiting on you checks while none waits. */
  vault: string | null;
  /** The conversation the rail is open on. */
  thread: string;
  /** The transcript's scroll commands (Chat's `scrollerRef`). */
  scroller: RefObject<MessageScrollerCommands | null>;
  /** Plan: the conversation's latest todo list (`railPlan`). */
  plan: RailPlan;
  /** The agent is at it now: a turn runs, not waiting and not stopping. */
  working: boolean;
  /** Subagents: every subagent the conversation started (`railSubagents`). */
  subagents: RailSubagents;
  /** What reading the thread's transcript back found. */
  transcript: TranscriptStatus['state'];
  /** Changes: what the conversation changed (`railChanges`). */
  changes: RailChanges;
  /** Sources: what the conversation drew on (`railSources`). */
  sources: RailSources;
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
 * that order, each one line here added by the wave that builds it, and it
 * takes memoized, derived props only, never the messages, which change with
 * every streamed word: a turn's stream never draws it again.
 */
export const ConversationRail = memo(function ConversationRail({
  id,
  drawer,
  folded,
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
  subagents,
  transcript,
  changes,
  sources,
  onOpenPath,
  onViewDiff,
  reveal,
}: ConversationRailProps) {
  const own = useRef<HTMLElement | null>(null);
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
      {/* The cards, in §0 Q5's order: each wave adds its own here. */}
      <WaitingCard
        waiting={waiting}
        vault={vault}
        thread={thread}
        folded={folded}
        jump={jump}
        scroller={scroller}
      />
      <PlanCard plan={plan} working={working} folded={folded} />
      <SubagentsCard subagents={subagents} transcript={transcript} folded={folded} jump={jump} />
      <ChangesCard
        changes={changes}
        folded={folded}
        jump={jump}
        onOpenPath={onOpenPath}
        onViewDiff={onViewDiff}
        reveal={reveal}
      />
      <SourcesCard
        sources={sources}
        folded={folded}
        jump={jump}
        onOpenPath={onOpenPath}
        reveal={reveal}
      />
    </Rail>
  );
});
