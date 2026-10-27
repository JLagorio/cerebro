import { useEffect, useMemo, useState } from 'react';
import { readCliTranscript } from '@/agent/agentIpc';
import { railSources } from '@/agent/elements/railSources';
import { RAIL_SOURCES_WORDS, SourcesCard } from '@/agent/rail/SourcesCard';
import { healFromTranscript, replayTranscript } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage, TranscriptRead } from '@/agent/types';
import type { TranscriptStatus } from '@/agent/useConversations';
import { Rail } from '@/components/ai/Rail';
import { __seedCliTranscript } from '@/lib/mockIpc';
import { LAB_VAULT, type LabSection } from '../presets';

/**
 * The rail's Sources card (M92.6) in its five states: a conversation opened
 * as a thread opens (useConversations), its saved copy first, then its
 * transcript read back from Claude Code's session file
 * (`read_cli_transcript`) to rebuild or heal it, and the card drawn over what
 * its finished replies drew on (`railSources`), at the rail's width. The lab
 * keeps no thread in storage, so each preset's seed hands the stage the
 * saved copy itself.
 *
 * Synthetic, in the shape `src-tauri/src/agent/fold.rs` replays a session:
 * made-up ids, example.test addresses and the demo vault's pages.
 */

/** A conversation as the stage opens it: what the thread saved, and the
 *  session its transcript is read from. Each preset's seed sets it before
 *  the stage mounts. */
let staged: { saved: ChatMessage[]; session: string } = { saved: [], session: '' };

const session = (n: number) => `00000000-0000-4000-8000-00000009216${n}`;
const RISK = 'records/risks/risk-scanner-delivery.md';
const LEAD_TIMES = 'https://scanners.example.test/lead-times';

/** A web search that brought back one page, as the session file keeps its
 *  result. */
const SEARCHED: AgentStreamEvent[] = [
  {
    kind: 'ToolStart',
    tool_name: 'WebSearch',
    tool_id: 'toolu_lab_sources_search',
    input: JSON.stringify({ query: 'scanner lead times' }),
  },
  {
    kind: 'ToolDone',
    tool_id: 'toolu_lab_sources_search',
    output: 'One result for scanner lead times.',
    is_error: false,
  },
  {
    kind: 'ToolResult',
    tool_id: 'toolu_lab_sources_search',
    data: {
      type: 'web_search',
      query: 'scanner lead times',
      results: [{ title: 'Scanner lead times', url: LEAD_TIMES }],
    },
  },
];

/** A read of the scanner risk's page. */
const READ: AgentStreamEvent[] = [
  {
    kind: 'ToolStart',
    tool_name: 'mcp__cerebro__get_note',
    tool_id: 'toolu_lab_sources_read',
    input: JSON.stringify({ path: RISK }),
  },
  {
    kind: 'ToolDone',
    tool_id: 'toolu_lab_sources_read',
    output: '# Scanner hardware delivery is slipping\n\nNo mitigation is recorded.',
    is_error: false,
  },
];

/** A researcher that ran and used two tools, whose own transcript in
 *  `subagents/` is gone: its report is kept, its steps are not. */
const RESEARCHED: AgentStreamEvent[] = [
  {
    kind: 'ToolStart',
    tool_name: 'Agent',
    tool_id: 'toolu_lab_sources_researcher',
    input: JSON.stringify({
      description: 'Read the open risks',
      subagent_type: 'cerebro-researcher',
      prompt: 'Read the open risks, and say which is dated.',
    }),
  },
  {
    kind: 'ToolDone',
    tool_id: 'toolu_lab_sources_researcher',
    output: 'Scanner delivery is the dated one.',
    is_error: false,
  },
  {
    kind: 'ToolResult',
    tool_id: 'toolu_lab_sources_researcher',
    data: {
      type: 'agent',
      agent_id: 'a0000000000092160',
      agent_type: 'cerebro-researcher',
      status: 'completed',
      tool_uses: 2,
      duration_ms: 3100,
      model: 'claude-haiku-4-5',
      summary: 'Scanner delivery is the dated one.',
    },
  },
];

/** One turn as its session file replays it: the person's words, the reply's
 *  calls, its answer, whose words name no web address, and its end. */
