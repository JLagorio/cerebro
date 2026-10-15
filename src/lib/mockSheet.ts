import type { Model } from '@ironcalc/wasm';
import type {
  FillAxis,
  FillResult,
  FormulaCell,
  GridChange,
  RestructureResult,
} from '@/engine/sheet/gridEdit';
import { fillProblem, gridChangeProblem, preOpCell } from '@/engine/sheet/gridEdit';
import type { Area } from '@/engine/sheet/selection';
import type { CompletionContext } from '@/engine/sheet/formulaComplete';
import type { WrittenSheetCell } from '@/engine/sheet/edit';
import { cellAddress } from '@/engine/sheet/fence';
import type { SheetCellValue, SheetInput, SheetResult } from '@/engine/sheet/fence';
import {
  SHEET_LIMITS,
  SHEET_WORDS,
  sheetProblem,
  workbookProblem,
  sheetWord as word,
} from '@/engine/sheet/limits';
export { SHEET_LIMITS, SHEET_WORDS, literalArraySize } from '@/engine/sheet/limits';

/** Browser-only twin of sheet/engine.rs, held by sheet-calc-cases.json.
 * Rust is the packaged engine; the mock runs the identical upstream release. */
type RawValue = string | number | boolean | null;
type Engine = Pick<typeof import('@ironcalc/wasm'), 'Model' | 'getTokens'> & {
  readValues?: (bytes: Uint8Array) => Map<string, RawValue>;
};
let loading: Promise<Engine> | null = null;
export function loadEngine(): Promise<Engine> {
  loading ??= (async () => {
    const engine = await import('@ironcalc/wasm');
    const { default: wasm } = await import('@ironcalc/wasm/wasm_bg.wasm?url');
    await engine.default({ module_or_path: wasm });
    const { default: valuesUrl } = await import('./sheetValues/values.wasm?url');
    const response = await fetch(valuesUrl);
    if (!response.ok) throw new Error('The sheet value reader could not load.');
    const readValues = cachedValueReader(await response.arrayBuffer());
    return { ...engine, readValues };
  })().catch(() => {
    loading = null;
    throw new Error("The sheet engine couldn't load in this browser.");
  });
  return loading;
}

/** 0.8.3 compares new names ignoring case but resolves references by exact
 * spelling. Normalize known sheet tokens only in the calculation copy.
 * Upstream token offsets count Unicode characters, not UTF-16 code units. */
function sheetReferences(engine: Engine, source: string, names: Map<string, string>): string {
  if (!/^[=+-]/.test(source)) return source;
  const characters = Array.from(source);
  const tokens = engine.getTokens(source);
  for (let index = tokens.length - 1; index >= 0; index--) {
    const { token, start, end } = tokens[index];
    if (typeof token !== 'object') continue;
    const name =
      'Reference' in token ? token.Reference.sheet : 'Range' in token ? token.Range.sheet : null;
    if (!name) continue;
    const actual = names.get(name.toUpperCase());
    if (actual === undefined || actual === name) continue;
    const text = characters.slice(start, end).join('');
    const bang = text.lastIndexOf('!');
    if (bang < 0) continue;
    const prefix = text.match(/^\s*/)?.[0] ?? '';
    const replacement = `${prefix}'${actual.replaceAll("'", "''")}'${text.slice(bang)}`;
    characters.splice(start, end - start, ...Array.from(replacement));
  }
  return characters.join('');
}

