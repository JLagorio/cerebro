// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AttachmentFilePanel, AttachmentUploadContext } from './AttachmentFilePanel';
import * as ipc from '@/lib/ipc';
const editor = vi.hoisted(() => ({
  isEditable: true,
  getBlock: vi.fn(() => ({ id: 'image' })),
  updateBlock: vi.fn(),
  getExtension: vi.fn(() => ({ closeMenu: vi.fn() })),
}));
vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => editor,
  FilePanel: ({ tabs }: { tabs: { name: string; tabPanel: ReactNode }[] }) => (
    <div>
      {tabs.map((tab) => (
        <section key={tab.name} aria-label={tab.name}>
          {tab.tabPanel}
        </section>
      ))}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
it.each(['attachments/plan.png', 'clips/demo.mp4', 'clips/standup.m4a', 'docs/contract.pdf'])(
  'keeps the filename as the embedded block name for %s',
  (url) => {
    render(<AttachmentFilePanel blockId="image" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'File URL' }), {
      target: { value: ` ${url} ` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Embed' }));
    expect(editor.updateBlock).toHaveBeenLastCalledWith('image', {
      props: { url, name: url.split('/').at(-1) },
    });
  },
);
it('states the cap and captures its placeholder before opening the browser picker', async () => {
  const accept = vi.fn(async () => {});
  const prepare = vi.fn(() => accept);
  render(
    <AttachmentUploadContext.Provider value={prepare}>
      <AttachmentFilePanel blockId="image" />
    </AttachmentUploadContext.Provider>,
  );
  expect(screen.getByText('Copied into attachments/ · up to 50 MB')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Choose files' }));
  expect(prepare).toHaveBeenCalledWith({ id: 'image', replace: true });
  const file = new File(['bytes'], 'image.png');
  fireEvent.change(screen.getByTestId('attachment-upload-input'), { target: { files: [file] } });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(accept).toHaveBeenCalledWith([file]);
});
it('captures the upload owner before a native picker resolves', async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  let finish!: (paths: string[]) => void;
  vi.spyOn(ipc, 'pickFiles').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const accept = vi.fn(async () => {});
  const prepare = vi.fn(() => accept);
  render(
    <AttachmentUploadContext.Provider value={prepare}>
      <AttachmentFilePanel blockId="image" />
    </AttachmentUploadContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose files' }));
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(accept).not.toHaveBeenCalled();
  finish(['/outside/image.png']);
  await waitFor(() => expect(accept).toHaveBeenCalledWith(['/outside/image.png']));
});
