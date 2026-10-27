// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as agentIpc from './agentIpc';
import type { ActionReadError, ChatRecoveryInspection } from '@/lib/generated/actions';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

afterEach(() => {
  invoke.mockReset();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

// Use the existing module namespace so a missing public read is an assertion
// failure, never a missing named import or a compiler error during RED.
function read(runId: string): Promise<unknown> {
  const inspect = Reflect.get(agentIpc, 'readChatRecovery');
  expect(inspect, 'agentIpc must expose the original-root recovery read').toBeTypeOf('function');
  return (inspect as (runId: string) => Promise<unknown>)(runId);
}

describe('M95 original-root recovery IPC', () => {
  it('sends only runId and preserves native refusals without fabricating empty history', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const errors: ActionReadError[] = [
      { code: 'denied', message: 'Read denied.', retryDisposition: 'never' },
      { code: 'not_found', message: 'Root not found.', retryDisposition: 'never' },
      { code: 'unavailable', message: 'Read unavailable.', retryDisposition: 'refresh' },
    ];
    for (const error of errors) {
      invoke.mockRejectedValueOnce(error);
      await expect(read('original-root-7')).rejects.toEqual(error);
      expect(invoke).toHaveBeenLastCalledWith('chat_recovery_inspect', {
        runId: 'original-root-7',
      });
    }
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('reports browser history as unavailable with browser provenance and no native work', async () => {
    await expect(read('original-root-7')).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/browser/i),
      retryDisposition: expect.stringMatching(/^(never|refresh|reconcile)$/),
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

// Compile this against the Rust-exported DTO, never a hand-generated response type.
const typedRead: (runId: string) => Promise<ChatRecoveryInspection> = agentIpc.readChatRecovery;
const allowed: ChatRecoveryInspection = {
  origin: {
    rootAttemptId: '22222222222222222222222222222222',
    runId: 'original-root-7',
    vaultId: 'vault',
    storeId: 'store',
    actorId: 'human:me',
    cliSessionId: 'cli-session',
    historicalAppSessionId: 'old-app-session',
    outcome: 'cancelled',
    startedAt: '2026-10-25T00:00:00Z',
    endedAt: '2026-10-25T00:01:00Z',
    nativeClosedAt: '2026-10-25T00:01:00Z',
    nativeCloseKind: 'stopped',
    appClosePrecision: 'clean_exact',
  },
  effects: [
    {
      effect: {
        invocationId: '11111111111111111111111111111111',
        state: 'outcome_unknown',
        approvalId: null,
        accountLabel: 'Safe account',
        canRetry: false,
        canReconcile: false,
      },
      detailsRead: 'available',
      reason: null,
      details: {
        effect: {
          invocationId: '11111111111111111111111111111111',
          state: 'outcome_unknown',
          approvalId: null,
          accountLabel: 'Safe account',
          canRetry: false,
          canReconcile: false,
        },
        revision: 1,
        account: { accountId: 'account', label: 'Safe account', accountRevision: 1 },
        target: { kind: 'record', label: 'Safe target', safeReference: 'safe-reference' },
        definitionDigest: 'a'.repeat(64),
        inputDigest: 'b'.repeat(64),
        preview: { summary: 'Sensitive historical preview', fields: [], redactedFields: [] },
        approval: null,
        attempts: [],
      },
    },
  ],
  brokerInventory: {
    state: 'complete',
    inspectedRunIds: ['original-root-7'],
    observedCount: 1,
    overflow: false,
    reasons: [],
  },
  generationCoverage: { state: 'unknown', reason: 'root_only_no_generation_binding' },
  externalEffectsCoverage: { state: 'unknown', reason: 'unbrokered_execution_not_covered' },
  issues: [],
};

it('replaces the entire native observation when account disclosure changes', async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const denied: ChatRecoveryInspection = {
    ...allowed,
    effects: [
      {
        effect: {
          invocationId: '11111111111111111111111111111111',
          state: 'outcome_unknown',
          approvalId: null,
          accountLabel: null,
          canRetry: false,
          canReconcile: false,
        },
        detailsRead: 'denied',
        details: null,
        reason: 'account_denied',
      },
    ],
  };
  invoke.mockResolvedValueOnce(allowed).mockResolvedValueOnce(denied);
  expect((await typedRead('original-root-7')).effects[0].details?.preview.summary).toBe(
    'Sensitive historical preview',
  );
  const refreshed = await typedRead('original-root-7');
  expect(refreshed).toEqual(denied);
  expect(refreshed.effects[0].details).toBeNull();
  expect(JSON.stringify(refreshed)).not.toContain('Sensitive historical preview');
  expect(invoke).toHaveBeenCalledTimes(2);
});
