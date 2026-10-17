import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { resetMockRoots, seedRoot } from '@/lib/mockRoots';
import { seedBytes } from '@/lib/mockBytes';
import { DocViewer } from './DocViewer';

beforeEach(resetMockRoots);
it('renders contained relative and percent-decoded images and names missing images', async () => {
  const root = seedRoot({ path: '/repo', label: 'repo' });
  seedBytes(root.id, 'images/a b.png', { bytes: [1, 2] });
  render(
    <DocViewer
      rootId={root.id}
      path="docs/readme.md"
      content={'![Logo](../images/a%20b.png)\n\n![Missing](/missing.png)'}
    />,
  );
  expect((await screen.findByRole('img', { name: 'Logo' })).getAttribute('src')).toBe(
    'data:image/png;base64,AQI=',
  );
  expect((await screen.findByRole('status')).textContent).toContain(
    'Image unavailable: missing.png',
  );
});
it('never auto-loads remote images or a root escape', () => {
  render(
    <DocViewer
      rootId="0"
      path="readme.md"
      content={'![Remote](https://example.com/pixel.png)\n\n![Outside](../secret.png)'}
    />,
  );
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByText('example.com')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load image' }));
  expect(screen.getByRole('img', { name: 'Remote' }).getAttribute('referrerpolicy')).toBe(
    'no-referrer',
  );
  expect(screen.getByText('Image unavailable: Outside')).toBeTruthy();
});
