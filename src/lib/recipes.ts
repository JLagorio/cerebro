import { declaredSlug } from '@/engine/identity';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';

/** One shared set of bytes, copied into the person's vault to become theirs. */
export const SHIPPED_RECIPES = Object.entries(
  import.meta.glob<string>('/shared/starter/vault/records/skills/*.md', {
    eager: true,
    query: '?raw',
    import: 'default',
  }),
)
  .map(([path, bytes]) => ({
    path: path.replace('/shared/starter/vault/', ''),
    bytes,
    slug: path.split('/').at(-1)!.replace(/\.md$/, ''),
    title: /^# (.+)$/m.exec(bytes)?.[1] ?? path,
  }))
  .sort((a, b) => a.slug.localeCompare(b.slug));

export function missingRecipes(entries: readonly Entry[]) {
  return SHIPPED_RECIPES.filter(
    (recipe) =>
      !entries.some(
        (entry) =>
          entry.path === recipe.path ||
          (entry.type === 'Skill' && declaredSlug(entry) === recipe.slug),
      ),
  );
}

export async function addRecipes(): Promise<boolean> {
  const state = useVaultStore.getState();
  if (!state.vaultPath || state.entriesVault !== state.vaultPath || state.status !== 'ready')
    return false;
  const missing = missingRecipes(state.entries);
  if (!missing.length) return true;
  try {
    return (
      (await state.applyBatch(
        missing.map(({ path, bytes }) => ({
          op: 'create' as const,
          path,
          content: bytes,
        })),
        { undo: 'Added recipes' },
      )) !== null
    );
  } catch (error) {
    useUiStore.getState().toast(error instanceof Error ? error.message : String(error));
    return false;
  }
}
