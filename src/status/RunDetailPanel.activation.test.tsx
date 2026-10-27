// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/ipc', { spy: true });
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { __resetOpenPages, registerSaveParticipant } from '@/editor/openPages';
import { DocumentOwner, type NoteWriteAck } from '@/editor/documentOwner';
import { __resetRescans, useVaultStore } from '@/stores/vaultStore';
import { PaneContext, useNavStore } from '@/stores/navStore';
import { RunDetailPanel } from './RunDetailPanel';
import { PaneLayoutHost } from '@/app/LastPlaceHost';
import { LAST_PLACE_KEY, rememberLastPlace } from '@/app/lastPlace';
import { PANE_LAYOUT_KEY } from '@/app/paneLayoutPersistence';
import { hasPendingLeaveIntent } from '@/app/leaveGuard';

function detail(origin: string | null = 'other'): ipc.FleetRunDetail {
  return {
    run: {
      run_id: 'run',
      actor: null,
      vault_id: origin,
      mode: 'ambient',
      lane: 'filed',
      started_at: '2026-10-23',
      ended_at: null,
      outcome: 'running',
      usage_state: 'pending',
      input_tokens: 0,
      output_tokens: 0,
      proposals_submitted: 2,
      applied: 0,
      rejected: 0,
      parent_run_id: null,
      cause: null,
      cli_session_id: null,
    },
    cost_components: null,
    assembly: null,
    model_id: null,
    refusals: [],
    refusals_total: 0,
    wrote: {
      state: 'recorded',
      writes: [
        {
          kind: 'vault.write',
          path: 'notes/destination.md',
          to: null,
          at: '2026-10-23',
          approved_by: null,
        },
      ],
    },
  };
}
function heldOwner() {
  let acknowledge!: (ack: NoteWriteAck) => void;
  const writer = vi.fn(
    () =>
      new Promise<NoteWriteAck>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const owner = new DocumentOwner(
    { vaultId: '/active', path: 'notes/draft.md', ownerId: 'pane' },
    'old',
    writer,
  );
  owner.edit('exact new draft');
  registerSaveParticipant({
    key: owner.key,
    prepare: () => {},
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  return { writer, release: () => acknowledge({ kind: 'file', contentHash: 'authoritative' }) };
}
beforeEach(() => {
  window.localStorage.removeItem(LAST_PLACE_KEY);
  window.localStorage.removeItem(PANE_LAYOUT_KEY);
  resetMockFs();
  __resetOpenPages();
  __resetRescans();
  useNavStore.getState().reset();
  useVaultStore.setState({
    vaultPath: '/active',
    entriesVault: '/active',
    entries: [],
    status: 'ready',
  });
  vi.spyOn(ipc, 'fleetRunOrigin').mockImplementation(async (id) =>
    id === null
      ? { kind: 'not_recorded' }
      : id === 'removed'
        ? { kind: 'unavailable' }
        : { kind: 'registered', vault: `/${id}` },
  );
  vi.spyOn(ipc, 'runKnowledgeWrites').mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetOpenPages();
  __resetRescans();
});

it.each([null, 'removed'])(
  'keeps pending decisions readable but inert without origin %s',
  async (origin) => {
    render(<RunDetailPanel detail={detail(origin)} onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
    const count = screen.getByTestId('run-detail-to-review');
    expect(count.textContent).toContain('2 still waiting');
    expect(count.getAttribute('disabled')).not.toBeNull();
    fireEvent.click(count);
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  },
);

it('opens pending decisions in the recorded vault after its switch completes', async () => {
  render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
  fireEvent.click(screen.getByTestId('run-detail-to-review'));
  await waitFor(() =>
    expect(useNavStore.getState().selection).toEqual({ kind: 'knowledge', nav: { tab: 'review' } }),
  );
  expect(useVaultStore.getState().vaultPath).toBe('/other');
  expect(useVaultStore.getState().entriesVault).toBe('/other');
});

it('allows only the latest activation within the same run to navigate', async () => {
  render(<RunDetailPanel detail={detail('active')} onClose={() => {}} />);
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
  let old!: (origin: ipc.RunOrigin) => void;
  vi.mocked(ipc.fleetRunOrigin).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        old = resolve;
      }),
  );
  fireEvent.click(screen.getByTestId('run-detail-page'));
  fireEvent.click(screen.getByTestId('run-detail-to-review'));
  await waitFor(() =>
    expect(useNavStore.getState().selection).toEqual({ kind: 'knowledge', nav: { tab: 'review' } }),
  );
  await act(async () => old({ kind: 'registered', vault: '/active' }));
  expect(useNavStore.getState().selection).toEqual({ kind: 'knowledge', nav: { tab: 'review' } });
});

it('preserves newer ordinary navigation while the origin lookup is still pending', async () => {
  render(<RunDetailPanel detail={detail()} onClose={() => {}} />);
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
  let finish!: (origin: ipc.RunOrigin) => void;
  vi.mocked(ipc.fleetRunOrigin).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByTestId('run-detail-page'));
  act(() => useNavStore.getState().navigate({ kind: 'settings' }));
  await act(async () => finish({ kind: 'registered', vault: '/other' }));
  expect(useVaultStore.getState().vaultPath).toBe('/active');
  expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
  expect(hasPendingLeaveIntent(`pane:${useNavStore.getState().active}`)).toBe(false);
});

