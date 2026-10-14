import type { AgentStreamEvent } from '@/agent/types';
import type { RunTranscript } from './mockIpc';

/**
 * The demo's run transcripts (M56.9): what a run's detail folds out of
 * Claude Code's session file, for the browser, which has none.
 *
 * Synthetic, in the shape `src-tauri/src/agent/fold.rs` folds a session file
 * into: the ids are made up (the session is run-scout-1's
 * `cli_session_id`), and no line came from a real recording. release-scout's
 * scheduled run searches, reads the five release risks one after another
 * (the run detail folds them into one row, M56.8), proposes a concept, is
 * refused a write outside its scope, and answers. The refusal's words are the
 * ones its detail lists under Refused (`demoOperational.ts`).
 */

const SESSION = '00000000-0000-4000-8000-000000000001';

const RISKS = [
  'records/risks/risk-console-splits-the-team.md',
  'records/risks/risk-messaging-unvalidated.md',
  'records/risks/risk-rollback-unrehearsed.md',
  'records/risks/risk-scanner-delivery.md',
  'records/risks/risk-single-pilot-customer.md',
];

const REFUSED = 'This run is scoped to records/risks and cannot write to records/work.';

const REPLY =
  'Three of the five release risks moved since the last check, so I proposed a Release ' +
  "watch concept for review. I couldn't file the follow-up in records/work: this run is " +
  'scoped to records/risks.';

/** One tool call and its completion. */
function call(
  id: string,
  name: string,
  input: Record<string, unknown>,
  output: string,
  isError = false,
): AgentStreamEvent[] {
  return [
    { kind: 'ToolStart', tool_name: name, tool_id: id, input: JSON.stringify(input) },
    { kind: 'ToolDone', tool_id: id, output, is_error: isError },
  ];
}

function scoutEvents(): AgentStreamEvent[] {
  return [
    { kind: 'Init', session_id: SESSION },
    {
      kind: 'UserPrompt',
      text: 'Your schedule came due (weekdays 08:30). Check the release risks for changes.',
    },
    { kind: 'ModelChanged', model: 'claude-opus-5' },
    { kind: 'Text', message_id: 'msg-demo-1', text: 'Checking the release risks.' },
    ...call(
      'tool-demo-1',
      'mcp__cerebro__search_notes',
      { query: 'release risk' },
      `5 matches:\n${RISKS.join('\n')}`,
    ),
    ...RISKS.flatMap((path, i) =>
      call(`tool-demo-${i + 2}`, 'mcp__cerebro__get_note', { path }, `Read ${path}.`),
    ),
    ...call(
      'tool-demo-7',
      'mcp__cerebro__write_concept',
      {
        path: 'knowledge/release-watch.md',
        type: 'topic',
        title: 'Release watch',
        description: 'Which release risks moved, and why.',
        body: 'Three of the five release risks moved this week.',
      },
      'Proposed knowledge/release-watch.md for review.',
    ),
    ...call(
      'tool-demo-8',
      'mcp__cerebro__create_note',
      { folder: 'records/work', slug: 'release-follow-up', body: 'Follow up on the risks.' },
      REFUSED,
      true,
    ),
    { kind: 'Text', message_id: 'msg-demo-2', text: REPLY },
    { kind: 'Result', text: REPLY, session_id: SESSION },
    { kind: 'TurnEnded', stop_reason: 'end_turn' },
  ];
}

/** Run id → its transcript, fresh each call so a test can change one. */
export function demoRunTranscripts(): Record<string, RunTranscript> {
  const events = scoutEvents();
  return {
    'run-scout-1': {
      runs_in_session: 1,
      // Claude Code's default, as the browser's other session reads assume.
      retention_days: 30,
      read: { state: 'read', events, lines: events.length, unclassified: [] },
    },
  };
}
