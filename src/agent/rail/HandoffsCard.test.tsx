// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_POLL_MS,
  HANDOFF_READS,
  RAIL_HANDOFFS_WORDS,
  railHandoffs,
} from '@/agent/elements/railHandoffs';
import { latestTodo, turnItems } from '@/agent/elements/turn';
import { StepItem } from '@/agent/toolRenderers';
import { applyEvent, endLiveTurn } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage } from '@/agent/types';
import type { FleetRun, FleetRunDetail } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { HandoffsCard, type HandoffsCardProps } from './HandoffsCard';

/**
 * The rail's Handed off card (M92.11): the runs the conversation's hand-offs
 * started, as runtime.db records them, read as the card is shown, when a run
 * is new and when a turn ends, then every 15 s only while one goes on and the
 * rail can be seen. A hand-off whose answer named no run says its run is not
 * recorded, and a failed read makes its row unavailable, never empty
 * (CV-05). A row's first action stays in the canvas; its second floats the
 * conversation before it opens the run.
 */

const fleetRunDetail = vi.fn<(runId: string) => Promise<FleetRunDetail>>();

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return { ...actual, fleetRunDetail: (runId: string) => fleetRunDetail(runId) };
});

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SCOUT = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const KNOWLEDGE = '1f1e2d3c4b5a69788796a5b4c3d2e1f1';

/** A hand_to call that went, answered as mcp.rs answers; with no run, an
 *  answer that names none. */
