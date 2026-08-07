import { readNote } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
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
 * Store-layer invariant: never throws. It toasts and returns null.
 */
export async function duplicateRecord(entry: Entry): Promise<string | null> {
  const { vaultPath, createItem } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return null;
  const title = `${entry.title} copy`;
  try {
    const body = await readNote(vaultPath, entry.path);
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
    toast(`Couldn't duplicate "${entry.title}"`);
    return null;
  }
}
