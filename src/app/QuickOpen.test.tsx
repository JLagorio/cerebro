import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuickOpen } from '@/app/QuickOpen';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { fixtureVault } from '@/test/factories';

afterEach(cleanup);

const PLACEHOLDER = 'Search items, projects, and docs…';

describe('QuickOpen', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ quickOpenVisible: true });
  });

  it('ranks an exact title prefix above a mid-title match', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'guided');
    const options = screen.getAllByRole('option');
    // 'Guided onboarding' (prefix match) must rank first
    expect(options[0].textContent).toContain('Guided onboarding');
  });

  it('Enter navigates to the top result and closes the palette', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'guided{Enter}');
    expect(useNavStore.getState().selection).toEqual({
      kind: 'project',
      path: 'projects/onboarding/project.md',
    });
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  it('picking an item opens its detail and navigates to its containing project', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'wire');
    await user.click(screen.getAllByRole('option')[0]);
    // v2: the owning project comes from Entry.project (containment).
    expect(useNavStore.getState().selection).toEqual({
      kind: 'project',
      path: 'projects/onboarding/project.md',
    });
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/items/fld-2.md');
  });
});
