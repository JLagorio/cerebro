import { useMemo } from 'react';
import { RAIL_HANDOFFS_WORDS, railHandoffs } from '@/agent/elements/railHandoffs';
import { HandoffsCard } from '@/agent/rail/HandoffsCard';
import { applyEvent } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage } from '@/agent/types';
import { Rail } from '@/components/ai/Rail';
import type { FleetRun, FleetRunDetail } from '@/lib/ipc';
import { __seedFleet } from '@/lib/mockIpc';
import type { LabSection } from '../presets';

/**
 * The rail's Handed off card (M92.11) in its five states: a conversation
 * whose reply handed work to the demo vault's agents (`hand_to`, as the live
 * stream folds its calls), the card drawn over its hand-offs
 * (`railHandoffs`) at the rail's width, and each run they started read from
 * the mock's fleet (`fleet_run_detail`), seeded per preset. The lab runs no
 * turn, so each preset's seed hands the stage the conversation itself.
 *
 * Synthetic: made-up run ids, in the shape runtime.db's ids take, and the
 * demo vault's two agents.
 */

const SESSION = '00000000-0000-4000-8000-000000092110';
const SCOUT_RUN = '0000000000000000000000000092111a';
const KNOWLEDGE_RUN = '0000000000000000000000000092111b';
/** A run the runtime database does not hold: its read is refused. */
const GONE_RUN = '0000000000000000000000000092111c';

/** The conversation the stage opens on. Each preset's seed sets it before
 *  the stage mounts. */
let staged: ChatMessage[] = [];

/** A time on the day the demo corpus is read. */
const at = (time: string) => `2026-07-28T${time}:00Z`;

/** A hand_to call that went, answered as mcp.rs answers it; with no run,
 *  an answer that names none. */
function handTo(id: string, agent: string, title: string, run: string | null): AgentStreamEvent[] {
  return [
    {
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__hand_to',
      tool_id: id,
      input: JSON.stringify({ agent, message: 'Bring the release brief up to date.' }),
    },
    {
      kind: 'ToolDone',
      tool_id: id,
      output:
        run === null
          ? `Started ${title} with what you handed it.`
          : `Started ${title} (run ${run}) with what you handed it. It works under its own ` +
            'scope and writes to the vault; it cannot reply here. Its outcome lands in the ' +
            "fleet, billed to this chain's root.",
      is_error: false,
    },
  ];
}

/** A reply that read a risk and answered, handing nothing off. */
const READ: AgentStreamEvent[] = [
  {
    kind: 'ToolStart',
    tool_name: 'mcp__cerebro__get_note',
    tool_id: 'toolu_lab_handoff_read',
    input: JSON.stringify({ path: 'records/risks/risk-scanner-delivery.md' }),
  },
  {
    kind: 'ToolDone',
    tool_id: 'toolu_lab_handoff_read',
    output: '# Scanner hardware delivery is slipping',
    is_error: false,
  },
];

const SCOUT = handTo('toolu_lab_handoff_scout', 'release-scout', 'Release scout', SCOUT_RUN);
const KNOWLEDGE = handTo('toolu_lab_handoff_knowledge', 'knowledge', 'Knowledge', KNOWLEDGE_RUN);

/** The reply's words after its calls. */
const ANSWER: AgentStreamEvent = {
  kind: 'Text',
  message_id: 'msg_lab_handoff',
  text: 'The release brief is with the agents now.',
};

/** The conversation: the person's ask, and a reply that made `calls`. */
function conversation(calls: AgentStreamEvent[]): ChatMessage[] {
  let reply: ChatMessage = {
    id: 'lab-handoff-a1',
    role: 'assistant',
    text: '',
    tools: [],
    streaming: false,
  };
  for (const event of [...calls, ANSWER]) reply = applyEvent(reply, event, 'live', SESSION);
  return [
    { id: 'lab-handoff-u1', role: 'user', text: 'Get the release brief current.', tools: [] },
    reply,
  ];
}

/** A run a hand-off started, as fleet.rs serves its row: attended, as every
 *  renderer-started agent run is booked, and caused by the hand-off. Still
 *  going with no `ended`. */
function handedRun(run_id: string, actor: string, started: string, ended: string | null): FleetRun {
  return {
    run_id,
    actor,
    vault_id: 'demo',
    mode: 'attended',
    lane: 'agent',
    started_at: at(started),
    ended_at: ended === null ? null : at(ended),
    outcome: ended === null ? 'running' : 'succeeded',
    usage_state: ended === null ? 'pending' : 'exact',
    input_tokens: ended === null ? 0 : 7_420,
    output_tokens: ended === null ? 0 : 515,
    proposals_submitted: null,
    applied: null,
    rejected: null,
    parent_run_id: null,
    cause: {
      kind: 'handoff',
      why: 'another agent handed it work',
      subject: null,
      detail: null,
      due_at: null,
    },
    cli_session_id: null,
  };
}

