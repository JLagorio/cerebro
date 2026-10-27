import { pageFolders } from '@/app/CreationDestinationField';
import { MAX_BATCH_BYTES } from '@/engine/batch';
import { isKnowledgePath } from '@/engine/okf';
import { sha256Hex } from '@/lib/sha256';
import { slugify } from '@/lib/slug';
import { useVaultStore } from '@/stores/vaultStore';

/** An explicit, session-only copy of the answer the person chose. It records
 * no inferred source/effect evidence and does not follow later regeneration. */
export interface AnswerPreview {
  attemptId: string;
  vault: string;
  text: string;
  hash: string;
}

export function answerPreview(attemptId: string, vault: string, text: string): AnswerPreview {
  return { attemptId, vault, text, hash: sha256Hex(text) };
}

export type AnswerSaveResult =
  { kind: 'saved'; path: string; version: string } | { kind: 'refused'; message: string };

/** New pages use the existing create-only batch and its single Undo owner.
 * Existing pages are never a fallback destination for this action. */
export async function saveAnswerPage(
  preview: AnswerPreview,
  title: string,
  folder: string,
  stillCurrent: () => boolean,
): Promise<AnswerSaveResult> {
  const refused = (message: string): AnswerSaveResult => ({ kind: 'refused', message });
  try {
    const state = useVaultStore.getState();
    const current = () => {
      const now = useVaultStore.getState();
      return (
        stillCurrent() &&
        now.status === 'ready' &&
        now.vaultPath === preview.vault &&
        now.entriesVault === preview.vault
      );
    };
    if (!current())
      return refused(
        'The original vault is no longer open. Close this preview and choose the answer again.',
      );
    const name = title.trim().replace(/\s+/g, ' ');
    if (name === '') return refused('Give this page a title.');
    if (preview.text.trim() === '' || sha256Hex(preview.text) !== preview.hash)
      return refused('This answer preview is unavailable. Choose the answer again.');
    if (!pageFolders(state.entries, state.folders).includes(folder))
      return refused('Choose a folder: this destination is unavailable.');
    const filename = slugify(name) || 'answer';
    const path = `${folder ? `${folder}/` : ''}${filename}.md`;
    if (isKnowledgePath(path))
      return refused(
        'Choose an ordinary page folder. Knowledge pages have their own review process.',
      );
    // The human title precedes the unmodified answer. A leading YAML fence in
    // generated prose cannot become this new page's frontmatter.
    const content = `# ${name}\n\n${preview.text}`;
    if (new TextEncoder().encode(content).byteLength > MAX_BATCH_BYTES)
      return refused('This answer is too large for a page save. Copy a smaller selection instead.');
    let failure: string | null = null;
    const result = await state.applyBatch([{ op: 'create', path, content }], {
      undo: `Saved answer as ${name}`,
      stillCurrent: current,
      onRefused: (message) => {
        failure = message;
      },
    });
    if (result === null)
      return refused(failure ?? 'The page was not saved. Resolve any pending saves and try again.');
    const file = result.files.find((item) => item.path === path);
    if (!file?.afterHash)
      return refused(
        'The save did not return a page version. Check the destination before trying again.',
      );
    return { kind: 'saved', path, version: file.afterHash };
  } catch (error) {
    return refused(error instanceof Error ? error.message : 'The page could not be saved.');
  }
}
