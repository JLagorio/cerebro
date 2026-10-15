import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import * as roots from '@/lib/rootsIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { renderMermaid } from '@/mermaid/render';
import { DiagramFace, ImageFace } from './faces';
import { resetFileTextCache } from './useFileText';
vi.mock('@/mermaid/render', () => ({ renderMermaid: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFileTextCache();
});
it('a diagram uses raw source and the shared renderer in an inert fitted face', async () => {
  useVaultStore.setState({ vaultPath: '/vault' });
  vi.spyOn(ipc, 'readNote').mockResolvedValue('flowchart LR\n A-->B');
  vi.mocked(renderMermaid).mockResolvedValue({
    ok: true,
    svg: '<svg id="cerebro-mermaid-fixture" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><text x="10" y="30">A to B</text></svg>',
  });
  render(<DiagramFace path="a.mmd" hash="one" />);
  await screen.findByText('A to B');
  expect(renderMermaid).toHaveBeenCalledWith('flowchart LR\n A-->B');
  expect(screen.getByTestId('whiteboard-diagram').className).toContain('pointer-events-none');
});
it('an unavailable image keeps the exact raw path and uses the vault bytes door', async () => {
  useVaultStore.setState({ vaultPath: '/vault' });
  vi.spyOn(roots, 'fileUrl').mockResolvedValue({ code: 'not_found', message: 'File not found' });
  render(<ImageFace path="attachments/gone.png" />);
  expect(await screen.findByTestId('file-image-unavailable')).toBeTruthy();
  expect(screen.getByText('Image unavailable: attachments/gone.png')).toBeTruthy();
  expect(roots.fileUrl).toHaveBeenCalledWith('0', 'attachments/gone.png');
});