const handTo = (id: string, agent: string, run: string | null): AgentStreamEvent[] => [
  {
    kind: 'ToolStart',
    tool_name: 'mcp__cerebro__hand_to',
    tool_id: id,
    input: JSON.stringify({ agent, message: 'Bring the brief up to date.' }),
  },
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

/** A reply as the live stream builds it: still streaming, or ended. */
function reply(events: AgentStreamEvent[], { streaming = false, id = 'a-1' } = {}): ChatMessage {
  let message: ChatMessage = { id, role: 'assistant', text: '', tools: [], streaming: true };
  for (const event of events) message = applyEvent(message, event, 'live', SESSION);
  return streaming ? message : endLiveTurn(message);
}

const asked: ChatMessage = { id: 'u-1', role: 'user', text: 'Hand the brief off', tools: [] };

/** The scout's hand-off (h-1), then knowledge's (h-2). */
const BOTH: ChatMessage[] = [
  asked,
  reply([...handTo('h-1', 'release-scout', SCOUT), ...handTo('h-2', 'knowledge', KNOWLEDGE)]),
];

/** A run's record, as fleet_run_detail answers; no `ended`, still going. */
function detailOf(runId: string, ended: string | null, outcome = 'succeeded'): FleetRunDetail {
  const run: FleetRun = {
    run_id: runId,
    actor: 'process:release-scout',
    vault_id: 'demo',
    mode: 'attended',
    lane: 'agent',
    started_at: '2026-07-28T11:20:00Z',
    ended_at: ended === null ? null : `2026-07-28T${ended}:00Z`,
    outcome: ended === null ? 'running' : outcome,
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
    run,
    cost_components: null,
    assembly: null,
    model_id: null,
    refusals: [],
    refusals_total: 0,
    wrote: { state: 'not_recorded' },
  };
}

/** What runtime.db holds, by run id: a run it does not hold is refused, as
 *  Rust refuses it. */
let records: Record<string, FleetRunDetail | Error> = {};

const jump = vi.fn((go: () => void) => go());

type PanelProps = Partial<HandoffsCardProps> & { messages: ChatMessage[] };

/** The panel's aside as the canvas draws it: the transcript, each reply's
 *  calls in its row (MessageScrollerItem's `data-message-id`), and the
 *  rail's card beside it. */
function Panel({ messages, ...card }: PanelProps) {
  return (
    <aside aria-label="AI panel">
      <div data-testid="transcript">
        {messages.map((message) => (
          <div key={message.id} data-message-id={message.id}>
            {message.role === 'assistant' &&
              turnItems(message, { streaming: message.streaming === true }).map((item) => (
                <StepItem
                  key={item.key}
                  item={item}
                  onOpenPath={() => {}}
                  streaming={message.streaming === true}
                  latestTodoId={latestTodo(message.tools)}
                />
              ))}
          </div>
        ))}
      </div>
      <HandoffsCard handoffs={railHandoffs(messages)} folded={false} jump={jump} {...card} />
    </aside>
  );
}

const card = () => screen.getByTestId('rail-handoffs');
const row = (runId: string) =>
  within(card())
    .getAllByTestId('rail-handoff')
    .find((el) => el.dataset.runId === runId) as HTMLElement;
/** A hand-off's own line in the transcript. */
const line = (toolId: string) =>
  [
    ...screen
      .getByTestId('transcript')
      .querySelectorAll<HTMLElement>('[data-testid="action-card"]'),
  ].find((el) => el.dataset.toolId === toolId) as HTMLElement;
const asks = () => fleetRunDetail.mock.calls.map(([runId]) => runId);

/** Let every read a render started land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Run the clock `ms` on, then let what it started land. */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

const realNavigate = useNavStore.getState().navigate;

beforeEach(() => {
  records = {};
  jump.mockClear();
  fleetRunDetail.mockReset().mockImplementation(async (runId) => {
    const held = records[runId];
    if (held === undefined) throw new Error(`no run with id ${runId}`);
    if (held instanceof Error) throw held;
    return held;
  });
  useUiStore.setState({ aiPanelPresentation: 'canvas', aiPanelMinimized: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useNavStore.setState({ navigate: realNavigate } as never);
});

describe('what the card says', () => {
  it('lists the runs its hand-offs started, newest first, as their records say they went', async () => {
    records = { [SCOUT]: detailOf(SCOUT, '11:24'), [KNOWLEDGE]: detailOf(KNOWLEDGE, null) };
    render(<Panel messages={BOTH} />);
    await settle();
    expect(card().dataset.state).toBe('ready');
    expect(screen.getByRole('group', { name: 'Handed off' })).toBe(card());
    expect(within(card()).getByRole('heading', { level: 3 }).textContent).toBe(
      'Handed off1 running · 1 done',
    );
    const rows = within(card()).getAllByTestId('rail-handoff');
    expect(rows.map((el) => [el.dataset.runId, el.dataset.state, el.dataset.toolId])).toEqual([
      [KNOWLEDGE, 'running', 'h-2'],
      [SCOUT, 'done', 'h-1'],
    ]);
    expect(row(SCOUT).textContent).toContain('Handed to release-scout');
    expect(row(SCOUT).textContent).toContain('succeeded · 4m');
    expect(row(KNOWLEDGE).textContent).toContain('running');
    // One read, of each run once.
    expect(asks()).toEqual([KNOWLEDGE, SCOUT]);
  });

  it('draws a conversation that handed nothing off as one quiet line ending in None, and reads nothing', async () => {
    render(<Panel messages={[asked, reply([{ kind: 'TextDelta', text: 'Nothing to hand.' }])]} />);
    await settle();
    expect(card().dataset.state).toBe('empty');
    expect(within(card()).getByRole('heading', { level: 3 }).textContent).toBe('Handed offNone');
    expect(within(card()).queryByRole('button')).toBeNull();
    expect(fleetRunDetail).not.toHaveBeenCalled();
  });

  it('reads “Run not recorded” where a hand-off’s answer names no run, and asks nothing of it', async () => {
    render(<Panel messages={[asked, reply(handTo('h-1', 'release-scout', null))]} />);
    await settle();
    expect(card().dataset.state).toBe('not-recorded');
    const unnamed = within(card()).getByTestId('rail-handoff');
    expect(unnamed.dataset.state).toBe('not-recorded');
    expect(unnamed.hasAttribute('data-run-id')).toBe(false);
    expect(unnamed.textContent).toContain('Handed to release-scout');
    expect(unnamed.textContent).toContain(RAIL_HANDOFFS_WORDS.notRecorded);
    expect(card().textContent).not.toContain('None');
    // No run to read or to open.
    expect(fleetRunDetail).not.toHaveBeenCalled();
    expect(within(unnamed).queryByTestId('rail-handoff-open')).toBeNull();
  });

  it('makes a row whose read failed unavailable, and the card partial', async () => {
    // The knowledge run is one the runtime database does not hold.
    records = { [SCOUT]: detailOf(SCOUT, '11:24') };
    render(<Panel messages={BOTH} />);
    await settle();
    expect(card().dataset.state).toBe('partial');
    expect(screen.getByTestId('rail-handoffs-partial').textContent).toContain(
      RAIL_HANDOFFS_WORDS.partial,
    );
    expect(row(KNOWLEDGE).dataset.state).toBe('unavailable');
    expect(row(KNOWLEDGE).textContent).toContain(RAIL_HANDOFFS_WORDS.rowUnavailable);
    expect(row(SCOUT).dataset.state).toBe('done');
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('is unavailable, never empty, when no run’s read answers', async () => {
    records = { [SCOUT]: new Error('runtime.db is locked'), [KNOWLEDGE]: new Error('locked') };
    render(<Panel messages={BOTH} />);
    await settle();
    expect(card().dataset.state).toBe('unavailable');
    expect(within(card()).getByTestId('section-unavailable').textContent).toBe(
      RAIL_HANDOFFS_WORDS.unavailable,
    );
    // The hand-offs stay listed, claiming nothing of their runs, and said once.
    expect(
      within(card())
        .getAllByTestId('rail-handoff')
        .map((el) => el.dataset.state),
    ).toEqual(['unavailable', 'unavailable']);
    expect(card().textContent).not.toContain(RAIL_HANDOFFS_WORDS.rowUnavailable);
    expect(card().textContent).not.toContain('None');
  });

  it('claims nothing while its first read is out', async () => {
    fleetRunDetail.mockReturnValue(new Promise(() => undefined));
    render(<Panel messages={BOTH} />);
    await settle();
    expect(screen.queryByTestId('rail-handoffs')).toBeNull();
  });

  it('lists the newest eight and says how many came before', async () => {
    const events = Array.from({ length: HANDOFF_READS + 3 }, (_, at) =>
      handTo(`h-${at}`, 'release-scout', `run${at}`),
    ).flat();
    for (let at = 0; at < HANDOFF_READS + 3; at += 1)
      records[`run${at}`] = detailOf(`run${at}`, '11:24');
    render(<Panel messages={[asked, reply(events)]} />);
    await settle();
    expect(within(card()).getAllByTestId('rail-handoff')).toHaveLength(HANDOFF_READS);
    expect(asks()).toHaveLength(HANDOFF_READS);
    expect(asks()).not.toContain('run0');
    expect(screen.getByTestId('rail-handoffs-earlier').textContent).toBe(
      RAIL_HANDOFFS_WORDS.earlier(HANDOFF_READS, HANDOFF_READS + 3),
    );
  });

  it('makes every control a button and a tab stop of its own, never an href (CV-16)', async () => {
    records = { [SCOUT]: detailOf(SCOUT, '11:24'), [KNOWLEDGE]: detailOf(KNOWLEDGE, null) };
    render(<Panel messages={BOTH} />);
    await settle();
    expect(card().querySelector('a[href]')).toBeNull();
    const buttons = within(card()).getAllByRole('button');
    // The fold, and each row's two.
    expect(buttons).toHaveLength(5);
    for (const button of buttons) expect(button.getAttribute('tabindex')).toBe('0');
    expect(document.querySelectorAll('[data-unknown-icon]')).toHaveLength(0);
  });
});

describe('the polling rules', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  it('polls every 15 s while a run goes on, and stops once every run has ended', async () => {
    records = { [SCOUT]: detailOf(SCOUT, '11:24'), [KNOWLEDGE]: detailOf(KNOWLEDGE, null) };
    render(<Panel messages={BOTH} />);
    await settle();
    expect(asks()).toHaveLength(2);
    await wait(HANDOFF_POLL_MS - 1);
    expect(asks()).toHaveLength(2);
    await wait(1);
    expect(asks()).toEqual([KNOWLEDGE, SCOUT, KNOWLEDGE, SCOUT]);
    // The knowledge run ends: the next poll reads it, and the last.
    records[KNOWLEDGE] = detailOf(KNOWLEDGE, '11:30');
    await wait(HANDOFF_POLL_MS);
    expect(asks()).toHaveLength(6);
    expect(row(KNOWLEDGE).dataset.state).toBe('done');
    await wait(HANDOFF_POLL_MS * 4);
    expect(asks()).toHaveLength(6);
  });

  it('never polls when every run had ended at its first read', async () => {
    records = { [SCOUT]: detailOf(SCOUT, '11:24'), [KNOWLEDGE]: detailOf(KNOWLEDGE, '11:25') };
    render(<Panel messages={BOTH} />);
    await settle();
    await wait(HANDOFF_POLL_MS * 4);
    expect(asks()).toHaveLength(2);
  });

  it('never reads or polls while the rail is folded, and reads again as it unfolds', async () => {
    records = { [SCOUT]: detailOf(SCOUT, '11:24'), [KNOWLEDGE]: detailOf(KNOWLEDGE, null) };
    const view = render(<Panel messages={BOTH} folded />);
    await settle();
    await wait(HANDOFF_POLL_MS * 4);
    expect(fleetRunDetail).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rail-handoffs')).toBeNull();
    view.rerender(<Panel messages={BOTH} folded={false} />);
    await settle();
    expect(asks()).toHaveLength(2);
    await wait(HANDOFF_POLL_MS);
    expect(asks()).toHaveLength(4);
    // The rail hides: the polling stops, and the card keeps what it drew.
    view.rerender(<Panel messages={BOTH} folded />);
    await wait(HANDOFF_POLL_MS * 4);
    expect(asks()).toHaveLength(4);
    expect(card().dataset.state).toBe('ready');
    view.rerender(<Panel messages={BOTH} folded={false} />);
    await settle();
    expect(asks()).toHaveLength(6);
  });

  it('stops polling when the rail goes', async () => {
    records = { [KNOWLEDGE]: detailOf(KNOWLEDGE, null) };
    const view = render(<Panel messages={[asked, reply(handTo('h-2', 'knowledge', KNOWLEDGE))]} />);
    await settle();
    view.unmount();
    await wait(HANDOFF_POLL_MS * 4);
    expect(asks()).toEqual([KNOWLEDGE]);
  });

  it('reads at a turn’s end, and never on a streamed word', async () => {
    records = { [SCOUT]: detailOf(SCOUT, '11:24') };
    let working = reply(handTo('h-1', 'release-scout', SCOUT), { streaming: true });
    const view = render(<Panel messages={[asked, working]} />);
    await settle();
    expect(asks()).toEqual([SCOUT]);
    for (let at = 0; at < 50; at += 1) {
      working = applyEvent(working, { kind: 'TextDelta', text: `word${at} ` }, 'live', SESSION);
      view.rerender(<Panel messages={[asked, working]} />);
    }
    await settle();
    expect(asks()).toEqual([SCOUT]);
    view.rerender(<Panel messages={[asked, endLiveTurn(working)]} />);
    await settle();
    expect(asks()).toEqual([SCOUT, SCOUT]);
  });

  it('reads a run its turn hands off as it goes, without waiting for the turn to end', async () => {
    records = { [SCOUT]: detailOf(SCOUT, '11:24'), [KNOWLEDGE]: detailOf(KNOWLEDGE, null) };
    const first = handTo('h-1', 'release-scout', SCOUT);
    const view = render(<Panel messages={[asked, reply(first, { streaming: true })]} />);
    await settle();
    expect(asks()).toEqual([SCOUT]);
    view.rerender(
      <Panel
        messages={[
          asked,
          reply([...first, ...handTo('h-2', 'knowledge', KNOWLEDGE)], { streaming: true }),
        ]}
      />,
    );
    await settle();
    expect(asks()).toEqual([SCOUT, KNOWLEDGE, SCOUT]);
    expect(row(KNOWLEDGE).dataset.state).toBe('running');
  });

  it('reads nothing on a poll that comes while the window is hidden', async () => {
    records = { [KNOWLEDGE]: detailOf(KNOWLEDGE, null) };
    render(<Panel messages={[asked, reply(handTo('h-2', 'knowledge', KNOWLEDGE))]} />);
    await settle();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      await wait(HANDOFF_POLL_MS * 2);
      expect(asks()).toEqual([KNOWLEDGE]);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
    await wait(HANDOFF_POLL_MS);
    expect(asks()).toEqual([KNOWLEDGE, KNOWLEDGE]);
  });

  it('drops an answer that lands after the rail folded', async () => {
    let answer: (detail: FleetRunDetail) => void = () => undefined;
    fleetRunDetail.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    records = { [KNOWLEDGE]: detailOf(KNOWLEDGE, '11:30') };
    const messages = [asked, reply(handTo('h-2', 'knowledge', KNOWLEDGE))];
    const view = render(<Panel messages={messages} />);
    view.rerender(<Panel messages={messages} folded />);
    answer(detailOf(KNOWLEDGE, null));
    await settle();
    expect(screen.queryByTestId('rail-handoffs')).toBeNull();
    // Unfolding reads it afresh.
    view.rerender(<Panel messages={messages} folded={false} />);
    await settle();
    expect(row(KNOWLEDGE).dataset.state).toBe('done');
  });
});

describe('a row’s first action', () => {
  it('shows the hand-off’s line in the transcript, and stays in the canvas', async () => {
    const navigate = vi.fn();
    useNavStore.setState({ navigate } as never);
    records = { [SCOUT]: detailOf(SCOUT, '11:24'), [KNOWLEDGE]: detailOf(KNOWLEDGE, null) };
    render(<Panel messages={BOTH} />);
    await settle();
    fireEvent.click(within(row(SCOUT)).getByTestId('rail-handoff-show'));
    expect(jump).toHaveBeenCalledTimes(1);
    // Its line's own control, the one that opens its run.
    const target = line('h-1').querySelector('[data-slot="subagent-handoff-run"]');
    expect(target).not.toBeNull();
    expect(document.activeElement).toBe(target);
    expect(useUiStore.getState().aiPanelPresentation).toBe('canvas');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('lets the host’s transcript scroller bring the line into view', async () => {
    const reveal = vi.fn();
    records = { [SCOUT]: detailOf(SCOUT, '11:24'), [KNOWLEDGE]: detailOf(KNOWLEDGE, null) };
    render(<Panel messages={BOTH} reveal={reveal} />);
    await settle();
    fireEvent.click(within(row(KNOWLEDGE)).getByTestId('rail-handoff-show'));
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(line('h-2'));
    expect(useUiStore.getState().aiPanelPresentation).toBe('canvas');
  });

  it('lands on the line itself where its run is not recorded, for as long as it holds focus', async () => {
    render(<Panel messages={[asked, reply(handTo('h-1', 'release-scout', null))]} />);
    await settle();
    fireEvent.click(within(card()).getByTestId('rail-handoff-show'));
    const own = line('h-1');
    expect(document.activeElement).toBe(own);
    expect(own.getAttribute('tabindex')).toBe('-1');
    act(() => own.blur());
    expect(own.hasAttribute('tabindex')).toBe(false);
    expect(useUiStore.getState().aiPanelPresentation).toBe('canvas');
  });
});

describe('a row’s second action', () => {
  it('floats the conversation first, then opens the run', async () => {
    let during: string | null = null;
    const navigate = vi.fn(() => {
      during = useUiStore.getState().aiPanelPresentation;
    });
    useNavStore.setState({ navigate } as never);
    records = { [SCOUT]: detailOf(SCOUT, '11:24'), [KNOWLEDGE]: detailOf(KNOWLEDGE, null) };
    render(<Panel messages={BOTH} />);
    await settle();
    fireEvent.click(
      screen.getByRole('button', { name: RAIL_HANDOFFS_WORDS.open('release-scout') }),
    );
    expect(navigate).toHaveBeenCalledWith({ kind: 'knowledge', nav: { tab: 'runs', run: SCOUT } });
    expect(during).toBe('floating');
    expect(jump).not.toHaveBeenCalled();
  });
});
