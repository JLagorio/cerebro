// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyMockVault, resetMockFs } from '@/lib/mockIpc';
import { SHIPPED_RECIPES } from '@/lib/recipes';
import { useVaultStore } from '@/stores/vaultStore';
import { RecipesOffer } from './RecipesOffer';
beforeEach(async () => {
  emptyMockVault();
  await useVaultStore.getState().openVault('/demo-vault');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetMockFs();
});
it('names the missing recipes, adds all missing recipes, and disappears', async () => {
  render(<RecipesOffer />);
  expect(screen.getByTestId('recipes-offer').textContent).toContain(
    'Catch me up, Draft reply, What I did',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add recipes' }));
  await waitFor(() => expect(screen.queryByTestId('recipes-offer')).toBeNull());
  expect(
    useVaultStore
      .getState()
      .entries.map((e) => e.path)
      .sort(),
  ).toEqual(SHIPPED_RECIPES.map((r) => r.path));
});
it('stays when a batch is refused and disables its button while waiting', async () => {
  let finish!: () => void;
  const batch = vi.spyOn(useVaultStore.getState(), 'applyBatch').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(null);
      }),
  );
  render(<RecipesOffer />);
  const button = screen.getByRole('button', { name: 'Add recipes' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(batch).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
  });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByTestId('recipes-offer')).toBeTruthy();
});
it('hides until this vault’s scan lands, and names a failed read', async () => {
  useVaultStore.setState({ entriesVault: '/other' });
  const { rerender } = render(<RecipesOffer />);
  expect(screen.queryByTestId('recipes-offer')).toBeNull();
  await act(async () => {
    useVaultStore.setState({ status: 'error' });
  });
  rerender(<RecipesOffer />);
  expect(screen.getByTestId('section-unavailable').textContent).toContain(
    'The library could not be read.',
  );
  expect(screen.queryByRole('button', { name: 'Add recipes' })).toBeNull();
});
it('counts a page at the shipped path even without a slug', async () => {
  (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.set(
    SHIPPED_RECIPES[0].path,
    '# Mine\n',
  );
  await useVaultStore.getState().rescan();
  render(<RecipesOffer />);
  expect(screen.getByTestId('recipes-offer').textContent).toContain('What I did');
  expect(screen.getByTestId('recipes-offer').textContent).not.toContain('Catch me up');
  expect(screen.getByRole('button', { name: /^Add recipes$/ })).toBeTruthy();
});
