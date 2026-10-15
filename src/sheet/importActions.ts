import { readCsvText } from '@/app/csvActions';
import { csvProblemText, readCsvRecords } from '@/engine/csv';
import {
  csvSheetBody,
  defaultPageTitle,
  importUndoLabel,
  sheetPageContent,
  type SheetImportPreview,
} from '@/engine/sheet/import';
import { pickSheetFile, scanVault } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

export type SheetChoice =
  { ok: true; preview: SheetImportPreview } | { ok: false; reason: string } | null;
/** Choosing only reads. The returned body is a draft until Import creates it. */
export async function chooseSheetFile(owned: () => boolean = () => true): Promise<SheetChoice> {
  try {
    const file = await pickSheetFile();
    if (!file) return null;
    let workbook;
    if (file.kind === 'csv') {
      const bytes = Uint8Array.from(atob(file.bytesBase64), (c) => c.charCodeAt(0));
      const read = await readCsvText({ size: bytes.length, arrayBuffer: async () => bytes.buffer });
      if (!read.ok) return { ok: false, reason: read.reason };
      const parsed = readCsvRecords(read.text);
      if (parsed.problems.length) return { ok: false, reason: csvProblemText(parsed.problems[0]) };
      workbook = csvSheetBody(parsed.records);
    } else workbook = file.workbook;
    return {
      ok: true,
      preview: { ...workbook, file: file.name, title: defaultPageTitle(file.name) },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (owned()) useUiStore.getState().toast(reason);
    return { ok: false, reason };
  }
}

export async function importSheetPage(
  preview: SheetImportPreview,
  title: string,
  owned: () => boolean = () => true,
): Promise<string | null> {
  const state = useVaultStore.getState(),
    vault = state.vaultPath;
  if (!vault || refusedAcrossVaults(state)) return null;
  let live = true;
  const unsubscribe = useVaultStore.subscribe((next, previous) => {
    if (next.vaultPath !== previous.vaultPath) live = false;
  });
  const current = () => live && owned() && useVaultStore.getState().vaultPath === vault;
  try {
    const name = title.trim();
    if (!name || /[\r\n]/.test(name)) {
      useUiStore.getState().toast(!name ? 'Name the page.' : 'Use one line for the page name.');
      return null;
    }
    const entries = await scanVault(vault);
    if (!current()) return null;
    const taken = new Set(entries.map((entry) => entry.path.toLowerCase()));
    const base = slugify(name) || 'imported-sheet';
    let path = `${base}.md`,
      suffix = 2;
    while (taken.has(path.toLowerCase())) path = `${base}-${suffix++}.md`;
    const result = await useVaultStore
      .getState()
      .applyBatch([{ op: 'create', path, content: sheetPageContent(name, preview.body) }], {
        undo: importUndoLabel(name),
      });
    return result !== null && current() ? path : null;
  } catch (error) {
    if (current())
      useUiStore
        .getState()
        .toast(
          `Couldn't import the sheet: ${error instanceof Error ? error.message : String(error)}`,
        );
    return null;
  } finally {
    unsubscribe();
  }
}
