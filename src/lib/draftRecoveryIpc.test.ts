// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CASES from '../../src-tauri/fixtures/draft-recovery-cases.json';
import * as mock from './mockIpc';
import { sha256Hex } from './sha256';

const vault = '/demo-vault';
const source = 'gone-recovery-target.md';
let download: Blob | null;
let filename: string;

beforeEach(() => {
  mock.resetMockFs();
  download = null;
  filename = '';
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: (blob: Blob) => {
        download = blob;
        return 'blob:retained-draft';
      },
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filename = this.download;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function choose(content: string, format = 'json') {
  return mock.chooseDraftExport(vault, source, `recovery.${format}`, format, sha256Hex(content));
}
async function blobText(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(new TextDecoder('utf-8', { ignoreBOM: true }).decode(reader.result as ArrayBuffer));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

describe('deleted draft recovery IPC', () => {
  it('checks guarded target presence without mistaking unsupported or foreign targets for deletion', async () => {
    expect(await mock.probeDraftTarget(vault, source)).toEqual({ kind: 'missing' });
    await mock.createRecoveredPage(vault, source, 'recovered.md', 'body');
    expect(await mock.probeDraftTarget(vault, 'recovered.md')).toEqual({ kind: 'present' });
    for (const path of ['../gone.md', '.git/gone.md', 'gone.txt', 'views/gone.md']) {
      expect(await mock.probeDraftTarget(vault, path)).toEqual(
        expect.objectContaining({ kind: 'unavailable' }),
      );
    }
    expect(await mock.probeDraftTarget('/foreign-vault', source)).toEqual(
      expect.objectContaining({ kind: 'unavailable' }),
    );
  });

  it.each(CASES.create)(
    'exact new-page create: $name',
    async ({ original, destination, content, allowed }) => {
      const action = mock.createRecoveredPage(vault, original, destination, content);
      if (!allowed) {
        await expect(action).rejects.toThrow();
        expect(mock.peekFile(destination)).toBeNull();
        return;
      }
      const result = await action;
      expect(result.path).toBe(destination);
      expect(result.contentHash).toBe(sha256Hex(content));
      expect(result.batch.files).toEqual([
        expect.objectContaining({
          path: destination,
          beforeHash: null,
          afterHash: sha256Hex(content),
        }),
      ]);
      expect(mock.peekFile(destination)).toBe(content);
      expect(mock.peekFile(original)).toBeNull();
      await expect(
        mock.createRecoveredPage(vault, original, destination, 'overwrite'),
      ).rejects.toThrow();
      expect(mock.peekFile(destination)).toBe(content);
    },
  );

  it.each(CASES.exports)(
    'validates frozen $format payload without changing bytes: $content',
    async ({ format, content, allowed }) => {
      if (!['json', 'md', 'mmd', 'canvas'].includes(format)) {
        await expect(choose(content, format)).rejects.toThrow();
        return;
      }
      const origin = format === 'mmd' ? 'gone.mmd' : format === 'canvas' ? 'gone.canvas' : source;
      const choice = await mock.chooseDraftExport(
        vault,
        origin,
        `recovery.${format}`,
        format,
        sha256Hex(content),
      );
      expect(choice.kind).toBe('chosen');
      if (choice.kind !== 'chosen') throw new Error('Expected a browser export token');
      if (!allowed) {
        await expect(mock.commitDraftExport(vault, choice.token, content)).rejects.toThrow();
        expect(download).toBeNull();
        return;
      }
      expect(await mock.commitDraftExport(vault, choice.token, content)).toEqual({
        kind: 'exported',
        destination: `recovery.${format}`,
      });
      expect(filename).toBe(`recovery.${format}`);
      expect(await blobText(download!)).toBe(content);
      expect(mock.peekFile(origin)).toBeNull();
      await expect(mock.commitDraftExport(vault, choice.token, content)).rejects.toThrow();
    },
  );

  it('consumes tokens on wrong content, foreign vault, explicit cancel and expiry', async () => {
    const content = '{"format":"cerebro-retained-draft","version":1}';
    for (const reason of ['content', 'vault', 'cancel', 'expiry']) {
      const chosen = await choose(content);
      if (chosen.kind !== 'chosen') throw new Error('Expected token');
      if (reason === 'cancel') await mock.cancelDraftExport(chosen.token);
      if (reason === 'expiry') {
        vi.useFakeTimers();
        vi.advanceTimersByTime(60_001);
      }
      await expect(
        mock.commitDraftExport(
          reason === 'vault' ? '/foreign-vault' : vault,
          chosen.token,
          reason === 'content' ? content + ' ' : content,
        ),
      ).rejects.toThrow();
      await expect(mock.commitDraftExport(vault, chosen.token, content)).rejects.toThrow();
      expect(download).toBeNull();
      vi.useRealTimers();
    }
  });

  it('rejects oversized UTF-8 payloads, inappropriate source formats, and invalid filenames', async () => {
    const content = 'x'.repeat(10 * 1024 * 1024 + 1);
    const choice = await mock.chooseDraftExport(vault, source, 'body.md', 'md', sha256Hex(content));
    if (choice.kind !== 'chosen') throw new Error('Expected token');
    await expect(mock.commitDraftExport(vault, choice.token, content)).rejects.toThrow();
    await expect(
      mock.chooseDraftExport(vault, 'knowledge/concepts/a.md', 'body.md', 'md', sha256Hex('body')),
    ).rejects.toThrow();
    await expect(
      mock.chooseDraftExport(vault, source, '../body.json', 'json', sha256Hex('{}')),
    ).rejects.toThrow();
    expect(download).toBeNull();
  });
});
