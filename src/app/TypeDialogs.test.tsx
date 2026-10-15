import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeEntry } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { TypeListing } from '@/engine/typeCatalog';

vi.mock('./typeActions', async (original) => ({
  ...(await original<typeof import('./typeActions')>()),
  renameDatabase: vi.fn(),
}));

import { renameDatabase } from './typeActions';
import { RenameTypeDialog } from './TypeDialogs';

const listing: TypeListing = {
  name: 'Recipe',
  icon: 'file-text',
  color: null,
  count: 2,
  system: false,
  docPath: 'types/recipe.md',
};

beforeEach(() => {
  vi.clearAllMocks();
  useVaultStore.setState({
    entries: [makeEntry({ path: 'types/recipe.md', type: 'Type', title: 'Recipe' })],
  });
  useNavStore.setState({ selection: { kind: 'type', name: 'Recipe' } });
});

describe('the database rename dialog', () => {
  it('closes and follows the renamed database only after the batch succeeds', async () => {
    let finish!: (applied: boolean) => void;
    vi.mocked(renameDatabase).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const close = vi.fn();
    render(<RenameTypeDialog listing={listing} onClose={close} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Dish' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(renameDatabase).toHaveBeenCalledWith(listing, 'Dish');
    expect(close).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    finish(true);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Dish' });
  });

  it('keeps the draft open and retryable after a refusal', async () => {
    vi.mocked(renameDatabase).mockResolvedValue(false);
    const close = vi.fn();
    render(<RenameTypeDialog listing={listing} onClose={close} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Dish' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(close).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement).value).toBe(
      'Dish',
    );
    expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Recipe' });
  });

  it('does not navigate away from another page after a successful rename', async () => {
    vi.mocked(renameDatabase).mockResolvedValue(true);
    useNavStore.setState({ selection: { kind: 'home' } });
    const close = vi.fn();
    render(<RenameTypeDialog listing={listing} onClose={close} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Dish' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });
});
