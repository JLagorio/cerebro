// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetRunDetail } from '@/lib/ipc';
import { __seedRunHistoryRegistry } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { RunDetailPanel } from './RunDetailPanel';

const reads = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
  fleetRunConfiguration: reads,
  runKnowledgeWrites: () => Promise.resolve(null),
}));

function detail(id = 'configuration-run', vault = 'demo'): FleetRunDetail {
  return {
    run: {
      run_id: id,
      actor: 'process:release-scout',
      vault_id: vault,
      mode: 'ambient',
      lane: 'scheduled',
      started_at: '2026-10-24T12:00:00Z',
      ended_at: null,
      outcome: 'running',
      usage_state: 'unknown',
      input_tokens: 0,
      output_tokens: 0,
      proposals_submitted: null,
      applied: null,
      rejected: null,
      parent_run_id: null,
      cause: null,
      cli_session_id: null,
    },
    cost_components: null,
    assembly: null,
    model_id: null,
    refusals: [],
    refusals_total: 0,
    wrote: { state: 'not_recorded' },
  };
}
const identity = { sha256: 'a'.repeat(64), metadata_label: null };
function recorded(id = 'configuration-run') {
  return {
    state: 'recorded',
    manifest: {
      format: 1,
      run_id: id,
      vault_id: 'demo',
      store_uuid: 'store',
      dispatched_at: '2026-10-24T12:00:00Z',
      effective_grant: {
        actor_id: identity,
        read_scope: { mode: 'prefixes', selectors: [identity] },
        write_scope: { mode: 'none' },
        tools: { mode: 'none' },
        chain: [],
        run_kind: 'attended',
        ask_first: true,
      },
      permission_mode: 'default',
      cli_tools: [],
      allowed_tools: [identity],
      denied_tools: [],
      asked_tools: [],
      requested_model: identity,
      requested_effort: null,
      observed_model_at_dispatch: { state: 'unknown', reason: 'not_observed_before_dispatch' },
      observed_cli_version: { state: 'recorded', value: { major: 2, minor: 1, patch: 250 } },
      artifacts: [],
      standing_agent: { state: 'unknown', reason: 'no_native_identity_receipt' },
      skills: { state: 'unknown', reason: 'no_native_identity_receipt' },
      defined_subagents: [],
      effective_system_prompt_sha256: null,
      connectors: [],
      inherits_user_mcp: false,
      user_settings: { state: 'unknown', reason: 'inherited_user_configuration' },
      settings_hardening: true,
      seated: true,
      message_transport: 'stdin',
      coverage: [],
      // A producer outside the Rust contract must not turn the inspector into a raw JSON viewer.
      raw_prompt: 'DO-NOT-RENDER-private-canary',
    },
  };
}
async function originReady() {
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
}
async function open() {
  await originReady();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Run configuration' }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  reads.mockReset().mockResolvedValue({ state: 'not_recorded', reason: 'legacy' });
  __seedRunHistoryRegistry({ '/demo-vault': 'demo', '/other-vault': 'other' });
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entriesVault: '/demo-vault',
    status: 'ready',
    entries: [],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the existing run details configuration disclosure', () => {
  it('performs no configuration read before the person opens it', async () => {
    render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
    await originReady();
    expect(reads).not.toHaveBeenCalled();
  });
  it.each([
    ['legacy', 'Configuration was not recorded for this run.'],
    ['expired', 'Configuration expired.'],
    ['deleted', 'Configuration deleted.'],
    ['capture_failed', 'Configuration capture failed.'],
  ])('keeps the %s reason distinct from an unavailable read', async (reason, words) => {
    reads.mockResolvedValue({ state: 'not_recorded', reason });
    render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
    await open();
    expect(await screen.findByText(words)).toBeTruthy();
    expect(reads).toHaveBeenCalledExactlyOnceWith('/demo-vault', 'configuration-run');
    expect(
      within(screen.getByTestId('run-configuration')).queryByTestId('section-unavailable'),
    ).toBeNull();
  });
  it('keeps failed reads unavailable and retries only the same requested run', async () => {
    reads
      .mockRejectedValueOnce(new Error('private diagnostic'))
      .mockResolvedValueOnce({ state: 'not_recorded', reason: 'expired' });
    render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
    await open();
    const section = screen.getByTestId('run-configuration');
    expect(await within(section).findByText('Configuration unavailable.')).toBeTruthy();
    expect(section.textContent).not.toContain('private diagnostic');
    fireEvent.click(within(section).getByRole('button', { name: 'Retry configuration' }));
    expect(await screen.findByText('Configuration expired.')).toBeTruthy();
    expect(reads.mock.calls).toEqual([
      ['/demo-vault', 'configuration-run'],
      ['/demo-vault', 'configuration-run'],
    ]);
  });
  it('displays recorded identities and unknown facts without raw payload or inferred values', async () => {
    reads.mockResolvedValue(recorded());
    render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
    await open();
    expect(await screen.findByText('2.1.250')).toBeTruthy();
    const section = screen.getByTestId('run-configuration');
    expect(section.textContent).toContain('label not recorded');
    expect(section.textContent).toContain('a'.repeat(64));
    expect(section.textContent).toContain('not observed before dispatch');
    expect(section.innerHTML).not.toContain('DO-NOT-RENDER-private-canary');
  });
  it.each([null, undefined])('names absent optional configuration facts (%s)', async (absent) => {
    const response = recorded();
    reads.mockResolvedValue({
      ...response,
      manifest: {
        ...response.manifest,
        requested_model: absent,
        effective_system_prompt_sha256: absent,
      },
    });
    render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
    await open();
    expect(await screen.findByText('2.1.250')).toBeTruthy();
    expect(screen.getByText('Requested model').nextElementSibling?.textContent).toBe(
      'not recorded',
    );
    expect(screen.getByText('System instruction identity').nextElementSibling?.textContent).toBe(
      'not recorded',
    );
  });
  it('does not read a foreign run through the current vault or switch that vault', async () => {
    render(<RunDetailPanel detail={detail('foreign-run', 'other')} onClose={() => {}} />);
    await open();
    expect(
      await screen.findByText('Open this run’s vault to inspect its configuration.'),
    ).toBeTruthy();
    expect(reads).not.toHaveBeenCalled();
    expect(useVaultStore.getState().vaultPath).toBe('/demo-vault');
  });
  it('retires an in-flight reply when the run changes, even inside the same vault', async () => {
    const pending = deferred<ReturnType<typeof recorded>>();
    reads
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ state: 'not_recorded', reason: 'deleted' });
    const view = render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
    await open();
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    view.rerender(<RunDetailPanel detail={detail('next-run')} onClose={() => {}} />);
    await act(async () => pending.resolve(recorded()));
    expect(screen.queryByText('2.1.250')).toBeNull();
    expect(reads).toHaveBeenCalledTimes(1);
    await open();
    expect(await screen.findByText('Configuration deleted.')).toBeTruthy();
    expect(reads).toHaveBeenLastCalledWith('/demo-vault', 'next-run');
  });
  it('retires a closed disclosure reply and reads afresh on reopen', async () => {
    const pending = deferred<ReturnType<typeof recorded>>();
    reads
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ state: 'not_recorded', reason: 'expired' });
    render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
    await open();
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Run configuration' }));
    await act(async () => pending.resolve(recorded()));
    expect(screen.queryByText('2.1.250')).toBeNull();
    await open();
    expect(await screen.findByText('Configuration expired.')).toBeTruthy();
    expect(reads).toHaveBeenCalledTimes(2);
  });
  it('retires a reply across a vault departure and return', async () => {
    const pending = deferred<ReturnType<typeof recorded>>();
    reads
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ state: 'not_recorded', reason: 'deleted' });
    render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
    await open();
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    act(() => useVaultStore.setState({ vaultPath: '/other-vault', entriesVault: '/other-vault' }));
    act(() => useVaultStore.setState({ vaultPath: '/demo-vault', entriesVault: '/demo-vault' }));
    await act(async () => pending.resolve(recorded()));
    expect(screen.queryByText('2.1.250')).toBeNull();
    expect(reads).toHaveBeenCalledTimes(1);
    await open();
    expect(await screen.findByText('Configuration deleted.')).toBeTruthy();
  });
  it.each([
    [
      'a batched vault departure and return',
      () => {
        useVaultStore.setState({ vaultPath: '/other-vault', entriesVault: '/other-vault' });
        useVaultStore.setState({ vaultPath: '/demo-vault', entriesVault: '/demo-vault' });
      },
    ],
    [
      'a batched same-path opening cycle',
      () => {
        useVaultStore.setState({ status: 'scanning' });
        useVaultStore.setState({ status: 'ready' });
      },
    ],
  ] as const)('retires a pending reply after %s', async (_name, changeOpening) => {
    const pending = deferred<ReturnType<typeof recorded>>();
    reads
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ state: 'not_recorded', reason: 'deleted' });
    render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
    await open();
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    act(() => changeOpening());
    await act(async () => pending.resolve(recorded()));
    expect(screen.queryByText('2.1.250')).toBeNull();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', { name: 'Run configuration' }).getAttribute('aria-expanded'),
    ).toBe('false');
    await open();
    expect(await screen.findByText('Configuration deleted.')).toBeTruthy();
    expect(reads).toHaveBeenCalledTimes(2);
  });
});
