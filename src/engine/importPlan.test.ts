import { expect, it } from 'vitest';
import { composeImport } from './importSources';
import { copyIndexOf, planImports, type ImportBatchOp, type ImportFile } from './importPlan';
const stamp = { now: '2026-10-13T10:00:00Z', actor: 'human:me' };
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const content = '---\ntype: Work item\n---\n# Imported\n';
const op: ImportBatchOp = {
  op: 'import',
  system: 'linear',
  recordId: id,
  path: 'records/imported.md',
  content,
};
const file = (path = op.path, body = content): ImportFile => ({
  path,
  content: composeImport(body, { system: op.system, recordId: id, ...stamp }).content,
});
const plan = (
  requests = [op],
  files: ImportFile[] = [],
  occupied: string[] = [],
  others: string[] = [],
) =>
  planImports(
    requests.map((op, index) => ({ index, op })),
    files,
    occupied,
    others,
    stamp,
  );
it('creates stamped pages and repeats one identity as a duplicate within its batch', () => {
  const result = plan([op, { ...op, path: 'another.md' }]);
  expect(result.writes).toHaveLength(1);
  expect(result.writes[0].op.content).toContain('source_system: "linear"');
  expect(result.imports.map((row) => row.outcome)).toEqual(['created', 'duplicate']);
  expect(result.imports[1].first).toBe(0);
});
it('keeps the first sorted copy wherever it moved and names additional copies', () => {
  const result = plan([op], [file('z.md'), file('moved/a.md')]);
  expect(result.writes).toEqual([]);
  expect(result.imports[0]).toMatchObject({
    path: 'moved/a.md',
    alsoAt: ['z.md'],
    outcome: 'unchanged',
  });
});
it('replaces unchanged imports with a read-hash check and preserves edits or unreadable stamps', () => {
  expect(plan([{ ...op, content: content + 'new\n' }], [file()]).writes[0].op).toMatchObject({
    op: 'replace_file',
    path: op.path,
    expectHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  const edited = file();
  edited.content += 'my edit\n';
  expect(plan([op], [edited]).imports[0]).toMatchObject({
    outcome: 'kept',
    reason: 'changed_since_import',
  });
  const reformatted = file();
  reformatted.content = reformatted.content.replace(
    'imported_by: "human:me"',
    "imported_by: 'human:me'",
  );
  expect(plan([op], [reformatted]).imports[0]).toMatchObject({
    outcome: 'kept',
    reason: 'stamp_unreadable',
  });
});
it('walks past occupied and batch-allocated names without ASCII case clashes', () => {
  const result = plan(
    [op, { ...op, recordId: id.replace('aaaaaaaa', 'bbbbbbbb') }],
    [],
    ['RECORDS/IMPORTED.MD'],
  );
  expect(result.imports.map((row) => row.path)).toEqual([
    'records/imported-2.md',
    'records/imported-3.md',
  ]);
});
it('ignores copies in protected roots and refuses another write to the planned path', () => {
  expect(copyIndexOf([file('knowledge/a.md'), file('sources/a.md')]).size).toBe(0);
  expect(() => plan([op], [], [], [op.path])).toThrow('planned twice');
  expect(() => plan([op], [file('moved/a.md')], [], ['moved/a.md'])).toThrow('planned twice');
});
it('two Notion spellings are one identity, and a duplicate still validates its payload', () => {
  const notion = { ...op, system: 'notion', recordId: '0123456789abcdef0123456789abcdef' };
  expect(
    plan([
      notion,
      { ...notion, recordId: 'https://www.notion.so/Page-01234567-89ab-cdef-0123-456789abcdef' },
    ]).imports[1].outcome,
  ).toBe('duplicate');
  expect(() => plan([op, { ...op, content: '---\nimport_hash: forged\n---\n' }])).toThrow(
    'Cerebro stamps',
  );
});
