import { useEffect, useMemo, useState } from 'react';
import { readCliTranscript } from '@/agent/agentIpc';
import { INPUT_PREVIEW_CHARS, railPlan } from '@/agent/elements/railPlan';
import { PlanCard, RAIL_PLAN_WORDS } from '@/agent/rail/PlanCard';
import { healFromTranscript, replayTranscript } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage, ToolCall, TranscriptRead } from '@/agent/types';
import type { TranscriptStatus } from '@/agent/useConversations';
import { Rail } from '@/components/ai/Rail';
import { __seedCliTranscript } from '@/lib/mockIpc';
import { LAB_VAULT, type LabSection } from '../presets';

/**
 * The rail's Plan card (M92.17) in its five states: a conversation opened as
 * a thread opens (useConversations), its saved copy first, then its
 * transcript read back from Claude Code's session file (`read_cli_transcript`)
 * to rebuild it or heal it, and the card drawn over the plan its replies
 * left (`railPlan`), at the rail's width. The lab keeps no thread in storage,
 * so each preset's seed hands the stage the saved copy itself.
 *
 * Synthetic, in the shapes `src-tauri/src/agent/fold.rs` replays a session
 * and conversations.ts saves a call: made-up ids and the demo vault's pages.
 */

/** A conversation as the stage opens it: what the thread saved, and the
 *  session its transcript is read from. Each preset's seed sets it before the
 *  stage mounts. */
let staged: { saved: ChatMessage[]; session: string } = { saved: [], session: '' };

const session = (n: number) => `00000000-0000-4000-8000-00000009217${n}`;
const RISK = 'records/risks/risk-scanner-delivery.md';
const TODOS_WRITTEN =
  'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable';

/** A line's time, `seconds` into the conversation. */
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 6, 28, 11, 40, 0) + seconds * 1000).toISOString();

const PLAN = [
  ['Read the open risks', 'Reading the open risks'],
  ['Find the risk with no mitigation', 'Finding the risk with no mitigation'],
  ['Draft the escalation note', 'Drafting the escalation note'],
  ['Link the note from the launch page', 'Linking the note from the launch page'],
] as const;

interface Todo {
  content: string;
  status: string;
  activeForm: string;
}

/** The plan, each step at the status given. */
const steps = (statuses: string[]): Todo[] =>
  PLAN.map(([content, activeForm], i) => ({ content, status: statuses[i], activeForm }));

/** A TodoWrite call that returned, and the list Claude Code kept. */
function wrote(id: string, todos: Todo[], seconds: number): AgentStreamEvent[] {
  return [
    {
      kind: 'ToolStart',
      tool_name: 'TodoWrite',
      tool_id: id,
      input: JSON.stringify({ todos }),
      at: at(seconds),
    },
    {
      kind: 'ToolDone',
      tool_id: id,
      output: TODOS_WRITTEN,
      is_error: false,
      at: at(seconds + 0.1),
    },
    {
      kind: 'ToolResult',
      tool_id: id,
      data: {
        type: 'todos',
        todos: todos.map(({ content, status, activeForm }) => ({
          content,
          status,
          active_form: activeForm,
        })),
      },
    },
  ];
}

/** A vault page the agent read. */
function readRisk(id: string, seconds: number): AgentStreamEvent[] {
  return [
    {
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__get_note',
      tool_id: id,
      input: JSON.stringify({ path: RISK }),
      at: at(seconds),
    },
    {
      kind: 'ToolDone',
      tool_id: id,
      output: '# Scanner hardware delivery is slipping\n\nNo mitigation is recorded.',
      is_error: false,
      at: at(seconds + 0.4),
    },
  ];
}

/** One turn as its session file replays: the person's words, the reply's
 *  calls, then its words and its end; with no `answer`, the person stopped
 *  it after its calls. */
function turn(
  n: number,
  asked: string,
  calls: AgentStreamEvent[],
  answer: string | null,
): AgentStreamEvent[] {
  const end: AgentStreamEvent[] =
    answer === null
      ? [{ kind: 'TurnInterrupted', reason: 'stopped' }]
      : [
          { kind: 'Text', message_id: `msg_lab_plan_${n}`, text: answer, at: at(n * 10 + 8) },
          {
            kind: 'TurnEnded',
            stop_reason: 'end_turn',
            last_uuid: `00000000-0000-4000-8000-0000000921${n}9`,
          },
        ];
  return [
    { kind: 'UserPrompt', text: asked, uuid: `00000000-0000-4000-8000-0000000921${n}0` },
    { kind: 'ModelChanged', model: 'claude-sonnet-5' },
    ...calls,
    ...end,
  ];
}

