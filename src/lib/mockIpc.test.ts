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

  it('listViews is empty for the demo vault and saveView round-trips', async () => {
    expect(await mock.listViews('/demo-vault')).toEqual([]);
    await mock.saveView('/demo-vault', 'my-view', 'name: My view\n');
    expect(await mock.listViews('/demo-vault')).toEqual([
      { id: 'my-view', yaml: 'name: My view\n' },
    ]);
  });
});