function withCalculation<T>(
  engine: Engine,
  sheets: SheetInput[],
  zone: string,
  read: (model: Model | null, results: SheetResult[], raw: Map<string, RawValue>) => T,
  rawValues = false,
  paused = false,
): T {
  const problem = workbookProblem(sheets);
  if (problem) throw new Error(problem);
  if (!sheets.length) return read(null, [], new Map());
  let model: Model | undefined;
  try {
    try {
      model = new engine.Model('cerebro', 'en', zone, 'en');
    } catch {
      model = new engine.Model('cerebro', 'en', 'UTC', 'en');
    }
    model.pauseEvaluation();
    let prefix = '__cerebro_';
    const requested = new Set(sheets.map((sheet) => sheet.name.toUpperCase()));
    while (sheets.some((_, index) => requested.has(`${prefix}${index}`.toUpperCase())))
      prefix += '_';
    // Rename each new sheet immediately so a requested Sheet1 never collides
    // with a default sheet the engine has yet to rename.
    for (let index = 0; index < sheets.length; index++) {
      if (index) model.newSheet();
      model.renameSheet(index, `${prefix}${index}`);
    }
    const results: SheetResult[] = [];
    const held = new Map<string, string>();
    for (const [index, sheet] of sheets.entries()) {
      const message = sheetProblem(sheet);
      if (message) {
        results.push({ ok: false, name: sheet.name, problem: 'too_large', message });
        continue;
      }
      try {
        model.renameSheet(index, sheet.name);
      } catch {
        const taken = held.has(sheet.name.toUpperCase());
        results.push({
          ok: false,
          name: sheet.name,
          problem: taken ? 'name_taken' : 'name_invalid',
          message: word(taken ? 'nameTaken' : 'nameInvalid', { name: sheet.name }),
        });
        continue;
      }
      held.set(sheet.name.toUpperCase(), sheet.name);
      results.push({ ok: true, name: sheet.name, rows: 0, cols: 0, cells: [] });
    }
    for (const formulas of [false, true]) {
      sheets.forEach((sheet, index) => {
        if (!results[index].ok) return;
        for (const cell of sheet.cells)
          if (/^[=+-]/.test(cell.source) === formulas)
            model!.setUserInput(
              index,
              cell.row,
              cell.col,
              sheetReferences(engine, cell.source, held),
            );
      });
    }
    if (paused) return read(model, results, new Map());
    model.resumeEvaluation();
    model.evaluate();
    results.forEach((result, index) => {
      if (!result.ok) return;
      const positions = new Set<string>();
      for (const cell of sheets[index].cells) {
        positions.add(`${cell.row}:${cell.col}`);
        result.rows = Math.max(result.rows, cell.row);
        result.cols = Math.max(result.cols, cell.col);
        const structure = model!.getCellArrayStructure(index, cell.row, cell.col);
        if (typeof structure !== 'object') continue;
        const size =
          'DynamicAnchor' in structure
            ? structure.DynamicAnchor
            : 'ArrayAnchor' in structure
              ? structure.ArrayAnchor
              : null;
        if (!size) continue;
        const lastRow = Math.min(SHEET_LIMITS.rows, cell.row + size[1] - 1);
        const lastCol = Math.min(SHEET_LIMITS.columns, cell.col + size[0] - 1);
        result.rows = Math.max(result.rows, lastRow);
        result.cols = Math.max(result.cols, lastCol);
        for (let row = cell.row; row <= lastRow; row++)
          for (let col = cell.col; col <= lastCol; col++)
            if (model!.getFormattedCellValue(index, row, col) !== '')
              positions.add(`${row}:${col}`);
      }
      result.cells = [...positions]
        .map((position): SheetCellValue => {
          const [row, col] = position.split(':').map(Number);
          const type = model!.getCellType(index, row, col);
          return {
            row,
            col,
            kind: type === 16 ? 'error' : type === 4 ? 'boolean' : type === 1 ? 'number' : 'text',
            display: model!.getFormattedCellValue(index, row, col),
          };
        })
        .sort((a, b) => a.row - b.row || a.col - b.col);
    });
    const raw = rawValues ? engine.readValues?.(model.toBytes()) : new Map<string, RawValue>();
    if (raw === undefined) throw new Error('The sheet value reader is unavailable.');
    return read(model, results, raw);
  } catch (error) {
    if (paused)
      throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
    throw new Error(SHEET_WORDS.stopped, { cause: error });
  } finally {
    model?.free();
  }
}

export function calculateWith(engine: Engine, sheets: SheetInput[], zone: string): SheetResult[] {
  return withCalculation(engine, sheets, zone, (_model, results) => results);
}

