import { CSV_MAX_BYTES, csvProblemText, parseCsv, type CsvTable } from '@/engine/csv';
import { MAX_BATCH_OPS } from '@/engine/batch';
import { planCsvImport, type CsvImportDraft } from '@/engine/csvImport';
import { viewCsv } from '@/engine/csvExport';
import { buildSchema } from '@/engine/schema';
import { isReservedTypeName, listTypes, typeViews } from '@/engine/typeCatalog';
import type { Entry, ListFile, Schema, Selection } from '@/engine/types';
import { resolveSurface } from '@/engine/surface';
import { resolveView } from '@/engine/views';
import { exportCsv, scanVault } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';
import { normalizeFieldName, RESERVED } from './typeActions';

export type CsvRead = { ok: true; table: CsvTable } | { ok: false; reason: string };

/** Refuse size before allocating the file, and never replace bad bytes with �. */
export async function readCsvText(
  file: Pick<File, 'size' | 'arrayBuffer'>,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (file.size > CSV_MAX_BYTES) return { ok: false, reason: csvProblemText({ code: 'tooLarge' }) };
  try {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > CSV_MAX_BYTES)
      return { ok: false, reason: csvProblemText({ code: 'tooLarge' }) };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: csvProblemText({ code: 'encoding' }) };
    }
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "Couldn't read the CSV. Choose it again." };
  }
}

export async function readCsvFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<CsvRead> {
  const read = await readCsvText(file);
  return read.ok ? { ok: true, table: parseCsv(read.text, { maxRows: MAX_BATCH_OPS }) } : read;
}

export function columnNames(headers: readonly string[]): string[] {
  const names = new Set<string>([...RESERVED, 'title']);
  return headers.map((header, index) => {
    const base = normalizeFieldName(header) || `column_${index + 1}`;
    let name = base,
      suffix = 2;
    while (names.has(name)) name = `${base}_${suffix++}`;
    names.add(name);
    return name;
  });
}

export function nameProblem(raw: string, entries: Entry[], schema: Schema): string | null {
  const name = raw.trim();
  if (name === '') return 'Name the database.';
  if (isReservedTypeName(name)) return `“${name}” is a name Cerebro reserves — choose another.`;
  if (listTypes(entries, schema).some((type) => type.name.toLowerCase() === name.toLowerCase()))
    return `A database named “${name}” already exists.`;
  if (/[\r\n]/.test(name)) return 'Use one line for the database name.';
  return null;
}

/** The preview stays a draft until every create can land together. */
export async function importCsv(draft: CsvImportDraft): Promise<string | null> {
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  if (vault === null || refusedAcrossVaults(state)) return null;
  const sameVault = () => useVaultStore.getState().vaultPath === vault;
  try {
    // A second import or outside create may have taken a name during preview.
    const entries = await scanVault(vault);
    if (!sameVault()) return null;
    const schema = buildSchema(entries);
    const name = draft.name.trim();
    const problem = nameProblem(name, entries, schema);
    if (problem !== null) {
      useUiStore.getState().toast(problem);
      return null;
    }
    const plan = planCsvImport({ ...draft, name }, entries, schema);
    if (!plan.ok) {
      useUiStore.getState().toast(plan.reason);
      return null;
    }
    const applied = await useVaultStore.getState().applyBatch(plan.ops, {
      undo: `Imported ${plan.records} records into “${name}”`,
    });
    if (applied === null || !sameVault()) return null;
    useNavStore.getState().navigate({ kind: 'type', name });
    return name;
  } catch (error) {
    if (sameVault()) useUiStore.getState().toast(`Couldn't import the CSV: ${String(error)}`);
    return null;
  }
}

/** Resolve the requested saved tab, including a closed tab's own filters.
 * Transient search and collapsed bands are not part of the saved view. */
export async function exportViewCsv(
  selection: Extract<Selection, { kind: 'type' | 'list' }>,
  views: ListFile[],
): Promise<boolean> {
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  if (vault === null || refusedAcrossVaults(state)) return false;
  const sameVault = () => useVaultStore.getState().vaultPath === vault;
  try {
    const { entries } = state;
    const schema = buildSchema(entries);
    const list =
      selection.kind === 'list'
        ? views.find(
            (item) =>
              item.id === selection.id && item.collection === (selection.collection ?? null),
          )
        : undefined;
    if (selection.kind === 'list' && list === undefined) return false;
    const tabs =
      selection.kind === 'type' ? typeViews(selection.name, schema) : list!.definition.views;
    const tab =
      selection.kind === 'type'
        ? (tabs.find((view) => view.id === selection.view) ?? tabs[0])
        : resolveView(list!.definition, selection.view);
    if (['chart', 'dashboard', 'whiteboard'].includes(tab.presentation.type)) return false;
    const surface = resolveSurface(selection, entries, schema, views);
    if (surface.unavailable) {
      useUiStore.getState().toast(surface.unavailable.message);
      return false;
    }
    if (surface.entries.some(entry => entry.authority?.kind === 'sqlite_metadata')) {
      useUiStore.getState().toast('Exporting this selected view needs its canonical export reader. No file was created.');
      return false;
    }
    const source =
      selection.kind === 'type' ? { type: selection.name, project: null } : list!.definition.source;
    const output = viewCsv(surface.entries, surface.presentation, source, schema, entries);
    const filename = `${slugify(`${surface.title} ${tab.name}`) || 'view'}.csv`;
    const saved = await exportCsv(filename, output.csv);
    if (saved === null || !sameVault()) return false;
    useUiStore.getState().toast(`Exported ${output.rows} rows to ${saved}`);
    return true;
  } catch (error) {
    if (sameVault())
      useUiStore
        .getState()
        .toast(
          `Couldn't export the view: ${error instanceof Error ? error.message : String(error)}`,
        );
    return false;
  }
}
