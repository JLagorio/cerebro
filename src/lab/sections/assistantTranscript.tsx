import { useEffect, useRef } from 'react';
import { MOCK_STACK, MOCK_TEST_STDERR, MOCK_TEST_STDOUT } from '@/agent/mockAgent';
import type { AgentStreamEvent } from '@/agent/types';
import { ASSISTANT_ACTOR } from '@/engine/authors';
import { demoFleetRuns } from '@/lib/demoOperational';
import type { FleetRun, RunTranscript as Transcript } from '@/lib/ipc';
import { __seedFleet, __seedRunTranscripts } from '@/lib/mockIpc';
import { RunTranscript } from '@/status/RunTranscript';
import type { LabSection } from '../presets';

/**
 * A replayed assistant turn (M91.15), as a run's detail folds Claude Code's
 * session file and draws it with the conversation's AI elements (M91.14):
 * its reasoning, a researcher subagent with its own steps, the todo Plan, a
 * test run as Test Results, a render that died as a Terminal with its Stack
 * Trace, a web search, and the answer's citation. RunTranscript is the
 * section that reads a session file and draws its turns; the turn's Sources
 * and the File Tree of what it changed are drawn by the panel's live turn
 * alone, from no read a preset could fail (e2e/m91-sources.spec.ts and
 * e2e/turn-changeset.spec.ts hold them).
 *
 * Synthetic, in the shape `src-tauri/src/agent/fold.rs` replays a session
 * and its `subagents/` (the conformance goldens' shape): made-up ids, the
 * demo vault's pages, and the mock agent's own test and stack output.
 */

const RUN = 'run-lab-assistant';
const SESSION = '00000000-0000-4000-8000-000000091150';
const AGENT = 'toolu_lab_agent';
const RISK = 'records/risks/risk-scanner-delivery.md';
const LEAD_TIMES = 'https://example.com/scanners/lead-times';
const TODOS_WRITTEN =
  'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable';

/** The session the stage opens, as the run's row records it: each preset's
 * seed sets it before the stage mounts. */
let staged: string | null = SESSION;

/** A line's time, `seconds` into the turn. */
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 6, 28, 11, 50, 0) + seconds * 1000).toISOString();

const PLAN = [
  ['Ask a researcher which risk matters most', 'Asking a researcher'],
  ['Run the vault scripts’ tests', 'Running the tests'],
  ['Render the risk notes', 'Rendering the risk notes'],
  ['Look up scanner lead times', 'Looking up scanner lead times'],
] as const;

/** A TodoWrite call and its result, each item at the status given. */
function plan(id: string, statuses: string[], seconds: number): AgentStreamEvent[] {
  const items = PLAN.map(([content, activeForm], i) => ({
    content,
    status: statuses[i],
    activeForm,
  }));
  return [
    {
      kind: 'ToolStart',
      tool_name: 'TodoWrite',
      tool_id: id,
      input: JSON.stringify({ todos: items }),
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
        todos: items.map(({ content, status, activeForm }) => ({
          content,
          status,
          active_form: activeForm,
        })),
      },
    },
  ];
}

/** A command that exited non-zero, and what it printed. */
function failedCommand(
  id: string,
  command: string,
  printed: { stdout: string; stderr: string },
  seconds: number,
): AgentStreamEvent[] {
  return [
    {
      kind: 'ToolStart',
      tool_name: 'Bash',
      tool_id: id,
      input: JSON.stringify({ command, description: `Run ${command}` }),
      at: at(seconds),
    },
    {
      kind: 'ToolDone',
      tool_id: id,
      output: `Exit code 1\n${printed.stdout === '' ? printed.stderr : printed.stdout}`,
      is_error: true,
      at: at(seconds + 1.9),
    },
    {
      kind: 'ToolResult',
      tool_id: id,
      data: { type: 'shell', ...printed, interrupted: false, truncated: false },
    },
  ];
}

const REPORT =
  'Scanner delivery threatens the launch most: it has a date and no recorded mitigation.';

/** What the researcher did, as its own transcript in `subagents/` replays:
 * every line names the Agent call that started it. */
