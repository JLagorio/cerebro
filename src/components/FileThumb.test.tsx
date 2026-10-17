import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileThumb } from './FileThumb';
import { useVaultStore } from '@/stores/vaultStore';
import type { Thumbnail } from '@/engine/thumbs';
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/rootsIpc', () => ({ fileThumbnail: read }));
const ready: Thumbnail = {
  state: 'ready',
  dataUrl: 'data:image/png;base64,AQI=',
  width: 1,
  height: 1,
  source: 'fig',
};
beforeEach(() => {
  read.mockReset().mockResolvedValue(ready);
  useVaultStore.setState({ vaultPath: '/one' });
});
afterEach(() => vi.unstubAllGlobals());
describe('FileThumb', () => {
  it('waits until near the viewport, then shows a data URL with the requested fit', async () => {
    let intersect!: IntersectionObserverCallback;
    const observe = vi.fn(),
      disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    render(<FileThumb rootId="0" path="a.fig" size={256} fit="cover" caption />);
    expect(read).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledOnce();
    act(() =>
      intersect(
        [{ isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
    const image = await screen.findByRole('img', { name: 'a.fig' });
    expect(image.getAttribute('src')).toBe(ready.dataUrl);
    expect(image.style.objectFit).toBe('cover');
    expect(screen.getByText('Preview stored in the file')).toBeTruthy();
    expect(disconnect).toHaveBeenCalled();
    fireEvent.error(image);
    expect(screen.getByText("This file couldn't be read")).toBeTruthy();
  });
  it('eager requests bypass the observer and names a missing preview', async () => {
    const observer = vi.fn();
    vi.stubGlobal('IntersectionObserver', observer);
    read.mockResolvedValue({ state: 'none', reason: 'toolMissing' });
    render(<FileThumb rootId="0" path="a.pdf" eager />);
    expect(await screen.findByText('Previews of this kind need Quick Look (macOS)')).toBeTruthy();
    expect(observer).not.toHaveBeenCalled();
    expect(document.querySelector('img')).toBeNull();
  });
  it('drops late results on unmount', async () => {
    let resolve!: (value: Thumbnail) => void;
    read.mockImplementation(
      () =>
        new Promise<Thumbnail>((done) => {
          resolve = done;
        }),
    );
    const mounted = render(<FileThumb rootId="0" path="a.png" eager />);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    mounted.unmount();
    await act(async () => resolve(ready));
    expect(document.querySelector('img')).toBeNull();
  });
  it('an A to B to A visit never reuses an earlier in-flight root-zero result', async () => {
    let resolve!: (value: Thumbnail) => void;
    read
      .mockImplementationOnce(
        () =>
          new Promise<Thumbnail>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({ state: 'none', reason: 'noPreview' });
    render(<FileThumb rootId="0" path="a.png" eager />);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    act(() => {
      useVaultStore.setState({ vaultPath: '/two' });
      useVaultStore.setState({ vaultPath: '/one' });
    });
    expect(await screen.findByText('This file carries no preview')).toBeTruthy();
    await act(async () => resolve(ready));
    expect(document.querySelector('img')).toBeNull();
  });
});
