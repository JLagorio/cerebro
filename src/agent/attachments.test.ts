// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DroppedFile } from '@/engine/osDrop';

const ipc = vi.hoisted(() => ({
  inspectDropped: vi.fn(),
  importAttachment: vi.fn(),
  importAttachmentBytes: vi.fn(),
  deleteNote: vi.fn(),
}));

vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  ...ipc,
}));

import { copyIn, discardCopies, pastedFiles, pendingFrom, sameSource } from './attachments';

/**
 * The composer's files (M91.17) come in through the doors a page's
 * attachments use (CV-56): refused up front when they never could be
 * copied, copied in order when the message is sent, the batch ending at the
 * first refusal, and the Undo moving the new copies to the Trash (CV-37).
 * Nothing here throws (CV-03).
 */

const dropped = (path: string, over: Partial<DroppedFile> = {}): DroppedFile => ({
  path,
  name: path.split('/').at(-1) ?? path,
  kind: 'file',
  size: 12,
  hidden: false,
  ...over,
});

const pdf = () => new File(['%PDF-1.7'], 'brief.pdf', { type: 'application/pdf' });

beforeEach(() => {
  vi.clearAllMocks();
  ipc.inspectDropped.mockImplementation(async (paths: string[]) =>
    paths.map((path) => dropped(path)),
  );
  ipc.importAttachment.mockImplementation(async (_vault: string, source: string) => ({
    path: `attachments/${source.split('/').at(-1)}`,
    reused: false,
  }));
  ipc.importAttachmentBytes.mockImplementation(async (_vault: string, name: string) => ({
    path: `attachments/${name}`,
    reused: false,
  }));
  ipc.deleteNote.mockResolvedValue({});
});

describe('pendingFrom', () => {
  it('lets in what can be copied, in the order given, and names the rest with why', async () => {
    ipc.inspectDropped.mockResolvedValue([
      dropped('/outside/report.pdf'),
      dropped('/outside/folder', { kind: 'folder', size: null }),
      dropped('/outside/.env', { hidden: true }),
      dropped('/outside/gone.txt', { kind: 'missing', size: null }),
      dropped('/outside/huge.mov', { size: 60_000_000 }),
      dropped('/outside/notes.md'),
    ]);
    const { files, skipped } = await pendingFrom([
      '/outside/report.pdf',
      '/outside/folder',
      '/outside/.env',
      '/outside/gone.txt',
      '/outside/huge.mov',
      '/outside/notes.md',
    ]);
    expect(files.map((file) => [file.label, file.fileKind, file.state, file.source])).toEqual([
      ['report.pdf', 'pdf', 'waiting', '/outside/report.pdf'],
      ['notes.md', 'markdown', 'waiting', '/outside/notes.md'],
    ]);
    expect(skipped).toEqual([
      'folder (a folder)',
      '.env (a hidden file)',
      'gone.txt (could not be read)',
      'huge.mov is over 50 MB',
    ]);
    // One look at the paths, through the drop door's inspection.
    expect(ipc.inspectDropped).toHaveBeenCalledOnce();
  });

  it('takes a browser File by its name and size, never asking the disk', async () => {
    const big = new File(['x'], 'huge.mov');
    Object.defineProperty(big, 'size', { value: 60_000_000 });
    const { files, skipped } = await pendingFrom([pdf(), big]);
    expect(files.map((file) => [file.label, file.fileKind])).toEqual([['brief.pdf', 'pdf']]);
    expect(skipped).toEqual(['huge.mov is over 50 MB']);
    expect(ipc.inspectDropped).not.toHaveBeenCalled();
  });

  it('gives every waiting file its own id, never a file chip’s', async () => {
    const { files } = await pendingFrom(['/outside/a.pdf', '/outside/b.pdf']);
    const ids = files.map((file) => file.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id.startsWith('file:')).toBe(false);
    expect(sameSource(files[0], files[0])).toBe(true);
    expect(sameSource(files[0], files[1])).toBe(false);
  });

  it('names a path the inspection left unanswered, never dropping it without a word', async () => {
    ipc.inspectDropped.mockResolvedValue([dropped('/outside/a.pdf')]);
    const { files, skipped } = await pendingFrom(['/outside/a.pdf', '/outside/b.pdf']);
    expect(files.map((f) => f.source)).toEqual(['/outside/a.pdf']);
    expect(skipped).toEqual(['b.pdf (could not be read)']);
  });

  it('refuses every path in words when the inspection fails, and never throws', async () => {
    ipc.inspectDropped.mockRejectedValue(new Error('the drop door is shut'));
    const file = pdf();
    const { files, skipped } = await pendingFrom(['/outside/a.pdf', file]);
    expect(files.map((f) => f.source)).toEqual([file]);
    expect(skipped).toEqual(['a.pdf (the drop door is shut)']);
  });
});