export interface ReportCell {
  sheet: string;
  address: string;
  source: string;
  type: 'blank' | 'text' | 'number' | 'boolean' | 'error';
  value: string | number | boolean | null;
  display: string;
  error?: string;
}
export interface SheetEditReport {
  changed: ReportCell[];
  changed_total: number;
  errors: { sheet: string; address: string; error: string; new: boolean }[];
  errors_total: number;
}
function reportCells(engine: Engine, sheets: SheetInput[], zone: string): Map<string, ReportCell> {
  return withCalculation(
    engine,
    sheets,
    zone,
    (_model, results, raw) => {
      const cells = new Map<string, ReportCell>();
      results.forEach((result, index) => {
        if (!result.ok) throw new Error(result.message);
        for (const cell of result.cells) {
          const address = cellAddress(cell.row, cell.col);
          const source =
            sheets[index].cells.find((c) => c.row === cell.row && c.col === cell.col)?.source ?? '';
          const cached = raw.get(`${index}:${cell.row}:${cell.col}`);
          const value = cell.kind === 'error' ? null : cached;
          if (value === undefined || (cell.kind === 'number' && typeof value !== 'number'))
            throw new Error(SHEET_WORDS.stopped);
          cells.set(`${index}:${cell.row}:${cell.col}`, {
            sheet: result.name,
            address,
            source,
            type: cell.kind,
            value,
            display: cell.display,
            ...(cell.kind === 'error' ? { error: cell.display } : {}),
          });
        }
      });
      return cells;
    },
    true,
  );
}
export function editReportWith(
  engine: Engine,
  before: SheetInput[],
  after: SheetInput[],
  written: WrittenSheetCell[],
  zone = 'UTC',
): SheetEditReport {
  const old = reportCells(engine, before, zone);
  const next = reportCells(engine, after, zone);
  const order = new Set<string>();
  for (const cell of written) {
    const index = after.findIndex((sheet) => sheet.name === cell.sheet);
    if (index >= 0) order.add(`${index}:${cell.row}:${cell.col}`);
  }
  for (const [index, sheet] of after.entries()) {
    const previous = before.findIndex((s) => s.name === sheet.name);
    const positions = new Set<string>();
    for (const key of next.keys())
      if (key.startsWith(`${index}:`)) positions.add(key.slice(key.indexOf(':') + 1));
    for (const key of old.keys())
      if (key.startsWith(`${previous}:`)) positions.add(key.slice(key.indexOf(':') + 1));
    for (const position of [...positions].sort((a, b) => {
      const [ar, ac] = a.split(':').map(Number);
      const [br, bc] = b.split(':').map(Number);
      return ar - br || ac - bc;
    }))
      order.add(`${index}:${position}`);
  }
  const blank = (sheet: string, row: number, col: number): ReportCell => ({
    sheet,
    address: cellAddress(row, col),
    source: '',
    type: 'blank',
    value: null,
    display: '',
  });
  const previous = (index: number, row: number, col: number) =>
    old.get(`${before.findIndex((s) => s.name === after[index].name)}:${row}:${col}`) ??
    blank(after[index].name, row, col);
  const changed: ReportCell[] = [];
  let changed_total = 0;
  for (const key of order) {
    const [index, row, col] = key.split(':').map(Number);
    const cell = next.get(key) ?? blank(after[index].name, row, col);
    if (JSON.stringify(cell) !== JSON.stringify(previous(index, row, col))) {
      changed_total++;
      if (changed.length < 200) changed.push(cell);
    }
  }
  const errors: SheetEditReport['errors'] = [];
  let errors_total = 0;
  for (const [key, cell] of next)
    if (cell.type === 'error') {
      errors_total++;
      const [index, row, col] = key.split(':').map(Number);
      if (errors.length < 50)
        errors.push({
          sheet: cell.sheet,
          address: cell.address,
          error: cell.error!,
          new: previous(index, row, col).type !== 'error',
        });
    }
  return { changed, changed_total, errors, errors_total };
}
export async function sheetEditReport(
  before: SheetInput[],
  after: SheetInput[],
  written: WrittenSheetCell[],
): Promise<SheetEditReport> {
  return editReportWith(
    await loadEngine(),
    before,
    after,
    written,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
}

/** Read the pinned engine's serialized cached values without evaluating or
 * altering its workbook. The project-owned wasm facade uses upstream's own
 * decoder and Cell::value, so precision and formula introspection stay exact. */
export function cachedValueReader(
  bytes: BufferSource,
): (snapshot: Uint8Array) => Map<string, RawValue> {
  const module = new WebAssembly.Module(bytes);
  const imports: WebAssembly.Imports = {};
  for (const item of WebAssembly.Module.imports(module)) {
    // Upstream wasm-bindgen emits descriptor exports even in this read-only
    // facade. None of our four ABI functions calls them. Fail closed if an
    // updated build unexpectedly tries to reach JavaScript through one.
    if (
      item.kind !== 'function' ||
      !['__wbindgen_placeholder__', '__wbindgen_externref_xform__'].includes(item.module)
    )
      throw new Error('Unexpected sheet value reader import.');
    const group = (imports[item.module] ??= {});
    group[item.name] = () => {
      throw new Error('The sheet value reader called an unused upstream binding.');
    };
  }
  const exports = new WebAssembly.Instance(module, imports).exports as {
    memory: WebAssembly.Memory;
    input_buffer: (length: number) => number;
    read_values: () => number;
    output_len: () => number;
    release_buffers: () => void;
  };
  return (snapshot) => {
    if (snapshot.byteLength > 64 * 1024 * 1024)
      throw new Error('The calculation snapshot is too large.');
    try {
      const input = exports.input_buffer(snapshot.byteLength);
      if (!input) throw new Error('The calculation snapshot could not be allocated.');
      new Uint8Array(exports.memory.buffer, input, snapshot.byteLength).set(snapshot);
      const output = exports.read_values();
      const answer = JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(exports.memory.buffer, output, exports.output_len()),
        ),
      ) as {
        ok: boolean;
        cells?: { sheet: number; row: number; col: number; value: RawValue }[];
        error?: string;
      };
      if (!answer.ok || !Array.isArray(answer.cells))
        throw new Error(answer.error ?? 'The calculation snapshot could not be read.');
      return new Map(answer.cells.map((c) => [`${c.sheet}:${c.row}:${c.col}`, c.value]));
    } finally {
      exports.release_buffers();
    }
  };
}

