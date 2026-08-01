import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

vi.mock('./agentIpc', () => ({
  runAgent: vi.fn(async () => undefined),
  startMcp: vi.fn(async () => ({ port: 1, token: 't' })),
  stopAgent: vi.fn(async () => undefined),
  onAgentEvent: vi.fn(() => () => undefined),
}));

import * as agentIpc from './agentIpc';
import { useAgentChat } from './useAgentChat';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

/**
 * The seam that makes skills real (M13.1): the transcript shows what was
 * typed while the agent runs the expanded message. Reverting `message:
 * outgoing` to the typed text — one word — kept every other test green, which
 * is exactly why these exist.
 */
describe('useAgentChat send expansion', () => {
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
  });

  it('shows the typed text but runs the expanded message', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('/weekly-review', () => Promise.resolve('EXPANDED BODY')));
    expect(result.current.messages[0].text).toBe('/weekly-review');
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ message: 'EXPANDED BODY' }),
      ),
    );
  });

  it('falls back to sending the typed text when the expansion rejects', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('/gone', () => Promise.reject(new Error('unreadable'))));
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ message: '/gone' }),
      ),
    );
  });

  it('appends the turn synchronously — a pending expansion leaves no window to interleave', () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('/slow', () => new Promise<string>(() => undefined)));
    // Both bubbles exist and streaming is up before the expansion resolves,
    // so a second send sees a busy conversation rather than an idle one.
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.streaming).toBe(true);
  });

  it('still accepts a plain pre-expanded string', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('shown', 'sent'));
    expect(result.current.messages[0].text).toBe('shown');
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ message: 'sent' }),
      ),
    );
  });
});

/**
 * Preempting the background runner (PR #5 review). Two races lived here:
 * send() fired runAgent before the runner's finish() released the stream
 * (the new turn's events were dropped while learningPath was set — empty
 * bubble), and finish() dropped agentBusy on its way out, letting the
 * runner read the agent as idle and schedule a background run that would
 * replace the chat's child mid-answer.
 */
describe('useAgentChat preempting the background runner', () => {
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ learningPath: null, agentBusy: false });
  });

  it('waits for the runner to release the stream, then re-claims the busy flag', async () => {
    useUiStore.setState({ learningPath: 'notes/reading.md', agentBusy: true });
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));

    // The kill was issued…
    await vi.waitFor(() => expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalled());
    // …but the runner still owns the stream, so the new child must not
    // start: its events would land while the handler is ignoring them.
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    // The killed child's terminal Done lands: the runner's finish()
    // releases the stream and drops agentBusy on its way out.
    act(() => {
      useUiStore.getState().setLearningPath(null);
      useUiStore.getState().setAgentBusy(false);
    });

    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    // The chat re-claimed the agent — the runner cannot read it as idle
    // and schedule a background run over this turn.
    expect(useUiStore.getState().agentBusy).toBe(true);
  });

  it('starts immediately when no background run owns the stream', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
  });
});
