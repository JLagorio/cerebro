/**
 * Sub-pages (M55.13): give a page a child, or drop one page into another.
 *
 * Both are human actions, so neither throws (CV-03): a failure toasts
 * "Couldn't add sub-page" or its refusal, rescans so the store shows what the
 * disk holds, and returns null.
 *
 * A page's sub-pages live in its folder (engine/docPages.ts). A page with
 * none is a plain file, so its first one moves it into a folder of its own,
 * by rename: its bytes never change and its stem links keep resolving.
 * Before any move, every open page lands its pending save (M53.6) — the page
 * being moved is usually the one on screen, and a save that landed after the
 * rename would write the old path back.
 */

import { canHaveSubPages, growPlan, nestPlan, type PageMove } from '@/engine/docPages';
import { flushOpenPages } from '@/editor/openPages';
import { createFolder, renameNote } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

const FAILED = "Couldn't add sub-page";

const refuse = (reason: string): null => {
  useUiStore.getState().toast(`${FAILED}: ${reason}`);
  return null;
};

/** Rename on disk, then follow the page in history and in Favorites. */
async function move(vault: string, { from, to }: PageMove): Promise<void> {
  await renameNote(vault, from, to);
  useNavStore.getState().replacePath(from, to);
  useUiStore.getState().replaceFavoritePath(vault, from, to);
}

/**
 * Add a page titled `title` inside `parentPath`, growing the parent into a
 * folder of its own first when it is a plain file. Returns the child's path,
 * or null when refused or failed.
 */
export async function addSubPage(parentPath: string, title: string): Promise<string | null> {
  const trimmed = title.trim();
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  if (vault === null || trimmed === '') return null;
  if (refusedAcrossVaults(state)) return null;
  const parent = state.entries.find((e) => e.path === parentPath);
  if (parent === undefined) return refuse('the page is gone');
  if (!canHaveSubPages(parent)) return refuse(`"${parent.title}" can't have sub-pages`);
  try {
    await flushOpenPages();
    const fresh = useVaultStore.getState();
    const plan = growPlan(parent, fresh.entries, fresh.folders);
    if ('refused' in plan) return refuse(plan.refused);
    if (plan.move !== null) {
      await createFolder(vault, plan.folder);
      await move(vault, plan.move);
    }
    // createItem rescans, so the parent's new path and the child land together.
    return await fresh.createItem({
      folder: plan.folder,
      slug: slugify(trimmed) || 'page',
      frontmatter: {},
      body: `# ${trimmed}\n`,
    });
  } catch (err) {
    useUiStore.getState().toast(`${FAILED}: ${err instanceof Error ? err.message : String(err)}`);
    await useVaultStore.getState().rescan();
    return null;
  }
}

/**
 * Make `srcPath` (a page, or a page's folder) a sub-page of `targetPath`,
 * growing the target first when it is a plain file. Returns the moves made,
 * in order, or null when refused or failed.
 */
export async function nestPage(srcPath: string, targetPath: string): Promise<PageMove[] | null> {
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  if (vault === null) return null;
  if (refusedAcrossVaults(state)) return null;
  const target = state.entries.find((e) => e.path === targetPath);
  if (target === undefined) return refuse('the page is gone');
  try {
    await flushOpenPages();
    const fresh = useVaultStore.getState();
    const plan = nestPlan(srcPath, target, fresh.entries, fresh.folders);
    if ('refused' in plan) return refuse(plan.refused);
    const grows = plan.moves.length > 1;
    if (grows) await createFolder(vault, plan.folder);
    for (const step of plan.moves) await move(vault, step);
    await useVaultStore.getState().rescan();
    return plan.moves;
  } catch (err) {
    useUiStore.getState().toast(`${FAILED}: ${err instanceof Error ? err.message : String(err)}`);
    await useVaultStore.getState().rescan();
    return null;
  }
}
