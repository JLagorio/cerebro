import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText, deleteRecord, duplicateRecord } from '@/views/recordActions';
import { makeEntry } from '@/test/factories';

const readNote = vi.fn();
const deleteNote = vi.fn();

vi.mock('@/lib/ipc', () => ({
  readNote: (...args: unknown[]) => readNote(...args) as Promise<string>,
  deleteNote: (...args: unknown[]) => deleteNote(...args) as Promise<void>,
}));

const entry = makeEntry({
  path: 'records/work/fld-1.md',
  title: 'Design first-run flow',
  type: 'Work item',
  properties: { key: 'FLD-1', status: 'todo' },
  relationships: { assignee: ['ana-rios'] },
  outgoingLinks: [],
});

function deps(overrides: { vaultPath?: string | null; rescan?: ReturnType<typeof vi.fn> } = {}) {
  return {
    vaultPath: overrides.vaultPath === undefined ? '/vault' : overrides.vaultPath,
    createItem: vi.fn().mockResolvedValue('records/work/design-first-run-flow-copy.md'),
    rescan: overrides.rescan ?? vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
  };
}

beforeEach(() => {
  readNote.mockReset().mockResolvedValue('# Design first-run flow\n\nBody.\n');
  deleteNote.mockReset().mockResolvedValue(undefined);
});

describe('duplicateRecord', () => {
  // `key` identifies the record. Two records answering to one key is worse
  // than a copy with none — the item-key allocator would hand the number out
  // again and the list would show two FLD-1s.
  it('copies every property except the key', async () => {
    const d = deps();
    await duplicateRecord(entry, d);
    expect(d.createItem).toHaveBeenCalledWith({
      folder: 'records/work',
      slug: 'design-first-run-flow-copy',
      frontmatter: { status: 'todo', type: 'Work item', assignee: ['[[ana-rios]]'] },
      body: '# Design first-run flow\n\nBody.\n',
    });
  });

  // Relationships arrive from the scanner bracket-stripped. Writing the stems
  // back verbatim would produce `assignee: ana-rios`, which is a plain string
  // on disk — the copy would silently lose every link the original had.
  it('re-wraps relationships as wikilinks on the way to disk', async () => {
    const d = deps();
    await duplicateRecord(entry, d);
    const written = d.createItem.mock.calls[0][0] as { frontmatter: Record<string, unknown> };
    expect(written.frontmatter.assignee).toEqual(['[[ana-rios]]']);
  });

  it('toasts and returns null instead of throwing when the read fails', async () => {
    readNote.mockRejectedValue(new Error('gone'));
    const d = deps();
    await expect(duplicateRecord(entry, d)).resolves.toBeNull();
    expect(d.toast).toHaveBeenCalledWith("Couldn't duplicate this record");
  });

  it('does nothing without an open vault', async () => {
    const d = deps({ vaultPath: null });
    expect(await duplicateRecord(entry, d)).toBeNull();
    expect(d.createItem).not.toHaveBeenCalled();
  });
});

describe('deleteRecord', () => {
  it('removes the file and refreshes the vault', async () => {
    const d = deps();
    expect(await deleteRecord(entry, d)).toBe(true);
    expect(deleteNote).toHaveBeenCalledWith('/vault', entry.path);
    expect(d.rescan).toHaveBeenCalled();
  });

  it('reports failure instead of throwing at a closing menu', async () => {
    deleteNote.mockRejectedValue(new Error('read-only'));
    const d = deps();
    expect(await deleteRecord(entry, d)).toBe(false);
    expect(d.toast).toHaveBeenCalledWith("Couldn't delete this record");
    expect(d.rescan).not.toHaveBeenCalled();
  });

  // The file IS gone; a rescan that fails is a stale screen, not a delete
  // that did not happen, and reporting false would send the caller looking
  // for a record that no longer exists.
  it('still reports success when only the refresh fails', async () => {
    const d = deps({ rescan: vi.fn().mockRejectedValue(new Error('busy')) });
    expect(await deleteRecord(entry, d)).toBe(true);
    expect(d.toast).toHaveBeenCalledWith("Couldn't refresh vault");
  });
});

describe('copyText', () => {
  it('says so when the clipboard permission is refused, rather than nothing', async () => {
    const toast = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    expect(await copyText('[[x]]', 'Link', toast)).toBe(false);
    expect(toast).toHaveBeenCalledWith("Couldn't copy link");
  });

  it('confirms the copy so the click is not silent', async () => {
    const toast = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    expect(await copyText('[[x]]', 'Link', toast)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('[[x]]');
    expect(toast).toHaveBeenCalledWith('Link copied');
  });
});
