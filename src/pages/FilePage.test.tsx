import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { seedBytes, reset as resetBytes } from '@/lib/mockBytes';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore, layoutOf } from '@/stores/navStore';
import { missingFiles } from '@/app/filePresence';
import { rememberLastPlace, readLastPlace } from '@/app/lastPlace';
import { readPaneLayout, writePaneLayout } from '@/app/paneLayoutPersistence';
import { FilePage } from './FilePage';

beforeEach(() => {
  resetBytes();
  localStorage.clear();
  useNavStore.getState().reset();
  useVaultStore.setState({ vaultPath: '/file-page-test', entries: [] });
});
it('draws a vault file with a title, crumb and desktop actions without a scanned entry', async () => {
  seedBytes('0', 'attachments/readme.txt', { text: 'An attached document' });
  render(<FilePage selection={{ kind: 'file', path: 'attachments/readme.txt' }} />);
  expect(screen.getByRole('heading', { name: 'readme.txt' })).toBeTruthy();
  expect(screen.getByTestId('file-crumb').textContent).toBe('attachments');
  expect((await screen.findByTestId('code-viewer')).textContent).toContain('An attached document');
  expect(screen.getByTestId('file-actions').textContent).toContain('Reveal in Finder');
  expect(missingFiles('/file-page-test')).not.toContain('attachments/readme.txt');
});
it('keeps an unscanned place until the byte probe proves it missing, then drops saved visits', async () => {
  const selection = { kind: 'file', path: 'attachments/gone.pdf' } as const;
  useNavStore.getState().navigate(selection);
  rememberLastPlace('/file-page-test', selection);
  writePaneLayout('/file-page-test', layoutOf(useNavStore.getState()));
  expect(readLastPlace('/file-page-test')).toEqual(selection);
  render(<FilePage selection={selection} />);
  expect(await screen.findByTestId('viewer-not-found')).toBeTruthy();
  await waitFor(() => expect(missingFiles('/file-page-test')).toContain(selection.path));
  expect(readLastPlace('/file-page-test')).toBeNull();
  expect(
    readPaneLayout('/file-page-test')?.panes.flatMap((pane) => pane.entries),
  ).not.toContainEqual(selection);
});
