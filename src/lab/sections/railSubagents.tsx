import { useEffect, useMemo, useState } from 'react';
import { readCliTranscript } from '@/agent/agentIpc';
import { railSubagents } from '@/agent/elements/railSubagents';
import { SUBAGENTS_WORDS, SubagentsCard } from '@/agent/rail/SubagentsCard';
import { healFromTranscript, replayTranscript } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage, TranscriptRead } from '@/agent/types';
import type { TranscriptStatus } from '@/agent/useConversations';
import { Rail } from '@/components/ai/Rail';
import { __seedCliTranscript } from '@/lib/mockIpc';
import { LAB_VAULT, type LabSection } from '../presets';

/**
 * The rail's Subagents card (M92.4) in its five states: a conversation
 * opened as a thread opens (useConversations), its saved copy first, then its
 * transcript read back from Claude Code's session file
 * (`read_cli_transcript`) to rebuild or heal it, and the card drawn over the
 * subagents its replies started (`railSubagents`), at the rail's width. The
 * lab keeps no thread in storage, so each preset's seed hands the stage the
 * saved copy itself.
 *
 * Synthetic, in the shape `src-tauri/src/agent/fold.rs` replays a session
 * and its `subagents/` (the conformance goldens' shape): made-up ids and the
 * demo vault's pages.
 */

/** A conversation as the stage opens it: what the thread saved, and the
 *  session its transcript is read from. Each preset's seed sets it before
 *  the stage mounts. */
let staged: { saved: ChatMessage[]; session: string } = { saved: [], session: '' };

const session = (n: number) => `00000000-0000-4000-8000-00000009240${n}`;
const RESEARCHER = 'toolu_lab_rail_researcher';
const CHECKER = 'toolu_lab_rail_checker';
const RISK = 'records/risks/risk-scanner-delivery.md';
const REPORT =
  'Scanner delivery threatens the launch most: it has a date and no recorded mitigation.';

/** A line's time, `seconds` into the conversation. */
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 6, 28, 11, 20, 0) + seconds * 1000).toISOString();

/** An Agent call as it starts. */
function agent(id: string, description: string, seconds: number): AgentStreamEvent {
  return {
    kind: 'ToolStart',
    tool_name: 'Agent',
    tool_id: id,
    input: JSON.stringify({
      description,
      subagent_type: 'cerebro-researcher',
      prompt: `${description}, and say what you found.`,
    }),
    at: at(seconds),
  };
}

/** What the researcher did, as its own transcript in `subagents/` replays:
 *  every line names the Agent call that started it. */
function researcherSteps(): AgentStreamEvent[] {
  return [
    {
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__search_notes',
      tool_id: 'toolu_lab_rail_sub_1',
      input: JSON.stringify({ query: 'risk' }),
      parent: RESEARCHER,
      at: at(2.2),
    },
    {
      kind: 'ToolDone',
      tool_id: 'toolu_lab_rail_sub_1',
      output: `Five open risks under records/risks, among them ${RISK}.`,
      is_error: false,
      parent: RESEARCHER,
      at: at(2.6),
    },
    {
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__get_note',
      tool_id: 'toolu_lab_rail_sub_2',
      input: JSON.stringify({ path: RISK }),
      parent: RESEARCHER,
      at: at(2.7),
    },
    {
      kind: 'ToolDone',
      tool_id: 'toolu_lab_rail_sub_2',
      output: '# Scanner hardware delivery is slipping\n\nNo mitigation is recorded.',
      is_error: false,
      parent: RESEARCHER,
      at: at(3),
    },
    { kind: 'Text', message_id: 'msg_lab_rail_sub', text: REPORT, parent: RESEARCHER, at: at(3.4) },
  ];
}

/** The researcher's Agent call, returned with its report; `steps` false
 *  leaves out its own transcript, as when its `subagents/` file is gone. */
function researcher({ steps }: { steps: boolean }): AgentStreamEvent[] {
  return [
    agent(RESEARCHER, 'Read the open risks', 2),
    ...(steps ? researcherSteps() : []),
    { kind: 'ToolDone', tool_id: RESEARCHER, output: REPORT, is_error: false, at: at(5.8) },
    {
      kind: 'ToolResult',
      tool_id: RESEARCHER,
      data: {
        type: 'agent',
        agent_id: 'a0000000000092401',
        agent_type: 'cerebro-researcher',
        status: 'completed',
        tool_uses: 2,
        duration_ms: 3800,
        model: 'claude-haiku-4-5',
        summary: REPORT,
      },
    },
  ];
}

/** A second subagent whose API call failed: its run reads failed, in its
 *  own words. */
function checker(): AgentStreamEvent[] {
  return [
    agent(CHECKER, 'Check the vendor’s ship dates', 6),
    { kind: 'Error', message: 'API Error: 529 overloaded', parent: CHECKER },
    { kind: 'ToolDone', tool_id: CHECKER, output: 'failed', is_error: true, at: at(7) },
  ];
}

/** A reply that read a page and answered, starting no subagent. */
function plain(): AgentStreamEvent[] {
  return [
    {
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__get_note',
      tool_id: 'toolu_lab_rail_read',
      input: JSON.stringify({ path: RISK }),
      at: at(2),
    },
    {
      kind: 'ToolDone',
      tool_id: 'toolu_lab_rail_read',
      output: '# Scanner hardware delivery is slipping',
      is_error: false,
      at: at(2.4),
    },
  ];
}

