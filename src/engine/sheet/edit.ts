import { parseDocument } from 'yaml';
import { encodeCsv } from '@/engine/csv';
import { splitFrontmatter } from '@/engine/frontmatter';
import {
  cellAddress,
  readSheetFences,
  type PageSheetFence,
  type SheetCellSource,
  type SheetInput,
} from './fence';
import { SHEET_LIMITS, sheetProblem, workbookProblem, sheetWord } from './limits';

export const SHEET_EDIT_LIMITS = {
  ops: 25,
  cells: 2_000,
  cell_chars: 10_000,
  sheet_name_chars: 31,
  max_row: SHEET_LIMITS.rows,
  max_column: SHEET_LIMITS.columns,
} as const;
export const SHEET_EDIT_SUFFIX = '\nNothing was written.';
export interface SheetEditRequest {
  path: string;
  ops: unknown[];
  expectHash?: string;
}
export interface WrittenSheetCell {
  sheet: string;
  row: number;
  col: number;
}
export interface SheetEditPlan {
  body: string;
  before: SheetInput[];
  after: SheetInput[];
  written: WrittenSheetCell[];
  ops: string[];
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function refuse(words: string): never {
  throw new Error(words + SHEET_EDIT_SUFFIX);
}
const chars = (text: string) => Array.from(text).length;
const sameName = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

/** Shape validation precedes write-door refusals; detailed ops are judged
 * against the bytes held by the door after its stale-version check. */
export function parseSheetEdit(input: unknown): SheetEditRequest {
  const value = object(input);
  if (!value || typeof value.path !== 'string' || !value.path.trim())
    throw new Error('edit_sheet needs a path');
  if (!Array.isArray(value.ops)) throw new Error('edit_sheet needs `ops`, a list of operations');
  return {
    path: value.path,
    ops: value.ops,
    ...(typeof value.expect_hash === 'string' ? { expectHash: value.expect_hash } : {}),
  };
}

export function sheetAddress(raw: unknown): { row: number; col: number } | null {
  if (typeof raw !== 'string') return null;
  const match = /^\$?([a-z]+)\$?([0-9]+)$/i.exec(raw.trim());
  if (!match) return null;
  const col = Array.from(match[1].toUpperCase()).reduce(
    (n, ch) => n * 26 + ch.charCodeAt(0) - 64,
    0,
  );
  const row = Number(match[2]);
  return Number.isSafeInteger(row) &&
    Number.isSafeInteger(col) &&
    row > 0 &&
    row <= 1_048_576 &&
    col <= 16_384
    ? { row, col }
    : null;
}

export function sheetNameValid(name: string): boolean {
  return (
    name.length > 0 &&
    chars(name) <= SHEET_EDIT_LIMITS.sheet_name_chars &&
    !/[\\/*?:[\]]/.test(name)
  );
}

/** The canonical source contains only filled inputs, with blank intermediate
 * rows retained. A lone --- must not become a frontmatter delimiter. */
export function encodeSheetRecords(
  cells: readonly SheetCellSource[],
  eol: '\n' | '\r\n' = '\n',
): string {
  const filled = cells.filter((cell) => cell.source !== '');
  const count = Math.max(0, ...filled.map((cell) => cell.row));
  const rows: string[][] = Array.from({ length: count }, () => []);
  for (const cell of filled) {
    const row = rows[cell.row - 1];
    while (row.length < cell.col) row.push('');
    row[cell.col - 1] = cell.source;
  }
  return encodeSheetMatrix(rows, eol);
}

/** Raw matrix writer also keeps CSV-import blank and padded trailing records. */
export function encodeSheetMatrix(
  rows: readonly (readonly string[])[],
  eol: '\n' | '\r\n' = '\n',
): string {
  return rows
    .map((row) =>
      row.length === 1 && row[0] === '---' ? `"---"${eol}` : encodeCsv([row], { eol }),
    )
    .join('');
}

export function encodeSheetSource(
  source: string,
  cells: readonly SheetCellSource[],
  eol: '\n' | '\r\n' = '\n',
): string {
  const { body, yaml } = splitFrontmatter(source);
  const prefix = source.slice(0, source.length - body.length);
  // A header closed at EOF needs a line ending before any new records.
  const header = yaml !== null && !prefix.endsWith('\n') ? prefix + eol : prefix;
  return header + encodeSheetRecords(cells, eol);
}

export function writeSheetFence(
  body: string,
  fence: PageSheetFence,
  cells: readonly SheetCellSource[],
): string {
  const opening = body.slice(fence.span[0], fence.contentSpan[0]);
  const closing = body.slice(fence.contentSpan[1], fence.span[1]);
  const eol = opening.endsWith('\r\n') ? '\r\n' : '\n';
  return opening + encodeSheetSource(fence.source, cells, eol) + closing;
}

/** Shared human/agent input validation; only the agent adds its op/suffix. */
export function normalizeSheetInput(raw: string, label: string): string {
  if (chars(raw) > SHEET_EDIT_LIMITS.cell_chars)
    throw new Error(`the value for ${label} is longer than 10,000 characters.`);
  if (Array.from(raw).some((ch) => ch.charCodeAt(0) <= 31 && !['\n', '\r', '\t'].includes(ch)))
    throw new Error(`the value for ${label} holds a control character a page can't carry.`);
  const value = raw.replace(/\r\n?/g, '\n');
  if (/^ {0,3}(?:`{3}|~{3})/m.test(value))
    throw new Error(
      `the value for ${label} has a line starting with \`\`\` or ~~~, which would end the sheet block.`,
    );
  return value;
}

function yamlName(name: string): string {
  try {
    const parsed = parseDocument(name);
    if (!parsed.errors.length && parsed.toJS({ maxAliasCount: 100 }) === name) return name;
  } catch {
    /* An alias-looking name is carried as a quoted scalar. */
  }
  return JSON.stringify(name);
}
function newFence(sheet: SheetInput, eol: '\n' | '\r\n'): string {
  return `\`\`\`cerebro-sheet${eol}---${eol}format: 1${eol}name: ${yamlName(sheet.name)}${eol}---${eol}${encodeSheetRecords(sheet.cells, eol)}\`\`\`${eol}`;
}
function normalized(sheets: SheetInput[]): SheetInput[] {
  return sheets.map((sheet) => ({
    name: sheet.name,
    cells: [...sheet.cells].sort((a, b) => a.row - b.row || a.col - b.col),
  }));
}

export function planSheetEdit(body: string, request: SheetEditRequest): SheetEditPlan {
  const fences = readSheetFences(body);
  const unavailable = fences.find((fence) => !fence.parsed.ok);
  if (unavailable && !unavailable.parsed.ok)
    refuse(
      `The sheet block on body line ${unavailable.line} can't be read (${unavailable.parsed.message}). Fix it first.`,
    );
  const { ops } = request;
  if (!ops.length) refuse('edit_sheet needs at least one op.');
  if (ops.length > SHEET_EDIT_LIMITS.ops)
    refuse(`edit_sheet takes at most 25 ops in one call; this call has ${ops.length}.`);
  const count = ops.reduce<number>(
    (total, op) =>
      total + (Array.isArray(object(op)?.cells) ? (object(op)!.cells as unknown[]).length : 0),
    0,
  );
  if (count > SHEET_EDIT_LIMITS.cells)
    refuse(
      `One edit_sheet call changes at most 2,000 cells; this one names ${count}. Split it into smaller calls.`,
    );
  const before = fences.map((fence) => ({
    name: fence.name,
    cells: fence.parsed.ok ? fence.parsed.cells.map((cell) => ({ ...cell })) : [],
  }));
  const after = before.map((sheet) => ({
    name: sheet.name,
    cells: sheet.cells.map((cell) => ({ ...cell })),
  }));
  const touched = new Set<number>();
  const written: WrittenSheetCell[] = [];
  const descriptions: string[] = [];
  for (const [index, raw] of ops.entries()) {
    const number = index + 1;
    const op = object(raw);
    if (!op || (op.op !== 'set_cells' && op.op !== 'add_sheet'))
      refuse(`Op ${number}: \`op\` must be set_cells or add_sheet.`);
    if (op.op === 'add_sheet') {
      if (typeof op.name !== 'string') refuse(`Op ${number}: add_sheet needs \`name\`.`);
      const name = op.name;
      if (!sheetNameValid(name))
        refuse(
          `Op ${number}: ${JSON.stringify(name)} can't name a sheet. Use 1 to 31 characters, none of \\ / * ? : [ ].`,
        );
      const existing = after.find((sheet) => sameName(sheet.name, name));
      if (existing)
        refuse(
          `Op ${number}: the page already has a sheet named ${JSON.stringify(existing.name)}.`,
        );
      after.push({ name, cells: [] });
      touched.add(after.length - 1);
      descriptions.push(`Added the sheet ${name}.`);
      continue;
    }
    if (typeof op.sheet !== 'string' || !Array.isArray(op.cells))
      refuse(`Op ${number}: set_cells needs \`sheet\` and \`cells\`, a list of {address, value}.`);
    const name = op.sheet;
    const sheetIndex = after.findIndex((sheet) => sameName(sheet.name, name));
    if (sheetIndex < 0)
      refuse(
        `Op ${number}: no sheet named ${JSON.stringify(name)} on this page. Its sheets: ${JSON.stringify(after.map((sheet) => sheet.name))}.`,
      );
    const sheet = after[sheetIndex];
    const used = new Set<string>();
    for (const rawCell of op.cells) {
      const cell = object(rawCell);
      const address = sheetAddress(cell?.address);
      if (!address)
        refuse(
          `Op ${number}: ${JSON.stringify(cell?.address ?? null)} is not a cell address. Use A1-style addresses without a sheet name.`,
        );
      const label = cellAddress(address.row, address.col);
      if (address.row > SHEET_LIMITS.rows || address.col > SHEET_LIMITS.columns)
        refuse(`Op ${number}: ${label} is past the 500 rows and 26 columns a sheet can hold.`);
      if (used.has(label)) refuse(`Op ${number}: ${label} appears twice in this op.`);
      used.add(label);
      if (typeof cell?.value !== 'string')
        refuse(
          `Op ${number}: the value for ${label} must be text, as you would type it into the cell.`,
        );
      let value: string;
      try {
        value = normalizeSheetInput(cell.value, label);
      } catch (error) {
        refuse(`Op ${number}: ${error instanceof Error ? error.message : String(error)}`);
      }
      sheet.cells = sheet.cells.filter(
        (cell) => cell.row !== address.row || cell.col !== address.col,
      );
      if (value) sheet.cells.push({ ...address, source: value });
      if (
        !written.some(
          (cell) =>
            cell.sheet === sheet.name && cell.row === address.row && cell.col === address.col,
        )
      )
        written.push({ sheet: sheet.name, ...address });
    }
    touched.add(sheetIndex);
    descriptions.push(
      `Set ${op.cells.length} ${op.cells.length === 1 ? 'cell' : 'cells'} on ${sheet.name}.`,
    );
  }
  const held = new Set<string>();
  for (const sheet of after) {
    const problem = !sheetNameValid(sheet.name)
      ? sheetWord('nameInvalid', { name: sheet.name })
      : held.has(sheet.name.toUpperCase())
        ? sheetWord('nameTaken', { name: sheet.name })
        : sheetProblem(sheet);
    if (problem) refuse(`The sheets couldn't be computed (${problem}).`);
    held.add(sheet.name.toUpperCase());
  }
  const problem = workbookProblem(after);
  if (problem) refuse(`The sheets couldn't be computed (${problem}).`);
  let planned = body;
  for (let index = fences.length - 1; index >= 0; index--)
    if (touched.has(index)) {
      const fence = fences[index];
      planned =
        planned.slice(0, fence.span[0]) +
        writeSheetFence(body, fence, after[index].cells) +
        planned.slice(fence.span[1]);
    }
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  for (const sheet of after.slice(fences.length)) {
    if (planned && !planned.endsWith(eol + eol)) planned += planned.endsWith(eol) ? eol : eol + eol;
    planned += newFence(sheet, eol);
  }
  const reread = readSheetFences(planned);
  const roundtrip = reread.every((fence) => fence.parsed.ok)
    ? reread.map((fence) => ({
        name: fence.name,
        cells: fence.parsed.ok ? fence.parsed.cells : [],
      }))
    : null;
  if (!roundtrip || JSON.stringify(normalized(roundtrip)) !== JSON.stringify(normalized(after)))
    refuse(
      'The edited page would not read back as the same sheets (an unclosed fence above them?).',
    );
  return {
    body: planned,
    before: normalized(before),
    after: normalized(after),
    written,
    ops: descriptions,
  };
}
