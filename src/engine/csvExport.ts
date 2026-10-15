import { columnUniverse, defaultColumnsFor, type ColumnDef } from './columns';
import { encodeCsv } from './csv';
import { buildRows, entryRows } from './rows';
import { humanize } from './schema';
import type { Entry, FieldKind, ListSource, Presentation, Schema } from './types';
import { limitEntries } from './viewFilters';
import { visibleColumns } from './views';

/** Export top-level records in band order. A multi-value band can repeat a
 * record on screen; it still has only one row in the exported file. */
export function exportRows(
  entries: Entry[],
  presentation: Presentation,
  schema: Schema,
  allEntries = entries,
): Entry[] {
  const rows = entryRows(
    buildRows({
      entries: limitEntries(entries, presentation.limit),
      group: presentation.group,
      schema,
      allEntries,
    }),
  );
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      if (row.depth !== 0 || seen.has(row.entry.path)) return false;
      seen.add(row.entry.path);
      return true;
    })
    .map((row) => row.entry);
}

export function exportColumns(
  presentation: Presentation,
  source: ListSource,
  entries: Entry[],
  schema: Schema,
): ColumnDef[] {
  const universe = columnUniverse(source, entries, schema, presentation.group);
  const columns =
    presentation.columns.length === 0 ? defaultColumnsFor(universe) : visibleColumns(presentation);
  return columns.flatMap(({ field }) => {
    const def = universe.find((item) => item.name === field);
    return def === undefined ? [] : [def];
  });
}

/** Stored text stays text, while labels and relation titles match the view.
 * Display formatting never turns an absent cell into zero or rounds a number. */
export function cellText(entry: Entry, field: string, schema: Schema): string {
  const raw = schema.fieldValue(entry, field);
  if (raw === null || raw === undefined || raw === '') return '';
  const { def, display } = schema.resolveField(entry, field);
  if (
    def?.kind === 'select' ||
    def?.kind === 'status' ||
    def?.kind === 'multiselect' ||
    def?.kind === 'person' ||
    def?.kind === 'relation'
  )
    return display;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : '';
  if (typeof raw === 'boolean') return String(raw);
  if (typeof raw === 'string') return raw;
  if (def?.kind === 'daterange' && typeof raw === 'object' && !Array.isArray(raw)) {
    const range = raw as { start?: unknown; end?: unknown };
    const start = typeof range.start === 'string' ? range.start : '';
    const end = typeof range.end === 'string' ? range.end : '';
    return end === '' || end === start ? start : `${start} → ${end}`;
  }
  return Array.isArray(raw) ? raw.map(String).join(', ') : '';
}

/** Text that resembles a spreadsheet formula remains a literal on import. */
export function guardCsvText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** Spreadsheet formula prefixes in text are literal. Numeric fields keep
 * genuine numbers, including negative ones; malformed numeric text is guarded. */
export function guardFormula(text: string, kind: FieldKind | null = null): string {
  if (kind === 'number' && text.trim() !== '' && Number.isFinite(Number(text))) return text;
  if (kind === 'checkbox' && (text === 'true' || text === 'false')) return text;
  return guardCsvText(text);
}

export function viewCsv(
  entries: Entry[],
  presentation: Presentation,
  source: ListSource,
  schema: Schema,
  allEntries = entries,
): { csv: string; rows: number } {
  const rows = exportRows(entries, presentation, schema, allEntries);
  const columns = exportColumns(presentation, source, entries, schema);
  const cells = rows.map((entry) => [
    guardFormula(entry.title),
    ...columns.map((column) =>
      guardFormula(
        cellText(entry, column.name, schema),
        schema.resolveField(entry, column.name).def?.kind ?? null,
      ),
    ),
  ]);
  return {
    csv:
      '\uFEFF' +
      encodeCsv([
        ['Name', ...columns.map((column) => guardFormula(humanize(column.name)))],
        ...cells,
      ]),
    rows: rows.length,
  };
}
