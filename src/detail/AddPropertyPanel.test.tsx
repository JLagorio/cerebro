import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import { resetLayers } from '@/components/ui/layers';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

afterEach(cleanup);

/**
 * The dismissal this surface shipped without (M16.1).
 *
 * "Clicking away from the add-property menu doesn't close it. I'm forced to
 * press cancel." It had no scrim, no dialog role and no document listener,
 * so Cancel was the only mouse exit — and Escape from anywhere but the name
 * input bubbled to the record panel's global handler and closed the panel.
 */
describe('AddPropertyPanel dismissal', () => {
  beforeEach(() => {
    resetLayers();
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });

  function setup() {
    const onCancel = vi.fn();
    const onAdd = vi.fn();
    render(
      <div>
        <button type="button" data-testid="elsewhere">
          elsewhere
        </button>
        <AddPropertyPanel ownerType="Work item" onAdd={onAdd} onCancel={onCancel} />
      </div>,
    );
    return { onCancel, onAdd };
  }

  it('closes when a press lands outside it', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByTestId('elsewhere'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('stays open when a press lands inside it', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByPlaceholderText('Property name'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('closes on Escape from the name input', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByPlaceholderText('Property name'));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  // The reported bug: focus on a kind tile, not the input, meant Escape was
  // unhandled here and taken by the record panel instead.
  it('closes on Escape with focus on a kind tile', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    screen.getByTestId('property-kind-select').focus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('keeps Escape away from a global listener behind it', async () => {
    const user = userEvent.setup();
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    try {
      setup();
      screen.getByTestId('property-kind-select').focus();
      behind.mockClear();
      await user.keyboard('{Escape}');
      expect(behind).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });

  it('steps Escape back out of relation config instead of discarding it', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByTestId('property-kind-relation'));
    expect(screen.getByTestId('add-relation-panel')).toBeTruthy();

    await user.keyboard('{Escape}');
    // Back to the catalog, and the surface itself is still open.
    expect(screen.getByTestId('add-property-panel')).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('closes outright on a press outside the relation step', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByTestId('property-kind-relation'));
    await user.click(screen.getByTestId('elsewhere'));
    expect(onCancel).toHaveBeenCalled();
  });
});
