import { describe, expect, it } from 'vitest';
import { droppedReason, droppedTextReason, NO_DROP_ZONE, type DroppedFile } from './osDrop';
const file: DroppedFile = {
  path: '/a/note.md',
  name: 'note.md',
  kind: 'file',
  size: 4,
  hidden: false,
};
describe('drop reasons', () => {
  it('accepts files for attachments and only bounded text for capture', () => {
    expect(droppedReason(file, true)).toBeNull();
    expect(droppedReason({ ...file, name: 'a.pdf' })).toBeNull();
    expect(droppedReason({ ...file, name: 'a.pdf' }, true)).toBe('not a text file');
    expect(droppedReason({ ...file, size: 4 * 1024 * 1024 + 1 }, true)).toBe('too large');
    expect(droppedReason({ ...file, size: null }, true)).toBeNull();
  });
  it('names hidden files, folders, missing files and typed read refusals', () => {
    expect(droppedReason({ ...file, hidden: true })).toBe('a hidden file');
    expect(droppedReason({ ...file, kind: 'folder' })).toBe('a folder');
    expect(droppedReason({ ...file, kind: 'missing' })).toBe('could not be read');
    expect(droppedTextReason({ kind: 'folder' })).toBe('a folder');
    expect(droppedTextReason({ kind: 'notFound' })).toBe('could not be read');
    expect(droppedTextReason({ kind: 'notText' })).toBe('not a text file');
    expect(droppedTextReason({ kind: 'tooLarge', size: 8, limit: 4 })).toBe('too large');
    expect(NO_DROP_ZONE).toBe('Drop files on the Inbox, a Files property, or a page.');
  });
});
