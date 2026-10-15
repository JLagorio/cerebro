import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fileRefusal } from '@/engine/fileBytes';
import { useVaultStore } from '@/stores/vaultStore';
import { FileImage } from './FileImage';

const fileUrl = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rootsIpc', () => ({ fileUrl }));
beforeEach(() => {
  fileUrl.mockReset();
  useVaultStore.setState({ vaultPath: '/vault/one' });
});
it('uses a contained URL, basename alt, lazy decoding and no draggable URL', async () => {
  fileUrl.mockResolvedValue('data:image/png;base64,AQI=');
  render(<FileImage rootId="r" path="images/a b.png" />);
  const image = await screen.findByRole('img', { name: 'a b.png' });
  expect(fileUrl).toHaveBeenCalledWith('r', 'images/a b.png');
  expect(image.getAttribute('draggable')).toBe('false');
  expect(image.getAttribute('loading')).toBe('lazy');
  expect(image.getAttribute('decoding')).toBe('async');
});
it.each(['refusal', 'transport', 'decode'])(
  'reports %s failure and notifies its fallback owner',
  async (failure) => {
    if (failure === 'transport') fileUrl.mockRejectedValue(new Error('offline'));
    else
      fileUrl.mockResolvedValue(
        failure === 'refusal' ? fileRefusal('not_found') : 'data:image/png;base64,AQI=',
      );
    const onError = vi.fn();
    render(<FileImage rootId="r" path="gone.png" onError={onError} />);
    if (failure === 'decode') fireEvent.error(await screen.findByRole('img'));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Image unavailable: gone.png',
    );
    expect(onError).toHaveBeenCalledOnce();
  },
);
it('drops an old vault response and never shows its URL in the new vault', async () => {
  let first!: (url: string) => void;
  fileUrl
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          first = resolve;
        }),
    )
    .mockResolvedValueOnce('data:image/png;base64,bmV3');
  render(<FileImage rootId="0" path="same.png" />);
  act(() => useVaultStore.setState({ vaultPath: '/vault/two' }));
  await waitFor(() =>
    expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,bmV3'),
  );
  await act(async () => first('data:image/png;base64,b2xk'));
  expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,bmV3');
});
