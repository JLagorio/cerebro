import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVaultStore } from '@/stores/vaultStore';
import { describeIngest, documentCount, ingestDropped, ingestFiles } from './ingest';
import { mockVaultFiles, resetMockFs, seedExtractions } from './mockIpc';
import { byteEntries, storedBytes } from './mockBytes';
import { stageDropped } from './mockDropped';
import * as ipc from './ipc';
import * as pdf from './extract/pdfText';
const vault = '/demo-vault';
const extracted = {
  state: 'extracted' as const,
  markdown: '## Goals\n\n4. Keep the plan\n',
  not_carried: [],
  truncated: false,
};
beforeEach(() => {
  vi.restoreAllMocks();
  resetMockFs();
  useVaultStore.setState({ vaultPath: vault, entriesVault: vault, entries: [] });
});
const captures = () =>
  mockVaultFiles().filter(
    ([path, body]) => path.startsWith('inbox/') && body.includes('source_system: file'),
  );
describe('document capture inlet', () => {
  it('keeps the original before extracting and files all provenance keys', async () => {
    stageDropped([{ path: '/outside/Goals.docx', content: 'office bytes' }]);
    seedExtractions({ 'attachments/Goals.docx': extracted });
    const original = ipc.extractDocument;
    const read = vi.spyOn(ipc, 'extractDocument').mockImplementation(async (v, path) => {
      expect(Array.from(storedBytes('0', path)!)).toEqual(
        Array.from(new TextEncoder().encode('office bytes')),
      );
      return original(v, path);
    });
    const result = await ingestDropped(['/outside/Goals.docx'], () => true);
    expect(result.paths).toHaveLength(1);
    expect(read).toHaveBeenCalledWith(vault, 'attachments/Goals.docx');
    const saved = (await ipc.readNoteSource(vault, result.paths[0])).content;
    for (const key of [
      'source_file: Goals.docx',
      'source_system: file',
      'source_attachment: attachments/Goals.docx',
      'extraction: extracted',
      'source_record_id:',
    ])
      expect(saved).toContain(key);
    expect(saved).toContain('![Goals.docx](/attachments/Goals.docx)');
    expect(saved).toContain('## Goals');
    expect(saved).not.toContain('/outside/');
  });
  it('files a failed extraction with the original and reports why', async () => {
    stageDropped([{ path: '/outside/Locked.docx', content: 'encrypted bytes' }]);
    seedExtractions({ 'attachments/Locked.docx': { state: 'encrypted' } });
    const result = await ingestDropped(['/outside/Locked.docx'], () => true);
    expect(result.paths).toHaveLength(1);
    expect(describeIngest(result)).toContain('Locked.docx: encrypted');
    expect((await ipc.readNoteSource(vault, result.paths[0])).content).toContain(
      'Encrypted: this file needs a password',
    );
    expect(storedBytes('0', 'attachments/Locked.docx')).not.toBeNull();
  });
  it('keeps one file and capture when the same native document is dropped again', async () => {
    stageDropped([{ path: '/outside/Goals.docx', content: 'same bytes' }]);
    seedExtractions({ 'attachments/Goals.docx': extracted });
    const first = await ingestDropped(['/outside/Goals.docx'], () => true);
    const second = await ingestDropped(['/outside/Goals.docx'], () => true);
    expect(second.paths).toEqual([]);
    expect(second.duplicates[0].path).toBe(first.paths[0]);
    expect(describeIngest(second)).toContain('already filed as Goals');
    expect(byteEntries('0')).toHaveLength(1);
    expect(captures()).toHaveLength(1);
  });
  it('hashes browser bytes before copying, even when a repeated file was renamed', async () => {
    seedExtractions({ 'attachments/One.docx': extracted });
    const result = await ingestFiles([
      new File(['same bytes'], 'One.docx'),
      new File(['same bytes'], 'Two.docx'),
    ]);
    expect(result.paths).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    expect(byteEntries('0').map(([path]) => path)).toEqual(['attachments/One.docx']);
  });
  it('serializes concurrent document jobs before their duplicate decision', async () => {
    seedExtractions({ 'attachments/One.docx': extracted });
    const [one, two] = await Promise.all([
      ingestFiles([new File(['same'], 'One.docx')]),
      ingestFiles([new File(['same'], 'Two.docx')]),
    ]);
    expect(one.paths).toHaveLength(1);
    expect(two.duplicates).toHaveLength(1);
    expect(captures()).toHaveLength(1);
    expect(byteEntries('0')).toHaveLength(1);
  });
  it('never files a delayed extraction into another vault', async () => {
    stageDropped([{ path: '/outside/Goals.docx', content: 'bytes' }]);
    vi.spyOn(ipc, 'extractDocument').mockImplementation(async () => {
      useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other', entries: [] });
      return { format: 'docx', sha256: 'a'.repeat(64), bytes: 5, outcome: extracted };
    });
    const create = vi.spyOn(useVaultStore.getState(), 'createItem');
    expect((await ingestDropped(['/outside/Goals.docx'], () => true)).paths).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
  it('waits for the corpus before it copies anything', async () => {
    useVaultStore.setState({ entriesVault: null });
    const result = await ingestFiles([new File(['bytes'], 'One.docx')]);
    expect(result.skipped[0].reason).toContain('vault is still opening');
    expect(byteEntries('0')).toEqual([]);
  });
  it('retires a queued drop across A to B to A before copying any original', async () => {
    const first = ingestFiles([new File(['first'], 'One.docx')]);
    const second = ingestFiles([new File(['second'], 'Two.docx')]);
    useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other', entries: [] });
    useVaultStore.setState({ vaultPath: vault, entriesVault: vault, entries: [] });
    expect((await first).paths).toEqual([]);
    expect((await second).paths).toEqual([]);
    expect(byteEntries('0')).toEqual([]);
  });
  it('retires extraction even when the original vault is reopened before the read returns', async () => {
    vi.spyOn(ipc, 'extractDocument').mockImplementation(async () => {
      useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other', entries: [] });
      useVaultStore.setState({ vaultPath: vault, entriesVault: vault, entries: [] });
      return { format: 'docx', sha256: 'a'.repeat(64), bytes: 5, outcome: extracted };
    });
    const create = vi.spyOn(useVaultStore.getState(), 'createItem');
    expect((await ingestFiles([new File(['bytes'], 'One.docx')])).paths).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
  it('keeps a completed old-vault write but never publishes its path after a switch', async () => {
    seedExtractions({ 'attachments/One.docx': extracted });
    const original = useVaultStore.getState().createItem;
    vi.spyOn(useVaultStore.getState(), 'createItem').mockImplementation(async (args) => {
      const path = await original(args);
      useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other', entries: [] });
      return path;
    });
    const result = await ingestFiles([new File(['bytes'], 'One.docx')]);
    expect(result).toEqual({ paths: [], duplicates: [], skipped: [] });
    expect(captures()).toHaveLength(1);
  });
  it('routes PDF bytes to the PDF helper and files a no-text-layer outcome', async () => {
    const read = vi.spyOn(pdf, 'extractPdfText').mockResolvedValue({ state: 'no_text_layer' });
    const result = await ingestFiles([new File(['%PDF bytes'], 'Scan.pdf')]);
    expect(Array.from(read.mock.calls[0][0])).toEqual(
      Array.from(new TextEncoder().encode('%PDF bytes')),
    );
    expect(describeIngest(result)).toContain('Scan.pdf: no text layer');
    expect((await ipc.readNoteSource(vault, result.paths[0])).content).toContain('No text layer:');
  });
  it('counts only extractor inputs and surfaces attachment refusals', async () => {
    expect(
      documentCount([{ name: 'a.docx' }, { name: 'a.PDF' }, { name: 'a.ics' }, { name: 'a.txt' }]),
    ).toBe(2);
    const file = new File(['x'], 'Huge.docx');
    Object.defineProperty(file, 'size', { value: 50_000_001 });
    const result = await ingestFiles([file]);
    expect(result.paths).toEqual([]);
    expect(result.skipped[0].reason).toContain('over 50 MB');
    expect(byteEntries('0')).toEqual([]);
  });
});
