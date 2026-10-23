import { describe, expect, it } from 'vitest';
import {
  foldHandoffReads,
  HANDOFF_READS,
  handoffLines,
  handoffRunIds,
  handoffsCount,
  handoffsGoingOn,
  handoffsState,
  NO_READS,
  RAIL_HANDOFFS_WORDS,
  railHandoffs,
  type HandoffReads,
  type HandoffRun,
  type HandoffRunRead,
  type RailHandoffs,
} from '@/agent/elements/railHandoffs';
import { applyEvent, endLiveTurn } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage } from '@/agent/types';
import type { FleetRun, FleetRunDetail } from '@/lib/ipc';

/**
 * The rail's Handed off rows (M92.11): the conversation's main-thread
 * hand-offs that went, read off the manifest's `handoff` renderer, newest
 * first, each with the run its answer names; and what reading those runs
 * answered, folded into what the card says (CV-05, CV-44).
 */

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const RUN_A = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const RUN_B = '1f1e2d3c4b5a69788796a5b4c3d2e1f1';

const ask = (id: string, text: string): ChatMessage => ({ id, role: 'user', text, tools: [] });

/** A reply as the reducer builds it from a live stream, still streaming. */
function live(events: AgentStreamEvent[], id = 'reply'): ChatMessage {
  let message: ChatMessage = { id, role: 'assistant', text: '', tools: [], streaming: true };
  for (const event of events) message = applyEvent(message, event, 'live', SESSION);
  return message;
}

/** A hand_to call as it starts. */
const start = (id: string, agent: string, parent?: string): AgentStreamEvent => ({
  kind: 'ToolStart',
  tool_name: 'mcp__cerebro__hand_to',
  tool_id: id,
  input: JSON.stringify({ agent, message: 'Bring the brief up to date.' }),
  ...(parent === undefined ? {} : { parent }),
});

/** A hand_to call that went, answered as mcp.rs answers; with no run, an
 *  answer that names none. */
const handTo = (id: string, agent: string, run: string | null): AgentStreamEvent[] => [
  start(id, agent),
  {
    kind: 'ToolDone',
    tool_id: id,
    output:
      run === null
        ? `Started ${agent} with what you handed it.`
        : `Started ${agent} (run ${run}) with what you handed it.`,
    is_error: false,
  },
];

const read = (outcome: string, started = '11:20', ended: string | null = null): HandoffRun => ({
  outcome,
  started_at: `2026-07-28T${started}:00Z`,
  ended_at: ended === null ? null : `2026-07-28T${ended}:00Z`,
});

/** A fleet detail of a run, as fleet_run_detail answers. */
function detail(runId: string, run: HandoffRun): FleetRunDetail {
  const row: FleetRun = {
    run_id: runId,
    actor: 'process:release-scout',
    vault_id: 'demo',
    mode: 'attended',
    lane: 'agent',
    ...run,
    usage_state: 'exact',
    input_tokens: 0,
    output_tokens: 0,
    proposals_submitted: null,
    applied: null,
    rejected: null,
    parent_run_id: null,
    cause: null,
    cli_session_id: null,
  };
  return {
    run: row,
    cost_components: null,
    assembly: null,
    model_id: null,
    refusals: [],
    refusals_total: 0,
    wrote: { state: 'not_recorded' },
  };
}

const answered = (value: FleetRunDetail): PromiseSettledResult<FleetRunDetail> => ({
  status: 'fulfilled',
  value,
});
const refused: PromiseSettledResult<FleetRunDetail> = {
  status: 'rejected',
  reason: new Error('no run with id'),
};

/** Two hand-offs, in this order: the scout's (RUN_A), then knowledge's
 *  (RUN_B). */
function two(): RailHandoffs {
  return railHandoffs([
    ask('u', 'Hand it off'),
    endLiveTurn(
      live([...handTo('h-1', 'release-scout', RUN_A), ...handTo('h-2', 'knowledge', RUN_B)]),
    ),
  ]);
}

const reads = (entries: [string, HandoffRunRead][]): HandoffReads => new Map(entries);

