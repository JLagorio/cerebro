import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeEntry } from '@/test/factories';
import { MAX_BATCH_OPS } from './batch';
import { parseCsv } from './csv';
import {
  inferKind,
  planCsvImport,
  viableKinds,
  type CsvImportDraft,
  type CsvKind,
} from './csvImport';
import { splitFrontmatter } from './frontmatter';
import { buildSchema } from './schema';

const draft = (csv: string, kinds?: CsvKind[]): CsvImportDraft => {
  const table = parseCsv(csv);
  return {
    name: 'Books',
    table,
    titleColumn: 0,
    columns: table.headers.map((name, index) => ({
      name: name.toLowerCase(),
      kind: kinds?.[index] ?? inferKind(table.rows.map((row) => row[index])),
    })),
  };
};
const plan = (value: CsvImportDraft, entries = [] as ReturnType<typeof makeEntry>[]) =>
  planCsvImport(value, entries, buildSchema(entries));
const metadata = (content: string) =>
  parse(splitFrontmatter(content).yaml ?? '') as Record<string, unknown>;

describe('CSV kind inference', () => {
  it.each([
    [['1', '-2.5', ''], 'number'],
    [['007', '008'], 'text'],
    [['1,200'], 'text'],
    [['$5'], 'text'],
    [['1e3'], 'text'],
    [['true', 'false', 'yes'], 'checkbox'],
    [['2026-10-15', '2026-11-01'], 'date'],
    [['2026-02-30'], 'text'],
    [['https://example.test/a', 'https://example.test/b'], 'url'],
    [['a@example.test'], 'email'],
    [['red', 'red', 'blue'], 'select'],
    [['red', 'blue', 'green'], 'text'],
    [['', ' '], 'text'],
  ] as [string[], CsvKind][])('infers %j as %s without discarding information', (cells, kind) => {
    expect(inferKind(cells)).toBe(kind);
    expect(viableKinds(cells)).toContain('text');
  });
});

describe('a CSV create plan', () => {
  it('creates the Type first, skips blank cells, and preserves YAML scalars and multiline strings', () => {
    const value = draft(
      'Title,Notes,Pages,Read,Empty\r\nDune,"A desert\r\nplanet",412,true,\r\n"One, two",": # null",9,false,\r\n,007,,yes,\r\n',
    );
    const result = plan(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records).toBe(3);
    expect(result.untitled).toBe(1);
    expect(result.ops.map((op) => op.path)).toEqual([
      'types/books.md',
      'records/books/dune.md',
      'records/books/one-two.md',
      'records/books/untitled.md',
    ]);
    expect(metadata(result.ops[0].content)).toMatchObject({
      type: 'Type',
      folder: 'records/books',
      fields: { notes: { kind: 'text' }, pages: { kind: 'number' }, read: { kind: 'checkbox' } },
    });
    expect(metadata(result.ops[1].content)).toEqual({
      type: 'Books',
      notes: 'A desert\nplanet',
      pages: 412,
      read: true,
    });
    expect(metadata(result.ops[2].content).notes).toBe(': # null');
    expect(metadata(result.ops[3].content)).toEqual({ type: 'Books', notes: '007', read: true });
    expect(splitFrontmatter(result.ops[3].content).body).toContain('# Untitled');
  });
  it('seeds select options with collision-free ids and stores their ids', () => {
    const result = plan(draft('Title,Label\nA,A B\nB,A-B\nC,A B'));
    if (!result.ok) throw new Error(result.reason);
    expect(metadata(result.ops[0].content)).toMatchObject({
      fields: {
        label: {
          kind: 'select',
          options: [
            { id: 'a-b', label: 'A B' },
            { id: 'a-b-2', label: 'A-B' },
          ],
        },
      },
    });
    expect(metadata(result.ops[1].content).label).toBe('a-b');
    expect(metadata(result.ops[2].content).label).toBe('a-b-2');
  });
  it('claims filenames case-insensitively and bounds long slugs', () => {
    const entries = [
      makeEntry({ path: 'types/BOOKS.md' }),
      makeEntry({ path: 'records/books/DUNE.md' }),
    ];
    const result = plan(
      draft(`Title\nDune\nDUNE\n${'a'.repeat(90)}\n${'word-'.repeat(20)}\n😀`),
      entries,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.ops.map((op) => op.path)).toEqual([
      'types/books-2.md',
      'records/books/dune-2.md',
      'records/books/dune-3.md',
      'records/books/row-3.md',
      `records/books/${'word-'.repeat(15)}word.md`,
      'records/books/row-5.md',
    ]);
  });
  it('refuses malformed rows and caps in words', () => {
    expect(plan(draft('Title\nA,B'))).toEqual({
      ok: false,
      reason: 'Row 2 has more values than the header.',
    });
    const value = draft('Title\nA');
    value.table.rows = Array.from({ length: MAX_BATCH_OPS }, () => ['A']);
    expect(plan(value)).toEqual({
      ok: false,
      reason: `One import can create up to ${MAX_BATCH_OPS - 1} records; this CSV has ${MAX_BATCH_OPS} rows.`,
    });
    const huge = draft('Title,Text\nA,B');
    huge.table.rows = [['A', 'x'.repeat(16 * 1024 * 1024)]];
    expect(plan(huge)).toMatchObject({ ok: false });
  });
});
