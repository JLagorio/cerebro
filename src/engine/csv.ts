import { utf8Length } from './comments';
import { IMPORT_MAX_BYTES } from './fileKinds';

export const CSV_MAX_BYTES = IMPORT_MAX_BYTES;
export const CSV_MAX_COLUMNS = 100;
export const CSV_MAX_COLUMN_NAME = 200;

export type CsvProblem =
  | { code: 'empty' | 'header' | 'noRows' | 'tooLarge' | 'encoding' }
  | { code: 'afterQuote' | 'unclosedQuote' | 'nul' | 'longRow'; row: number }
  | { code: 'columns' | 'columnName'; count: number };

export interface CsvTable {
  headers: string[];
  rows: string[][];
  /** Total nonblank data records, even when a caller bounds the preview. */
  rowCount: number;
  blankRows: number;
  problems: CsvProblem[];
}

export function csvProblemText(problem: CsvProblem): string {
  switch (problem.code) {
    case 'empty':
      return 'The CSV is empty.';
    case 'header':
      return 'The CSV needs a header row.';
    case 'noRows':
      return 'The CSV has a header and no rows.';
    case 'tooLarge':
      return 'Choose a CSV smaller than 16 MB.';
    case 'encoding':
      return 'This file isn’t UTF-8 text. Save it as “CSV UTF-8” and choose it again.';
    case 'afterQuote':
      return `Row ${problem.row}: text follows a closing quote.`;
    case 'unclosedQuote':
      return `Row ${problem.row}: a quote is never closed.`;
    case 'nul':
      return `Row ${problem.row} holds a NUL character.`;
    case 'longRow':
      return `Row ${problem.row} has more values than the header.`;
    case 'columns':
      return `A CSV can hold up to ${CSV_MAX_COLUMNS} columns; this one has ${problem.count}.`;
    case 'columnName':
      return `Column ${problem.count} has a name longer than ${CSV_MAX_COLUMN_NAME} characters.`;
  }
}

/** The one RFC 4180 scanner (M61.5, M67.1). Record callbacks keep database
 * previews bounded while sheet fences retain blank and ragged rows. */
function visitCsvRecords(
  text: string,
  onRow: (values: string[], row: number, hadQuotedField: boolean) => void,
  onProblem: (problem: CsvProblem) => void,
  delimiter: ',' | '\t' = ',',
): void {
  let values: string[] = [],
    field = '',
    quoted = false,
    afterQuote = false,
    record = 1;
  let dirty = false;
  let quotedField = false;
  const seen = new Set<string>();
  const problem = (code: 'afterQuote' | 'unclosedQuote' | 'nul') => {
    const key = `${code}:${record}`;
    if (!seen.has(key)) {
      seen.add(key);
      onProblem({ code, row: record });
    }
  };
  const endField = () => {
    values.push(field);
    field = '';
    afterQuote = false;
  };
  const endRow = () => {
    endField();
    const row = record++;
    const current = values;
    const hadQuotedField = quotedField;
    quotedField = false;
    values = [];
    dirty = false;
    seen.clear();
    onRow(current, row, hadQuotedField);
  };
  for (let at = 0; at < text.length; at++) {
    const ch = text[at];
    dirty = true;
    if (ch === '\0') problem('nul');
    if (quoted) {
      if (ch === '"') {
        if (text[at + 1] === '"') {
          field += '"';
          at++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else if (ch === '\r') {
        field += '\n';
        if (text[at + 1] === '\n') at++;
      } else field += ch;
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[at + 1] === '\n') at++;
      endRow();
      continue;
    }
    if (afterQuote) problem('afterQuote');
    if (ch === '"' && field === '' && !afterQuote) {
      quoted = true;
      quotedField = true;
    } else field += ch;
  }
  if (quoted) problem('unclosedQuote');
  if (dirty || values.length > 0 || field !== '') endRow();
}

export interface CsvRecords {
  records: string[][];
  problems: CsvProblem[];
}

/** Raw records, without headers, padding, trimming or blank-row removal.
 * Quoted line endings normalize to LF; record numbers count CSV records. */
export function readCsvRecords(raw: string, delimiter: ',' | '\t' = ','): CsvRecords {
  const result: CsvRecords = { records: [], problems: [] };
  if (utf8Length(raw) > CSV_MAX_BYTES) {
    result.problems.push({ code: 'tooLarge' });
    return result;
  }
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  visitCsvRecords(
    text,
    (row) => result.records.push(row),
    (problem) => result.problems.push(problem),
    delimiter,
  );
  return result;
}

/** Read database records with a named header and a bounded preview. */
export function parseCsv(
  raw: string,
  options: { maxRows?: number; delimiter?: ',' | '\t'; header?: boolean } = {},
): CsvTable {
  const result: CsvTable = { headers: [], rows: [], rowCount: 0, blankRows: 0, problems: [] };
  const maxRows = options.maxRows ?? Infinity;
  if (utf8Length(raw) > CSV_MAX_BYTES) {
    result.problems.push({ code: 'tooLarge' });
    return result;
  }
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  if (text === '') {
    result.problems.push({ code: 'empty' });
    return result;
  }
  visitCsvRecords(
    text,
    (current, row, hadQuotedField) => {
      // Process records as they arrive. A large import can count all rows while
      // retaining only the batch-sized preview, instead of allocating millions
      // of tiny arrays for a file we already know cannot be imported.
      if (result.headers.length === 0) {
        if (current.length === 1 && current[0].trim() === '' && !hadQuotedField) {
          result.blankRows++;
          return;
        }
        const names = new Set<string>();
        result.headers =
          options.header === false
            ? current.map((_, index) => `Column ${index + 1}`)
            : current.map((value, index) => {
                const base = value.trim() || `Column ${index + 1}`;
                if (base.length > CSV_MAX_COLUMN_NAME)
                  result.problems.push({ code: 'columnName', count: index + 1 });
                let name = base,
                  suffix = 2;
                while (names.has(name.toLowerCase())) name = `${base} ${suffix++}`;
                names.add(name.toLowerCase());
                return name;
              });
        if (result.headers.length > CSV_MAX_COLUMNS)
          result.problems.push({ code: 'columns', count: result.headers.length });
        if (options.header !== false) return;
      }
      if (current.every((value) => value.trim() === '')) {
        result.blankRows++;
        return;
      }
      result.rowCount++;
      if (result.rows.length >= maxRows) return;
      if (current.length > result.headers.length) result.problems.push({ code: 'longRow', row });
      result.rows.push([
        ...current,
        ...Array<string>(Math.max(0, result.headers.length - current.length)).fill(''),
      ]);
    },
    (problem) => {
      if (result.rowCount <= maxRows) result.problems.push(problem);
    },
    options.delimiter,
  );
  if (result.headers.length === 0) {
    result.problems.push({ code: 'header' });
    return result;
  }
  if (result.rowCount === 0) result.problems.push({ code: 'noRows' });
  return result;
}

/** Encode records with only necessary quotes. Exports keep CRLF by default;
 * source sheet fences may request their existing LF line ending. */
export function encodeCsv(
  rows: readonly (readonly string[])[],
  options: { eol?: '\n' | '\r\n' } = {},
): string {
  const eol = options.eol ?? '\r\n';
  return (
    rows
      .map((row) =>
        row
          .map((value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value))
          .join(','),
      )
      .join(eol) + eol
  );
}
