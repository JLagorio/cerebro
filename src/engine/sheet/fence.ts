import { parseDocument } from 'yaml';
import { csvProblemText, readCsvRecords } from '@/engine/csv';
import { splitFrontmatter } from '@/engine/frontmatter';

/** A cerebro-sheet fence carries an optional YAML header (format: 1, name:)
 * followed by CSV source cells. Its info string is only the language: the
 * editor does not retain fence metadata. Excel input rules apply: a leading
 * apostrophe keeps text, =/+/- begin formulas, and 007 reads as 7. This is
 * separate from the field arithmetic dialect in engine/formula.ts. */
export const SHEET_FENCE = 'cerebro-sheet';

export interface SheetCellSource {
  row: number;
  col: number;
  source: string;
}
export interface SheetInput {
  name: string;
  cells: SheetCellSource[];
}
export type SheetCellKind = 'number' | 'text' | 'boolean' | 'error';
export interface SheetCellValue {
  row: number;
  col: number;
  kind: SheetCellKind;
  display: string;
}
export interface SheetComputed {
  ok: true;
  name: string;
  rows: number;
  cols: number;
  cells: SheetCellValue[];
}
export type SheetResult =
  | SheetComputed
  | {
      ok: false;
      name: string;
      problem: 'name_invalid' | 'name_taken' | 'too_large';
      message: string;
    };
export type SheetFence =
  | { ok: true; name: string; cells: SheetCellSource[]; rows: number; cols: number }
  | { ok: false; reason: 'format' | 'header' | 'csv'; message: string };

export function parseSheetFence(source: string): SheetFence {
  const { yaml, body } = splitFrontmatter(source);
  let name = '';
  if (yaml !== null) {
    const document = parseDocument(yaml);
    if (document.errors.length > 0)
      return {
        ok: false,
        reason: 'header',
        message: "This sheet's header isn't key: value lines.",
      };
    let header: unknown;
    try {
      header = document.toJS({ maxAliasCount: 100 });
    } catch {
      return {
        ok: false,
        reason: 'header',
        message: "This sheet's header isn't key: value lines.",
      };
    }
    if (typeof header !== 'object' || header === null || Array.isArray(header))
      return {
        ok: false,
        reason: 'header',
        message: "This sheet's header isn't key: value lines.",
      };
    const fields = header as Record<string, unknown>;
    if (fields.format !== undefined) {
      if (typeof fields.format !== 'number')
        return { ok: false, reason: 'format', message: "This sheet's format: isn't a number." };
      if (fields.format !== 1)
        return {
          ok: false,
          reason: 'format',
          message: `This sheet says format ${fields.format}. Cerebro reads format 1.`,
        };
    }
    if (fields.name !== undefined) {
      if (typeof fields.name !== 'string' && typeof fields.name !== 'number')
        return { ok: false, reason: 'header', message: "This sheet's name: must be text." };
      name = String(fields.name);
    }
  }
  const { records, problems } = readCsvRecords(body);
  if (problems.length) return { ok: false, reason: 'csv', message: csvProblemText(problems[0]) };
  // A final line ending is syntax, and extra blank lines at the end carry no
  // cells. Internal blanks still preserve every following row's address.
  while (
    records.length &&
    records[records.length - 1].length === 1 &&
    records[records.length - 1][0] === ''
  )
    records.pop();
  const cells: SheetCellSource[] = [];
  let cols = 0;
  records.forEach((row, r) => {
    cols = Math.max(cols, row.length);
    row.forEach((source, c) => {
      if (source !== '') cells.push({ row: r + 1, col: c + 1, source });
    });
  });
  return { ok: true, name, cells, rows: records.length, cols };
}

/** Ordinals include unreadable fences, so fixing one never renames its peers. */
export function sheetNames(fences: readonly SheetFence[]): string[] {
  return fences.map((fence, index) =>
    fence.ok && fence.name !== '' ? fence.name : `Sheet${index + 1}`,
  );
}

export function sheetRequest(fences: readonly SheetFence[]): {
  sheets: SheetInput[];
  slots: number[];
} {
  const names = sheetNames(fences);
  const sheets: SheetInput[] = [];
  const slots: number[] = [];
  fences.forEach((fence, index) => {
    if (!fence.ok) return;
    slots.push(index);
    sheets.push({ name: names[index], cells: fence.cells });
  });
  return { sheets, slots };
}

export function columnLabel(column: number): string {
  let result = '';
  for (let at = column; at > 0; at = Math.floor((at - 1) / 26))
    result = String.fromCharCode(65 + ((at - 1) % 26)) + result;
  return result;
}

export function cellAddress(row: number, col: number): string {
  return `${columnLabel(col)}${row}`;
}

interface SheetSourceBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  children?: readonly SheetSourceBlock[];
}

/** The document, not the mounted node views, determines a sheet's ordinal.
 * Columns, toggles and AI answers participate in the same page workbook. */
export function sheetSourcesOf(
  blocks: readonly SheetSourceBlock[],
): { id: string; source: string }[] {
  return blocks.flatMap((block) => [
    ...(block.type === 'sheet'
      ? [
          {
            id: block.id ?? '',
            source: typeof block.props?.source === 'string' ? block.props.source : '',
          },
        ]
      : []),
    ...sheetSourcesOf(block.children ?? []),
  ]);
}

export interface FenceOpening {
  marker: string;
  language: string;
}
/** CommonMark backtick/tilde fences, up to three spaces of indentation. */
export function fenceOpening(line: string): FenceOpening | null {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r]*)\r?$/.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { marker: match[1], language: match[2].trim().split(/\s/, 1)[0] };
}
export function fenceCloses(line: string, marker: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  return !!match && match[1][0] === marker[0] && match[1].length >= marker.length;
}

export interface PageSheetFence {
  /** UTF-16 offsets for JS splicing; shared replay converts these to UTF-8 bytes. */
  span: [number, number];
  line: number;
  bodyLines: [number, number];
  contentSpan: [number, number];
  source: string;
  name: string;
  parsed: SheetFence;
}

/** Source spans, rather than a markdown reserializer, keep every untouched
 * block and delimiter byte intact. Other fenced code hides its examples. */
export function readSheetFences(body: string): PageSheetFence[] {
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length);
  const fences: PageSheetFence[] = [];
  for (let at = 0; at < lines.length;) {
    const opening = fenceOpening(lines[at].replace(/\n$/, ''));
    if (!opening) {
      at++;
      continue;
    }
    let end = at + 1;
    while (end < lines.length && !fenceCloses(lines[end].replace(/\n$/, ''), opening.marker)) end++;
    const closed = end < lines.length;
    if (opening.language === SHEET_FENCE) {
      const start = offsets[at + 1],
        contentEnd = offsets[end];
      const raw = body.slice(start, contentEnd);
      const source = closed ? raw.replace(/\r?\n$/, '') : raw;
      const parsed: SheetFence = closed
        ? parseSheetFence(source)
        : {
            ok: false,
            reason: 'header',
            message: 'This sheet block has no closing fence.',
          };
      fences.push({
        span: [offsets[at], offsets[closed ? end + 1 : end]],
        line: at + 1,
        bodyLines: [at + 2, end],
        contentSpan: [start, contentEnd],
        source,
        name: parsed.ok && parsed.name ? parsed.name : `Sheet${fences.length + 1}`,
        parsed,
      });
    }
    at = closed ? end + 1 : lines.length;
  }
  return fences;
}