describe('railHandoffs', () => {
  it('lists each main-thread hand-off that went, newest first, with the run its answer names', () => {
    const reply = live([
      ...handTo('h-1', 'release-scout', RUN_A),
      {
        kind: 'ToolStart',
        tool_name: 'mcp__cerebro__get_note',
        tool_id: 'read-1',
        input: '{"path":"notes/risks.md"}',
      },
      { kind: 'ToolDone', tool_id: 'read-1', output: 'Five risks.' },
      ...handTo('h-2', 'knowledge', RUN_B),
      // Refused by hand_to: it started nothing.
      start('h-3', 'night-owl'),
      { kind: 'ToolDone', tool_id: 'h-3', output: 'night-owl is paused.', is_error: true },
      // Refused by Claude Code.
      start('h-4', 'night-owl'),
      {
        kind: 'ToolDenied',
        tool_id: 'h-4',
        tool_name: 'mcp__cerebro__hand_to',
        message: "Permission to use hand_to has been denied by permission rule 'hand_to'.",
      },
      { kind: 'ToolDone', tool_id: 'h-4', output: 'denied', is_error: true },
      // Still under way: it has not answered.
      start('h-5', 'release-scout'),
    ]);
    const handoffs = railHandoffs([ask('u', 'Hand it off'), reply]);
    expect(handoffs.rows).toEqual([
      { toolId: 'h-2', agent: 'knowledge', runId: RUN_B, icon: 'forward' },
      { toolId: 'h-1', agent: 'release-scout', runId: RUN_A, icon: 'forward' },
    ]);
    expect(handoffs.earlier).toBe(0);
    expect(handoffs.streaming).toBe(true);
    expect(handoffRunIds(handoffs)).toEqual([RUN_B, RUN_A]);
  });

  it('keeps a subagent’s own call out: only the main thread’s are listed', () => {
    const reply = live([
      {
        kind: 'ToolStart',
        tool_name: 'Agent',
        tool_id: 'a-1',
        input: JSON.stringify({ description: 'Look', subagent_type: 'cerebro-researcher' }),
      },
      start('h-nested', 'release-scout', 'a-1'),
      {
        kind: 'ToolDone',
        tool_id: 'h-nested',
        output: `Started release-scout (run ${RUN_A}) with what you handed it.`,
        parent: 'a-1',
      },
      ...handTo('h-1', 'knowledge', RUN_B),
    ]);
    expect(railHandoffs([reply]).rows.map((row) => row.toolId)).toEqual(['h-1']);
  });

  it('reads a hand-off whose answer names no run as not recorded, never as none', () => {
    const handoffs = railHandoffs([endLiveTurn(live(handTo('h-1', 'release-scout', null)))]);
    expect(handoffs.rows).toEqual([
      { toolId: 'h-1', agent: 'release-scout', runId: null, icon: 'forward' },
    ]);
    // Nothing to read, so nothing to wait for.
    expect(handoffRunIds(handoffs)).toEqual([]);
    expect(handoffsState(handoffs, NO_READS)).toBe('not-recorded');
    const [line] = handoffLines(handoffs, NO_READS);
    expect(line).toMatchObject({
      state: 'not-recorded',
      runId: null,
      title: 'Handed to release-scout',
      note: RAIL_HANDOFFS_WORDS.notRecorded,
    });
  });

  it('lists the newest eight, and counts the ones before them', () => {
    const events = Array.from({ length: HANDOFF_READS + 2 }, (_, at) =>
      handTo(`h-${at}`, 'release-scout', `run${at}`),
    ).flat();
    const handoffs = railHandoffs([endLiveTurn(live(events))]);
    expect(handoffs.rows.map((row) => row.toolId)).toEqual(
      Array.from({ length: HANDOFF_READS }, (_, at) => `h-${HANDOFF_READS + 1 - at}`),
    );
    expect(handoffs.earlier).toBe(2);
    expect(handoffRunIds(handoffs)).toHaveLength(HANDOFF_READS);
  });

  it('holds one quiet answer for a conversation that handed nothing off, turn or no turn', () => {
    const none = railHandoffs([]);
    expect(none).toEqual({ rows: [], earlier: 0, streaming: false });
    expect(railHandoffs([ask('u', 'Hello'), live([{ kind: 'TextDelta', text: 'Hi' }])])).toBe(none);
    expect(handoffsState(none, NO_READS)).toBe('empty');
  });

  it('gives back the same object across 50 streamed words, and news at the turn’s end', () => {
    let reply = live(handTo('h-1', 'release-scout', RUN_A));
    const question = ask('u', 'Hand it off');
    const first = railHandoffs([question, reply]);
    const tools = reply.tools;
    for (let at = 0; at < 50; at += 1) {
      reply = applyEvent(reply, { kind: 'TextDelta', text: `word ${at} ` }, 'live', SESSION);
      // A new message and a new list every time, its calls untouched.
      expect(reply.tools).toBe(tools);
      expect(railHandoffs([question, reply])).toBe(first);
    }
    // The turn's end is news: the card reads the runs again then. Its rows
    // stay the rows they were.
    const ended = railHandoffs([question, endLiveTurn(reply)]);
    expect(ended).not.toBe(first);
    expect(ended.streaming).toBe(false);
    expect(ended.rows).toBe(first.rows);
    // A new hand-off is news too.
    const more = railHandoffs([
      question,
      endLiveTurn(reply),
      ask('u2', 'And again'),
      live(handTo('h-2', 'knowledge', RUN_B), 'reply-2'),
    ]);
    expect(more.rows.map((row) => row.toolId)).toEqual(['h-2', 'h-1']);
  });
});

