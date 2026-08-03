import { deleteNote, readNote } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import type { Entry } from '@/engine/types';

/**
 * Copy, duplicate and delete, for any surface that lists records (M16.21).
 *
 * These three exist once already, inline in `DetailHeaderActions` (M16.11),
 * and the list's row menu needs the same three. They are here as functions
 * over explicit dependencies rather than a second copy inside a second
 * component, so the panel's copy becomes deletable and the operations are
 * testable without mounting anything.
 *
 * They follow the store-layer invariant even though they are not store
 * actions: nothing throws to a caller. Each catches, toasts, and reports
 * failure in its return value, because every call site here is a menu item
 * that must not leave an unhandled rejection behind a closing popover.
 */

export interface RecordActionDeps {
  vaultPath: string | null;
  createItem(args: {
    folder: string;
    slug: string;
    frontmatter: Record<string, unknown>;
    body?: string;
  }): Promise<string>;
  rescan(): Promise<void>;
  toast(message: string): void;
}

/** Clipboard access is a permission, not a certainty — a silent failure here
 * reads as "the menu item does nothing". */
export async function copyText(text: string, what: string, toast: RecordActionDeps['toast']) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
    return true;
  } catch {
    toast(`Couldn't copy ${what.toLowerCase()}`);
    return false;
  }
}

/** The path of the copy, or null when it could not be made. */
export async function duplicateRecord(
  entry: Entry,
  deps: RecordActionDeps,
): Promise<string | null> {
  if (deps.vaultPath === null) return null;
  const title = `${entry.title} copy`;
  try {
    const body = await readNote(deps.vaultPath, entry.path);
    // `key` is not copied: it identifies the record, and two records
    // answering to one key is worse than a copy with none.
    const { key: _key, ...props } = entry.properties;
    const frontmatter: Record<string, unknown> = { ...props };
    if (entry.type !== null) frontmatter.type = entry.type;
    // Relationships arrive bracket-stripped from the scanner; disk wants them
    // back as wikilinks, or the copy loses every link the original had.
    for (const [name, targets] of Object.entries(entry.relationships)) {
      frontmatter[name] = targets.map((t) => `[[${t}]]`);
    }
    const created = await deps.createItem({
      folder: entry.path.slice(0, Math.max(entry.path.lastIndexOf('/'), 0)),
      slug: slugify(title) || 'copy',
      frontmatter,
      body,
    });
    deps.toast(`Duplicated as "${title}"`);
    return created;
  } catch {
    deps.toast("Couldn't duplicate this record");
    return null;
  }
}

/** True when the file left the vault. The rescan failing separately is a
 * refresh problem, not a delete that did not happen. */
export async function deleteRecord(entry: Entry, deps: RecordActionDeps): Promise<boolean> {
  if (deps.vaultPath === null) return false;
  try {
    await deleteNote(deps.vaultPath, entry.path);
  } catch {
    deps.toast("Couldn't delete this record");
    return false;
  }
  try {
    await deps.rescan();
  } catch {
    deps.toast("Couldn't refresh vault");
  }
  return true;
}
