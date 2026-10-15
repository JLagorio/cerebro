// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import cases from '../../src-tauri/fixtures/attachment-names.json';
import { importAttachment, importAttachmentBytes, resetMockFs } from './mockIpc';
import { stageDropped } from './mockDropped';
import { seedLink, seedBytes, storedBytes } from './mockBytes';
import { ATTACHMENT_MAX_BYTES } from '@/engine/attachments';
const vault = '/demo-vault';
const writes = () => (window as unknown as { __cerebroMockWrites: unknown[] }).__cerebroMockWrites;
beforeEach(resetMockFs);
it('replays the shared attachment names through the mock path door', async () => {
  for (const item of cases) {
    resetMockFs();
    const leaf = item.name.split(/[\\/]/).at(-1) ?? '';
    const path = `/outside/${leaf}`;
    stageDropped([{ path, content: 'bytes', size: item.size }]);
    if (item.refusal !== null)
      await expect(importAttachment(vault, path)).rejects.toThrow(item.refusal);
    else expect((await importAttachment(vault, path)).path).toBe(`attachments/${item.safe}`);
  }
});
it('reuses identical bytes only in the case/normalization-insensitive name family', async () => {
  const first = await importAttachmentBytes(vault, 'caf\u00e9.png', 'AQID');
  const rows = writes().length;
  expect(await importAttachmentBytes(vault, 'CAFE\u0301.PNG', 'AQID')).toEqual({
    ...first,
    reused: true,
  });
  expect(writes()).toHaveLength(rows);
  expect((await importAttachmentBytes(vault, 'caf\u00e9.png', 'BAUG')).path).toBe(
    'attachments/caf\u00e9-2.png',
  );
  expect((await importAttachmentBytes(vault, 'other.png', 'AQID')).reused).toBe(false);
  expect(storedBytes('0', first.path)).toEqual(Uint8Array.from([1, 2, 3]));
});
it('never reuses a symlink and refuses redirected or case-folded attachment folders', async () => {
  seedBytes('0', 'elsewhere/a.png', { bytes: [1, 2, 3] });
  seedLink('0', 'attachments/a.png', 'elsewhere/a.png');
  expect((await importAttachmentBytes(vault, 'a.png', 'AQID')).path).toBe('attachments/a-2.png');
  resetMockFs();
  seedLink('0', 'attachments', 'elsewhere');
  await expect(importAttachmentBytes(vault, 'a.png', 'AQID')).rejects.toThrow(
    'attachments/ is not the folder the scanner skips',
  );
  resetMockFs();
  seedBytes('0', 'Attachments/a.png', { bytes: [1] });
  await expect(importAttachmentBytes(vault, 'a.png', 'AQID')).rejects.toThrow(
    'attachments/ is not the folder the scanner skips',
  );
});
it('refuses hidden, missing, folders, malformed bytes and over-cap data before placing', async () => {
  await expect(importAttachmentBytes(vault, '.env', '%%%')).rejects.toThrow('.env is hidden');
  await expect(importAttachment(vault, '/outside/missing')).rejects.toThrow(
    'missing could not be read',
  );
  stageDropped([
    { path: '/outside/folder', folder: true },
    { path: '/outside/big.mov', size: ATTACHMENT_MAX_BYTES + 1 },
  ]);
  await expect(importAttachment(vault, '/outside/folder')).rejects.toThrow('folder is a folder');
  await expect(importAttachment(vault, '/outside/big.mov')).rejects.toThrow(
    'big.mov is over 50 MB',
  );
  for (const encoded of ['%', 'YQ', 'YR==', 'YQ==\n'])
    await expect(importAttachmentBytes(vault, 'a.txt', encoded)).rejects.toThrow(
      'a.txt could not be read',
    );
  await expect(
    importAttachmentBytes(
      vault,
      'big.mov',
      'A'.repeat(Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4 + 1),
    ),
  ).rejects.toThrow('big.mov is over 50 MB');
  expect(writes()).toHaveLength(0);
});
