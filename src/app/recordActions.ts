import { readNote, writeClipboard } from '@/lib/ipc';
import { formatWikilink, linkTargetOf } from '@/engine/wikilink';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';
import { isKnowledgePath } from '@/engine/okf';
import type { Entry } from '@/engine/types';

/**
 * Record-level actions that more than one surface offers (M20.5).
 *
 * `duplicate` lived inside `DetailHeaderActions`, so the only way to copy a
 * record was to open it first — the bulk bar could select twenty and delete
 * them but not duplicate one. Lifting it here rather than writing a second
 * copy is the rule this codebase keeps re-learning: two spellings of the same
 * write eventually disagree about which frontmatter travels.
 *
 * Store-layer invariant: never throws. The quiet variant lets bulk actions
 * report failures together; the single-record wrapper toasts and returns null.
 */
export async function duplicateRecordQuietly(entry: Entry): Promise<string | null> {
  const state = useVaultStore.getState();
  const { vaultPath, createItem } = state;
  if (
    vaultPath === null ||
    (state.entriesVault !== null && state.entriesVault !== vaultPath) ||
    isKnowledgePath(entry.path)
  )
    return null;
  const title = `${entry.title} copy`;
  try {
    const body = await readNote(vaultPath, entry.path);
    if (useVaultStore.getState().vaultPath !== vaultPath) return null;
    // `key` is not copied: it identifies the record (LNC-4), and two records
    // answering to one key is worse than a copy with none.
    const { key: _key, ...props } = entry.properties;
    const frontmatter: Record<string, unknown> = { ...props };
    if (entry.type !== null) frontmatter.type = entry.type;
    // Relationships arrive bracket-stripped from the scanner; disk wants them
    // back as wikilinks.
    for (const [name, targets] of Object.entries(entry.relationships)) {
      frontmatter[name] = targets.map((t) => `[[${t}]]`);
    }
    return await createItem({
      folder: entry.path.slice(0, Math.max(entry.path.lastIndexOf('/'), 0)),
      slug: slugify(title) || 'copy',
      frontmatter,
      body,
    });
  } catch {
    return null;
  }
}

export async function duplicateRecord(entry: Entry): Promise<string | null> {
  if (refusedAcrossVaults(useVaultStore.getState())) return null;
  const path = await duplicateRecordQuietly(entry);
  if (path === null) useUiStore.getState().toast(`Couldn't duplicate "${entry.title}"`);
  return path;
}

/** The selected pages, once each, copied as stem/key links. Clipboard access
 * may fail, so its human action always reports the outcome without throwing. */
export async function copyPageLinks(entries: readonly Entry[]): Promise<boolean> {
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  if (unique.length === 0) return false;
  try {
    await writeClipboard(unique.map((entry) => formatWikilink(linkTargetOf(entry))).join('\n'));
    useUiStore
      .getState()
      .toast(`${unique.length === 1 ? 'Link' : `${unique.length} links`} copied`);
    return true;
  } catch {
    useUiStore.getState().toast("Couldn't copy to the clipboard");
    return false;
  }
}
