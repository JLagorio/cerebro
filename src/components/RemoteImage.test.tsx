import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { clearRemoteImages } from '@/lib/remoteImages';
import { RemoteImage } from './RemoteImage';
beforeEach(clearRemoteImages);
it('draws no img until Load and sends no referrer', () => {
  render(<RemoteImage src="https://images.example/a.png" alt="Photo" />);
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByText('images.example')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load image' }));
  const image = screen.getByRole('img', { name: 'Photo' });
  expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(image.getAttribute('loading')).toBe('lazy');
  expect(image.getAttribute('draggable')).toBe('false');
  fireEvent.error(image);
  expect(screen.getByText("This image couldn't be loaded.")).toBeTruthy();
});
it.each(['http://images.example/a.png', '//images.example/a.png'])(
  'refuses insecure %s without a button',
  (src) => {
    render(<RemoteImage src={src} />);
    expect(screen.getByText('HTTP images are not allowed.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  },
);
it('draws embedded data immediately', () => {
  render(<RemoteImage src="data:image/png;base64,AQI=" alt="Embedded" />);
  expect(screen.getByRole('img', { name: 'Embedded' })).toBeTruthy();
});