it.each(['replace', 'close', 'unmount'])(
  'invalidates a resolving link on %s even when the vault identity is unchanged',
  async (ending) => {
    const view = render(
      <RunDetailPanel detail={detail('active')} onClose={() => view.unmount()} />,
    );
    await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
    let finish!: (origin: ipc.RunOrigin) => void;
    vi.mocked(ipc.fleetRunOrigin).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByTestId('run-detail-page'));
    if (ending === 'replace') {
      const next = detail('active');
      next.run.run_id = 'second-run';
      view.rerender(<RunDetailPanel detail={next} onClose={() => {}} />);
    } else if (ending === 'close') fireEvent.click(screen.getByTestId('run-detail-close'));
    else view.unmount();
    await act(async () => finish({ kind: 'registered', vault: '/active' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  },
);

it('cancels an actual vault switch still waiting for a save after the detail closes', async () => {
  const held = heldOwner();
  const view = render(<RunDetailPanel detail={detail()} onClose={() => view.unmount()} />);
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
  fireEvent.click(screen.getByTestId('run-detail-page'));
  await waitFor(() => expect(held.writer).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByTestId('run-detail-close'));
  await act(async () => held.release());
  expect(useVaultStore.getState().vaultPath).toBe('/active');
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
});

it('cancels same-vault navigation still waiting for a save after the detail closes', async () => {
  const held = heldOwner();
  const view = render(<RunDetailPanel detail={detail('active')} onClose={() => view.unmount()} />);
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
  fireEvent.click(screen.getByTestId('run-detail-to-review'));
  await waitFor(() => expect(held.writer).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByTestId('run-detail-close'));
  await act(async () => held.release());
  expect(useVaultStore.getState().vaultPath).toBe('/active');
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
});

it('preserves a newer ordinary navigation queued behind the same save', async () => {
  const held = heldOwner();
  render(<RunDetailPanel detail={detail('active')} onClose={() => {}} />);
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
  fireEvent.click(screen.getByTestId('run-detail-to-review'));
  await waitFor(() => expect(held.writer).toHaveBeenCalledOnce());
  useNavStore.getState().navigate({ kind: 'settings' });
  await act(async () => held.release());
  expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
});

it('finishes its own accepted switch when that switch retires the source host', async () => {
  rememberLastPlace('/other', { kind: 'settings' });
  const original = ipc.scanVault;
  let finishScan!: (entries: Awaited<ReturnType<typeof ipc.scanVault>>) => void;
  vi.spyOn(ipc, 'scanVault').mockImplementation((vault) =>
    vault === '/other'
      ? new Promise((resolve) => {
          finishScan = resolve;
        })
      : original(vault),
  );
  function Host() {
    const pane = useNavStore((state) => state.active);
    const vault = useVaultStore((state) => state.vaultPath);
    return vault === '/active' ? (
      <PaneContext.Provider value={pane}>
        <RunDetailPanel detail={detail()} onClose={() => {}} />
      </PaneContext.Provider>
    ) : (
      <p>Destination host</p>
    );
  }
  render(
    <>
      <PaneLayoutHost />
      <Host />
    </>,
  );
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
  fireEvent.click(screen.getByTestId('run-detail-page'));
  expect(await screen.findByText('Destination host')).toBeTruthy();
  expect(screen.queryByTestId('run-detail')).toBeNull();
  await act(async () => finishScan([]));
  await waitFor(() =>
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/destination.md' }),
  );
  expect(useVaultStore.getState().vaultPath).toBe('/other');
});

it('does not let an already canceled open request supersede a valid request awaiting save', async () => {
  const held = heldOwner();
  const valid = useVaultStore.getState().openVault('/other', { stillCurrent: () => true });
  await waitFor(() => expect(held.writer).toHaveBeenCalledOnce());
  const canceled = useVaultStore.getState().openVault('/canceled', { stillCurrent: () => false });
  held.release();
  await Promise.all([valid, canceled]);
  expect(useVaultStore.getState().vaultPath).toBe('/other');
});

it('does not let an accepted cross-vault handoff overwrite newer navigation during its scan', async () => {
  const original = ipc.scanVault;
  let finishScan!: (entries: Awaited<ReturnType<typeof ipc.scanVault>>) => void;
  vi.spyOn(ipc, 'scanVault').mockImplementation((vault) =>
    vault === '/other'
      ? new Promise((resolve) => {
          finishScan = resolve;
        })
      : original(vault),
  );
  function Host() {
    const pane = useNavStore((state) => state.active);
    const vault = useVaultStore((state) => state.vaultPath);
    return vault === '/active' ? (
      <PaneContext.Provider value={pane}>
        <RunDetailPanel detail={detail()} onClose={() => {}} />
      </PaneContext.Provider>
    ) : (
      <p>Destination host</p>
    );
  }
  render(
    <>
      <PaneLayoutHost />
      <Host />
    </>,
  );
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
  fireEvent.click(screen.getByTestId('run-detail-page'));
  expect(await screen.findByText('Destination host')).toBeTruthy();
  act(() => useNavStore.getState().navigate({ kind: 'settings' }));
  expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
  await act(async () => finishScan([]));
  expect(useVaultStore.getState().vaultPath).toBe('/other');
  expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
});

it('does not let an older cross-vault activation beat ordinary navigation queued behind its save', async () => {
  const held = heldOwner();
  function Host() {
    const pane = useNavStore((state) => state.active);
    const vault = useVaultStore((state) => state.vaultPath);
    const selection = useNavStore((state) => state.selection);
    return vault === '/active' && selection.kind === 'home' ? (
      <PaneContext.Provider value={pane}>
        <RunDetailPanel detail={detail()} onClose={() => {}} />
      </PaneContext.Provider>
    ) : (
      <p>Destination host</p>
    );
  }
  render(
    <>
      <PaneLayoutHost />
      <Host />
    </>,
  );
  await waitFor(() => expect(screen.queryByText('Resolving origin…')).toBeNull());
  fireEvent.click(screen.getByTestId('run-detail-page'));
  await waitFor(() => expect(held.writer).toHaveBeenCalledOnce());
  act(() => useNavStore.getState().navigate({ kind: 'settings' }));
  await act(async () => held.release());
  await waitFor(() => expect(useVaultStore.getState().status).toBe('ready'));
  expect.soft(useVaultStore.getState().vaultPath).toBe('/active');
  expect.soft(useNavStore.getState().selection).toEqual({ kind: 'settings' });
});