function researcherSteps(): AgentStreamEvent[] {
  return [
    {
      kind: 'Thinking',
      message_id: 'msg_lab_sub_1',
      text: 'I should find the open risks first, then read the one with a date.',
      parent: AGENT,
      at: at(4),
    },
    {
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__search_notes',
      tool_id: 'toolu_lab_sub_1',
      input: JSON.stringify({ query: 'risk' }),
      parent: AGENT,
      at: at(4.2),
    },
    {
      kind: 'ToolDone',
      tool_id: 'toolu_lab_sub_1',
      output: `Five open risks under records/risks, among them ${RISK}.`,
      is_error: false,
      parent: AGENT,
      at: at(4.6),
    },
    {
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__get_note',
      tool_id: 'toolu_lab_sub_2',
      input: JSON.stringify({ path: RISK }),
      parent: AGENT,
      at: at(4.7),
    },
    {
      kind: 'ToolDone',
      tool_id: 'toolu_lab_sub_2',
      output: '# Scanner hardware delivery is slipping\n\nNo mitigation is recorded.',
      is_error: false,
      parent: AGENT,
      at: at(5),
    },
    { kind: 'Text', message_id: 'msg_lab_sub_2', text: REPORT, parent: AGENT, at: at(5.6) },
  ];
}

/** The turn, as the run's session file replays it; `steps` false leaves out
 * the researcher's own transcript, as when its `subagents/` file is gone. */
function turn({ steps }: { steps: boolean }): AgentStreamEvent[] {
  return [
    {
      kind: 'UserPrompt',
      text: 'Which risk should I escalate? Have a researcher check, run the vault’s tests, render the risk notes and look up scanner lead times.',
      uuid: '00000000-0000-4000-8000-000000091151',
    },
    { kind: 'ModelChanged', model: 'claude-sonnet-5' },
    {
      kind: 'Thinking',
      message_id: 'msg_lab_1',
      text: 'Four things to check. A plan keeps them in view, and a researcher can read the risks while I run the scripts.',
      at: at(1),
    },
    ...plan('toolu_lab_todo_1', ['in_progress', 'pending', 'pending', 'pending'], 1.6),
    {
      kind: 'ToolStart',
      tool_name: 'Agent',
      tool_id: AGENT,
      input: JSON.stringify({
        description: 'Read the open risks',
        subagent_type: 'cerebro-researcher',
        prompt:
          'Read the open risks under records/risks and say which one threatens the launch most.',
      }),
      at: at(2),
    },
    ...(steps ? researcherSteps() : []),
    { kind: 'ToolDone', tool_id: AGENT, output: REPORT, is_error: false, at: at(5.8) },
    {
      kind: 'ToolResult',
      tool_id: AGENT,
      data: {
        type: 'agent',
        agent_id: 'a0000000000091151',
        agent_type: 'cerebro-researcher',
        status: 'completed',
        tool_uses: 2,
        duration_ms: 3800,
        model: 'claude-haiku-4-5',
        summary: REPORT,
      },
    },
    ...plan('toolu_lab_todo_2', ['completed', 'in_progress', 'pending', 'pending'], 6),
    ...failedCommand(
      'toolu_lab_tests',
      'pnpm vitest run scripts',
      { stdout: MOCK_TEST_STDOUT, stderr: MOCK_TEST_STDERR },
      6.4,
    ),
    ...failedCommand(
      'toolu_lab_render',
      'node scripts/render-notes.mjs',
      { stdout: '', stderr: MOCK_STACK },
      9,
    ),
    {
      kind: 'ToolStart',
      tool_name: 'WebSearch',
      tool_id: 'toolu_lab_search',
      input: JSON.stringify({ query: 'warehouse scanner lead times' }),
      at: at(11.2),
    },
    {
      kind: 'ToolDone',
      tool_id: 'toolu_lab_search',
      output: `Web search results for query: "warehouse scanner lead times"\n\nLinks: [{"title":"Scanner lead times - Example Logistics","url":"${LEAD_TIMES}"}]`,
      is_error: false,
      at: at(13.5),
    },
    {
      kind: 'ToolResult',
      tool_id: 'toolu_lab_search',
      data: {
        type: 'web_search',
        query: 'warehouse scanner lead times',
        results: [{ title: 'Scanner lead times - Example Logistics', url: LEAD_TIMES }],
      },
    },
    ...plan('toolu_lab_todo_3', ['completed', 'completed', 'completed', 'completed'], 13.8),
    {
      kind: 'Thinking',
      message_id: 'msg_lab_2',
      text: 'The researcher and the render both point at the scanners, and the tests say no risk is flagged as unmitigated, which is wrong.',
      at: at(15),
    },
    {
      kind: 'Text',
      message_id: 'msg_lab_2',
      text: `Escalate [[risk-scanner-delivery]]: it is dated, nothing mitigates it, and scanners currently ship in 10 to 14 weeks ([Example Logistics](${LEAD_TIMES})). The vault's own check missed it — \`risks > flags a risk with no mitigation\` fails — and the render dies on line 6 of that note.`,
      at: at(16),
    },
    {
      kind: 'TurnEnded',
      stop_reason: 'end_turn',
      last_uuid: '00000000-0000-4000-8000-000000091199',
    },
  ];
}

