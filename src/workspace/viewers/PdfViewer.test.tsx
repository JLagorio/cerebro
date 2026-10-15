import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IS_MAC } from '@/lib/keys/combo';
import type { FileProbe } from '@/engine/fileBytes';
import type { PdfDocument, PdfViewEvents } from './pdf/pdfjs';
import { PdfViewer } from './PdfViewer';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  open: vi.fn(),
  text: vi.fn(),
  mount: vi.fn(),
  outside: vi.fn(),
  desktop: vi.fn(),
  view: { page: vi.fn(), scale: vi.fn(), find: vi.fn(), closeFind: vi.fn(), destroy: vi.fn() },
}));
vi.mock('./pdf/pdfjs', () => ({
  openPdf: mocks.open,
  hasTextLayer: mocks.text,
  mountPdfView: mocks.mount,
}));
vi.mock('@/lib/rootsIpc', () => ({
  readFileBytes: mocks.read,
  openFileOutside: mocks.outside,
  desktopFileActions: mocks.desktop,
}));
const probe: FileProbe = {
  size: 100,
  mime: 'application/pdf',
  kind: 'pdf',
  door: 'ipc',
  sniff: 'binary',
  open: 'allow',
};
let doc: PdfDocument;
let events: PdfViewEvents;
beforeEach(() => {
  vi.clearAllMocks();
  doc = {
    numPages: 40,
    destroy: vi.fn(async () => {}),
    getOutline: async () => [{ title: 'Results', dest: [19, 'Fit'], items: [] }],
  } as unknown as PdfDocument;
  mocks.read.mockResolvedValue(new Uint8Array([1]));
  mocks.open.mockResolvedValue({ ok: true, doc });
  mocks.text.mockResolvedValue(true);
  mocks.mount.mockImplementation(async (_container, _doc, callbacks: PdfViewEvents) => {
    events = callbacks;
    return mocks.view;
  });
  mocks.desktop.mockReturnValue(false);
  mocks.outside.mockResolvedValue({ state: 'opened' });
});
const show = () => render(<PdfViewer rootId="0" path="report.pdf" probe={probe} />);
async function loaded() {
  await screen.findByRole('textbox', { name: 'PDF page' });
  await waitFor(() => expect(mocks.mount).toHaveBeenCalled());
}
it.each(['encrypted', 'corrupt', 'engine'] as const)(
  'names %s without offering broken controls',
  async (reason) => {
    mocks.open.mockResolvedValue({ ok: false, reason });
    show();
    expect(await screen.findByTestId(`pdf-${reason}`)).toBeTruthy();
    expect(screen.queryByRole('toolbar')).toBeNull();
  },
);
it('names loading, failed read and too large; refuses oversized bytes before reading', async () => {
  mocks.read.mockRejectedValue(new Error('read'));
  const mounted = show();
  expect(screen.getByTestId('pdf-loading')).toBeTruthy();
  expect(await screen.findByTestId('pdf-unavailable')).toBeTruthy();
  mounted.unmount();
  mocks.read.mockClear();
  render(<PdfViewer rootId="0" path="huge.pdf" probe={{ ...probe, size: 70 * 1024 * 1024 }} />);
  expect(await screen.findByTestId('pdf-too-large')).toBeTruthy();
  expect(mocks.read).not.toHaveBeenCalled();
});
it('jumps by outline and page input, clamps, zooms, and destroys both view and document', async () => {
  const mounted = show();
  await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Outline' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Results' }));
  expect(mocks.view.page).toHaveBeenLastCalledWith(20);
  const input = screen.getByRole('textbox', { name: 'PDF page' });
  fireEvent.change(input, { target: { value: '99' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(mocks.view.page).toHaveBeenLastCalledWith(40);
  fireEvent.change(input, { target: { value: '12' } });
  fireEvent.blur(input);
  expect(mocks.view.page).toHaveBeenLastCalledWith(12);
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(mocks.view.scale).toHaveBeenLastCalledWith(1.1);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'page-fit' } });
  expect(mocks.view.scale).toHaveBeenLastCalledWith('page-fit');
  mounted.unmount();
  expect(mocks.view.destroy).toHaveBeenCalledOnce();
  expect(doc.destroy).toHaveBeenCalledOnce();
});
it('finds literal text, steps both ways, and Escape closes only the search bar', async () => {
  show();
  await loaded();
  const pages = screen.getByRole('generic', { name: 'PDF pages' });
  pages.focus();
  fireEvent.keyDown(pages, { key: 'f', metaKey: IS_MAC, ctrlKey: !IS_MAC });
  const input = await screen.findByRole('textbox', { name: 'Find in PDF' });
  fireEvent.change(input, { target: { value: 'a.*' } });
  expect(mocks.view.find).toHaveBeenLastCalledWith('a.*');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(mocks.view.find).toHaveBeenLastCalledWith('a.*', true, false);
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  expect(mocks.view.find).toHaveBeenLastCalledWith('a.*', true, true);
  act(() => events.matches({ current: 2, total: 40 }));
  expect(screen.getByText('2 of 40')).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('search')).toBeNull();
  expect(screen.getByTestId('pdf-viewer')).toBeTruthy();
  expect(mocks.view.closeFind).toHaveBeenCalledOnce();
});
it('says no text, lists failed pages, and distinguishes a failed text check', async () => {
  mocks.text.mockResolvedValue(false);
  const mounted = show();
  await loaded();
  expect(await screen.findByText(/has no text layer/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Find' }));
  expect(screen.getByText('No text to search')).toBeTruthy();
  act(() => events.failed(3));
  expect(screen.getByText('Could not draw page 3.')).toBeTruthy();
  mounted.unmount();
  mocks.text.mockRejectedValue(new Error('text'));
  show();
  await loaded();
  expect(await screen.findByText(/Could not check/)).toBeTruthy();
  expect(screen.queryByText(/has no text layer/)).toBeNull();
});
it('Print is browser-disabled and hands the original file to the desktop app', async () => {
  const mounted = show();
  await loaded();
  expect(screen.getByRole('button', { name: 'Print…' })).toHaveProperty('disabled', true);
  mounted.unmount();
  mocks.desktop.mockReturnValue(true);
  show();
  await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
  await waitFor(() => expect(mocks.outside).toHaveBeenCalledWith('0', 'report.pdf'));
});

it('a rejected document cleanup after navigation is handled', async () => {
  vi.mocked(doc.destroy).mockRejectedValue(new Error('worker already closed'));
  const mounted = show();
  await loaded();
  mounted.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(doc.destroy).toHaveBeenCalledOnce();
});
