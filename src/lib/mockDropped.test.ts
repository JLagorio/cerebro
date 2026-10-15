// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import cases from '../../src-tauri/fixtures/dropped-cases.json';
import {
  inspectDropped,
  readDroppedText,
  stageDropped,
  resetDropped,
  listenOsFileDrop,
  mockDrop,
} from './mockDropped';
import { importAttachment, resetMockFs } from './mockIpc';
import { reset as resetBytes, fileUrl } from './mockBytes';

beforeEach(() => {
  resetDropped();
  resetMockFs();
  resetBytes();
});
it('replays the shared dropped cases', async () => {
  for (const item of cases) {
    resetDropped();
    const path = item.absolute ? `/outside/${item.name}` : item.name;
    if (item.seed !== null) {
      const seed = item.seed as {
        text?: string;
        bytes?: number[];
        folder?: boolean;
        size?: number;
      };
      stageDropped([
        {
          path,
          content: seed.text,
          folder: seed.folder,
          size: seed.size,
          base64: seed.bytes === undefined ? undefined : btoa(String.fromCharCode(...seed.bytes)),
        },
      ]);
    }
    const [result] = await inspectDropped([path]);
    expect({ kind: result.kind, size: result.size, hidden: result.hidden }, item.id).toEqual(
      item.inspect,
    );
    expect(await readDroppedText(path), item.id).toEqual(item.read);
  }
});
it('copies staged binary bytes into the contained attachment lane', async () => {
  stageDropped([{ path: '/outside/photo.png', base64: 'AQIDBA==' }]);
  const { path } = await importAttachment('/demo-vault', '/outside/photo.png');
  expect(path).toBe('attachments/photo.png');
  expect(await fileUrl('0', path)).toBe('data:image/png;base64,AQIDBA==');
});
it('the seam emits enter, over, drop, and can hold until leave', async () => {
  const events = vi.fn();
  const stop = await listenOsFileDrop(events);
  const input = { at: { x: 12, y: 20 }, files: [{ path: '/outside/a.md', content: 'a' }] };
  mockDrop({ ...input, hold: true });
  expect(events.mock.calls.map(([event]) => event.type)).toEqual(['enter', 'over']);
  (window as unknown as { __cerebroMockDragLeave: () => void }).__cerebroMockDragLeave();
  mockDrop(input);
  expect(events.mock.calls.map(([event]) => event.type)).toEqual([
    'enter',
    'over',
    'leave',
    'enter',
    'over',
    'drop',
  ]);
  stop();
});
it('an old subscription cleanup does not remove a replacement of the same handler', async () => {
  const handler = vi.fn();
  const older = listenOsFileDrop(handler);
  const newer = listenOsFileDrop(handler);
  (await older)();
  mockDrop({ at: { x: 1, y: 2 }, files: [] });
  expect(handler).toHaveBeenCalledTimes(3);
  (await newer)();
});
