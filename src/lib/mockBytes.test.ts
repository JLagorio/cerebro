import { beforeEach, describe, expect, it } from 'vitest';
import RAW from '../../shared/files/bytes.v1.json';
import { FILE_BYTES, fileRefusal, isFileRefusal } from '@/engine/fileBytes';
import { emptyMockVault, mockVaultFiles, resetMockFs } from './mockIpc';
import {
  listDir,
  readFileText,
  resetMockRoots,
  seedFile,
  seedRoot,
  unmountRoot,
} from './mockRoots';
import { fileUrl, probeFile, readFileBytes, reset, seedBytes, seedLink } from './mockBytes';

beforeEach(() => {
  reset();
  resetMockRoots();
  resetMockFs();
});
describe('contained mock bytes', () => {
  it('replays the shared bytes cases', async () => {
    for (const row of RAW.cases)
      if ('refusal' in row)
        expect(await probeFile(row.root, row.rel)).toEqual(
          fileRefusal(row.refusal as 'bad_address'),
        );
    for (const row of RAW.files) {
      seedBytes('0', row.rel, row);
      const probe = await probeFile('0', row.rel);
      expect(probe).toMatchObject({ size: row.bytes.length, door: row.door, open: row.open });
      const read = await readFileBytes('0', row.rel);
      if (row.door === 'ipc') expect(read).toEqual(Uint8Array.from(row.bytes));
      else expect(read).toEqual(fileRefusal('wrong_door'));
    }
  });
  it('serves data URLs only for scheme rows and IPC bytes only below the cap', async () => {
    seedBytes('0', 'a.png', { bytes: [137, 80, 78, 71, 0] });
    expect(await fileUrl('0', 'a.png')).toBe('data:image/png;base64,iVBORwA=');
    seedBytes('0', 'a.pdf', { text: '%PDF-', size: FILE_BYTES.limits.body_bytes + 1 });
    expect(await readFileBytes('0', 'a.pdf')).toEqual(fileRefusal('too_large'));
    expect(await fileUrl('0', 'a.pdf')).toEqual(fileRefusal('wrong_door'));
    seedBytes('0', 'large.png', { size: FILE_BYTES.limits.body_bytes + 1 });
    expect(await probeFile('0', 'large.png')).toMatchObject({
      size: FILE_BYTES.limits.body_bytes + 1,
    });
    expect(await fileUrl('0', 'large.png')).toEqual(fileRefusal('too_large'));
  });
  it('reads vault root zero from the live note disk, including whole frontmatter', async () => {
    const [path, content] = mockVaultFiles()[0];
    expect(await readFileText('0', path)).toEqual({ kind: 'text', content });
    seedBytes('0', 'attachments/é.png', { bytes: [0, 1, 2] });
    expect(await listDir('0', 'attachments')).toContainEqual({
      name: 'é.png',
      path: 'attachments/é.png',
      isDir: false,
      size: 3,
      ignored: false,
    });
    emptyMockVault();
    expect(await readFileText('0', path)).toEqual({ kind: 'notFound' });
  });
  it('uses mounted roots and refuses them after unmount', async () => {
    const root = seedRoot({ path: '/repo', label: 'repo' });
    seedFile('/repo', 'readme.md', '# A');
    expect(await readFileText(root.id, 'readme.md')).toEqual({ kind: 'text', content: '# A' });
    seedBytes(root.id, 'image.png', { bytes: [0] });
    expect(isFileRefusal(await probeFile(root.id, 'image.png'))).toBe(false);
    await unmountRoot(root.id);
    expect(await probeFile(root.id, 'image.png')).toEqual(fileRefusal('no_such_root'));
  });
  it('follows contained links and directory links, refuses escape and bounds loops', async () => {
    seedBytes('0', 'images/a.png', { bytes: [1, 2] });
    seedLink('0', 'alias', 'images');
    expect(await probeFile('0', 'alias/a.png')).toMatchObject({ size: 2, kind: 'image' });
    seedLink('0', 'outside.png', '../outside.png');
    expect(await probeFile('0', 'outside.png')).toEqual(fileRefusal('outside'));
    seedLink('0', 'loop.png', 'loop.png');
    expect(await probeFile('0', 'loop.png')).toEqual(fileRefusal('not_found'));
    expect(await probeFile('0', 'images')).toEqual(fileRefusal('folder'));
  });
  it('keeps binary, invalid UTF-8 and byte-length text limits honest', async () => {
    seedBytes('0', 'bad.txt', { bytes: [255] });
    expect(await readFileText('0', 'bad.txt')).toEqual({ kind: 'binary' });
    seedBytes('0', 'big.txt', { text: 'é'.repeat(1024 * 1024 + 1) });
    expect(await readFileText('0', 'big.txt')).toMatchObject({ kind: 'tooLarge', size: 2097154 });
    seedBytes('0', 'cut.txt', { text: 'a'.repeat(8191) + 'é' });
    expect(await probeFile('0', 'cut.txt')).toMatchObject({ sniff: 'text' });
    expect(await readFileText('0', 'cut.txt')).toMatchObject({ kind: 'text' });
  });
});
