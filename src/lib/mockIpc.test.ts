// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from './mockIpc';

beforeEach(() => {
  mock.resetMockFs();
});

describe('mockIpc', () => {
  it('pickVault and getLastVault return the demo vault path', async () => {
    expect(await mock.pickVault()).toBe('/demo-vault');
    expect(await mock.getLastVault()).toBe('/demo-vault');
  });

  it('scanVault parses the seeded demo vault into entries', async () => {
    const entries = await mock.scanVault('/demo-vault');
    expect(entries.length).toBeGreaterThan(50);
    expect(entries.every((e) => e.parseError === null)).toBe(true);
    const item = entries.find((e) => e.path === 'items/fld-1.md');
    expect(item?.title).toBe('First-run walkthrough GA');
    expect(item?.type).toBe('Work item');
    expect(item?.properties.key).toBe('FLD-1');
    expect(item?.relationships.project).toEqual(['guided-onboarding-ga']);
    expect(item?.relationships.assignee).toEqual(['ana-rios']);
  });

  it('exposes the file map for Playwright assertions', () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    expect(fs).toBeInstanceOf(Map);
    expect(fs.has('items/fld-1.md')).toBe(true);
  });

  it('readNote returns the body with frontmatter stripped', async () => {
    const body = await mock.readNote('/demo-vault', 'items/fld-1.md');
    expect(body.startsWith('# First-run walkthrough GA')).toBe(true);
    expect(body).not.toContain('---');
  });

  it('updateFrontmatter patches values, deletes nulls, preserves order and unknown keys', async () => {
    await mock.updateFrontmatter('/demo-vault', 'items/fld-1.md', { status: 'done', due: null });
    const entries = await mock.scanVault('/demo-vault');
    const item = entries.find((e) => e.path === 'items/fld-1.md');
    expect(item?.properties.status).toBe('done');
    expect(item?.properties).not.toHaveProperty('due');
    expect(item?.properties.estimate).toBe('XL'); // untouched key preserved
    const raw = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.get(
      'items/fld-1.md',
    ) as string;
    expect(raw.indexOf('type:')).toBeLessThan(raw.indexOf('key:')); // key order preserved
    expect(raw).toContain('project:'); // unknown-to-the-patch key preserved
  });

  it('createNote dedupes slugs with -2, -3 and returns the vault-relative path', async () => {
    const path = await mock.createNote(
      '/demo-vault',
      'items',
      'fld-1',
      { type: 'Work item', key: 'FLD-99' },
      '',
    );
    expect(path).toBe('items/fld-1-2.md');
    const again = await mock.createNote('/demo-vault', 'items', 'fld-1', { type: 'Work item' }, '');
    expect(again).toBe('items/fld-1-3.md');
    const entries = await mock.scanVault('/demo-vault');
    expect(entries.find((e) => e.path === 'items/fld-1-2.md')?.properties.key).toBe('FLD-99');
  });

  it('setNoteTitle rewrites the first H1', async () => {
    await mock.setNoteTitle('/demo-vault', 'items/fld-1.md', 'Renamed walkthrough');
    const entries = await mock.scanVault('/demo-vault');
    expect(entries.find((e) => e.path === 'items/fld-1.md')?.title).toBe('Renamed walkthrough');
  });

  // Parity with write.rs create_note: default H1 for empty bodies, no fence
  // block for an empty mapping, null-valued keys skipped on create.
  it('createNote defaults an empty body to a humanized H1 (exact bytes)', async () => {
    await mock.createNote('/demo-vault', 'items', 'empty-note', { type: 'Work item' }, '');
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    expect(fs.get('items/empty-note.md')).toBe('---\ntype: Work item\n---\n\n# Empty note\n');
  });

  it('createNote omits the fence block when the frontmatter map is empty', async () => {
    await mock.createNote('/demo-vault', 'items', 'no-fm', {}, 'Some body\n');
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    expect(fs.get('items/no-fm.md')).toBe('Some body\n');
  });

  it('createNote skips null-valued frontmatter keys', async () => {
    await mock.createNote(
      '/demo-vault',
      'items',
      'with-null',
      { type: 'Work item', due: null },
      'Body.\n',
    );
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    expect(fs.get('items/with-null.md')).toBe('---\ntype: Work item\n---\n\nBody.\n');
  });

  // Parity with write.rs replace_h1 (fence/indent-aware via first_h1_line_start).
  it('setNoteTitle skips H1-looking lines inside code fences', async () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    fs.set(
      'items/fenced.md',
      '---\ntype: Work item\n---\n\n```bash\n# comment in code\n```\n\n# Real title\n\nBody.\n',
    );
    await mock.setNoteTitle('/demo-vault', 'items/fenced.md', 'New title');
    const raw = fs.get('items/fenced.md') as string;
    expect(raw).toContain('# comment in code'); // fenced line untouched
    expect(raw).toContain('# New title');
    expect(raw).not.toContain('# Real title');
  });

  it('setNoteTitle prepends when the only H1 is inside a fence', async () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    fs.set('items/only-fenced.md', '```\n# only in code\n```\n');
    await mock.setNoteTitle('/demo-vault', 'items/only-fenced.md', 'Prepended');
    expect(fs.get('items/only-fenced.md')).toBe('# Prepended\n\n```\n# only in code\n```\n');
  });

  it('setNoteTitle replaces an H1 with up to 3 leading spaces', async () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    fs.set('items/indent.md', '  # Indented title\n\nBody.\n');
    await mock.setNoteTitle('/demo-vault', 'items/indent.md', 'Fixed');
    expect(fs.get('items/indent.md')).toBe('# Fixed\n\nBody.\n');
  });

  it('listViews is empty for the demo vault and saveView round-trips', async () => {
    expect(await mock.listViews('/demo-vault')).toEqual([]);
    await mock.saveView('/demo-vault', 'my-view', 'name: My view\n');
    expect(await mock.listViews('/demo-vault')).toEqual([
      { id: 'my-view', yaml: 'name: My view\n' },
    ]);
  });

  // --- Vault format v2 (M2 Task 3) — parity with scan.rs / write.rs ---

  it('scanVault resolves containment: nearest ancestor project.md wins', async () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    fs.set('projects/atlas/project.md', '---\ntype: Project\n---\n\n# Atlas\n');
    fs.set('projects/atlas/items/a1.md', '---\ntype: Work item\n---\n\n# One\n');
    fs.set('projects/atlas/sub/project.md', '---\ntype: Project\n---\n\n# Sub\n');
    fs.set('projects/atlas/sub/notes.md', '# Notes\n');
    fs.set('inbox/loose.md', '# Loose\n');
    const entries = await mock.scanVault('/demo-vault');
    const get = (p: string) => entries.find((e) => e.path === p)!;
    expect(get('projects/atlas/items/a1.md').project).toBe('projects/atlas/project.md');
    expect(get('projects/atlas/items/a1.md').folder).toBe('projects/atlas/items');
    expect(get('projects/atlas/sub/notes.md').project).toBe('projects/atlas/sub/project.md');
    expect(get('projects/atlas/project.md').project).toBe('projects/atlas/project.md');
    expect(get('inbox/loose.md').project).toBeNull();
  });

  it('renameNote moves a note, refuses to clobber, and moves folders', async () => {
    await mock.createFolder('/demo-vault', 'projects/atlas/items');
    await mock.renameNote('/demo-vault', 'items/fld-1.md', 'projects/atlas/items/fld-1.md');
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    expect(fs.has('items/fld-1.md')).toBe(false);
    expect(fs.has('projects/atlas/items/fld-1.md')).toBe(true);
    await expect(
      mock.renameNote('/demo-vault', 'items/fld-2.md', 'projects/atlas/items/fld-1.md'),
    ).rejects.toThrow('already exists');
    // Folder move: every key under the prefix relocates.
    await mock.renameNote('/demo-vault', 'items', 'archive');
    expect([...fs.keys()].some((p) => p.startsWith('items/'))).toBe(false);
    expect(fs.has('archive/fld-2.md')).toBe(true);
  });

  it('deleteNote removes notes or whole folders, throwing on unknown paths', async () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    await mock.deleteNote('/demo-vault', 'items/fld-1.md');
    expect(fs.has('items/fld-1.md')).toBe(false);
    await mock.deleteNote('/demo-vault', 'items');
    expect([...fs.keys()].some((p) => p.startsWith('items/'))).toBe(false);
    await expect(mock.deleteNote('/demo-vault', 'items/nope.md')).rejects.toThrow('not found');
  });

  it('listFolders derives dirs from paths, includes explicit empty folders, skips views', async () => {
    await mock.createFolder('/demo-vault', 'projects/empty-folder');
    await mock.saveView('/demo-vault', 'v', 'name: V\n');
    const dirs = await mock.listFolders('/demo-vault');
    expect(dirs).toContain('items');
    expect(dirs).toContain('projects/empty-folder');
    expect(dirs.some((d) => d === 'views' || d.startsWith('views/'))).toBe(false);
    expect([...dirs].sort()).toEqual(dirs);
  });
});
