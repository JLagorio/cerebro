// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActions } from './AgentActions';
import { emitUiAction } from './agentIpc';
import { __resetOpenPages, onExternalWrite } from '@/editor/openPages';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The agent's write tools announce what they changed (M53.6), because the
 * watcher drops the echo of every write the app makes, the agent's included.
 * The bridge is where that announcement becomes a rescan, and where the pages
 * showing a named file hear about it.
 */
describe('AgentActions and vault_changed', () => {
  const calls: string[] = [];
  const rescan = vi.fn(async () => {
    calls.push('rescan');
  });

  beforeEach(() => {
    calls.length = 0;
    rescan.mockClear();
    useVaultStore.setState({ rescan });
    render(<AgentActions />);
    onExternalWrite('a.md', {
      pending: () => calls.push('pending'),
      settled: () => calls.push('settled'),
    });
  });

  afterEach(() => {
    cleanup();
    __resetOpenPages();
  });

  it('tells the page showing a named file, then rescans once, then settles it', async () => {
    await act(async () => {
      emitUiAction({ action: 'vault_changed', paths: ['a.md'] });
    });
    await vi.waitFor(() => expect(calls).toEqual(['pending', 'rescan', 'settled']));
    expect(rescan).toHaveBeenCalledOnce();
  });

  it('only rescans when the write named no file', async () => {
    await act(async () => {
      emitUiAction({ action: 'vault_changed' });
    });
    await vi.waitFor(() => expect(rescan).toHaveBeenCalledOnce());
    expect(calls).toEqual(['rescan']);
  });
});
