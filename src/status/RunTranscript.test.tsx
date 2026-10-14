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
