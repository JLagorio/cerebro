import { saveBeforeAction } from '@/app/leaveGuard';
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
 * rename would write the old path back. A page whose save is held (an outside
 * write, a reconcile or an open choice, M55.6) cannot land it, so a move that
 * touches that page is refused until it has settled.
 */

import { canHaveSubPages, growPlan, nestPlan, type PageMove } from '@/engine/docPages';
import { heldOpenPages } from '@/editor/openPages';
import { renameKeepingLinks } from '@/app/renameActions';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

const FAILED = "Couldn't add sub-page";

const refuse = (reason: string): null => {
  useUiStore.getState().toast(`${FAILED}: ${reason}`);
  return null;
};

/**
 * Why `moves` must wait, or null: an open page they move (itself, or inside
 * a moved folder) still holds a save the flush could not land.
 */
function heldBy(moves: PageMove[]): string | null {
  const held = heldOpenPages().find((path) =>
    moves.some(({ from }) => path === from || path.startsWith(`${from}/`)),
  );
  if (held === undefined) return null;
  const title = useVaultStore.getState().entries.find((e) => e.path === held)?.title ?? held;
  return `"${title}" has changes waiting on you. Settle them first`;
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
    if (!(await saveBeforeAction('all', 'caller'))) return null;
    const fresh = useVaultStore.getState();
    if (fresh.vaultPath !== vault || refusedAcrossVaults(fresh)) return null;
    const plan = growPlan(parent, fresh.entries, fresh.folders);
    if ('refused' in plan) return refuse(plan.refused);
    const waiting = plan.move === null ? null : heldBy([plan.move]);
    if (waiting !== null) return refuse(waiting);
    if (plan.move !== null) {
      const result = await renameKeepingLinks({
        steps: [plan.move],
        label: `Move ${parent.title}`,
      });
      if (result === null) return null;
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
    if (!(await saveBeforeAction('all', 'caller'))) return null;
    const fresh = useVaultStore.getState();
    if (fresh.vaultPath !== vault || refusedAcrossVaults(fresh)) return null;
    const plan = nestPlan(srcPath, target, fresh.entries, fresh.folders);
    if ('refused' in plan) return refuse(plan.refused);
    const waiting = heldBy(plan.moves);
    if (waiting !== null) return refuse(waiting);
    const result = await renameKeepingLinks({
      steps: plan.moves,
      label: `Move ${fresh.entries.find((entry) => entry.path === srcPath)?.title ?? srcPath}`,
    });
    if (result === null) return null;
    return plan.moves;
  } catch (err) {
    useUiStore.getState().toast(`${FAILED}: ${err instanceof Error ? err.message : String(err)}`);
    await useVaultStore.getState().rescan();
    return null;
  }
}
