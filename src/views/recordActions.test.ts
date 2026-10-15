import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText, deleteRecord, duplicateRecord } from '@/views/recordActions';
import { makeEntry } from '@/test/factories';

const readNote = vi.fn();
const trashPath = vi.fn();

vi.mock('@/lib/ipc', () => ({
  readNote: (...args: unknown[]) => readNote(...args) as Promise<string>,
}));
vi.mock('@/app/trashActions', () => ({
  trashPath: (...args: unknown[]) => trashPath(...args) as Promise<unknown>,
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
  trashPath.mockReset().mockResolvedValue({ stamp: '20261014T093000Z-a1b2' });
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
  // M60.8: through trashPath, which moves it to the vault's Trash, toasts and
  // rescans; deleteRecord adds no words of its own.
  it('moves the record to the Trash through trashPath', async () => {
    const d = deps();
    expect(await deleteRecord(entry, d)).toBe(true);
    expect(trashPath).toHaveBeenCalledWith(entry.path, 'Design first-run flow');
    expect(d.toast).not.toHaveBeenCalled();
  });

  it('reports a refusal as false, never a throw at a closing menu', async () => {
    trashPath.mockResolvedValue(null);
    const d = deps();
    expect(await deleteRecord(entry, d)).toBe(false);
    expect(d.toast).not.toHaveBeenCalled();
  });

  it('does nothing with no vault open', async () => {
    expect(await deleteRecord(entry, deps({ vaultPath: null }))).toBe(false);
    expect(trashPath).not.toHaveBeenCalled();
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
