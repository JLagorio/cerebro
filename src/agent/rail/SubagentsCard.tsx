import { memo } from 'react';
import { Badge } from '@/components/ai/Badge';
import { RailSection, type RailSectionState } from '@/components/ai/Rail';
import { StepHead, type StepState } from '@/components/ai/StepLine';
import { subagentFacts } from '@/components/ai/Subagent';
import { Trace } from '@/components/ai/Trace';
import { StateMessage } from '@/components/ui/StateMessage';
import type { RailSubagentRow, RailSubagents } from '@/agent/elements/railSubagents';
import { subagentWords } from '@/agent/elements/turnTitles';
import { revealStep } from '@/agent/stepReveal';
import type { TranscriptStatus } from '@/agent/useConversations';
import './rail-jump.css';

/**
 * Subagents (M92.4, §2): every subagent the conversation's turns started,
 * one line each, said as its line in the transcript says it: what it was
 * asked, what kind it is, how it went (denied kept apart from failed), and
 * its tool uses and time as recorded; while it runs, what it is doing now.
 * The heading counts them by state, "2 running · 3 done", leaving out a
 * state no line is in. A line's press stays in the canvas (§1): the rail's
 * `jump`, and the transcript opens the subagent's own line, brings it into
 * view and focuses it (stepReveal.ts).
 *
 * It reads nothing itself: its lines are `railSubagents`', the same object
 * while a turn streams words, and what reading the thread's transcript back
 * found decides the rest. A read that failed leaves the lines the
 * conversation held, under a line saying some turns could not be read back;
 * with no turns held at all, the card says it could not read the
 * conversation, never that none ran (CV-05). While a thread with nothing
 * held is still being read, it waits, drawing nothing; folded away with the
 * rail, it keeps what it drew.
 */

/** The card's words. */
export const SUBAGENTS_WORDS = {
  title: 'Subagents',
  /** A subagent nobody named a task for, as its line in the transcript. */
  untitled: 'Subagent',
  done: 'Done',
  show: ' (show it in the conversation)',
  notRecorded: 'Steps not recorded',
  partial: 'Some turns could not be read back',
  unavailable: "Couldn't read this conversation back",
} as const;

/** The heading's counts, in this order, each a state's word. */
const BUCKETS: readonly (readonly [StepState, string])[] = [
  ['running', 'running'],
  ['waiting', 'waiting'],
  ['done', 'done'],
  ['failed', 'failed'],
  ['denied', 'denied'],
  ['interrupted', 'interrupted'],
  ['cancelled', 'cancelled'],
  ['not_run', 'not run'],
  ['paused', 'paused'],
];

/** "2 running · 3 done": each state a line is in, counted. */
export function subagentsCount(rows: readonly RailSubagentRow[]): string | undefined {
  const counted = BUCKETS.flatMap(([state, word]) => {
    const count = rows.filter((row) => row.state === state).length;
    return count === 0 ? [] : [`${count} ${word}`];
  });
  return counted.length === 0 ? undefined : counted.join(' · ');
}

/**
 * The card's state, or null while it waits for a read: unavailable when the
 * transcript could not be read back and the conversation holds no turns,
 * partial when it holds some; empty with no lines; not recorded when a
 * line's steps are not, once the read has healed what it could; else ready.
 */
export function subagentsState(
  subagents: RailSubagents,
  transcript: TranscriptStatus['state'],
): RailSectionState | null {
  if (transcript === 'unavailable') return subagents.held ? 'partial' : 'unavailable';
  const reading = transcript === 'reading';
  if (reading && !subagents.held) return null;
  if (subagents.rows.length === 0) return 'empty';
  return !reading && subagents.rows.some((row) => row.stepsNotRecorded === true)
    ? 'not-recorded'
    : 'ready';
}

export interface SubagentsCardProps {
  /** The conversation's subagents (`railSubagents`). */
  subagents: RailSubagents;
  /** What reading the thread's transcript back found (useConversations). */
  transcript: TranscriptStatus['state'];
  /** Folded away with the rail (ConversationRail), hidden and inert: the
   *  card draws nothing new until the rail unfolds. */
  folded: boolean;
  /** The rail's primary action (ConversationRail's `jump`). */
  jump: (go: () => void) => void;
}

/** A folded card keeps what it drew; an unfolding one draws the latest. */
function stillWhileFolded(before: SubagentsCardProps, after: SubagentsCardProps): boolean {
  if (before.folded && after.folded) return true;
  return (
    before.subagents === after.subagents &&
    before.transcript === after.transcript &&
    before.folded === after.folded &&
    before.jump === after.jump
  );
}

/** A line's words, as its line in the transcript says them: its task, or the
 *  transcript's "Denied: …" where Claude Code refused the call (a refused
 *  run reads failed there, its words denied), and the state's words where
 *  the title does not say them. */
function lineWords(row: RailSubagentRow): { title: string; statusText?: string | null } {
  const { type, description } = row;
  if (row.state === 'denied') {
    const refused = { type, description, status: 'failed' as const, parts: [], tools: [] };
    return subagentWords(refused, true) ?? { title: SUBAGENTS_WORDS.untitled };
  }
  return {
    title: description.trim() === '' ? SUBAGENTS_WORDS.untitled : description,
    statusText: row.state === 'done' ? SUBAGENTS_WORDS.done : undefined,
  };
}

function SubagentLine({
  row,
  healing,
  jump,
}: {
  row: RailSubagentRow;
  /** The transcript is being read back: steps may still come. */
  healing: boolean;
  jump: (go: () => void) => void;
}) {
  const words = lineWords(row);
  const kind = row.type.trim();
  const note =
    row.now ??
    (row.stepsNotRecorded === true && !healing ? SUBAGENTS_WORDS.notRecorded : undefined);
  return (
    <button
      type="button"
      // WebKit leaves a native button without one out of the Tab order.
      tabIndex={0}
      data-testid="rail-subagent"
      data-tool-id={row.toolId}
      data-state={row.state}
      className="cb-ai-step-link cb-rail-jump"
      onClick={() => jump(() => revealStep(row.toolId))}
    >
      <StepHead
        status={row.state}
        statusText={words.statusText}
        title={words.title}
        after={
          kind === '' ? undefined : (
            <Badge variant="secondary" data-slot="subagent-type">
              <span className="sr-only">by the </span>
              {kind}
            </Badge>
          )
        }
        description={subagentFacts(row)}
        progress={note}
      />
      <span className="sr-only">{SUBAGENTS_WORDS.show}</span>
    </button>
  );
}

export const SubagentsCard = memo(function SubagentsCard({
  subagents,
  transcript,
  jump,
}: SubagentsCardProps) {
  const state = subagentsState(subagents, transcript);
  if (state === null) return null;
  const { rows } = subagents;
  const healing = transcript === 'reading';
  return (
    <RailSection
      data-testid="rail-subagents"
      title={SUBAGENTS_WORDS.title}
      icon="bot"
      count={subagentsCount(rows)}
      state={state}
    >
      {state === 'unavailable' && (
        <StateMessage compact state="unavailable" title={SUBAGENTS_WORDS.unavailable} />
      )}
      {state === 'partial' && (
        <StateMessage
          compact
          state="partial"
          title={SUBAGENTS_WORDS.partial}
          testId="rail-subagents-partial"
        />
      )}
      {rows.length > 0 && (
        <Trace data-slot="rail-subagent-lines">
          {rows.map((row) => (
            <SubagentLine key={row.toolId} row={row} healing={healing} jump={jump} />
          ))}
        </Trace>
      )}
    </RailSection>
  );
}, stillWhileFolded);
