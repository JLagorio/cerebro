import { saveBeforeAction } from '@/app/leaveGuard';
import { heldOpenPages } from '@/editor/openPages';
import type { BatchOp } from '@/engine/batch';
import { appendDatabaseFence, canHoldDatabaseBlock } from '@/engine/databaseBlock';
import { buildSchema } from '@/engine/schema';
import { typeViews } from '@/engine/typeCatalog';
import type { ViewDefinition } from '@/engine/types';
import { checkView } from '@/engine/viewCheck';
import { suggestedViewName } from '@/engine/viewSuggestion';
import { nextViewId, serializeViewList } from '@/engine/views';
import { readNoteSource, scanVault } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';
import { findTypeDoc, guardEditable } from './typeActions';

/** The person adds a checked suggestion as one reversible change. Every
 * read follows the editor flush; hashes keep a later edit from being lost. */
export async function acceptViewSuggestion({
  database,
  view,
  placeOn,
}: {
  database: string;
  view: ViewDefinition;
  placeOn?: string;
}): Promise<string | null> {
  const initial = useVaultStore.getState();
  const vault = initial.vaultPath;
  if (vault === null || refusedAcrossVaults(initial)) return null;
  const current = () =>
    useVaultStore.getState().vaultPath === vault && !refusedAcrossVaults(useVaultStore.getState());
  const toast = (words: string) => {
    if (current()) useUiStore.getState().toast(words);
  };
  try {
    if (!(await saveBeforeAction('all', 'caller'))) return null;
    if (!current()) return null;
    const entries = await scanVault(vault);
    if (!current()) return null;
    const doc = findTypeDoc(entries, database);
    if (doc === null) {
      toast(`${database} is gone, so this view has nowhere to go.`);
      return null;
    }
    if (!guardEditable(doc, database)) return null;
    const schema = buildSchema(entries);
    if (checkView(view, database, schema, entries).length > 0) {
      toast(`This view no longer fits ${database}.`);
      return null;
    }
    const page =
      placeOn === undefined ? undefined : entries.find((entry) => entry.path === placeOn);
    if (placeOn !== undefined && (page === undefined || !canHoldDatabaseBlock(page))) {
      toast('This page can no longer hold a database view. Nothing was written.');
      return null;
    }
    if (heldOpenPages().some((path) => path === doc.path || path === placeOn)) {
      toast('These pages have changes waiting on you. Settle them before adding this view.');
      return null;
    }
    const existing = typeViews(database, schema);
    const name = suggestedViewName(
      view.name,
      existing.map((saved) => saved.name),
    );
    const id = nextViewId(
      view.name,
      existing.map((saved) => saved.id),
    );
    const next = { ...view, id, name };
    const source = await readNoteSource(vault, doc.path);
    if (!current()) return null;
    if (doc.hash !== null && source.hash !== doc.hash) {
      toast('This database changed. Try adding the view again.');
      return null;
    }
    const ops: BatchOp[] = [
      {
        op: 'patch',
        path: doc.path,
        set: { views: serializeViewList([...existing, next]) },
        expectHash: source.hash,
      },
    ];
    if (page !== undefined) {
      const source = await readNoteSource(vault, page.path);
      if (!current()) return null;
      if (page.hash !== null && source.hash !== page.hash) {
        toast('This page changed. Try placing the view again.');
        return null;
      }
      const content = appendDatabaseFence(source.content, { database, view: id });
      if (content === null) {
        toast(
          `“${page.title}” ends inside a code block, so the view wasn't placed. Nothing was written.`,
        );
        return null;
      }
      ops.push({ op: 'replace_file', path: page.path, content, expectHash: source.hash });
    }
    if (!current()) return null;
    const label =
      `Added “${name}” to ${database}` +
      (page === undefined ? '' : ` and placed it on “${page.title}”`);
    const applied = await useVaultStore.getState().applyBatch(ops, { undo: label });
    return applied === null || !current() ? null : id;
  } catch (error) {
    toast(`Couldn't add this view: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
