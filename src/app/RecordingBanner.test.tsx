import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecordingBanner } from './RecordingBanner';
import { ReconciliationBanner } from './ReconciliationBanner';
import * as ipc from '@/lib/ipc';
import type { LedgerStatus, WriterStatus } from '@/lib/ipc';
import { isRecording, useLedgerStore } from '@/stores/ledgerStore';
import { useVaultStore } from '@/stores/vaultStore';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, ledgerStatus: vi.fn() };
});

function status(writer: WriterStatus, extra: Partial<LedgerStatus> = {}): LedgerStatus {
  return {
    verdict: 'valid',
    detail: 'valid',
    head: null,
    seq: 3,
    segments: 1,
    anomalies: 0,
    reconciliation_open: false,
    divergences: [],
    quarantined: [],
    stopped: false,
    history_unreadable: false,
    approved_supersessions: [],
    recorded_human: [],
    writer,
    ...extra,
  };
}

beforeEach(() => {
  useLedgerStore.setState({ vault: null, read: { kind: 'unread' } });
  useVaultStore.setState({ vaultPath: '/vault', status: 'ready', entries: [] });
  vi.mocked(ipc.ledgerStatus).mockReset();
});
afterEach(cleanup);

describe('RecordingBanner (M49.2)', () => {
  it('says nothing while the writer is held, or in the ledgerless browser mock', async () => {
    for (const state of ['held', 'none'] as const) {
      vi.mocked(ipc.ledgerStatus).mockResolvedValueOnce(status({ state, detail: null }));
      const { unmount } = render(<RecordingBanner vault="/vault" />);
      await waitFor(() => expect(useLedgerStore.getState().read.kind).toBe('read'));
      expect(screen.queryByTestId('recording-banner')).toBeNull();
      unmount();
    }
  });

  it('names a lost lock and who holds it', async () => {
    const holder = 'ledger_lock_held: another Cerebro instance … (held by pid 42 · Cerebro 0.1.0)';
    vi.mocked(ipc.ledgerStatus).mockResolvedValue(status({ state: 'lost-lock', detail: holder }));
    render(<RecordingBanner vault="/vault" />);
    const banner = await screen.findByTestId('recording-banner');
    expect(banner.dataset.state).toBe('lost-lock');
    expect(banner.textContent).toContain('Not recording knowledge.');
    expect(banner.textContent).toContain('Another Cerebro window or build');
    expect(banner.textContent).toContain('pid 42');
  });

  it('offers to reopen the vault, which is what starts recording it', async () => {
    vi.mocked(ipc.ledgerStatus).mockResolvedValue(
      status({ state: 'other-vault', detail: 'recording /demo instead' }),
    );
    const real = useVaultStore.getState().openVault;
    const openVault = vi.fn(async () => undefined);
    useVaultStore.setState({ openVault });
    try {
      render(<RecordingBanner vault="/vault" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Reopen vault' }));
      expect(openVault).toHaveBeenCalledWith('/vault');
    } finally {
      useVaultStore.setState({ openVault: real });
    }
  });

  it('a refused history offers no reopen — the startup check would refuse it again', async () => {
    vi.mocked(ipc.ledgerStatus).mockResolvedValue(status({ state: 'refused', detail: 'corrupt' }));
    render(<RecordingBanner vault="/vault" />);
    await screen.findByTestId('recording-banner');
    expect(screen.queryByRole('button', { name: 'Reopen vault' })).toBeNull();
  });

  it('a failed read is said, never rendered as "all is well"', async () => {
    vi.mocked(ipc.ledgerStatus).mockRejectedValue(new Error('ipc down'));
    render(<RecordingBanner vault="/vault" />);
    const banner = await screen.findByTestId('recording-banner');
    expect(banner.dataset.state).toBe('unavailable');
    expect(banner.textContent).toContain('ipc down');
    expect(isRecording('/vault', useLedgerStore.getState())).toBe(false);
  });

  it('re-reads after a rescan, so a mid-session change shows without a relaunch (K14)', async () => {
    vi.mocked(ipc.ledgerStatus).mockResolvedValueOnce(status({ state: 'held', detail: null }));
    render(<RecordingBanner vault="/vault" />);
    await waitFor(() => expect(ipc.ledgerStatus).toHaveBeenCalledTimes(1));
    vi.mocked(ipc.ledgerStatus).mockResolvedValueOnce(
      status({ state: 'refused', detail: 'corrupt' }),
    );
    useVaultStore.setState({ entries: [] });
    expect(await screen.findByTestId('recording-banner')).toBeTruthy();
    expect(ipc.ledgerStatus).toHaveBeenCalledTimes(2);
  });

  it('waits for the vault to be ready — the launch scan runs before that', () => {
    useVaultStore.setState({ status: 'scanning' });
    render(<RecordingBanner vault="/vault" />);
    expect(ipc.ledgerStatus).not.toHaveBeenCalled();
  });

  it('shares its read with the reconciliation banner', async () => {
    vi.mocked(ipc.ledgerStatus).mockResolvedValue(
      status({ state: 'held', detail: null }, { reconciliation_open: true, divergences: ['a'] }),
    );
    render(
      <>
        <RecordingBanner vault="/vault" />
        <ReconciliationBanner vault="/vault" />
      </>,
    );
    expect(await screen.findByTestId('reconciliation-banner')).toBeTruthy();
    expect(ipc.ledgerStatus).toHaveBeenCalledTimes(1);
  });
});

describe('useLedgerStore', () => {
  it('a slow read for the previous vault never lands over the current one', async () => {
    let releaseOld: (s: LedgerStatus) => void = () => undefined;
    vi.mocked(ipc.ledgerStatus)
      .mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve)))
      .mockResolvedValueOnce(status({ state: 'held', detail: null }));
    const old = useLedgerStore.getState().refresh('/old');
    await useLedgerStore.getState().refresh('/vault');
    releaseOld(status({ state: 'lost-lock', detail: 'x' }));
    await old;
    expect(useLedgerStore.getState().vault).toBe('/vault');
    expect(isRecording('/vault', useLedgerStore.getState())).toBe(true);
  });
});
