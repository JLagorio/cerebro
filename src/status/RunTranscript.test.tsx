// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '@/agent/types';
import { demoRunTranscripts } from '@/lib/demoTranscripts';
import type { RunTranscript as Transcript } from '@/lib/ipc';
import { RunTranscript } from './RunTranscript';

/**
 * A run's transcript in its detail (M56.9, D5): collapsed until asked for,
 * read once, drawn by the panel's reducer and rows, and every state that is
 * not a transcript says which state it is.
 */

const fleetRunTranscript = vi.fn<(runId: string) => Promise<Transcript>>();

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return { ...actual, fleetRunTranscript: (runId: string) => fleetRunTranscript(runId) };
});

const SESSION = '00000000-0000-4000-8000-000000000001';

function unavailable(reason: string, days: number | null = 30): Transcript {
  return {
    runs_in_session: 1,
    retention_days: days,
    read: { state: 'unavailable', reason, retention_days: days },
  };
}

function readOf(events: AgentStreamEvent[], over: Partial<Transcript> = {}): Transcript {
  return {
    runs_in_session: 1,
    retention_days: 30,
    read: { state: 'read', events, lines: events.length, unclassified: [] },
    ...over,
  };
}

function show(sessionId: string | null = SESSION, running = false) {
  render(<RunTranscript runId="run-scout-1" sessionId={sessionId} running={running} />);
}

async function expand() {
  fireEvent.click(screen.getByTestId('run-transcript-toggle'));
  await waitFor(() => expect(screen.queryByText('Reading…')).toBeNull());
}

afterEach(cleanup);