/** One turn as its session file replays it: the person's words, the reply's
 *  calls, its answer and its end. */
function turn(calls: AgentStreamEvent[]): AgentStreamEvent[] {
  return [
    {
      kind: 'UserPrompt',
      text: 'Which risk should I escalate? Have a researcher check.',
      uuid: '00000000-0000-4000-8000-000000092410',
    },
    { kind: 'ModelChanged', model: 'claude-sonnet-5' },
    ...calls,
    {
      kind: 'Text',
      message_id: 'msg_lab_rail_answer',
      text: 'Escalate [[risk-scanner-delivery]]: it is dated and nothing mitigates it.',
      at: at(9),
    },
    {
      kind: 'TurnEnded',
      stop_reason: 'end_turn',
      last_uuid: '00000000-0000-4000-8000-000000092419',
    },
  ];
}

function readOf(events: AgentStreamEvent[]): TranscriptRead {
  return { state: 'read', events, lines: events.length, unclassified: [] };
}

/** Stage a conversation: what its thread saved, and what reading its
 *  session file back gives. */
function stage(id: string, saved: ChatMessage[], file: AgentStreamEvent[]) {
  return () => {
    staged = { saved, session: id };
    __seedCliTranscript(id, readOf(file));
  };
}

/** A thread's saved copy of `events`: its subagents' summaries, never their
 *  steps (conversations.ts). */
const savedCopy = (id: string, events: AgentStreamEvent[]) =>
  replayTranscript(events, id).messages.map((message) => ({
    ...message,
    tools: message.tools.map((tool) =>
      tool.subagent === undefined
        ? tool
        : { ...tool, subagent: { ...tool.subagent, parts: [], tools: [] } },
    ),
  }));

interface Restored {
  messages: ChatMessage[];
  transcript: TranscriptStatus['state'];
}

/** What opening the thread comes to once its transcript is read, as
 *  useConversations restores it: rebuilt from the file when nothing was
 *  saved, the saved copy healed from it otherwise, and the copy as it
 *  stands when the file cannot be read. */
function restore(saved: ChatMessage[], id: string, read: TranscriptRead): Restored {
  if (read.state === 'unavailable') return { messages: saved, transcript: 'unavailable' };
  const rebuilt = replayTranscript(read.events, id).messages;
  if (saved.length === 0) return { messages: rebuilt, transcript: 'rebuilt' };
  const healed = healFromTranscript(saved, rebuilt);
  return { messages: healed, transcript: healed === saved ? 'idle' : 'healed' };
}

/** The conversation, opened: its saved copy at once, then its transcript. */
function Stage() {
  const [restored, setRestored] = useState<Restored>(() => ({
    messages: staged.saved,
    transcript: 'reading',
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
  const subagents = useMemo(() => railSubagents(restored.messages), [restored.messages]);
  return (
    <div className="w-75">
      <Rail title="Conversation details">
        <SubagentsCard
          subagents={subagents}
          transcript={restored.transcript}
          folded={false}
          jump={(go) => go()}
        />
      </Rail>
    </div>
  );
}

const CARD = '[data-testid="rail-subagents"]';
const LINE = '[data-testid="rail-subagent"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'rail-subagents',
  title: 'Conversation subagents',
  surface: 'Assistant › canvas › Conversation details',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'A researcher that read two pages and reported, and a checker whose API call failed.',
      seed: stage(session(1), [], turn([...researcher({ steps: true }), ...checker()])),
      expect: {
        present: [
          `${CARD}[data-state="ready"]`,
          `${LINE}[data-tool-id="${RESEARCHER}"][data-state="done"]`,
          `${LINE}[data-tool-id="${CHECKER}"][data-state="failed"]`,
        ],
        absent: [UNAVAILABLE],
        text: '1 done · 1 failed',
      },
    },
    empty: {
      note: 'The conversation read back whole, and no turn of it started a subagent.',
      seed: stage(session(2), [], turn(plain())),
      expect: {
        present: [`${CARD}[data-state="empty"]`],
        absent: [LINE, UNAVAILABLE],
        text: 'None',
      },
    },
    'not-recorded': {
      note: 'The researcher reported, but its own transcript is gone: its steps were not recorded.',
      seed: stage(session(3), [], turn(researcher({ steps: false }))),
      expect: {
        present: [`${CARD}[data-state="not-recorded"]`, `${LINE}[data-state="done"]`],
        absent: [UNAVAILABLE],
        text: SUBAGENTS_WORDS.notRecorded,
      },
    },
    partial: {
      note: 'The transcript cannot be read back: the subagents the saved copy holds, and a line that says so.',
      seed: stage(
        session(4),
        savedCopy(session(4), turn([...researcher({ steps: true }), ...checker()])),
        turn([...researcher({ steps: true }), ...checker()]),
      ),
      failNext: ['read_cli_transcript'],
      expect: {
        present: [`${CARD}[data-state="partial"]`, LINE],
        absent: [UNAVAILABLE],
        text: SUBAGENTS_WORDS.partial,
      },
    },
    unavailable: {
      note: 'Nothing was saved and the transcript cannot be read back: unavailable, never none.',
      seed: stage(session(5), [], turn(researcher({ steps: true }))),
      failNext: ['read_cli_transcript'],
      expect: {
        present: [`${CARD}[data-state="unavailable"]`, UNAVAILABLE],
        absent: [LINE],
        text: SUBAGENTS_WORDS.unavailable,
      },
    },
  },
};
