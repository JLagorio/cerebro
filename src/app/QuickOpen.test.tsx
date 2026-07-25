import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuickOpen } from '@/app/QuickOpen';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { fixtureVault } from '@/test/factories';

afterEach(cleanup);

describe('QuickOpen', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ quickOpenVisible: true });
  });

  it('ranks an exact title prefix above a mid-title match', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText('Search items, projects, and spaces…'), 'field');
    const options = screen.getAllByRole('option');
    // 'Field platform' (prefix match) must outrank 'Wire field sync banner' (substring match)
    expect(options[0].textContent).toContain('Field platform');
    expect(options.length).toBeGreaterThanOrEqual(2);
  });

  it('Enter navigates to the top result and closes the palette', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(
      screen.getByPlaceholderText('Search items, projects, and spaces…'),
      'field{Enter}',
    );
    expect(useNavStore.getState().selection).toEqual({ kind: 'space', path: 'spaces/field-platform.md' });
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  it('picking an item opens its detail and navigates to its project', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText('Search items, projects, and spaces…'), 'wire');
    await user.click(screen.getAllByRole('option')[0]);
    expect(useNavStore.getState().selection).toEqual({ kind: 'project', path: 'projects/onboarding.md' });
    expect(useUiStore.getState().detailPath).toBe('items/fld-2.md');
  });
});
