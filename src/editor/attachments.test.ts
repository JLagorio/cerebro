// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import {
  addAttachments,
  anchorAt,
  importSources,
  pastedFiles,
  placeBlocks,
  resolveAttachmentUrl,
} from './attachments';
import * as ipc from '@/lib/ipc';
import * as roots from '@/lib/rootsIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { ATTACHMENT_MAX_BYTES } from '@/engine/attachments';
import { blocksToMarkdownNow } from './markdown';
const state = useVaultStore.getState();
beforeEach(() => {
  useVaultStore.setState({ vaultPath: '/vault', entriesVault: '/vault' });
  useUiStore.setState({ toasts: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  useVaultStore.setState(state);
});
const clipboard = (files: File[], content: Record<string, string> = {}) =>
  ({
    files,
    types: ['Files', ...Object.keys(content)],
    getData: (type: string) => content[type] ?? '',
  }) as unknown as DataTransfer;
const makeEditor = () =>
  BlockNoteEditor.create({
    schema: cerebroSchema,
    initialContent: [
      { type: 'paragraph', content: 'First' },
      { type: 'paragraph', content: 'Second' },
    ],
  }) as CerebroEditor;
const messages = () => useUiStore.getState().toasts.map((toast) => toast.message);
it('takes file payloads only before rich/editor text, and names a nameless blob from the shared MIME table', () => {
  const file = new File(['png'], 'image.png', { type: 'image/png' });
  expect(pastedFiles(clipboard([file]))).toEqual([file]);
  expect(pastedFiles(clipboard([file], { 'text/html': '<img src="x">' }))).toEqual([file]);
  for (const content of [
    { 'text/html': '<table><tr><td>12</td></tr></table>' },
    { 'blocknote/html': '' },
    { 'vscode-editor-data': '' },
  ] as Record<string, string>[])
    expect(pastedFiles(clipboard([file], content))).toEqual([]);
  expect(pastedFiles(clipboard([new File(['png'], '', { type: 'image/png' })]))[0].name).toBe(
    'pasted.png',
  );
  expect(pastedFiles(null)).toEqual([]);
});
it('imports in order, refuses hidden/large files before reading, and keeps one failure from stopping the batch', async () => {
  const path = vi
    .spyOn(ipc, 'importAttachment')
    .mockResolvedValue({ path: 'attachments/path.png', reused: false });
  const bytes = vi
    .spyOn(ipc, 'importAttachmentBytes')
    .mockResolvedValue({ path: 'attachments/file.txt', reused: true });
  const hidden = new File(['secret'], '.env');
  const big = new File([], 'big.mov');
  Object.defineProperty(big, 'size', { value: ATTACHMENT_MAX_BYTES + 1 });
  const read = vi.fn(() => {
    throw new Error('must not read');
  });
  Object.defineProperty(hidden, 'arrayBuffer', { value: read });
  Object.defineProperty(big, 'arrayBuffer', { value: read });
  const batch = await importSources(
    '/vault',
    ['/outside/path.png', hidden, big, new File(['abc'], 'file.txt')],
    () => true,
  );
  expect(batch.results.map((result) => result.path)).toEqual([
    'attachments/path.png',
    'attachments/file.txt',
  ]);
  expect(batch.skipped).toEqual(['.env is hidden', 'big.mov is over 50 MB']);
  expect(read).not.toHaveBeenCalled();
  expect(path.mock.invocationCallOrder[0]).toBeLessThan(bytes.mock.invocationCallOrder[0]);
  expect(bytes).toHaveBeenCalledWith('/vault', 'file.txt', 'YWJj');
});
it('does not copy bytes whose page closed while the browser read them', async () => {
  let resolve!: (bytes: ArrayBuffer) => void;
  const file = new File([], 'image.png');
  Object.defineProperty(file, 'arrayBuffer', {
    value: () =>
      new Promise<ArrayBuffer>((done) => {
        resolve = done;
      }),
  });
  const copy = vi.spyOn(ipc, 'importAttachmentBytes');
  let current = true;
  const pending = importSources('/vault', [file], () => current);
  current = false;
  resolve(new ArrayBuffer(1));
  await pending;
  expect(copy).not.toHaveBeenCalled();
});
it('places a batch after its captured block in one undo step, with root-anchored durable media lines', () => {
  const editor = makeEditor();
  const host = document.createElement('div');
  document.body.append(host);
  editor.mount(host);
  try {
    editor.insertBlocks([{ type: 'paragraph' }], editor.document.at(-1)!, 'after');
    const originalTypes = editor.document.map((block) => block.type);
    const originalMarkdown = blocksToMarkdownNow(editor);
    const anchor = { id: editor.document[0].id };
    expect(
      placeBlocks(editor, anchor, [
        { path: 'attachments/image.png', reused: false },
        { path: 'attachments/report.pdf', reused: false },
      ]),
    ).toBe(true);
    expect(editor.document.map((block) => block.type)).toEqual([
      originalTypes[0],
      'image',
      'file',
      ...originalTypes.slice(1),
    ]);
    expect(blocksToMarkdownNow(editor)).toContain('![](/attachments/image.png)');
    editor.undo();
    expect(editor.document.map((block) => block.type)).toEqual(originalTypes);
    expect(blocksToMarkdownNow(editor)).toBe(originalMarkdown);
    expect(
      placeBlocks(editor, { id: 'deleted' }, [{ path: 'attachments/a.png', reused: true }]),
    ).toBe(false);
  } finally {
    editor.unmount();
    host.remove();
  }
});
it('finds a drop block and falls back to the last block for whitespace', () => {
  const editor = makeEditor();
  const host = document.createElement('div');
  const block = document.createElement('div');
  block.className = 'bn-block-outer';
  block.dataset.id = editor.document[0].id;
  host.append(block);
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => block),
  });
  expect(anchorAt(editor, host, { x: 1, y: 1 })).toEqual({ id: editor.document[0].id });
  vi.mocked(document.elementFromPoint).mockReturnValue(null);
  expect(anchorAt(editor, host, { x: 0, y: 0 })).toEqual({ id: editor.document[1].id });
});
it('refuses read-only and opening vaults before copying, with one notice', async () => {
  const copy = vi.spyOn(ipc, 'importAttachment');
  const editor = makeEditor();
  const options = {
    editor,
    sources: ['/outside/a.png'],
    anchor: { id: editor.document[0].id },
    current: () => true,
    readOnly: () => true,
  };
  await addAttachments(options);
  expect(messages()).toEqual(['This page is read-only — nothing was added']);
  expect(copy).not.toHaveBeenCalled();
  useUiStore.setState({ toasts: [] });
  useVaultStore.setState({ entriesVault: '/other' });
  await addAttachments({ ...options, readOnly: () => false });
  expect(messages()).toEqual(['Nothing added — the vault is still opening']);
  expect(copy).not.toHaveBeenCalled();
});
it('keeps the copy but places nothing if its page closes during the native call', async () => {
  let resolve!: (result: { path: string; reused: boolean }) => void;
  vi.spyOn(ipc, 'importAttachment').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const editor = makeEditor();
  let current = true;
  const pending = addAttachments({
    editor,
    sources: ['/outside/a.png', '/outside/b.png'],
    anchor: { id: editor.document[0].id },
    current: () => current,
    readOnly: () => false,
  });
  current = false;
  resolve({ path: 'attachments/a.png', reused: false });
  await pending;
  expect(editor.document).toHaveLength(2);
  expect(ipc.importAttachment).toHaveBeenCalledTimes(1);
  expect(messages()).toEqual([
    'Added 1 file to attachments/. The page closed first, so nothing was placed.',
  ]);
});
it('resolves local percent-encoded paths through root zero and refuses escapes/active URLs', async () => {
  const url = vi
    .spyOn(roots, 'fileUrl')
    .mockResolvedValue('cerebro-file://root/0/attachments/hello%20world.png');
  expect(await resolveAttachmentUrl('../attachments/hello%20world.png', 'pages/a.md')).toBe(
    'cerebro-file://root/0/attachments/hello%20world.png',
  );
  expect(url).toHaveBeenCalledWith('0', 'attachments/hello world.png');
  expect(await resolveAttachmentUrl('https://example.com/a.png', 'a.md')).toBe(
    'https://example.com/a.png',
  );
  for (const bad of ['../../outside.png', 'javascript:alert(1)', '/%FF.png', '//example.com/a.png'])
    expect(await resolveAttachmentUrl(bad, 'a.md')).toBe('');
});

it('never replaces an upload placeholder edited while the picker waited', async () => {
  const editor = makeEditor();
  const block = editor.insertBlocks([{ type: 'image' }], editor.document[0], 'after')[0];
  const anchor = { id: block.id, replace: true, expected: JSON.stringify(block) };
  editor.updateBlock(block.id, { props: { url: 'https://example.com/new.png' } });
  expect(placeBlocks(editor, anchor, [{ path: 'attachments/upload.png', reused: false }])).toBe(
    false,
  );
  expect(editor.getBlock(block.id)).toMatchObject({
    props: { url: 'https://example.com/new.png' },
  });
});