/** The assistant's run that answered, as the fleet records it. */
function assistantRun(session: string | null): FleetRun {
  return {
    run_id: RUN,
    actor: ASSISTANT_ACTOR,
    vault_id: 'demo',
    mode: 'attended',
    lane: 'agent',
    started_at: at(0),
    ended_at: at(17),
    outcome: 'succeeded',
    usage_state: 'exact',
    input_tokens: 24_800,
    output_tokens: 1_460,
    proposals_submitted: 0,
    applied: 0,
    rejected: 0,
    parent_run_id: null,
    cause: { kind: 'attended', why: 'you asked', subject: null, detail: null, due_at: null },
    cli_session_id: session,
  };
}

/** Seed the run with `session`, and what reading its transcript gives. */
function stage(session: string | null, read: Transcript['read']): () => void {
  return () => {
    staged = session;
    __seedFleet([...demoFleetRuns(), assistantRun(session)]);
    __seedRunTranscripts({ [RUN]: { runs_in_session: 1, retention_days: 30, read } });
  };
}

function readOf(events: AgentStreamEvent[]): Transcript['read'] {
  return { state: 'read', events, lines: events.length, unclassified: [] };
}

/**
 * The section, opened once as a person opens it: a run's transcript is read
 * only when asked for (M56.9), so the stage asks. A ref keeps StrictMode's
 * second mount from pressing it again.
 */
function Stage() {
  const box = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    box.current?.querySelector<HTMLButtonElement>('[data-testid="run-transcript-toggle"]')?.click();
  }, []);
  return (
    <div ref={box}>
      <RunTranscript runId={RUN} sessionId={staged} running={false} />
    </div>
  );
}

const TURN = '[data-testid="run-transcript-turn"]';
const STATE = '[data-testid="run-transcript-state"]';
const SUBAGENT = '[data-slot="subagent"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';

export const section: LabSection = {
  id: 'assistant-transcript',
  title: 'Assistant transcript',
  surface: 'Agents › a run’s detail',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'A turn with reasoning, a researcher and its steps, the plan, a failed test run, a stack trace and a web search.',
      seed: stage(SESSION, readOf(turn({ steps: true }))),
      expect: {
        present: [
          TURN,
          '[data-slot="chain-of-thought"]',
          '[data-slot="reasoning"]',
          SUBAGENT,
          '[data-slot="plan"]',
          '[data-slot="test-results"]',
          '[data-slot="stack-trace"]',
          '[data-testid="action-card"][data-tool="WebSearch"]',
          `${TURN} a[href="${LEAD_TIMES}"]`,
        ],
        absent: [STATE, UNAVAILABLE],
        text: 'Ran 19 tests, 1 failed',
      },
    },
    empty: {
      note: 'The session file was read and holds no turns.',
      seed: stage(SESSION, readOf([])),
      expect: {
        present: ['[data-testid="run-transcript-body"]'],
        absent: [TURN, UNAVAILABLE],
        text: 'The session file holds no turns.',
      },
    },
    'not-recorded': {
      note: 'The run recorded no Claude Code session, so there is no transcript to read.',
      seed: stage(null, readOf([])),
      expect: {
        present: [STATE],
        absent: [TURN, UNAVAILABLE],
        text: 'Transcript not recorded for this run.',
      },
    },
    partial: {
      note: 'The turn reads, but the researcher’s own transcript is gone: its steps were not recorded.',
      seed: stage(SESSION, readOf(turn({ steps: false }))),
      expect: {
        present: [TURN, SUBAGENT, '[data-slot="plan"]'],
        absent: [UNAVAILABLE],
        text: 'Steps not recorded',
      },
    },
    unavailable: {
      note: 'Reading the session file fails: nothing here says what the run said.',
      seed: stage(SESSION, readOf(turn({ steps: true }))),
      failNext: ['fleet_run_transcript'],
      expect: {
        present: [UNAVAILABLE],
        absent: [TURN],
        text: "Couldn't read this run's transcript",
      },
    },
  },
};