describe('copyIn', () => {
  const waitingFor = async (...sources: (string | File)[]) => (await pendingFrom(sources)).files;

  it('copies each file in order through its door: a path by import, a File by its bytes', async () => {
    const file = pdf();
    const files = await waitingFor('/outside/report.pdf', file);
    const outcome = await copyIn('/vault', files, () => true);
    expect(outcome).toEqual({
      kind: 'copied',
      copied: [
        { id: files[0].id, path: 'attachments/report.pdf', reused: false },
        { id: files[1].id, path: 'attachments/brief.pdf', reused: false },
      ],
    });
    expect(ipc.importAttachment).toHaveBeenCalledWith('/vault', '/outside/report.pdf');
    expect(ipc.importAttachmentBytes).toHaveBeenCalledWith('/vault', 'brief.pdf', btoa('%PDF-1.7'));
  });

  it('ends the batch at the first refusal, keeping what was copied before it', async () => {
    const files = await waitingFor('/outside/a.pdf', '/outside/b.pdf', '/outside/c.pdf');
    ipc.importAttachment
      .mockResolvedValueOnce({ path: 'attachments/a.pdf', reused: true })
      .mockRejectedValueOnce(new Error('b.pdf could not be read'));
    const outcome = await copyIn('/vault', files, () => true);
    expect(outcome).toEqual({
      kind: 'failed',
      copied: [{ id: files[0].id, path: 'attachments/a.pdf', reused: true }],
      failed: { id: files[1].id, reason: 'b.pdf could not be read' },
    });
    // The rest were not tried.
    expect(ipc.importAttachment).toHaveBeenCalledTimes(2);
  });

  it('copies nothing more once the person has left the conversation', async () => {
    const files = await waitingFor('/outside/a.pdf', '/outside/b.pdf');
    let live = true;
    ipc.importAttachment.mockImplementationOnce(async () => {
      live = false;
      return { path: 'attachments/a.pdf', reused: false };
    });
    const outcome = await copyIn('/vault', files, () => live);
    expect(outcome.kind).toBe('stale');
    expect(outcome.copied.map((file) => file.path)).toEqual(['attachments/a.pdf']);
    expect(ipc.importAttachment).toHaveBeenCalledOnce();
  });
});

describe('discardCopies', () => {
  it('moves each copy to the Trash, and names the first that stayed', async () => {
    ipc.deleteNote
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('not found: attachments/b.pdf'))
      .mockResolvedValueOnce({});
    const result = await discardCopies('/vault', [
      'attachments/a.pdf',
      'attachments/b.pdf',
      'attachments/c.pdf',
    ]);
    expect(ipc.deleteNote.mock.calls.map(([vault, path]) => [vault, path])).toEqual([
      ['/vault', 'attachments/a.pdf'],
      ['/vault', 'attachments/b.pdf'],
      ['/vault', 'attachments/c.pdf'],
    ]);
    expect(result).toEqual({
      moved: ['attachments/a.pdf', 'attachments/c.pdf'],
      failed: 'b.pdf stayed: not found: attachments/b.pdf',
    });
  });
});

describe('pastedFiles', () => {
  /** A clipboard as a paste event hands it over. */
  const clipboard = (files: File[], data: Record<string, string> = {}): DataTransfer =>
    ({
      files: Object.assign([...files], { item: (i: number) => files[i] ?? null }),
      types: [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])],
      getData: (type: string) => data[type] ?? '',
    }) as unknown as DataTransfer;

  it('takes a screenshot or a copied file, naming a nameless one for its MIME', () => {
    const shot = new File(['png'], '', { type: 'image/png' });
    const [named] = pastedFiles(clipboard([shot]));
    expect(named.name).toBe('pasted.png');
    expect(named.type).toBe('image/png');
    const file = pdf();
    expect(pastedFiles(clipboard([file], { 'text/plain': 'brief.pdf' }))).toEqual([file]);
  });

  it('leaves a paste that carries text to the text: words in HTML, or editor content', () => {
    const file = pdf();
    expect(pastedFiles(clipboard([file], { 'text/html': '<p>Two tiers</p>' }))).toEqual([]);
    expect(pastedFiles(clipboard([file], { 'blocknote/html': '<p></p>' }))).toEqual([]);
    expect(pastedFiles(clipboard([], { 'text/plain': 'just words' }))).toEqual([]);
    expect(pastedFiles(null)).toEqual([]);
    // A copied picture's HTML holds no words: the picture is the paste.
    expect(pastedFiles(clipboard([file], { 'text/html': '<img src="x.png">' }))).toEqual([file]);
  });
});
