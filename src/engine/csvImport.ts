import { slugify } from '@/lib/slug';
import { MAX_BATCH_BYTES, MAX_BATCH_OPS, type BatchOp } from './batch';
import { convertValue } from './castRules';
import { utf8Length } from './comments';
import { homeFolderFor } from './createRecord';
import { csvProblemText, type CsvTable } from './csv';
import { composeNote } from './frontmatter';
import { inferKindFromValue, optionId, validateValue } from './properties';
import { buildSchema } from './schema';
import type { Entry, FieldOption, Schema } from './types';

export type CsvKind = 'number' | 'checkbox' | 'date' | 'url' | 'email' | 'select' | 'text';
const INFERENCE: CsvKind[] = ['number', 'checkbox', 'date', 'url', 'email', 'select', 'text'];
const record: Entry = {
  path: '',
  filename: '',
  folder: '',
  project: null,
  title: '',
  type: null,
  properties: {},
  relationships: {},
  outgoingLinks: [],
  snippet: '',
  createdAt: '',
  modifiedAt: '',
  parseError: null,
  hash: null,
};
const ctx = {
  from: 'text' as const,
  field: 'column',
  record,
  schema: buildSchema([]),
  entries: [],
};

function cellValue(value: string, kind: CsvKind): { ok: true; value: unknown } | { ok: false } {
  if (kind === 'text' || kind === 'select') return { ok: true, value };
  // Email validation deliberately accepts any stored string. Inference needs
  // the stricter shape reader, or every prose column would become Email.
  if (kind === 'email' && inferKindFromValue(value.trim()) !== 'email') return { ok: false };
  if (
    (kind === 'url' || kind === 'email') &&
    validateValue({ name: 'column', kind }, value.trim()) !== null
  )
    return { ok: false };
  return convertValue(value.trim(), kind, ctx);
}

/** Strict inference never turns identifiers with leading zeros into numbers. */
export function viableKinds(cells: readonly string[]): CsvKind[] {
  const values = cells.filter((value) => value.trim() !== '');
  if (values.length === 0) return ['text'];
  return INFERENCE.filter((kind) => {
    if (kind === 'select') {
      const distinct = new Set(values);
      return (
        values.length >= 3 &&
        distinct.size <= 8 &&
        distinct.size < values.length &&
        values.every((value) => value.length <= 24)
      );
    }
    return values.every((value) => cellValue(value, kind).ok);
  });
}

export function inferKind(cells: readonly string[]): CsvKind {
  return viableKinds(cells)[0];
}

export interface CsvImportDraft {
  name: string;
  table: CsvTable;
  titleColumn: number;
  columns: { name: string; kind: CsvKind }[];
}
export type CsvImportPlan =
  | {
      ok: true;
      ops: Extract<BatchOp, { op: 'create' }>[];
      records: number;
      untitled: number;
      folder: string;
    }
  | { ok: false; reason: string };

/** Every file is planned before the writer sees it; paths and option ids are
 * unique, and one import is one undoable create batch. */
export function planCsvImport(
  draft: CsvImportDraft,
  entries: Entry[],
  schema: Schema,
): CsvImportPlan {
  const { name, table, titleColumn, columns } = draft;
  if (table.problems.length > 0) return { ok: false, reason: csvProblemText(table.problems[0]) };
  if (table.rows.length === 0) return { ok: false, reason: 'The CSV has a header and no rows.' };
  const count = Math.max(table.rowCount, table.rows.length);
  if (count + 1 > MAX_BATCH_OPS)
    return {
      ok: false,
      reason: `One import can create up to ${MAX_BATCH_OPS - 1} records; this CSV has ${count} rows.`,
    };
  if (table.rowCount > table.rows.length)
    return { ok: false, reason: 'The preview is incomplete. Choose the CSV again.' };
  if (
    !Number.isInteger(titleColumn) ||
    titleColumn < 0 ||
    titleColumn >= table.headers.length ||
    columns.length !== table.headers.length
  )
    return { ok: false, reason: 'Choose the title column and a kind for every column.' };
  const taken = new Set(entries.map((entry) => entry.path.toLowerCase()));
  const claim = (base: string) => {
    let path = `${base}.md`,
      n = 2;
    while (taken.has(path.toLowerCase())) path = `${base}-${n++}.md`;
    taken.add(path.toLowerCase());
    return path;
  };
  const folder = homeFolderFor(name, schema, entries);
  const options = new Map<number, Map<string, string>>();
  const fields: [string, unknown][] = [];
  const usedNames = new Set<string>();
  for (let index = 0; index < columns.length; index++) {
    if (index === titleColumn) continue;
    const column = columns[index];
    if (column.name === '' || usedNames.has(column.name))
      return { ok: false, reason: 'Every property needs a unique name.' };
    usedNames.add(column.name);
    if (!viableKinds(table.rows.map((row) => row[index])).includes(column.kind))
      return {
        ok: false,
        reason: `${table.headers[index]} has values that cannot be read as ${column.kind}.`,
      };
    if (column.kind !== 'select') {
      fields.push([column.name, { kind: column.kind }]);
      continue;
    }
    const map = new Map<string, string>(),
      ids = new Set<string>(),
      choices: FieldOption[] = [];
    for (const row of table.rows) {
      const value = row[index];
      if (value.trim() === '' || map.has(value)) continue;
      const base = optionId(value) || 'option';
      let id = base,
        n = 2;
      while (ids.has(id)) id = `${base}-${n++}`;
      ids.add(id);
      map.set(value, id);
      choices.push({ id, label: value, color: null });
    }
    options.set(index, map);
    fields.push([column.name, { kind: 'select', options: choices }]);
  }
  const ops: Extract<BatchOp, { op: 'create' }>[] = [
    {
      op: 'create',
      path: claim(`types/${slugify(name) || 'database'}`),
      content: composeNote(
        { type: 'Type', icon: 'table-2', folder, fields: Object.fromEntries(fields) },
        `# ${name}\n`,
      ),
    },
  ];
  let untitled = 0;
  for (const [index, row] of table.rows.entries()) {
    let title = row[titleColumn].replace(/\s+/g, ' ').trim();
    if (title === '') {
      title = 'Untitled';
      untitled++;
    }
    let slug = slugify(title);
    if (slug.length > 80) {
      const short = slug.slice(0, 80);
      slug = short.includes('-') ? short.slice(0, short.lastIndexOf('-')) : '';
    }
    if (slug === '') slug = `row-${index + 1}`;
    const props: [string, unknown][] = [['type', name]];
    for (let col = 0; col < columns.length; col++) {
      if (col === titleColumn || row[col].trim() === '') continue;
      const spec = columns[col];
      const converted = cellValue(row[col], spec.kind);
      if (!converted.ok)
        return {
          ok: false,
          reason: `${table.headers[col]} has values that cannot be read as ${spec.kind}.`,
        };
      props.push([spec.name, options.get(col)?.get(row[col]) ?? converted.value]);
    }
    ops.push({
      op: 'create',
      path: claim(`${folder}/${slug}`),
      content: composeNote(Object.fromEntries(props), `# ${title}\n`),
    });
  }
  const bytes = ops.reduce((sum, op) => sum + utf8Length(op.content), 0);
  if (bytes > MAX_BATCH_BYTES)
    return {
      ok: false,
      reason: `This import would write ${(bytes / 1024 / 1024).toFixed(1)} MB; one change can write up to 16 MB.`,
    };
  return { ok: true, ops, records: table.rows.length, untitled, folder };
}
