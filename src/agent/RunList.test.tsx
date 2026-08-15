import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('./agentIpc', () => ({ stopAgent: vi.fn(async () => true) }));

import * as agentIpc from './agentIpc';
import { RunList } from './RunList';
import type { RunRecord } from './runs';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { appendRunLog, describeRun, writtenPath } from '@/engine/runLog';

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

describe('the run log (M17.15)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ runs: [] });
  });

  it('shows what it did after there is nothing left running', () => {
    // The gap this closes: an unattended agent could write into the vault for
    // a month and leave no record that it had run at all.
    appendRunLog({
      id: 'r-1',
      at: '2026-08-03T10:00:00Z',
      owner: 'job',
      label: 'Release scout',
      source: 'records/agents/scout.md',
      trigger: 'schedule',
      scope: ['records/risks'],
      files: ['records/risks/a.md'],
      status: 'ok',
    });
    render(<RunList />);
    fireEvent.click(screen.getByTestId('status-agent'));
    const row = screen.getByTestId('run-log-row');
    expect(row.textContent).toContain('Release scout');
    expect(row.textContent).toContain('Wrote records/risks/a.md');
  });

  it('an entry that knows its durable id opens that run in the fleet', () => {
    // M33.7 — the two run logs finally name the same run. Before this the
    // device-local log was keyed by a process tag that restarts at zero every
    // launch, so it could not address a database row at all.
    appendRunLog({
      id: 'r-2',
      at: '2026-08-03T10:00:00Z',
      owner: 'job',
      label: 'Release scout',
      source: 'records/agents/scout.md',
      trigger: 'schedule',
      scope: null,
      files: [],
      status: 'ok',
      durableId: 'durable-abc',
    });
    render(<RunList />);
    fireEvent.click(screen.getByTestId('status-agent'));

    fireEvent.click(screen.getByTestId('run-log-link'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'status',
      section: 'fleet',
      run: 'durable-abc',
    });
  });

  it('an entry from before the ids met is labelled device-only, and is not a link', () => {
    // Not broken — a run from before M33.7, or one that happened where no
    // runtime database exists. A link here would land nowhere.
    appendRunLog({
      id: 'r-3',
      at: '2026-08-03T10:00:00Z',
      owner: 'job',
      label: 'Old scout',
      source: null,
      trigger: 'schedule',
      scope: null,
      files: [],
      status: 'ok',
    });
    render(<RunList />);
    fireEvent.click(screen.getByTestId('status-agent'));

    const row = screen.getByTestId('run-log-row');
    expect(row.textContent).toContain('this device only');
    expect(screen.queryByTestId('run-log-link')).toBeNull();
  });

  it('says "wrote nothing" rather than leaving a blank', () => {
    // An agent that correctly decides to do nothing has run successfully, and
    // that is the outcome the ask: gate is designed to produce most of the time.
    expect(
      describeRun({
        id: 'r',
        at: '',
        owner: 'job',
        label: 'x',
        source: null,
        trigger: 'event',
        scope: null,
        files: [],
        status: 'ok',
      }),
    ).toBe('Wrote nothing');
  });

  it('stays out of the status bar entirely when nothing has ever run', () => {
    render(<RunList />);
    expect(screen.queryByTestId('status-agent')).toBeNull();
  });
});

describe('writtenPath', () => {
  it('reads the path a write tool is aimed at', () => {
    expect(writtenPath('mcp__cerebro__update_frontmatter', '{"path":"a/b.md"}')).toBe('a/b.md');
    expect(writtenPath('create_note', '{"folder":"records/risks","title":"X"}')).toBe(
      'records/risks',
    );
  });

  it('reports nothing for a read, and survives input that is not JSON', () => {
    expect(writtenPath('search_notes', '{"query":"x"}')).toBeNull();
    expect(writtenPath('update_frontmatter', 'not json')).toBeNull();
    expect(writtenPath('update_frontmatter', null)).toBeNull();
  });
});
