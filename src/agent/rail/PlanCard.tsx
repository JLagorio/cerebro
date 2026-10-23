import { memo } from 'react';
import { PLAN_WORDS, planProgress } from '@/components/ai/Plan';
import { Queue, QueueList, QueueSection, TodoQueueItem } from '@/components/ai/Queue';
import { RailSection } from '@/components/ai/Rail';
import { StateMessage } from '@/components/ui/StateMessage';
import type { RailPlan, RailPlanList } from '@/agent/elements/railPlan';
import type { TodoItem } from '@/engine/ai/types';

/**
 * The rail's Plan card (M92.17, §0 Q11): the conversation's latest todo list
 * (`railPlan`), "2 of 5 done" on its heading line, kept once its turn is
 * done. Its rows are the dock's (`TodoQueueItem`): what is left, then what is
 * done, each under its count; the step under way reads what the agent is
 * doing, with the working light, only while the turn that wrote the list
 * works. A section heads its items rather than folding them, so the card's
 * own fold is its one control, a tab stop of its own (RailSection).
 *
 * It reads nothing and polls nothing: the list is the conversation's own,
 * derived by its host. Where the list cannot be shown it says why (CV-05):
 * not recorded whole, an earlier list in place of one that does not read,
 * or a transcript that could not be read back; while that transcript is
 * still being read, the card waits, drawing nothing.
 */

/** The card's words. */
export const RAIL_PLAN_WORDS = {
  title: 'Plan',
  /** After an empty card's name: no list in this conversation. */
  none: 'None',
  notRecorded: 'Plan not recorded',
  earlier: 'Showing an earlier list',
  earlierDetail: "The latest list couldn't be read.",
  unavailable: "Couldn't read the plan",
  unavailableDetail: "This conversation's transcript couldn't be read back.",
} as const;

export interface PlanCardProps {
  /** The conversation's plan (`railPlan`). */
  plan: RailPlan;
  /** The agent is at it now: a turn runs, not waiting on the person and not
   *  stopping. The step under way of a list that turn wrote carries the
   *  working light. */
  working: boolean;
  /** Folded away with the rail (ConversationRail), hidden and inert: the
   *  card draws nothing new until the rail unfolds. */
  folded: boolean;
}

/**
 * A folded card keeps what it drew: its rail is hidden and inert, so the
 * lists a turn writes meanwhile cost it nothing, and it draws the latest as
 * the rail unfolds.
 */
function stillWhileFolded(before: PlanCardProps, after: PlanCardProps): boolean {
  if (before.folded && after.folded) return true;
  return (
    before.plan === after.plan && before.working === after.working && before.folded === after.folded
  );
}

export const PlanCard = memo(function PlanCard({ plan, working }: PlanCardProps) {
  if (plan.state === 'reading') return null;
  const { state, list } = plan;
  const shown = state === 'ready' || state === 'partial' ? list : null;
  return (
    <RailSection
      data-testid="rail-plan"
      title={RAIL_PLAN_WORDS.title}
      icon="route"
      state={state}
      count={shown === null ? undefined : planProgress(shown.todos)}
      none={list === null ? RAIL_PLAN_WORDS.none : PLAN_WORDS.noSteps}
    >
      {state === 'partial' && (
        <StateMessage compact state="partial" title={RAIL_PLAN_WORDS.earlier}>
          {RAIL_PLAN_WORDS.earlierDetail}
        </StateMessage>
      )}
      {state === 'not-recorded' && (
        <StateMessage compact state="not-recorded" title={RAIL_PLAN_WORDS.notRecorded} />
      )}
      {state === 'unavailable' && (
        <StateMessage compact state="unavailable" title={RAIL_PLAN_WORDS.unavailable}>
          {RAIL_PLAN_WORDS.unavailableDetail}
        </StateMessage>
      )}
      {shown !== null && (
        <PlanQueue list={shown} working={state === 'ready' && working && plan.current} />
      )}
    </RailSection>
  );
}, stillWhileFolded);

/** The list in the dock's rows: what is left, then what is done, each under
 *  its heading, where the dock folds what is done away. */
function PlanQueue({ list, working }: { list: RailPlanList; working: boolean }) {
  if (list.todos.length === 0) return null;
  // A list may name one todo twice; its place in the list is its identity.
  const items = (todos: readonly TodoItem[]) =>
    todos.map((todo, index) => <TodoQueueItem key={`${index}:${todo.content}`} todo={todo} />);
  return (
    <Queue isStreaming={working}>
      {list.todo.length > 0 && (
        <QueueSection
          data-section="todo"
          label="to do"
          count={list.todo.length}
          icon="list-todo"
          collapsible={false}
          headingLevel={4}
        >
          <QueueList>{items(list.todo)}</QueueList>
        </QueueSection>
      )}
      {list.done.length > 0 && (
        <QueueSection
          data-section="done"
          label="done"
          count={list.done.length}
          icon="list-checks"
          collapsible={false}
          headingLevel={4}
        >
          <QueueList>{items(list.done)}</QueueList>
        </QueueSection>
      )}
    </Queue>
  );
}
