// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOpenLogStore } from '@/stores/openLogStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { RecentlyOpenedSettings } from './RecentlyOpenedSettings';
import { keycapText } from '@/components/ui/Keycaps';

afterEach(cleanup);

/** Local noon on a day, so the shown local date is that day in any zone. */
const localNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

const rows = () => screen.queryAllByTestId('open-log-row').map((r) => r.textContent ?? '');

describe('RecentlyOpenedSettings (M59.3)', () => {
  beforeEach(() => {
    useOpenLogStore.setState({ logs: {}, saved: true });
    useVaultStore.setState({
      vaultPath: '/v',
      entriesVault: '/v',
      status: 'ready',
      entries: [
        makeEntry({ path: 'notes/plan.md', title: 'Plan' }),
        makeEntry({ path: 'notes/retro.md', title: 'Retro' }),
      ],
    });
  });

  it('lists this vault’s opens in log order, with the count and the last date', () => {
    const { record } = useOpenLogStore.getState();
    record('/v', 'notes/plan.md', localNoon(2026, 10, 1));
    record('/v', 'notes/plan.md', localNoon(2026, 10, 3));
    record('/v', 'notes/retro.md', localNoon(2026, 10, 12));
    record('/w', 'elsewhere.md', localNoon(2026, 10, 13));
    render(<RecentlyOpenedSettings />);
    expect(rows()).toEqual([
      expect.stringMatching(/^Retro.*notes\/retro\.md.*opened 1 time · last 2026-10-12.*Forget$/),
      expect.stringMatching(/^Plan.*notes\/plan\.md.*opened 2 times · last 2026-10-03.*Forget$/),
    ]);
  });

  it('Forget drops one page, and Clear empties the log', () => {
    const { record } = useOpenLogStore.getState();
    record('/v', 'notes/plan.md');
    record('/v', 'notes/retro.md');
    render(<RecentlyOpenedSettings />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0]);
    expect(rows()).toEqual([expect.stringContaining('Plan')]);
    fireEvent.click(screen.getByTestId('open-log-clear'));
    expect(rows()).toEqual([]);
    expect(screen.getByText('Nothing opened yet.')).toBeTruthy();
    expect(useOpenLogStore.getState().logs).toEqual({});
  });

  it('says nothing has been opened yet', () => {
    render(<RecentlyOpenedSettings />);
    expect(screen.getByText('Nothing opened yet.')).toBeTruthy();
    expect(screen.queryByTestId('open-log-clear')).toBeNull();
  });

  it('says when the log cannot be saved on this Mac', () => {
    useOpenLogStore.setState({ saved: false });
    render(<RecentlyOpenedSettings />);
    expect(screen.getByText('Not saved on this Mac — storage is unavailable.')).toBeTruthy();
  });

  it('shows a missing page by its path until a ready snapshot prunes it', () => {
    useOpenLogStore.getState().record('/v', 'notes/gone.md');
    useVaultStore.setState({ status: 'scanning' });
    render(<RecentlyOpenedSettings />);
    expect(rows()).toEqual([expect.stringMatching(/^notes\/gone\.mdnotes\/gone\.md/)]);
    cleanup();
    useVaultStore.setState({ status: 'ready' });
    render(<RecentlyOpenedSettings />);
    expect(rows()).toEqual([]);
  });

  it('says what is kept, and that agents never count', () => {
    render(<RecentlyOpenedSettings />);
    expect(screen.getByTestId('settings-recently-opened').textContent).toContain(
      `Pages you open yourself, kept for this vault on this Mac to rank ${keycapText('palette.open')} and the pickers. An agent's opens never count, and nothing is written to the vault.`,
    );
  });
});