/** Two turns, each writing the plan on: the second turn's list is the one
 *  that stands, kept once its turn is done. */
const planned = (): AgentStreamEvent[] => [
  ...turn(
    1,
    'Which risk should we escalate? Plan it out first.',
    [
      ...wrote('toolu_lab_plan_1', steps(['in_progress', 'pending', 'pending', 'pending']), 11),
      ...readRisk('toolu_lab_plan_read', 12),
      ...wrote('toolu_lab_plan_2', steps(['completed', 'in_progress', 'pending', 'pending']), 13),
    ],
    'The scanner delivery risk has no mitigation, so it is the one to escalate.',
  ),
  ...turn(
    2,
    'Go on with the note.',
    [...wrote('toolu_lab_plan_3', steps(['completed', 'completed', 'in_progress', 'pending']), 21)],
    'Drafting the escalation note now; linking it from the launch page comes next.',
  ),
];

/** A step's words past the most a saved call keeps of them, as the person
 *  dictated it. */
const DICTATED =
  "Draft the escalation note for the scanner delivery risk: the vendor's revised ship date, the two launch milestones it moves, and the mitigation the team agreed on in Monday's call";

/** `text` as a call's preview keeps it: cut, the cut marked. ASCII only, so
 *  a character is a code unit. */
const previewed = (text: string) =>
  text.length > INPUT_PREVIEW_CHARS ? `${text.slice(0, INPUT_PREVIEW_CHARS)}…` : text;

/** The thread's saved copy of a turn whose list held the dictated step: the
 *  call keeps its input's preview, never the whole (conversations.ts). */
function savedWithCutList(): ChatMessage[] {
  const todos = steps(['completed', 'in_progress', 'pending', 'pending']).map((todo, i) =>
    i === 2 ? { ...todo, content: DICTATED } : todo,
  );
  const call: ToolCall = {
    id: 'toolu_lab_plan_cut',
    name: 'TodoWrite',
    input: JSON.stringify({
      todos: todos.map((todo) => ({ ...todo, content: previewed(todo.content) })),
    }),
    output: TODOS_WRITTEN,
    done: true,
    failed: false,
    startedAt: at(11),
    endedAt: at(11.1),
  };
  return [
    {
      id: 'lab-plan-u1',
      role: 'user',
      text: 'Plan the escalation note and start on it.',
      tools: [],
    },
    {
      id: 'lab-plan-a1',
      role: 'assistant',
      text: 'Planned it, and the risk is read; the note is next.',
      tools: [call],
    },
  ];
}

/** The most of a call's input one ToolPayload carries (fold.rs
 *  `PAYLOAD_LIMIT_BYTES`). */
const PAYLOAD_LIMIT_BYTES = 256 * 1024;
const LOG_LINE = 'Shipment 4471 held at customs for inspection. ';

/**
 * A TodoWrite call whose list ran past what a call's input keeps: a step
 * holding a pasted delivery log. Its preview cuts the step, and its whole
 * input, cut at the cap, is no longer JSON. Built when asked for: a quarter
 * of a megabyte, ASCII, so a character is a byte.
 */
function oversized(id: string, seconds: number): AgentStreamEvent[] {
  const todos = [
    ...steps(['completed', 'in_progress', 'pending', 'pending']),
    {
      content: `Fold the vendor's delivery log into the risk: ${LOG_LINE.repeat(6_000)}`,
      status: 'pending',
      activeForm: 'Folding in the delivery log',
    },
  ];
  const whole = JSON.stringify({ todos });
  return [
    {
      kind: 'ToolStart',
      tool_name: 'TodoWrite',
      tool_id: id,
      input: JSON.stringify({
        todos: todos.map((todo) => ({ ...todo, content: previewed(todo.content) })),
      }),
      at: at(seconds),
    },
    {
      kind: 'ToolPayload',
      tool_id: id,
      part: 'input',
      text: whole.slice(0, PAYLOAD_LIMIT_BYTES),
      bytes: whole.length,
      truncated: true,
    },
  ];
}

function readOf(events: AgentStreamEvent[]): TranscriptRead {
  return { state: 'read', events, lines: events.length, unclassified: [] };
}

/** Stage a conversation: what its thread saved, and what reading its session
 *  file back gives, or nothing, when Claude Code no longer has it. */
function stage(id: string, saved: ChatMessage[], file: (() => AgentStreamEvent[]) | null) {
  return () => {
    staged = { saved, session: id };
    if (file !== null) __seedCliTranscript(id, readOf(file()));
  };
}

