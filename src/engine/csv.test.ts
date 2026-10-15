import { describe, expect, it } from 'vitest';
import {
  CSV_MAX_BYTES,
  CSV_MAX_COLUMNS,
  encodeCsv,
  parseCsv,
  readCsvRecords,
  csvProblemText,
} from './csv';

describe('the CSV reader and writer', () => {
  it('reads tab delimiters, quoted tabs and newlines without changing comma parsing', () => {
    const source = 'Name\tNotes\nA,B\t"one\ttwo\nthree"';
    expect(parseCsv(source, { delimiter: '\t' })).toMatchObject({
      headers: ['Name', 'Notes'],
      rows: [['A,B', 'one\ttwo\nthree']],
      problems: [],
    });
    expect(parseCsv('A,B\n1,2').rows).toEqual([['1', '2']]);
    expect(parseCsv('A\tB\n1\t2', { delimiter: '\t', header: false })).toMatchObject({
      headers: ['Column 1', 'Column 2'],
      rows: [
        ['A', 'B'],
        ['1', '2'],
      ],
      rowCount: 2,
    });
  });
  it('reads sheet records without consuming a header, padding, trimming or skipping blanks', () => {
    expect(readCsvRecords(' A ,B\n\n1\n2,3,4\n')).toEqual({
      records: [[' A ', 'B'], [''], ['1'], ['2', '3', '4']],
      problems: [],
    });
    expect(readCsvRecords('')).toEqual({ records: [], problems: [] });
  });
  it.each(['\n', '\r\n', '\r'])(
    'reads quoted and unquoted %j endings through the same scanner',
    (eol) => {
      expect(readCsvRecords(`"a${eol}b",c${eol}d`).records).toEqual([['a\nb', 'c'], ['d']]);
    },
  );
  it('reports raw-record problems without changing their record number', () => {
    expect(readCsvRecords('x\n"two\nlines"x\n"never').problems).toEqual([
      { code: 'afterQuote', row: 2 },
      { code: 'unclosedQuote', row: 3 },
    ]);
  });
  it('keeps an explicitly quoted blank header as one unnamed column', () => {
    expect(parseCsv('""\nA')).toMatchObject({
      headers: ['Column 1'],
      rows: [['A']],
      rowCount: 1,
      problems: [],
    });
  });
  it('bounds a preview without losing the count of records or leading blanks', () => {
    const table = parseCsv('\n'.repeat(10000) + 'Title\n' + 'A\n'.repeat(10000), { maxRows: 3 });
    expect(table.rows).toEqual([['A'], ['A'], ['A']]);
    expect(table.rowCount).toBe(10000);
    expect(table.blankRows).toBe(10000);
    expect(table.problems).toEqual([]);
  });
  it('reads quoted commas, escaped quotes and quoted line endings as text', () => {
    const table = parseCsv(
      'Title,Notes\r\nDune,"A desert\r\nplanet"\r\n"One, two","Say ""hello""\nagain"\r\nPlain,a"b\r\n',
    );
    expect(table.problems).toEqual([]);
    expect(table.rows).toEqual([
      ['Dune', 'A desert\nplanet'],
      ['One, two', 'Say "hello"\nagain'],
      ['Plain', 'a"b'],
    ]);
  });
  it.each(['\r\n', '\n', '\r'])('accepts %j record endings and one leading BOM', (ending) => {
    expect(parseCsv(`\uFEFFTitle,Value${ending}A,1${ending}B,2`).rows).toEqual([
      ['A', '1'],
      ['B', '2'],
    ]);
  });
  it('trims names, fills blanks and deduplicates them case-insensitively', () => {
    expect(parseCsv(' Title ,title,,Title 2\nA,B,C,D').headers).toEqual([
      'Title',
      'title 2',
      'Column 3',
      'Title 2 2',
    ]);
  });
  it('counts blanks, pads short rows, and numbers long rows by record rather than quoted line', () => {
    const table = parseCsv('Title,Notes\n\nA\nB,"two\nlines"\n,,,\nC,D,E\n');
    expect(table.blankRows).toBe(2);
    expect(table.rows).toEqual([
      ['A', ''],
      ['B', 'two\nlines'],
      ['C', 'D', 'E'],
    ]);
    expect(table.problems).toEqual([{ code: 'longRow', row: 6 }]);
  });
  it.each([
    ['', 'The CSV is empty.'],
    ['\n \n', 'The CSV needs a header row.'],
    ['Title\n', 'The CSV has a header and no rows.'],
    ['Title\n"A"x', 'Row 2: text follows a closing quote.'],
    ['Title\n"A', 'Row 2: a quote is never closed.'],
    ['Title\nA\u0000', 'Row 2 holds a NUL character.'],
  ])('names the problem in %j', (raw, expected) => {
    expect(parseCsv(raw).problems.map(csvProblemText)).toContain(expected);
  });
  it('enforces byte, column and header limits before import', () => {
    expect(parseCsv('é'.repeat(CSV_MAX_BYTES / 2 + 1)).problems).toEqual([{ code: 'tooLarge' }]);
    expect(
      parseCsv(
        Array(CSV_MAX_COLUMNS + 1)
          .fill('a')
          .join(','),
      ).problems,
    ).toContainEqual({ code: 'columns', count: 101 });
    expect(parseCsv('a'.repeat(201) + '\nx').problems).toContainEqual({
      code: 'columnName',
      count: 1,
    });
  });
  it('lets source carriers choose LF while exports keep CRLF', () => {
    expect(
      encodeCsv(
        [
          ['a', 'b'],
          ['c,d', 'e'],
        ],
        { eol: '\n' },
      ),
    ).toBe('a,b\n"c,d",e\n');
    expect(encodeCsv([['a']])).toBe('a\r\n');
  });
  it('round-trips Unicode, quotes, commas, newlines and blank cells with CRLF records', () => {
    const rows = [
      ['Title', 'Text', 'Empty'],
      ['A 😀', 'a,b', ''],
      ['B', '"x"\ny', ''],
    ];
    const encoded = encodeCsv(rows);
    expect(encoded).toBe('Title,Text,Empty\r\nA 😀,"a,b",\r\nB,"""x""\ny",\r\n');
    const parsed = parseCsv(encoded);
    expect([parsed.headers, ...parsed.rows]).toEqual(rows);
    expect(parsed.problems).toEqual([]);
  });
});