describe('foldHandoffReads', () => {
  it('keeps a run’s record, makes a failed read unavailable, and drops runs no longer listed', () => {
    const before = reads([
      [RUN_A, { state: 'read', run: read('running') }],
      ['gone', { state: 'read', run: read('succeeded') }],
    ]);
    const next = foldHandoffReads(
      before,
      [RUN_A, RUN_B],
      [refused, answered(detail(RUN_B, read('succeeded', '11:20', '11:24')))],
    );
    expect(next).toEqual(
      reads([
        // What it last answered stays, never drawn, for the polling rule.
        [RUN_A, { state: 'unavailable', last: read('running') }],
        [RUN_B, { state: 'read', run: read('succeeded', '11:20', '11:24') }],
      ]),
    );
    // A failed read of a run never read keeps nothing.
    expect(foldHandoffReads(NO_READS, [RUN_A], [refused]).get(RUN_A)).toEqual({
      state: 'unavailable',
      last: null,
    });
  });

  it('gives back the same map when no run says anything new', () => {
    const first = foldHandoffReads(
      NO_READS,
      [RUN_A, RUN_B],
      [answered(detail(RUN_A, read('running'))), refused],
    );
    const again = foldHandoffReads(
      first,
      [RUN_A, RUN_B],
      [answered(detail(RUN_A, read('running'))), refused],
    );
    expect(again).toBe(first);
    const moved = foldHandoffReads(
      first,
      [RUN_A, RUN_B],
      [answered(detail(RUN_A, read('succeeded', '11:20', '11:21'))), refused],
    );
    expect(moved).not.toBe(first);
    // The run that did not move is the same entry.
    expect(moved.get(RUN_B)).toBe(first.get(RUN_B));
  });

  it('reads a detail that holds no record it can read as a failed read', () => {
    const broken = { ...detail(RUN_A, read('running')), run: undefined };
    expect(
      foldHandoffReads(NO_READS, [RUN_A], [answered(broken as unknown as FleetRunDetail)]).get(
        RUN_A,
      ),
    ).toEqual({ state: 'unavailable', last: null });
  });
});