interface Restored {
  messages: ChatMessage[];
  transcript: TranscriptStatus;
}

/** What opening the thread comes to once its transcript is read, as
 *  useConversations restores it: rebuilt from the file when nothing was
 *  saved, the saved copy healed from it otherwise, and the copy as it stands
 *  when the file cannot be read. */
function restore(saved: ChatMessage[], id: string, read: TranscriptRead): Restored {
  if (read.state === 'unavailable') {
    return {
      messages: saved,
      transcript: {
        state: 'unavailable',
        reason: read.reason,
        retentionDays: read.retention_days,
        ...(read.detail === undefined ? {} : { detail: read.detail }),
      },
    };
  }
  const rebuilt = replayTranscript(read.events, id).messages;
  if (saved.length === 0) return { messages: rebuilt, transcript: { state: 'rebuilt' } };
  const healed = healFromTranscript(saved, rebuilt);
  return { messages: healed, transcript: { state: healed === saved ? 'idle' : 'healed' } };
}

/** The conversation, opened: its saved copy at once, then its transcript. */
function Stage() {
  const [restored, setRestored] = useState<Restored>(() => ({
    messages: staged.saved,
    transcript: { state: 'reading' },
  }));
  useEffect(() => {
    let current = true;
    const { saved, session: id } = staged;
    void readCliTranscript(LAB_VAULT, id, null).then((read) => {
      if (current) setRestored(restore(saved, id, read));
    });
    return () => {
      current = false;
    };
  }, []);
  const plan = useMemo(
    () => railPlan(restored.messages, restored.transcript),
    [restored.messages, restored.transcript],
  );
  return (
    <div className="w-75">
      <Rail title="Conversation details">
        <PlanCard plan={plan} working={false} folded={false} />
      </Rail>
    </div>
  );
}

const CARD = '[data-testid="rail-plan"]';
const STEP = `${CARD} [data-todo]`;
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'rail-plan',
  title: 'Conversation plan',
  surface: 'Assistant › canvas › Conversation details',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'Two turns each wrote the plan on; the second turn’s list stands, kept after its turn: 2 of 4 done.',
      seed: stage(session(1), [], planned),
      expect: {
        present: [
          `${CARD}[data-state="ready"]`,
          `${CARD} [data-section="todo"] [data-todo="in_progress"]`,
          `${CARD} [data-section="done"] [data-todo="completed"]`,
        ],
        absent: [UNAVAILABLE],
        text: '2 of 4 done',
      },
    },
    empty: {
      note: 'The conversation read a page and answered; no reply wrote a list.',
      seed: stage(session(2), [], () =>
        turn(
          1,
          'What does the scanner risk say?',
          readRisk('toolu_lab_plan_read', 11),
          'It says delivery is slipping, and records no mitigation.',
        ),
      ),
      expect: {
        present: [`${CARD}[data-state="empty"]`],
        absent: [STEP, UNAVAILABLE],
        text: RAIL_PLAN_WORDS.none,
      },
    },
    'not-recorded': {
      note: 'The thread saved its list’s preview, which cut the dictated step, and Claude Code no longer has the session file that held it whole.',
      seed: stage(session(3), savedWithCutList(), null),
      expect: {
        present: [`${CARD}[data-state="not-recorded"]`],
        absent: [STEP, UNAVAILABLE],
        text: RAIL_PLAN_WORDS.notRecorded,
      },
    },
    partial: {
      note: 'The latest list ran past what a call’s input keeps and its turn was stopped before Claude Code kept it: the list before it shows.',
      seed: stage(session(4), [], () =>
        turn(
          1,
          'Plan the escalation, and fold the vendor’s delivery log into the risk.',
          [
            ...wrote(
              'toolu_lab_plan_1',
              steps(['completed', 'in_progress', 'pending', 'pending']),
              11,
            ),
            ...oversized('toolu_lab_plan_2', 12),
          ],
          null,
        ),
      ),
      expect: {
        present: [`${CARD}[data-state="partial"]`, `${CARD} [data-todo="in_progress"]`],
        absent: [UNAVAILABLE],
        text: RAIL_PLAN_WORDS.earlier,
      },
    },
    unavailable: {
      note: 'Nothing of the thread was saved, and reading its transcript back fails: nothing here can say whether it had a plan.',
      seed: stage(session(5), [], planned),
      failNext: ['read_cli_transcript'],
      expect: {
        present: [`${CARD}[data-state="unavailable"]`, UNAVAILABLE],
        absent: [STEP],
        text: RAIL_PLAN_WORDS.unavailable,
      },
    },
  },
};
