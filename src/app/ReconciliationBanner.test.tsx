import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReconciliationBanner } from './ReconciliationBanner';
import { __seedLedger } from '@/lib/mockIpc';
import type { QuarantinedPath } from '@/lib/ipc';
import { useLedgerStore } from '@/stores/ledgerStore';

const VAULT = '/vault';
const edited: QuarantinedPath = {
  path: 'knowledge/metrics/churn.md',
  class: 'adoptable',
  reason: 'edited outside Cerebro',
};
const forged: QuarantinedPath = {
  path: 'knowledge/decisions/gcs-5.md',
  class: 'refused',
  reason: 'provenance forgery: the verified stamp changed out of band — refused',
};

async function seed(quarantined: QuarantinedPath[], stopped = false) {
  __seedLedger({ quarantined, stopped });
  await act(() => useLedgerStore.getState().refresh(VAULT));
}

beforeEach(() => useLedgerStore.setState({ vault: null, read: { kind: 'unread' } }));
afterEach(() => {
  cleanup();
  __seedLedger(null);
});

describe('ReconciliationBanner (M49.6)', () => {
  it('names every quarantined file and why — the banner used to say "(1 unresolved)"', async () => {
    await seed([edited, forged]);
    render(<ReconciliationBanner vault={VAULT} />);
    const banner = screen.getByTestId('reconciliation-banner');
    expect(banner.textContent).toContain('2 knowledge files differ from their recorded history.');
    expect(banner.textContent).toContain('the rest of the vault keeps recording');
    const rows = within(screen.getByTestId('quarantine-list')).getAllByRole('listitem');
    expect(rows.map((r) => r.dataset.path)).toEqual([edited.path, forged.path]);
    // Keep is offered only where it can work; the refusal reason is shown.
    expect(within(rows[0]).queryByRole('button', { name: 'Keep' })).not.toBeNull();
    expect(within(rows[1]).queryByRole('button', { name: 'Keep' })).toBeNull();
    expect(rows[1].textContent).toContain('provenance forgery');
  });

  it('Keep on one file records it, and the banner goes once nothing is left', async () => {
    await seed([edited]);
    render(<ReconciliationBanner vault={VAULT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByTestId('reconciliation-banner')).toBeNull());
  });

  it('Keep-all keeps what it can and shows the real refusal for the rest', async () => {
    await seed([edited, forged]);
    render(<ReconciliationBanner vault={VAULT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep all' }));
    const error = await screen.findByTestId('reconciliation-error');
    expect(error.textContent).toContain('kept 1 of 2 files');
    expect(error.textContent).toContain(`${forged.path}: provenance forgery`);
    await waitFor(() => {
      const rows = within(screen.getByTestId('quarantine-list')).getAllByRole('listitem');
      expect(rows.map((r) => r.dataset.path)).toEqual([forged.path]);
    });
  });

  it('offers only the per-file exits while no divergence is recorded', async () => {
    // A file can be quarantined before any scan recorded it; the vault-wide
    // exits resolve a recorded divergence and would only refuse.
    __seedLedger({ quarantined: [edited], open: false });
    await act(() => useLedgerStore.getState().refresh(VAULT));
    render(<ReconciliationBanner vault={VAULT} />);
    expect(screen.getByRole('button', { name: 'Keep' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep my files' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore recorded history' })).toBeNull();
  });

  it('Restore asks first, then restores', async () => {
    await seed([forged]);
    render(<ReconciliationBanner vault={VAULT} />);
    const row = within(screen.getByTestId('quarantine-list')).getByRole('listitem');
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }));
    expect(screen.getByTestId('reconciliation-banner')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm restore' }));
    await waitFor(() => expect(screen.queryByTestId('reconciliation-banner')).toBeNull());
  });

  it('says when recording is paused for the whole vault', async () => {
    await seed([edited], true);
    render(<ReconciliationBanner vault={VAULT} />);
    const banner = screen.getByTestId('reconciliation-banner');
    expect(banner.dataset.stopped).toBe('true');
    expect(banner.textContent).toContain('recording is paused for the whole vault');
  });

  // Measured 2026-09-28: a window recording another vault listed Keep and
  // Restore on every file, and each refused with ledger_writer_unavailable.
  it('offers no exit while this window is not recording the vault — each would refuse', async () => {
    __seedLedger({
      quarantined: [edited],
      writer: { state: 'other-vault', detail: 'recording /demo instead' },
    });
    await act(() => useLedgerStore.getState().refresh(VAULT));
    render(<ReconciliationBanner vault={VAULT} />);
    const banner = screen.getByTestId('reconciliation-banner');
    expect(banner.textContent).toContain(edited.path);
    expect(within(banner).queryAllByRole('button')).toEqual([]);
    expect(screen.getByTestId('reconciliation-not-recording')).toBeTruthy();
  });

  it('renders nothing for a vault whose files all match', async () => {
    await seed([]);
    render(<ReconciliationBanner vault={VAULT} />);
    expect(screen.queryByTestId('reconciliation-banner')).toBeNull();
  });
});
