import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import { parseCsv } from './csv';
import { cellText, exportColumns, exportRows, guardFormula, viewCsv } from './csvExport';
import { buildSchema } from './schema';
import type { Entry, FieldKind, Presentation } from './types';

const type = makeEntry({
  path: 'types/book.md',
  title: 'Book',
  type: 'Type',
  properties: {
    statuses: [{ id: 'todo', label: 'To read', group: 'not-started' }],
    fields: {
      text: { kind: 'text' },
      amount: { kind: 'number', precision: 0 },
      read: { kind: 'checkbox' },
      day: { kind: 'date' },
      span: { kind: 'daterange' },
      status: { kind: 'status' },
      genre: { kind: 'select', options: [{ id: 'sf', label: 'Science fiction' }] },
      tags: {
        kind: 'multiselect',
        options: [
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ],
      },
      author: { kind: 'person', target: 'Person' },
      related: { kind: 'relation', target: 'Book' },
      created: { kind: 'created_time' },
    },
  } as unknown as Entry['properties'],
});
const book = makeEntry({
  path: 'books/dune.md',
  title: 'Dune, volume 1',
  type: 'Book',
  properties: {
    text: 'two\nlines',
    amount: -3.125,
    read: false,
    day: '2026-07-28T09:30',
    span: { start: '2026-07-28', end: '2026-07-29' },
    status: 'todo',
    genre: 'sf',
    tags: ['a', 'ghost'],
  } as unknown as Entry['properties'],
  relationships: { author: ['frank', 'unresolved'], related: ['sequel'] },
});
const author = makeEntry({ path: 'people/frank.md', title: 'Frank Herbert', type: 'Person' });
const sequel = makeEntry({ path: 'books/sequel.md', title: 'Dune Messiah', type: 'Book' });
const entries = [type, book, author, sequel];
const schema = buildSchema(entries);
const presentation: Presentation = { type: 'table', columns: [], group: [], sort: [] };
const source = { type: 'Book', project: null };

describe('CSV cells', () => {
  it.each([
    ['text', 'two\nlines'],
    ['amount', '-3.125'],
    ['read', 'false'],
    ['day', '2026-07-28T09:30'],
    ['span', '2026-07-28 → 2026-07-29'],
    ['status', 'To read'],
    ['genre', 'Science fiction'],
    ['tags', 'Alpha, ghost'],
    ['author', 'Frank Herbert, unresolved'],
    ['related', 'Dune Messiah'],
    ['created', book.createdAt],
    ['missing', ''],
  ])('exports %s with its value or readable label', (field, expected) =>
    expect(cellText(book, field, schema)).toBe(expected),
  );
  it('keeps ghost ids and does not invent zero for absent numbers', () => {
    const changed = { ...book, properties: { genre: 'unknown', status: 'ghost' } };
    expect(cellText(changed, 'genre', schema)).toBe('unknown');
    expect(cellText(changed, 'status', schema)).toBe('ghost');
    expect(cellText(changed, 'amount', schema)).toBe('');
  });
  it.each(['=1+1', '+cmd', '-cmd', '@sum', '\tcmd', '\rcmd'])(
    'guards formula-looking text %j',
    (value) => {
      expect(guardFormula(value, 'text')).toBe(`'${value}`);
      expect(guardFormula(value, 'number')).toBe(`'${value}`);
    },
  );
  it('leaves genuine numbers and booleans alone, while guarding a negative-looking text field', () => {
    expect(guardFormula('-3.125', 'number')).toBe('-3.125');
    expect(guardFormula('-3.125', 'text')).toBe("'-3.125");
    expect(guardFormula('false', 'checkbox')).toBe('false');
  });
});

describe('a saved view CSV', () => {
  it('exports only known visible columns in their order and defaults an unstated set', () => {
    expect(
      exportColumns(
        {
          ...presentation,
          columns: [
            { field: 'read' },
            { field: 'missing' },
            { field: 'amount', hidden: true },
            { field: 'text' },
          ],
        },
        source,
        [book],
        schema,
      ).map((field) => field.name),
    ).toEqual(['read', 'text']);
    expect(exportColumns(presentation, source, [book], schema).map((field) => field.name)).toEqual([
      'text',
      'amount',
      'read',
      'day',
      'span',
      'status',
    ]);
    expect(
      exportColumns(
        { ...presentation, columns: [{ field: 'text', hidden: true }] },
        source,
        [book],
        schema,
      ),
    ).toEqual([]);
  });
  it('keeps band order, emits a multi-band record once, and drops nested-only rows', () => {
    const first = {
      ...book,
      relationships: { related: ['sequel'] },
      properties: { tags: ['b', 'a'] },
    };
    const second = { ...sequel, properties: { tags: ['a'] } };
    const all = [type, first, second];
    const local = buildSchema(all);
    expect(
      exportRows([first, second], { ...presentation, group: [{ field: 'tags' }] }, local).map(
        (entry) => entry.path,
      ),
    ).toEqual([first.path, second.path]);
    expect(
      exportRows(
        [first],
        {
          ...presentation,
          group: [{ field: 'related', descend: { direction: 'forward', field: 'related' } }],
        },
        local,
        all,
      ).map((entry) => entry.path),
    ).toEqual([first.path]);
  });
  it('writes a BOM, Name header, CRLF records, and unrounded number cells', () => {
    const output = viewCsv(
      [book, sequel],
      { ...presentation, columns: [{ field: 'amount' }, { field: 'text' }], limit: 1 },
      source,
      schema,
      entries,
    );
    expect(output.rows).toBe(1);
    expect(output.csv).toBe('\uFEFFName,Amount,Text\r\n"Dune, volume 1",-3.125,"two\nlines"\r\n');
    expect(parseCsv(output.csv).rows).toEqual([['Dune, volume 1', '-3.125', 'two\nlines']]);
  });
  it('guards titles and exported property headers, even for hand-edited metadata', () => {
    const hostileType = makeEntry({
      ...type,
      properties: {
        fields: { '=cmd': { kind: 'text' as FieldKind } },
      } as unknown as Entry['properties'],
    });
    const hostile = { ...book, title: '=cmd', properties: { '=cmd': '=1+1' } };
    const output = viewCsv(
      [hostile],
      { ...presentation, columns: [{ field: '=cmd' }] },
      source,
      buildSchema([hostileType, hostile]),
    );
    expect(parseCsv(output.csv)).toMatchObject({
      headers: ['Name', "'=cmd"],
      rows: [["'=cmd", "'=1+1"]],
    });
  });
});