describe('RunTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fleetRunTranscript.mockResolvedValue(demoRunTranscripts()['run-scout-1']);
  });

  it('starts collapsed and reads nothing', () => {
    show();
    const toggle = screen.getByTestId('run-transcript-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Transcript');
    expect(toggle.textContent).toContain("from Claude Code's session file");
    expect(fleetRunTranscript).not.toHaveBeenCalled();
    expect(screen.queryByTestId('run-transcript-body')).toBeNull();
  });

  it('reads the file once, on the first expand', async () => {
    show();
    await expand();
    fireEvent.click(screen.getByTestId('run-transcript-toggle'));
    fireEvent.click(screen.getByTestId('run-transcript-toggle'));
    expect(fleetRunTranscript).toHaveBeenCalledTimes(1);
    expect(fleetRunTranscript).toHaveBeenCalledWith('run-scout-1');
  });

  it('draws five get_note calls as one row, read-only', async () => {
    show();
    await expand();
    const body = screen.getByTestId('run-transcript-body');
    const groups = body.querySelectorAll('[data-testid="action-group"]');
    expect(groups).toHaveLength(1);
    expect(groups[0].textContent).toContain('read 5 notes');
    expect(screen.getByTestId('run-transcript-prompt').textContent).toContain('schedule came due');
    // A record of what the run did: no View diff, no word about reverting.
    expect(body.querySelector('[data-testid="action-view-diff"]')).toBeNull();
    expect(body.querySelector('[data-testid="action-no-revert"]')).toBeNull();
    expect(body.textContent).toContain('Release watch');
  });

  it('an expired file reads cleared by Claude Code, naming its retention', async () => {
    fleetRunTranscript.mockResolvedValue(unavailable('expired'));
    show();
    await expand();
    expect(screen.getByTestId('run-transcript-state').textContent).toBe(
      'Cleared by Claude Code, which deletes session files 30 days after their last turn.',
    );
    expect(screen.queryByTestId('run-transcript-body')).toBeNull();
  });

  it('a cleared file says the files were deleted', async () => {
    fleetRunTranscript.mockResolvedValue(unavailable('cleared'));
    show();
    await expand();
    expect(screen.getByTestId('run-transcript-state').textContent).toBe(
      "Cleared: this vault's Claude Code session files were deleted.",
    );
  });

  it('a run with no session says not recorded and reads nothing', () => {
    show(null);
    expect(screen.getByTestId('run-transcript-state').textContent).toBe(
      'Transcript not recorded for this run.',
    );
    expect(screen.queryByTestId('run-transcript-toggle')).toBeNull();
    expect(fleetRunTranscript).not.toHaveBeenCalled();
  });

  it('a rejected read is section-unavailable, never an empty thread', async () => {
    fleetRunTranscript.mockRejectedValue(new Error('no runtime database'));
    show();
    await expand();
    expect(screen.getByTestId('section-unavailable').textContent).toBe(
      "Couldn't read this run's transcript, so nothing here is a statement about what it said.",
    );
    expect(screen.queryByTestId('run-transcript-body')).toBeNull();
  });

  it('an unreadable file is section-unavailable too', async () => {
    fleetRunTranscript.mockResolvedValue(unavailable('unreadable'));
    show();
    await expand();
    expect(screen.getByTestId('section-unavailable')).toBeTruthy();
  });

  describe('an open turn', () => {
    // What the fold makes of a file whose last turn has not ended: its call
    // never finished, and the file's end cuts it off.
    const open: AgentStreamEvent[] = [
      { kind: 'UserPrompt', text: 'Check the risks.' },
      {
        kind: 'ToolStart',
        tool_name: 'mcp__cerebro__create_note',
        tool_id: 't-1',
        input: '{"folder":"records/risks","slug":"x","body":"y"}',
      },
      { kind: 'TurnInterrupted', reason: 'cut_off' },
    ];

    it('is still going while its run is running, never interrupted', async () => {
      fleetRunTranscript.mockResolvedValue(readOf(open));
      show(SESSION, true);
      await expand();
      expect(screen.queryByTestId('run-transcript-interrupted')).toBeNull();
      expect(screen.getByTestId('action-card').getAttribute('data-status')).toBe('running');
      expect(screen.getByTestId('run-transcript-running').textContent).toBe(
        'The run is still going; this is what its session file holds so far.',
      );
    });

    it('reads interrupted once its run is over', async () => {
      fleetRunTranscript.mockResolvedValue(readOf(open));
      show(SESSION, false);
      await expand();
      expect(screen.getByTestId('run-transcript-interrupted')).toBeTruthy();
      expect(screen.getByTestId('action-card').getAttribute('data-status')).toBe('interrupted');
      expect(screen.queryByTestId('run-transcript-running')).toBeNull();
    });

    // A subagent at work when the file was read: its Agent call and its own
    // second call have not ended.
    const delegating: AgentStreamEvent[] = [
      { kind: 'UserPrompt', text: 'Research the risks.' },
      {
        kind: 'ToolStart',
        tool_name: 'Agent',
        tool_id: 'a-1',
        input: JSON.stringify({ description: 'Read the risks', prompt: 'Read every risk.' }),
      },
      {
        kind: 'ToolStart',
        tool_name: 'mcp__cerebro__get_note',
        tool_id: 's-1',
        input: '{"path":"records/risks/a.md"}',
        parent: 'a-1',
      },
      { kind: 'ToolDone', tool_id: 's-1', output: 'Read it.', is_error: false, parent: 'a-1' },
      {
        kind: 'ToolStart',
        tool_name: 'mcp__cerebro__get_note',
        tool_id: 's-2',
        input: '{"path":"records/risks/b.md"}',
        parent: 'a-1',
      },
      { kind: 'TurnInterrupted', reason: 'cut_off' },
    ];
    const subagentOf = () =>
      screen
        .getByTestId('run-transcript-body')
        .querySelector<HTMLElement>('[data-slot="subagent"]')!;

    it('keeps a subagent still at work running while its run is running', async () => {
      fleetRunTranscript.mockResolvedValue(readOf(delegating));
      show(SESSION, true);
      await expand();
      expect(subagentOf().getAttribute('data-status')).toBe('running');
      expect(subagentOf().textContent).not.toContain('Interrupted');
    });

    it('reads that subagent interrupted once its run is over', async () => {
      fleetRunTranscript.mockResolvedValue(readOf(delegating));
      show(SESSION, false);
      await expand();
      expect(subagentOf().getAttribute('data-status')).toBe('interrupted');
    });
  });

  describe('a turn, drawn as the conversation draws one (M91.14)', () => {
    const reasoned: AgentStreamEvent[] = [
      { kind: 'UserPrompt', text: 'Weigh the release risks.' },
      { kind: 'Thinking', message_id: 'm1', text: 'The rollback risk has no rehearsal on record.' },
      {
        kind: 'ToolStart',
        tool_name: 'mcp__cerebro__get_note',
        tool_id: 't-1',
        input: '{"path":"records/risks/risk-rollback-unrehearsed.md"}',
      },
      { kind: 'ToolDone', tool_id: 't-1', output: 'Read it.', is_error: false },
      {
        kind: 'Text',
        message_id: 'm1',
        text: 'The **rollback** risk moved:\n\n- no rehearsal\n- no owner',
      },
      { kind: 'Result', text: 'The rollback risk moved.', session_id: SESSION },
      { kind: 'TurnEnded', stop_reason: 'end_turn' },
    ];

    it('shows its reasoning in an open chain of thought, then its answer as markdown', async () => {
      fleetRunTranscript.mockResolvedValue(readOf(reasoned));
      show();
      await expand();
      const turn = screen.getByTestId('run-transcript-turn');
      const chain = turn.querySelector<HTMLElement>('[data-slot="chain-of-thought"]')!;
      // The run's latest turn: its chain starts open, its reasoning one line.
      expect(chain.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
      const reasoning = chain.querySelector<HTMLElement>('[data-slot="reasoning"]')!;
      // No time on either side of it was recorded, so it says none (CV-05).
      expect(reasoning.textContent).toBe('Thought');
      fireEvent.click(reasoning.querySelector('button')!);
      expect(reasoning.textContent).toContain('The rollback risk has no rehearsal on record.');
      // The answer is the chat's markdown, not a plain paragraph.
      const answer = turn.querySelector<HTMLElement>('.cb-run-answer')!;
      expect(answer.querySelector('strong')?.textContent).toBe('rollback');
      expect([...answer.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
        'no rehearsal',
        'no owner',
      ]);
    });

    it('shows its prompt as a quiet bubble at the start', async () => {
      fleetRunTranscript.mockResolvedValue(readOf(reasoned));
      show();
      await expand();
      const prompt = screen.getByTestId('run-transcript-prompt');
      expect(prompt.getAttribute('data-align')).toBe('start');
      expect(prompt.querySelector('[data-slot="bubble"]')?.getAttribute('data-variant')).toBe(
        'muted',
      );
      expect(prompt.textContent).toBe('Weigh the release risks.');
    });

    it("draws a subagent's steps under it, with its tool uses and time as recorded", async () => {
      fleetRunTranscript.mockResolvedValue(
        readOf([
          { kind: 'UserPrompt', text: 'Research the risks.' },
          {
            kind: 'ToolStart',
            tool_name: 'Agent',
            tool_id: 'a-1',
            input: JSON.stringify({
              description: 'Read the risks',
              subagent_type: 'cerebro-researcher',
              prompt: 'Read every risk.',
            }),
          },
          {
            kind: 'ToolStart',
            tool_name: 'mcp__cerebro__get_note',
            tool_id: 's-1',
            input: '{"path":"records/risks/a.md"}',
            parent: 'a-1',
          },
          { kind: 'ToolDone', tool_id: 's-1', output: 'Read it.', is_error: false, parent: 'a-1' },
          {
            kind: 'ToolResult',
            tool_id: 'a-1',
            data: {
              type: 'agent',
              status: 'completed',
              tool_uses: 1,
              duration_ms: 1400,
              summary: 'Both risks moved.',
            },
          },
          { kind: 'ToolDone', tool_id: 'a-1', output: 'Both risks moved.', is_error: false },
          { kind: 'TurnEnded', stop_reason: 'end_turn' },
        ]),
      );
      show();
      await expand();
      const subagent = screen
        .getByTestId('run-transcript-body')
        .querySelector<HTMLElement>('[data-renderer="subagent"]')!;
      expect(subagent.getAttribute('data-slot')).toBe('subagent');
      expect(subagent.textContent).toContain('Read the risks');
      expect(subagent.textContent).toContain('cerebro-researcher');
      expect(subagent.textContent).toContain('1 tool use · 1.4s');
      expect(subagent.textContent).toContain('Both risks moved.');
      // Its own read is a row inside it, not a row of the turn's.
      expect(subagent.querySelectorAll('[data-testid="action-card"]')).toHaveLength(1);
    });

    it("says a failure Rust typed by its title, and one it could not in Claude Code's words", async () => {
      const failed = (error: AgentStreamEvent): AgentStreamEvent[] => [
        { kind: 'UserPrompt', text: 'Check the risks.' },
        error,
      ];
      fleetRunTranscript.mockResolvedValue(
        readOf(failed({ kind: 'Error', message: 'Claude Code exited with code 1' })),
      );
      show();
      await expand();
      expect(screen.getByTestId('turn-error').textContent).toContain(
        'Claude Code exited with code 1',
      );
      cleanup();
      fleetRunTranscript.mockResolvedValue(
        readOf(
          failed({
            kind: 'Error',
            message: 'raw words',
            notice: {
              kind: 'rate_limit',
              title: 'Usage limit reached',
              body: 'It resets later.',
              action: null,
              resets_at: null,
              window: null,
              cli_version: null,
            },
          }),
        ),
      );
      show();
      await expand();
      expect(screen.queryByTestId('turn-error')).toBeNull();
      expect(screen.getByTestId('run-transcript-turn').textContent).toBe('Usage limit reached');
    });
  });

  it('says when one session holds several runs', async () => {
    fleetRunTranscript.mockResolvedValue(
      readOf([{ kind: 'UserPrompt', text: 'hi' }], { runs_in_session: 3 }),
    );
    show();
    await expand();
    expect(screen.getByTestId('run-transcript-shared').textContent).toBe(
      'This Claude Code session holds 3 runs; all of it is shown.',
    );
  });

  it('the footnote names the retention, and no period when Claude Code never sweeps', async () => {
    show();
    await expand();
    expect(screen.getByTestId('run-transcript-retention').textContent).toBe(
      "Read from Claude Code's own session file, outside your vault. Claude Code deletes these " +
        'files 30 days after their last turn (30 by default), and Cerebro keeps no copy.',
    );
    cleanup();
    fleetRunTranscript.mockResolvedValue(readOf([], { retention_days: null }));
    show();
    await expand();
    expect(screen.getByTestId('run-transcript-retention').textContent).toBe(
      "Read from Claude Code's own session file, outside your vault. Cerebro keeps no copy.",
    );
  });

  it('keeps nothing in localStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    show();
    await expand();
    fireEvent.click(screen.getByTestId('run-transcript-toggle'));
    const local = setItem.mock.contexts.filter((context) => context === window.localStorage);
    expect(local).toHaveLength(0);
    setItem.mockRestore();
  });
});
