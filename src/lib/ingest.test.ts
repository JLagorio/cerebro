// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { KINDS } from '@/engine/fileKinds';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import {
  describeIngest,
  ingestFiles,
  ingestOne,
  INGESTIBLE_EXTENSIONS,
  isIngestible,
  MAX_INGEST_BYTES,
  VAULT_STILL_OPENING,
} from './ingest';

describe('what the Inbox takes comes from the kind table (M66.1)', () => {
  it('takes the six capture extensions, in any case', () => {
    for (const name of [
      'a.md',
      'a.markdown',
      'call.txt',
      'call.text',
      'talk.vtt',
      'talk.srt',
      'NOTES.MD',
    ]) {
      expect(isIngestible(name), name).toBe(true);
    }
  });

  it('refuses a picture, a bare filename and a dotfile', () => {
    for (const name of ['photo.png', 'Makefile', '.env', 'report.pdf', 'notes.']) {
      expect(isIngestible(name), name).toBe(false);
    }
  });

  it("lists the table's capture rows and its cap", () => {
    expect(INGESTIBLE_EXTENSIONS).toEqual(
      KINDS.kinds.filter((row) => row.ingest === 'capture').map((row) => row.ext),
    );
    expect(MAX_INGEST_BYTES).toBe(KINDS.limits.capture_max_bytes);
    expect(MAX_INGEST_BYTES).toBe(4 * 1024 * 1024);
  });

  it('says what it filed and skipped in the same words', () => {
    expect(describeIngest({ paths: [], duplicates: [], skipped: [] })).toBe('Nothing filed');
    expect(describeIngest({ paths: ['inbox/a.md'], duplicates: [], skipped: [] })).toBe(
      'Filed 1 note to the Inbox',
    );
    expect(
      describeIngest({
        paths: ['inbox/a.md', 'inbox/b.md'],
        duplicates: [],
        skipped: [{ filename: 'photo.png', reason: 'not a text file' }],
      }),
    ).toBe('Filed 2 notes to the Inbox — skipped photo.png (not a text file)');
  });

  it('names each repeat by its filed title, and says Nothing filed only when nothing was', () => {
    const scanner = {
      filename: 'scanner.vtt',
      path: 'inbox/scanner-slip.md',
      title: 'Scanner slip',
    };
    const standup = { filename: 'standup.vtt', path: 'inbox/s.md', title: 'Standup' };
    expect(describeIngest({ paths: [], duplicates: [scanner], skipped: [] })).toBe(
      'scanner.vtt is already filed as Scanner slip',
    );
    expect(
      describeIngest({ paths: ['inbox/a.md'], duplicates: [scanner, standup], skipped: [] }),
    ).toBe(
      'Filed 1 note to the Inbox — scanner.vtt is already filed as Scanner slip; standup.vtt is already filed as Standup',
    );
    expect(
      describeIngest({
        paths: [],
        duplicates: [scanner],
        skipped: [{ filename: 'photo.png', reason: 'not a text file' }],
      }),
    ).toBe('scanner.vtt is already filed as Scanner slip — skipped photo.png (not a text file)');
    expect(
      describeIngest({
        paths: [],
        duplicates: [],
        skipped: [{ filename: 'photo.png', reason: 'not a text file' }],
      }),
    ).toBe('Nothing filed — skipped photo.png (not a text file)');
  });
});

/** A dropped file, as the Inbox's drop handler hands it over. */
function dropped(name: string, content: string): File {
  return { name, size: content.length, text: () => Promise.resolve(content) } as unknown as File;
}

const VTT = [
  'WEBVTT',
  '',
  '00:00:03.000 --> 00:00:08.000',
  '<v Rosa Alvine>The scanner order slipped again, so night one is camera only.',
].join('\n');
const NAME = '2026-07-29 Scanner slip.vtt';
const PASTE = 'A pasted wall of text about the cutover. '.repeat(8);

const disk = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const inboxPaths = () => [...disk().keys()].filter((p) => p.startsWith('inbox/')).sort();

describe('a repeat drop names its filed copy (M64.7)', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
  });

  it('files the same file once and names the first copy on the second drop', async () => {
    const before = inboxPaths();
    const first = await ingestFiles([dropped(NAME, VTT)]);
    expect(first.paths).toEqual(['inbox/scanner-slip.md']);
    expect(disk().get('inbox/scanner-slip.md')).toContain('source_sha256: ');
    const second = await ingestFiles([dropped(NAME, VTT)]);
    expect(second).toEqual({
      paths: [],
      duplicates: [{ filename: NAME, path: 'inbox/scanner-slip.md', title: 'Scanner slip' }],
      skipped: [],
    });
    expect(describeIngest(second)).toBe(`${NAME} is already filed as Scanner slip`);
    expect(inboxPaths()).toEqual([...before, 'inbox/scanner-slip.md'].sort());
  });

  it('files the same file twice in one drop once', async () => {
    const result = await ingestFiles([dropped(NAME, VTT), dropped('copy.vtt', VTT)]);
    expect(result.paths).toEqual(['inbox/scanner-slip.md']);
    expect(result.duplicates).toEqual([
      { filename: 'copy.vtt', path: 'inbox/scanner-slip.md', title: 'Scanner slip' },
    ]);
    expect(disk().has('inbox/scanner-slip-2.md')).toBe(false);
  });

  it('files a paste once, and names it the second time', async () => {
    const first = await ingestOne('', PASTE);
    expect(first.kind).toBe('filed');
    const size = disk().size;
    const second = await ingestOne('', PASTE);
    expect(second.kind).toBe('duplicate');
    expect(second.path).toBe(first.path);
    expect(disk().size).toBe(size);
  });

  it('names a copy whose title changed by its title now', async () => {
    await ingestFiles([dropped(NAME, VTT)]);
    expect(await useVaultStore.getState().setTitle('inbox/scanner-slip.md', 'Night one')).toBe(
      true,
    );
    const again = await ingestFiles([dropped(NAME, VTT)]);
    expect(again.duplicates).toEqual([
      { filename: NAME, path: 'inbox/scanner-slip.md', title: 'Night one' },
    ]);
  });

  it('skips with words while the vault is still opening, and writes nothing', async () => {
    const size = disk().size;
    useVaultStore.setState({ entriesVault: '/another-vault' });
    const result = await ingestFiles([dropped(NAME, VTT)]);
    expect(result.paths).toEqual([]);
    expect(result.skipped).toEqual([{ filename: NAME, reason: VAULT_STILL_OPENING }]);
    expect(disk().size).toBe(size);
    await expect(ingestOne('', PASTE)).rejects.toThrow(VAULT_STILL_OPENING);
  });
});