function turn(calls: AgentStreamEvent[]): AgentStreamEvent[] {
  return [
    {
      kind: 'UserPrompt',
      text: 'Which risk should I escalate?',
      uuid: '00000000-0000-4000-8000-000000092170',
    },
    { kind: 'ModelChanged', model: 'claude-sonnet-5' },
    ...calls,
    {
      kind: 'Text',
      message_id: 'msg_lab_sources_answer',
      text: 'Escalate [[risk-scanner-delivery]]: it is dated and nothing mitigates it.',
    },
    {
      kind: 'TurnEnded',
      stop_reason: 'end_turn',
      last_uuid: '00000000-0000-4000-8000-000000092179',
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

interface Restored {
  messages: ChatMessage[];
  transcript: TranscriptStatus;
}

/** What opening the thread comes to once its transcript is read, as
 *  useConversations restores it: rebuilt from the file when nothing was
 *  saved, the saved copy healed from it otherwise, and the copy as it
 *  stands when the file cannot be read. */
function restore(saved: ChatMessage[], id: string, read: TranscriptRead): Restored {
  if (read.state === 'unavailable') {
    return {
      messages: saved,
      transcript: { state: 'unavailable', reason: read.reason, retentionDays: read.retention_days },
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
  const sources = useMemo(
    () => railSources(restored.messages, restored.transcript),
    [restored.messages, restored.transcript],
  );
  return (
    <div className="w-75">
      <Rail title="Conversation details">
        <SourcesCard
          sources={sources}
          folded={false}
          jump={(go) => go()}
          onOpenPath={() => undefined}
        />
      </Rail>
    </div>
  );
}

const CARD = '[data-testid="rail-sources"]';
const LINE = '[data-testid="rail-source"]';
const MISSING = '[data-testid="rail-sources-missing"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'rail-sources',
  title: 'Conversation sources',
  surface: 'Assistant › canvas › Conversation details',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'The reply searched the web and read the scanner risk: both listed, the web page by its host.',
      seed: stage(session(1), [], turn([...SEARCHED, ...READ])),
      expect: {
        present: [
          `${CARD}[data-state="ready"]`,
          `${LINE}[data-kind="url"]`,
          `${LINE}[data-kind="vault"]`,
        ],
        absent: [MISSING, UNAVAILABLE],
        text: 'Scanner lead times',
      },
    },
    empty: {
      note: 'The reply answered from what it knew: it read nothing and linked nothing.',
      seed: stage(session(2), [], turn([])),
      expect: {
        present: [`${CARD}[data-state="empty"]`],
        absent: [LINE, MISSING, UNAVAILABLE],
        text: 'None',
      },
    },
    'not-recorded': {
      note: 'The transcript reads back whole, but the researcher’s own steps are gone: what it drew on was not recorded, never none.',
      seed: stage(session(3), [], turn(RESEARCHED)),
      expect: {
        present: [`${CARD}[data-state="not-recorded"]`, `${MISSING}[data-missing="steps"]`],
        absent: [LINE, UNAVAILABLE],
        text: RAIL_SOURCES_WORDS.notRecorded,
      },
    },
    partial: {
      note: 'The transcript cannot be read back: the page the saved copy holds a read of, under a line saying some may be missing.',
      seed: stage(
        session(4),
        replayTranscript(turn(READ), session(4)).messages,
        turn([...SEARCHED, ...READ]),
      ),
      failNext: ['read_cli_transcript'],
      expect: {
        present: [
          `${CARD}[data-state="partial"]`,
          `${MISSING}[data-missing="transcript"]`,
          `${LINE}[data-kind="vault"]`,
        ],
        absent: [UNAVAILABLE],
        text: RAIL_SOURCES_WORDS.missing.transcript,
      },
    },
    unavailable: {
      note: 'Nothing was saved and the transcript cannot be read back: unavailable, never none.',
      seed: stage(session(5), [], turn([...SEARCHED, ...READ])),
      failNext: ['read_cli_transcript'],
      expect: {
        present: [`${CARD}[data-state="unavailable"]`, UNAVAILABLE],
        absent: [LINE, MISSING],
        text: RAIL_SOURCES_WORDS.unavailable,
      },
    },
  },
};
