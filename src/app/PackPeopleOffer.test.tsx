import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { PackPeopleOffer } from './PackPeopleOffer';
const install = vi.hoisted(() => vi.fn());
vi.mock('./packActions', () => ({ installPack: install }));
beforeEach(() => {
  install.mockReset().mockResolvedValue(true);
  useVaultStore.setState({ entries: [] });
});
it('previews type creates and installs only on click', async () => {
  render(<PackPeopleOffer />);
  expect(screen.getByTestId('pack-people').textContent).toContain('Creates types/company.md.');
  expect(install).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Install' })));
  expect(install).toHaveBeenCalledOnce();
});
it('explains an occupied target and offers no partial installation', () => {
  useVaultStore.setState({ entries: [makeEntry({ path: 'types/company.md' })] });
  render(<PackPeopleOffer />);
  expect(screen.getByTestId('pack-people').textContent).toContain('already holds a page');
  expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
});