/** Reference edits run paused, and return formula text without evaluating. */
export function restructureWith(
  engine: Engine,
  sheets: SheetInput[],
  sheet: number,
  change: GridChange,
  at: number,
  count: number,
): RestructureResult {
  const problem = gridChangeProblem(sheets, sheet, change, at, count);
  if (problem) throw new Error(problem);
  return withCalculation(
    engine,
    sheets,
    'UTC',
    (model, results) => {
      for (const result of results) if (!result.ok) throw new Error(result.message);
      if (!model) throw new Error("That sheet isn't on this page.");
      const formulas = (): FormulaCell[] => {
        const found: FormulaCell[] = [];
        for (let index = 0; index < sheets.length; index++) {
          for (let column = 1; column <= SHEET_LIMITS.columns; column++) {
            for (const row of model.getRowsWithData(index, column)) {
              const source = model.getCellContent(index, row, column);
              if (source.startsWith('='))
                found.push({ sheet: index, row: row - 1, column: column - 1, source });
            }
          }
        }
        return found.sort((a, b) => a.sheet - b.sheet || a.row - b.row || a.column - b.column);
      };
      const before = formulas();
      if (change === 'insert_rows') model.insertRows(sheet, at + 1, count);
      else if (change === 'delete_rows') model.deleteRows(sheet, at + 1, count);
      else if (change === 'insert_columns') model.insertColumns(sheet, at + 1, count);
      else model.deleteColumns(sheet, at + 1, count);
      const known = new Set(before.map((cell) => `${cell.sheet}:${cell.row}:${cell.column}`));
      const after = formulas().filter((cell) => {
        const previous = cell.sheet === sheet ? preOpCell(cell, change, at, count) : cell;
        return previous !== null && known.has(`${cell.sheet}:${previous.row}:${previous.column}`);
      });
      return { before, after };
    },
    false,
    true,
  );
}

/** Autofill reads and returns source text while evaluation remains paused. */
export function fillWith(
  engine: Engine,
  sheets: SheetInput[],
  sheet: number,
  area: Area,
  axis: FillAxis,
  to: number,
): FillResult {
  const problem = fillProblem(sheets, sheet, area, axis, to);
  if (problem) throw new Error(problem);
  return withCalculation(
    engine,
    sheets,
    'UTC',
    (model, results) => {
      for (const result of results) if (!result.ok) throw new Error(result.message);
      if (!model) throw new Error("That sheet isn't on this page.");
      const read = (area: Area) =>
        Array.from({ length: area.height }, (_, r) =>
          Array.from({ length: area.width }, (_, c) =>
            model.getCellContent(sheet, area.row + r + 1, area.column + c + 1),
          ),
        );
      const source = read(area);
      const upstream = { ...area, sheet, row: area.row + 1, column: area.column + 1 };
      if (axis === 'rows') model.autoFillRows(upstream, to + 1);
      else model.autoFillColumns(upstream, to + 1);
      const start = axis === 'rows' ? area.row : area.column;
      const end = start + (axis === 'rows' ? area.height : area.width) - 1;
      const from = to < start ? to : end + 1;
      const length = to < start ? start - to : to - end;
      const target = read(
        axis === 'rows'
          ? { ...area, row: from, height: length }
          : { ...area, column: from, width: length },
      );
      return { source, target };
    },
    false,
    true,
  );
}
export function completeWith(
  engine: Engine,
  names: string[],
  sheet: number,
  row: number,
  column: number,
  text: string,
  cursor: number,
): CompletionContext {
  if (!names[sheet]) throw new Error("That sheet isn't on this page.");
  if (row < 0 || column < 0 || row >= SHEET_LIMITS.rows || column >= SHEET_LIMITS.columns)
    throw new Error('Choose cells inside the sheet.');
  if ([...text].length > SHEET_LIMITS.cellChars)
    throw new Error('A formula holds at most 10,000 characters.');
  return withCalculation(
    engine,
    names.map((name) => ({ name, cells: [] })),
    'UTC',
    (model, results) => {
      for (const result of results) if (!result.ok) throw new Error(result.message);
      if (!model) throw new Error("That sheet isn't on this page.");
      return model.getFormulaCompletion(sheet, row + 1, column + 1, text, cursor);
    },
    false,
    true,
  );
}
