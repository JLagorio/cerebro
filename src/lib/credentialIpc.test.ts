// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialAcquisitionView } from './generated/actions';
import { beginGhImport, credentialAcquisition, cancelCredentialAcquisition } from './ipc';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => {
  invoke.mockReset();
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});
const pending: CredentialAcquisitionView = {
  attemptId: 'attempt-selector',
  connectionId: 'connection-selector',
  host: 'github.com',
  login: 'selected-login',
  expectedRevision: 2,
  revocationGeneration: 0,
  state: 'pending',
  error: null,
  observedAt: '2026-10-25T00:00:00Z',
};
describe('M96 public credential IPC helpers', () => {
  it('sends only exact selectors and preserves the safe acquisition view', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    invoke.mockResolvedValue(pending);
    expect(await beginGhImport('connection-selector', 'github.com', 'selected-login', 1)).toBe(
      pending,
    );
    expect(invoke).toHaveBeenLastCalledWith('begin_gh_import', {
      connectionId: 'connection-selector',
      host: 'github.com',
      login: 'selected-login',
      expectedRevision: 1,
    });
    expect(await credentialAcquisition('attempt-selector')).toBe(pending);
    expect(invoke).toHaveBeenLastCalledWith('credential_acquisition', {
      attemptId: 'attempt-selector',
    });
    const cancelled: CredentialAcquisitionView = {
      ...pending,
      state: 'cancelled',
      error: 'cancelled',
    };
    invoke.mockResolvedValueOnce(cancelled);
    expect(await cancelCredentialAcquisition('attempt-selector')).toBe(cancelled);
    expect(invoke).toHaveBeenLastCalledWith('cancel_credential_acquisition', {
      attemptId: 'attempt-selector',
    });
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it('propagates native unavailability without inventing an attempt or installed state', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    invoke.mockRejectedValue('unavailable');
    await expect(
      beginGhImport('connection-selector', 'github.com', 'selected-login', 1),
    ).rejects.toBe('unavailable');
    await expect(credentialAcquisition('attempt-selector')).rejects.toBe('unavailable');
    await expect(cancelCredentialAcquisition('attempt-selector')).rejects.toBe('unavailable');
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it('keeps browser begin poll and cancel unavailable with zero native work', async () => {
    await expect(
      beginGhImport('connection-selector', 'github.com', 'selected-login', 1),
    ).rejects.toBe('unavailable');
    await expect(credentialAcquisition('attempt-selector')).rejects.toBe('unavailable');
    await expect(cancelCredentialAcquisition('attempt-selector')).rejects.toBe('unavailable');
    expect(invoke).not.toHaveBeenCalled();
  });
});
