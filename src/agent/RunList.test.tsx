import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('./agentIpc', () => ({ stopAgent: vi.fn(async () => true) }));

import * as agentIpc from './agentIpc';
import { RunList } from './RunList';
import type { RunRecord } from './runs';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';

afterEach(cleanup);

/**
 * The "I started a task and walked away" surface (M17.7).
 *
 * What replaced `agentBusy` — a light with no switch behind it, which could
 * not say what was running, what it was about, or how to get back to it.
 */

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1',
  owner: 'chat',
  label: 'what is at risk right now?',
  place: { kind: 'list', id: 'roadmap', collection: null },
  path: null,
  conversationId: 'c-1',
  run: 8,
  startedAt: 0,
  ...over,
});

describe('RunList', () => {
  beforeEach(() => {
    vi.mocked(agentIpc.stopAgent).mockClear();
    useUiStore.setState({ runs: [], aiPanelOpen: false });
    useNavStore.setState({ selection: { kind: 'home' } });
  });

  it('draws nothing at all when nothing is running', () => {
    render(<RunList />);
    expect(screen.queryByTestId('status-agent')).toBeNull();
  });

  it('says what is running and what it is about', () => {
    useUiStore.setState({ runs: [run()] });
    render(<RunList />);
    fireEvent.click(screen.getByTestId('status-agent'));
    const row = screen.getByTestId('run-row');
    expect(row.textContent).toContain('what is at risk right now?');
    // Where it belongs, resolved by id because the List is not in this vault
    // fixture — a task list that renders blank for a deleted List is worse
    // than one that renders its id.
    expect(row.textContent).toContain('roadmap');
  });

  it('counts when there is more than one', () => {
    useUiStore.setState({
      runs: [run(), run({ id: 'r2', owner: 'job', label: 'Beta plan', path: 'notes/beta.md' })],
    });
    render(<RunList />);
    expect(screen.getByTestId('status-agent').textContent).toContain('2 running');
  });

  it('stops ONE run — the sentence that could not be written before runs had ids', () => {
    useUiStore.setState({
      runs: [run(), run({ id: 'r2', owner: 'job', label: 'Beta plan', run: 9 })],
    });
    render(<RunList />);
    fireEvent.click(screen.getByTestId('status-agent'));
    fireEvent.click(screen.getAllByTestId('run-stop')[1]);
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalledExactlyOnceWith(9);
  });

  it('cannot stop a task whose child does not exist yet', () => {
    // A task exists from the moment Send is pressed; the child does not exist
    // until the MCP handshake is done. Offering Stop in that window would
    // leave a run the list believes it stopped.
    useUiStore.setState({ runs: [run({ run: null })] });
    render(<RunList />);
    fireEvent.click(screen.getByTestId('status-agent'));
    expect(screen.getByTestId('run-stop').hasAttribute('disabled')).toBe(true);
  });

  it('takes you back to the conversation a chat run belongs to', () => {
    useUiStore.setState({ runs: [run()] });
    render(<RunList />);
    fireEvent.click(screen.getByTestId('status-agent'));
    // The row's own button, not the Stop beside it (whose label also names
    // the run so a screen reader knows what it would be stopping).
    fireEvent.click(within(screen.getByTestId('run-row')).getAllByRole('button')[0]);
    expect(useUiStore.getState().aiPanelOpen).toBe(true);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'list',
      id: 'roadmap',
      collection: null,
    });
  });

  it('takes you to the note a background job is reading', () => {
    useUiStore.setState({
      runs: [run({ owner: 'job', label: 'Beta plan', place: null, path: 'notes/beta.md' })],
    });
    render(<RunList />);
    fireEvent.click(screen.getByTestId('status-agent'));
    fireEvent.click(within(screen.getByTestId('run-row')).getAllByRole('button')[0]);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/beta.md' });
    // A background job is not a conversation, so it does not open the panel.
    expect(useUiStore.getState().aiPanelOpen).toBe(false);
  });
});