describe('what the card says', () => {
  it('claims nothing until a run it lists has answered', () => {
    const handoffs = two();
    expect(handoffsState(handoffs, NO_READS)).toBeNull();
    // One answered: the other is still being read, and says nothing.
    const one = reads([[RUN_A, { state: 'read', run: read('running') }]]);
    expect(handoffsState(handoffs, one)).toBe('ready');
    expect(handoffLines(handoffs, one).map((line) => line.state)).toEqual(['reading', 'running']);
  });

  it('is ready, partial or unavailable as its runs’ reads answered', () => {
    const handoffs = two();
    const ok = reads([
      [RUN_A, { state: 'read', run: read('succeeded', '11:20', '11:24') }],
      [RUN_B, { state: 'read', run: read('running') }],
    ]);
    expect(handoffsState(handoffs, ok)).toBe('ready');
    const half = reads([
      [RUN_A, { state: 'read', run: read('succeeded', '11:20', '11:24') }],
      [RUN_B, { state: 'unavailable', last: null }],
    ]);
    expect(handoffsState(handoffs, half)).toBe('partial');
    const none = reads([
      [RUN_A, { state: 'unavailable', last: null }],
      [RUN_B, { state: 'unavailable', last: read('running') }],
    ]);
    expect(handoffsState(handoffs, none)).toBe('unavailable');
  });

  it('is unavailable beside a run not recorded when no read answered', () => {
    const handoffs = railHandoffs([
      endLiveTurn(
        live([...handTo('h-1', 'release-scout', null), ...handTo('h-2', 'knowledge', RUN_B)]),
      ),
    ]);
    expect(handoffsState(handoffs, reads([[RUN_B, { state: 'unavailable', last: null }]]))).toBe(
      'unavailable',
    );
    expect(handoffsState(handoffs, reads([[RUN_B, { state: 'read', run: read('running') }]]))).toBe(
      'not-recorded',
    );
  });

  it('counts the runs that answered by state, and leaves out a state none is in', () => {
    const handoffs = railHandoffs([
      endLiveTurn(
        live([
          ...handTo('h-1', 'release-scout', RUN_A),
          ...handTo('h-2', 'knowledge', RUN_B),
          ...handTo('h-3', 'knowledge', 'run3'),
          ...handTo('h-4', 'knowledge', 'run4'),
        ]),
      ),
    ]);
    expect(handoffsCount(handoffs, NO_READS)).toBeUndefined();
    expect(
      handoffsCount(
        handoffs,
        reads([
          [RUN_A, { state: 'read', run: read('succeeded', '11:20', '11:24') }],
          [RUN_B, { state: 'read', run: read('running') }],
          ['run3', { state: 'read', run: read('quota_failed', '11:20', '11:21') }],
          ['run4', { state: 'unavailable', last: read('succeeded', '11:20', '11:22') }],
        ]),
      ),
    ).toBe('1 running · 1 done · 1 failed');
  });

  it('says each run as its record does: its outcome, and its time only when both ends were recorded', () => {
    const handoffs = railHandoffs([
      endLiveTurn(
        live([
          ...handTo('h-1', 'release-scout', RUN_A),
          ...handTo('h-2', '', RUN_B),
          ...handTo('h-3', 'knowledge', 'run3'),
          ...handTo('h-4', 'knowledge', 'run4'),
          ...handTo('h-5', 'knowledge', 'run5'),
        ]),
      ),
    ]);
    const lines = handoffLines(
      handoffs,
      reads([
        [RUN_A, { state: 'read', run: read('succeeded', '11:20', '11:24') }],
        [RUN_B, { state: 'read', run: read('running') }],
        ['run3', { state: 'read', run: read('abandoned_usage_unknown', '11:20', '11:40') }],
        ['run4', { state: 'read', run: read('cancelled', '11:20', '11:21') }],
        ['run5', { state: 'unavailable', last: read('running') }],
      ]),
    );
    expect(
      lines.map(({ toolId, state, title, facts, icon, note }) => ({
        toolId,
        state,
        title,
        facts,
        icon,
        note,
      })),
    ).toEqual([
      {
        toolId: 'h-5',
        state: 'unavailable',
        title: 'Handed to knowledge',
        facts: undefined,
        icon: 'forward',
        note: RAIL_HANDOFFS_WORDS.rowUnavailable,
      },
      {
        toolId: 'h-4',
        state: 'cancelled',
        title: 'Handed to knowledge',
        facts: 'cancelled · 1m',
        icon: 'circle-stop',
        note: undefined,
      },
      {
        // Its end is the sweep's, not when it stopped: no time.
        toolId: 'h-3',
        state: 'interrupted',
        title: 'Handed to knowledge',
        facts: 'abandoned usage unknown',
        icon: undefined,
        note: undefined,
      },
      {
        toolId: 'h-2',
        state: 'running',
        title: `Handed to ${RAIL_HANDOFFS_WORDS.someone}`,
        facts: 'running',
        icon: undefined,
        note: undefined,
      },
      {
        toolId: 'h-1',
        state: 'done',
        title: 'Handed to release-scout',
        facts: 'succeeded · 4m',
        icon: undefined,
        note: undefined,
      },
    ]);
  });
});

describe('handoffsGoingOn', () => {
  it('polls only while a run’s latest answer says it goes on', () => {
    const handoffs = two();
    expect(handoffsGoingOn(handoffs, NO_READS)).toBe(false);
    expect(
      handoffsGoingOn(handoffs, reads([[RUN_A, { state: 'read', run: read('running') }]])),
    ).toBe(true);
    expect(
      handoffsGoingOn(
        handoffs,
        reads([
          [RUN_A, { state: 'read', run: read('succeeded', '11:20', '11:24') }],
          [RUN_B, { state: 'read', run: read('failed', '11:20', '11:21') }],
        ]),
      ),
    ).toBe(false);
    // A run read going on whose next read failed is still known to go on.
    expect(
      handoffsGoingOn(handoffs, reads([[RUN_A, { state: 'unavailable', last: read('running') }]])),
    ).toBe(true);
    // One never read is not known to go on.
    expect(handoffsGoingOn(handoffs, reads([[RUN_A, { state: 'unavailable', last: null }]]))).toBe(
      false,
    );
    // A run the card no longer lists is no reason to poll.
    expect(
      handoffsGoingOn(handoffs, reads([['elsewhere', { state: 'read', run: read('running') }]])),
    ).toBe(false);
  });
});