const detailOf = (run: FleetRun): FleetRunDetail => ({
  run,
  cost_components: null,
  assembly: null,
  model_id: null,
  refusals: [],
  refusals_total: 0,
  wrote: { state: 'not_recorded' },
});

/** The scout's run took four minutes; the knowledge agent's goes on. */
const SCOUT_DONE = handedRun(SCOUT_RUN, 'process:release-scout', '11:20', '11:24');
const KNOWLEDGE_GOING = handedRun(KNOWLEDGE_RUN, 'process:knowledge', '11:21', null);

/** Stage the conversation made of `calls`, over a fleet holding `runs`. */
function seed(calls: AgentStreamEvent[], runs: FleetRun[]) {
  return () => {
    staged = conversation(calls);
    __seedFleet(runs, Object.fromEntries(runs.map((run) => [run.run_id, detailOf(run)])));
  };
}

/** The rail, open on the conversation. */
function Stage() {
  const handoffs = useMemo(() => railHandoffs(staged), []);
  return (
    <div className="w-75">
      <Rail title="Conversation details">
        <HandoffsCard handoffs={handoffs} folded={false} jump={(go) => go()} />
      </Rail>
    </div>
  );
}

const CARD = '[data-testid="rail-handoffs"]';
const LINE = '[data-testid="rail-handoff"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'conversation-handoffs',
  title: 'Handed off',
  surface: 'Assistant › canvas › Conversation details',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'The reply handed work to the release scout, whose run succeeded, and to the knowledge agent, whose run goes on.',
      seed: seed([...SCOUT, ...KNOWLEDGE], [SCOUT_DONE, KNOWLEDGE_GOING]),
      expect: {
        present: [
          `${CARD}[data-state="ready"]`,
          `${LINE}[data-run-id="${SCOUT_RUN}"][data-state="done"]`,
          `${LINE}[data-run-id="${KNOWLEDGE_RUN}"][data-state="running"]`,
        ],
        absent: [UNAVAILABLE],
        text: '1 running · 1 done',
      },
    },
    empty: {
      note: 'The reply read a page and answered, handing nothing off.',
      seed: seed(READ, []),
      expect: {
        present: [`${CARD}[data-state="empty"]`],
        absent: [LINE, UNAVAILABLE],
        text: 'None',
      },
    },
    'not-recorded': {
      note: 'The hand-off went, but its answer, as the thread kept it, names no run: not recorded, never none.',
      seed: seed(handTo('toolu_lab_handoff_unnamed', 'release-scout', 'Release scout', null), []),
      expect: {
        present: [`${CARD}[data-state="not-recorded"]`, `${LINE}[data-state="not-recorded"]`],
        absent: [UNAVAILABLE, `${LINE}[data-run-id]`],
        text: RAIL_HANDOFFS_WORDS.notRecorded,
      },
    },
    partial: {
      note: 'The scout’s run reads back; the other run is one the runtime database no longer holds.',
      seed: seed(
        [...SCOUT, ...handTo('toolu_lab_handoff_gone', 'knowledge', 'Knowledge', GONE_RUN)],
        [SCOUT_DONE],
      ),
      expect: {
        present: [
          `${CARD}[data-state="partial"]`,
          `${LINE}[data-run-id="${SCOUT_RUN}"][data-state="done"]`,
          `${LINE}[data-run-id="${GONE_RUN}"][data-state="unavailable"]`,
        ],
        absent: [UNAVAILABLE],
        text: RAIL_HANDOFFS_WORDS.partial,
      },
    },
    unavailable: {
      note: 'Every run’s read fails: the hand-offs stay listed, and no run’s state is claimed.',
      seed: seed([...SCOUT, ...KNOWLEDGE], [SCOUT_DONE, KNOWLEDGE_GOING]),
      failNext: ['fleet_run_detail'],
      expect: {
        present: [
          `${CARD}[data-state="unavailable"]`,
          UNAVAILABLE,
          `${LINE}[data-state="unavailable"]`,
        ],
        absent: [`${LINE}[data-state="done"]`, `${LINE}[data-state="running"]`],
        text: RAIL_HANDOFFS_WORDS.unavailable,
      },
    },
  },
};
