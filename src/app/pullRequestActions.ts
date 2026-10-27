import { saveBeforeAction } from '@/app/leaveGuard';
import { splitFrontmatter } from '@/engine/frontmatter';
import { heldOpenPages } from '@/editor/openPages';
import { isKnowledgePath } from '@/engine/okf';
import {
  findPullRequestUrls,
  parsePullRequestUrl,
  propertyPullRequestUrls,
  statusSuggestion,
  type PrRead,
} from '@/engine/pullRequest';
import { buildSchema } from '@/engine/schema';
import { readNoteSource, scanVault } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

/** PR facts stay ephemeral; only the person's accepted status lands. */
export async function setMergedStatus(
  path: string,
  expectHash: string,
  reads: readonly PrRead[],
  ownerCurrent: () => boolean,
): Promise<boolean> {
  const initial = useVaultStore.getState();
  const vault = initial.vaultPath;
  if (vault === null || refusedAcrossVaults(initial) || isKnowledgePath(path)) return false;
  let live = true;
  const unsubscribe = useVaultStore.subscribe((next, previous) => {
    if (next.vaultPath !== previous.vaultPath) live = false;
  });
  const current = () =>
    live &&
    ownerCurrent() &&
    useVaultStore.getState().vaultPath === vault &&
    !refusedAcrossVaults(useVaultStore.getState());
  const changed = () => {
    if (current())
      useUiStore.getState().toast('This page changed. Refresh its pull requests and try again.');
    return false;
  };
  try {
    if (!current()) return false;
    if (!(await saveBeforeAction('all', 'caller'))) return false;
    if (!current()) return false;
    if (heldOpenPages().includes(path)) return changed();
    const entries = await scanVault(vault);
    if (!current()) return false;
    const entry = entries.find((e) => e.path === path);
    if (entry === undefined || entry.parseError !== null || entry.hash !== expectHash)
      return changed();
    const source = await readNoteSource(vault, path);
    if (!current()) return false;
    if (source.hash !== expectHash || heldOpenPages().includes(path)) return changed();
    const linked = new Set(
      [
        ...propertyPullRequestUrls(entry),
        ...findPullRequestUrls(splitFrontmatter(source.content).body),
      ].map((url) => url.key),
    );
    const answered = new Set(
      reads.flatMap((read) =>
        read.state === 'read' ? [parsePullRequestUrl(read.pr.url)?.key] : [],
      ),
    );
    if (linked.size !== answered.size || [...linked].some((key) => !answered.has(key)))
      return changed();
    const suggestion = statusSuggestion(entry, buildSchema(entries), reads);
    if (suggestion === null) return changed();
    const result = await useVaultStore
      .getState()
      .applyBatch(
        [{ op: 'patch', path, set: { [suggestion.field]: suggestion.value }, expectHash }],
        { undo: `Status set to “${suggestion.label}” — its pull request merged` },
      );
    return result !== null && current();
  } catch (error) {
    if (current())
      useUiStore
        .getState()
        .toast(
          `Couldn't set the status: ${error instanceof Error ? error.message : String(error)}`,
        );
    return false;
  } finally {
    unsubscribe();
  }
}
