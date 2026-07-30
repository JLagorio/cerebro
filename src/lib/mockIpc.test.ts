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
    const item = entries.find((e) => e.path === 'projects/guided-onboarding-ga/items/fld-1.md');
    expect(item?.title).toBe('First-run walkthrough GA');
    expect(item?.type).toBe('Work item');
    expect(item?.properties.key).toBe('FLD-1');
    // v2 containment: membership from the folder, not a `project:` link.
    expect(item?.project).toBe('projects/guided-onboarding-ga/project.md');
    expect(item?.relationships.assignee).toEqual(['ana-rios']);
  });

  it('exposes the file map for Playwright assertions', () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    expect(fs).toBeInstanceOf(Map);
    expect(fs.has('projects/guided-onboarding-ga/items/fld-1.md')).toBe(true);
  });

  it('readNote returns the body with frontmatter stripped', async () => {
    const body = await mock.readNote('/demo-vault', 'projects/guided-onboarding-ga/items/fld-1.md');
    expect(body.startsWith('# First-run walkthrough GA')).toBe(true);
    expect(body).not.toContain('---');
  });

  it('updateFrontmatter patches values, deletes nulls, preserves order and unknown keys', async () => {
    await mock.updateFrontmatter('/demo-vault', 'projects/guided-onboarding-ga/items/fld-1.md', { status: 'done', due: null });
    const entries = await mock.scanVault('/demo-vault');
    const item = entries.find((e) => e.path === 'projects/guided-onboarding-ga/items/fld-1.md');
    expect(item?.properties.status).toBe('done');
    expect(item?.properties).not.toHaveProperty('due');
    expect(item?.properties.estimate).toBe('XL'); // untouched key preserved
    const raw = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.get(
      'projects/guided-onboarding-ga/items/fld-1.md',
    ) as string;
    expect(raw.indexOf('type:')).toBeLessThan(raw.indexOf('key:')); // key order preserved
    expect(raw).toContain('assignee:'); // unknown-to-the-patch key preserved
  });

  it('createNote dedupes slugs with -2, -3 and returns the vault-relative path', async () => {
    const folder = 'projects/guided-onboarding-ga/items';
    const path = await mock.createNote(
      '/demo-vault',
      folder,
      'fld-1',
      { type: 'Work item', key: 'FLD-99' },
      '',
    );
    expect(path).toBe(`${folder}/fld-1-2.md`);
    const again = await mock.createNote('/demo-vault', folder, 'fld-1', { type: 'Work item' }, '');
    expect(again).toBe(`${folder}/fld-1-3.md`);
    const entries = await mock.scanVault('/demo-vault');
    expect(entries.find((e) => e.path === `${folder}/fld-1-2.md`)?.properties.key).toBe('FLD-99');
  });

  it('setNoteTitle rewrites the first H1', async () => {
    await mock.setNoteTitle('/demo-vault', 'projects/guided-onboarding-ga/items/fld-1.md', 'Renamed walkthrough');
    const entries = await mock.scanVault('/demo-vault');
    expect(entries.find((e) => e.path === 'projects/guided-onboarding-ga/items/fld-1.md')?.title).toBe('Renamed walkthrough');
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

  // M3.5: the demo vault now ships saved views, so assert the round trip
  // rather than an empty list.
  it('saveView round-trips into the global views/ dir', async () => {
    const before = await mock.listViews('/demo-vault');
    expect(before.every((v) => v.project === null)).toBe(true);
    await mock.saveView('/demo-vault', 'my-view', 'name: My view\n');
    const after = await mock.listViews('/demo-vault');
    expect(after).toContainEqual(
      expect.objectContaining({
        id: 'my-view',
        yaml: 'name: My view\n',
        project: null,
        collection: null,
        path: 'views/my-view.yml',
      }),
    );
    expect(after).toHaveLength(before.length + 1);
  });

  // Task 6 parity with write.rs: a views/ dir next to a project.md is scoped.
  it('listViews scopes project views and sorts globals first', async () => {
    await mock.saveView('/demo-vault', 'global', 'name: G\n');
    await mock.saveView('/demo-vault', 'delivery', 'name: D\n', 'projects/guided-onboarding-ga');
    const views = await mock.listViews('/demo-vault');
    expect(views).toContainEqual(
      expect.objectContaining({ id: 'global', yaml: 'name: G\n', project: null }),
    );
    expect(views).toContainEqual(
      expect.objectContaining({
        id: 'delivery',
        yaml: 'name: D\n',
        project: 'projects/guided-onboarding-ga/project.md',
      }),
    );
    // M10 sorts by (collection, project, id) — collection is now the PRIMARY
    // key, because it is the container the sidebar groups by. Within one
    // collection, globals still sort ahead of project-scoped views.
    const keys = views.map((v) => [v.collection ?? '', v.project ?? '', v.id].join('\u0000'));
    expect(keys).toEqual([...keys].sort());
    const uncollected = views.filter((v) => v.collection === null);
    const scopedFirst = uncollected.findIndex((v) => v.project !== null);
    const globalLast = uncollected.map((v) => v.project).lastIndexOf(null);
    expect(globalLast).toBeLessThan(scopedFirst);
  });

  // --- Collections (M10) — parity with write.rs ---

  it('saveList writes a *.list.yml and attributes it to its collection', async () => {
    await mock.saveCollection('/demo-vault', 'product', 'name: Product\n');
    await mock.saveList('/demo-vault', 'product', 'roadmap', 'name: Roadmap\n');
    // A plain sub-folder still belongs to the Collection above it.
    await mock.saveList('/demo-vault', 'product/q3', 'risks', 'name: Risks\n');
    await mock.saveList('/demo-vault', '', 'triage', 'name: Triage\n');

    const lists = await mock.listViews('/demo-vault');
    const find = (id: string) => lists.find((l) => l.id === id)!;
    expect(find('roadmap').collection).toBe('product');
    expect(find('roadmap').path).toBe('product/roadmap.list.yml');
    expect(find('risks').collection).toBe('product');
    expect(find('triage').collection).toBeNull();
    expect(find('triage').path).toBe('triage.list.yml');
  });

  it('listCollections finds every marked folder, nested ones included', async () => {
    // The seeded demo vault ships its own Collection, so assert on the ones
    // this test creates rather than on the whole list.
    await mock.saveCollection('/demo-vault', 'zz-ops', 'name: Ops\n');
    await mock.saveCollection('/demo-vault', 'zz-product', 'name: Product\n');
    await mock.saveCollection('/demo-vault', 'zz-product/platform', 'name: Platform\n');
    const found = await mock.listCollections('/demo-vault');
    expect(found.map((c) => c.folder).filter((f) => f.startsWith('zz-'))).toEqual([
      'zz-ops',
      'zz-product',
      'zz-product/platform',
    ]);
    expect(found.find((c) => c.folder === 'zz-product')!.yaml).toBe('name: Product\n');
    // Sorted overall, so the sidebar order is stable.
    expect(found.map((c) => c.folder)).toEqual([...found.map((c) => c.folder)].sort());
  });

  it('refuses to make the vault root a collection', async () => {
    await expect(mock.saveCollection('/demo-vault', '', 'name: Root\n')).rejects.toThrow();
  });

  // Legacy views keep loading with no collection, so a pre-M10 vault surfaces
  // its saved views at the top level rather than losing them.
  it('legacy views load beside M10 lists', async () => {
    await mock.saveView('/demo-vault', 'legacy', 'name: Legacy\n');
    await mock.saveCollection('/demo-vault', 'product', 'name: Product\n');
    await mock.saveList('/demo-vault', 'product', 'roadmap', 'name: Roadmap\n');
    const lists = await mock.listViews('/demo-vault');
    expect(lists.find((l) => l.id === 'legacy')!.collection).toBeNull();
    expect(lists.find((l) => l.id === 'roadmap')!.collection).toBe('product');
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
    await mock.renameNote('/demo-vault', 'projects/guided-onboarding-ga/items/fld-1.md', 'projects/atlas/items/fld-1.md');
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    expect(fs.has('projects/guided-onboarding-ga/items/fld-1.md')).toBe(false);
    expect(fs.has('projects/atlas/items/fld-1.md')).toBe(true);
    await expect(
      mock.renameNote('/demo-vault', 'projects/guided-onboarding-ga/items/fld-2.md', 'projects/atlas/items/fld-1.md'),
    ).rejects.toThrow('already exists');
    // Folder move: every key under the prefix relocates.
    await mock.renameNote('/demo-vault', 'projects/guided-onboarding-ga/items', 'archive');
    expect([...fs.keys()].some((p) => p.startsWith('projects/guided-onboarding-ga/items/'))).toBe(
      false,
    );
    expect(fs.has('archive/fld-2.md')).toBe(true);
  });

  it('deleteNote removes notes or whole folders, throwing on unknown paths', async () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    await mock.deleteNote('/demo-vault', 'projects/guided-onboarding-ga/items/fld-1.md');
    expect(fs.has('projects/guided-onboarding-ga/items/fld-1.md')).toBe(false);
    await mock.deleteNote('/demo-vault', 'projects/guided-onboarding-ga/items');
    expect([...fs.keys()].some((p) => p.startsWith('projects/guided-onboarding-ga/items/'))).toBe(
      false,
    );
    await expect(mock.deleteNote('/demo-vault', 'items/nope.md')).rejects.toThrow('not found');
  });

  // Parity with src-tauri/src/knowledge.rs. If these two backends disagree
  // the boundary "works" in dev and vitest and only fails in the packaged
  // app — the worst possible way to discover it.
  describe('knowledge/ read-only boundary (M5)', () => {
    const CONCEPT = 'knowledge/metrics/onboarding-completion.md';

    it('refuses every human write into the bundle', async () => {
      await expect(mock.saveNote('/demo-vault', CONCEPT, '# Rewritten')).rejects.toThrow(
        /read-only/,
      );
      await expect(
        mock.updateFrontmatter('/demo-vault', CONCEPT, { lifecycle: 'deprecated' }),
      ).rejects.toThrow(/read-only/);
      await expect(mock.setNoteTitle('/demo-vault', CONCEPT, 'Mine now')).rejects.toThrow(
        /read-only/,
      );
      await expect(
        mock.createNote('/demo-vault', 'knowledge/metrics', 'smuggled', {}, ''),
      ).rejects.toThrow(/read-only/);
      await expect(mock.createFolder('/demo-vault', 'knowledge/new')).rejects.toThrow(/read-only/);
    });

    it('refuses moves in both directions', async () => {
      // Out: would strip the concept of its boundary.
      await expect(mock.renameNote('/demo-vault', CONCEPT, 'docs/stolen.md')).rejects.toThrow(
        /read-only/,
      );
      // In: would smuggle human content into the agent's corpus.
      await expect(
        mock.renameNote('/demo-vault', 'inbox/welcome.md', 'knowledge/welcome.md'),
      ).rejects.toThrow(/read-only/);
    });

    it('leaves notes outside the bundle writable', async () => {
      await expect(
        mock.updateFrontmatter('/demo-vault', 'inbox/welcome.md', { type: 'Note' }),
      ).resolves.toBeUndefined();
    });

    it('allows verifyConcept, scoped to the verified key', async () => {
      const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
      await mock.verifyConcept('/demo-vault', CONCEPT, {
        verified: [{ by: 'human:josef', at: '2026-07-28T10:00:00Z' }],
      });
      expect(fs.get(CONCEPT)).toContain('human:josef');

      // Must not become a general-purpose bypass of the guard above.
      await expect(
        mock.verifyConcept('/demo-vault', CONCEPT, { verified: [], description: 'rewritten' }),
      ).rejects.toThrow(/may only write/);
      await expect(
        mock.verifyConcept('/demo-vault', 'inbox/welcome.md', { verified: [] }),
      ).rejects.toThrow(/only applies to/);
    });
  });

  it('listFolders derives dirs from paths, includes explicit empty folders, skips views', async () => {
    await mock.createFolder('/demo-vault', 'projects/empty-folder');
    await mock.saveView('/demo-vault', 'v', 'name: V\n');
    const dirs = await mock.listFolders('/demo-vault');
    expect(dirs).toContain('projects/guided-onboarding-ga/items');
    expect(dirs).toContain('projects/empty-folder');
    expect(dirs.some((d) => d === 'views' || d.startsWith('views/'))).toBe(false);
    expect([...dirs].sort()).toEqual(dirs);
  });
});
