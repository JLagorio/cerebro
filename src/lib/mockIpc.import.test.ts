// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import * as mock from './mockIpc';
import { revertOps } from '@/engine/undoPlan';
import type { ImportBatchOp } from '@/engine/importPlan';
const vault = '/demo-vault';
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const request = (path: string, recordId = id, body = 'Original'): ImportBatchOp => ({
  op: 'import',
  system: 'linear',
  recordId,
  path,
  content: `---\ntype: Work item\n---\n${body}\n`,
});
const disk = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(() => mock.resetMockFs());
it('serializes concurrent imports of one identity into one page', async () => {
  const results = await Promise.all([
    mock.applyBatch(vault, [request('imports/a.md')]),
    mock.applyBatch(vault, [request('imports/b.md')]),
  ]);
  expect(results.flatMap((result) => result.imports?.map((row) => row.outcome))).toEqual([
    'created',
    'unchanged',
  ]);
  expect([...disk().keys()].filter((path) => path.startsWith('imports/'))).toEqual([
    'imports/a.md',
  ]);
});
it('undoes creates and replacements together and redoes their exact stamped bytes', async () => {
  await mock.applyBatch(vault, [request('imports/old.md')]);
  const before = disk().get('imports/old.md');
  const applied = await mock.applyBatch(vault, [
    request('imports/proposed.md', id, 'Updated'),
    request('imports/new.md', 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'),
  ]);
  const after = disk().get('imports/old.md');
  const undone = await mock.applyBatch(vault, revertOps(applied.files));
  expect(disk().get('imports/old.md')).toBe(before);
  expect(disk().has('imports/new.md')).toBe(false);
  await mock.applyBatch(vault, revertOps(undone.files));
  expect(disk().get('imports/old.md')).toBe(after);
  expect(disk().has('imports/new.md')).toBe(true);
});

const stamp = { actor: 'process:test-agent', runId: 'test-import-guard', approvedBy: null };
it('agent doors refuse stamp changes while ordinary body writes and human edits remain usable', async () => {
  const path = 'imports/guarded.md';
  await mock.applyBatch(vault, [request(path)]);
  const before = disk().get(path)!;
  for (const call of [
    () => mock.agentUpdateFrontmatter(vault, path, { import_hash: null }, undefined, stamp),
    () => mock.agentSetFields(vault, path, { set: { source_record_id: 'another' } }, stamp),
    () =>
      mock.agentCreate(
        vault,
        { folder: 'imports', slug: 'forged', body: '---\ngenerated: forged\n---\nBody' },
        stamp,
      ),
  ]) {
    await expect(call()).rejects.toThrow('Agent writes may not add, change or remove');
    expect(disk().get(path)).toBe(before);
    expect(disk().has('imports/forged.md')).toBe(false);
  }
  await mock.agentAppend(vault, path, 'An ordinary appendix.', undefined, stamp);
  const after = disk().get(path)!;
  expect(after).toContain('An ordinary appendix.');
  expect(after.split('\n---\n')[0]).toBe(before.split('\n---\n')[0]);
  await mock.updateFrontmatter(vault, path, { import_hash: 'person-edited' });
  expect(disk().get(path)).toContain('import_hash: "person-edited"');
});
it('closing a frontmatter fence cannot mint stamps through append or edit', async () => {
  const path = 'imports/fence.md';
  disk().set(path, '---\nsource_system: notion\n# close-me');
  const before = disk().get(path);
  await expect(mock.agentAppend(vault, path, '---\nBody', undefined, stamp)).rejects.toThrow(
    'source_system',
  );
  expect(disk().get(path)).toBe(before);
  await expect(
    mock.agentEdit(vault, path, [{ old: '# close-me', new: '---\nBody' }], undefined, stamp),
  ).rejects.toThrow('source_system');
  expect(disk().get(path)).toBe(before);
});
