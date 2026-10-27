// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRunStarted, runAgent, startedOrThrow, type RunOptions, type RunStart } from './agentIpc';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

afterEach(() => {
  invoke.mockReset();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const KEY = '1234567890abcdef1234567890abcdef';
const receipt = {
  generationId: '11111111111111111111111111111111',
  firstRunId: '22222222222222222222222222222222',
  currentRunId: '33333333333333333333333333333333',
  state: 'running',
};
const options = (): RunOptions => ({
  message: 'Keep the original logical question',
  systemPrompt: 'Frozen prompt',
  shell: 'off',
  connectors: false,
  attended: true,
});
const keyed = () => ({ ...options(), generationRequestKey: KEY });

function native() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

describe('M95 attended generation start IPC', () => {
  it('sends the logical request key as the top-level Tauri argument', async () => {
    native();
    invoke.mockResolvedValueOnce({ run: 8, run_id: receipt.firstRunId, session_id: 'session-1' });
    await runAgent('/vault', keyed());
    expect(invoke).toHaveBeenCalledWith(
      'run_agent',
      expect.objectContaining({
        vault: '/vault',
        generationRequestKey: KEY,
        request: expect.objectContaining({ message: 'Keep the original logical question' }),
      }),
    );
    const payload = invoke.mock.calls[0][1] as { request: Record<string, unknown> };
    expect(payload.request).not.toHaveProperty('generation_request_key');
    expect(payload.request).not.toHaveProperty('generationRequestKey');
  });

  it('returns the observed-generation envelope without announcing a process handle', async () => {
    native();
    const announced = vi.fn();
    const unsubscribe = onRunStarted(announced);
    try {
      invoke.mockResolvedValueOnce({ observed_generation: receipt });
      const result = await runAgent('/vault', keyed());
      expect(result).toEqual({ observed_generation: receipt });
      expect(result).not.toHaveProperty('run');
      expect(result).not.toHaveProperty('attach');
      expect(announced).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('cannot narrow an observed generation into a started handle', () => {
    const observed = { observed_generation: receipt } as unknown as RunStart;
    expect(() => startedOrThrow(observed)).toThrow(/observ|already|generation/i);
  });

  it('retains the same key on an explicit caller redelivery without fabricating the observed run', async () => {
    native();
    invoke.mockRejectedValueOnce(new Error('Start acknowledgement unavailable'));
    invoke.mockResolvedValueOnce({ observed_generation: receipt });
    const frozen = keyed();
    await expect(runAgent('/vault', frozen)).rejects.toThrow('Start acknowledgement unavailable');
    expect(await runAgent('/vault', frozen)).toEqual({ observed_generation: receipt });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][1]).toEqual(invoke.mock.calls[1][1]);
    expect(invoke.mock.calls[1][1]).toHaveProperty('generationRequestKey', KEY);
  });

  it('keeps an unkeyed legacy start as its genuine native handle', async () => {
    native();
    invoke.mockResolvedValueOnce({ run: 8, run_id: receipt.firstRunId, session_id: 'session-1' });
    const result = await runAgent('/vault', options());
    expect(result).toEqual({
      run: 8,
      durableId: receipt.firstRunId,
      sessionId: 'session-1',
      attach: receipt.firstRunId,
    });
    expect(invoke.mock.calls[0][1].generationRequestKey ?? null).toBeNull();
  });
});

it.each([
  { ...receipt, currentRunId: 99 },
  { ...receipt, state: { kind: 'success' } },
])(
  'rejects a malformed native generation observation without announcing authority: %j',
  async (invalid) => {
    native();
    const announced = vi.fn();
    const unsubscribe = onRunStarted(announced);
    try {
      invoke.mockResolvedValueOnce({ observed_generation: invalid });
      await expect(runAgent('/vault', keyed())).rejects.toThrow(/generation|observation|invalid/i);
      expect(announced).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  },
);


describe('M95 display-only archive binding IPC', () => {
  it('carries the visible question separately from the assembled request', async () => {
    native();
    const archiveBinding = {
      threadId: 'thread-original', userMessageId: 'user-original', assistantMessageId: 'answer-original',
      parentThreadId: null, branchMessageId: null,
      displayMessage: { text: 'Visible question', addressedLabel: 'Researcher', attachmentRefs: ['files/report.pdf'] },
    };
    invoke.mockResolvedValueOnce({ run: 8, run_id: receipt.firstRunId, session_id: 'session-1' });
    await runAgent('/vault', { ...keyed(), message: 'ASSEMBLED_OUTGOING', ...{ archiveBinding } });
    const payload = invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.archiveBinding).toEqual(archiveBinding);
    expect(payload.request).toHaveProperty('message', 'ASSEMBLED_OUTGOING');
    expect(payload.request).not.toHaveProperty('archiveBinding');
    expect(payload.request).not.toHaveProperty('displayMessage');
  });
});
