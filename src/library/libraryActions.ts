import { LIBRARY_FOLDER, libraryLabel, type LibraryKind } from '@/engine/library';
import type { Selection } from '@/engine/types';
import { createNote } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const NEW_BODY: Record<LibraryKind, (title: string) => string> = {
  skill: (title) =>
    `# ${title}\n\nWhat should the assistant do when this is invoked? Write it as numbered steps.\n`,
  agent: (title) =>
    `# ${title}\n\nStanding instructions for every run. Say what to read, what to produce, and what never to touch.\n`,
  template: (title) => `# {{title}}\n\n<!-- ${title} -->\n`,
};
export function libraryItemPlace(kind: LibraryKind, path: string): Selection {
  return kind === 'agent' ? { kind: 'doc', path } : { kind: 'library', tab: kind, path };
}
/** Ships inert; an agent stays paused until its owner configures and starts it. */
export async function createLibraryItem(kind: LibraryKind): Promise<string | null> {
  const vault = useVaultStore.getState().vaultPath;
  if (vault === null) return null;
  try {
    const title = `New ${libraryLabel(kind).toLowerCase()}`;
    const slug = slugify(title);
    const path = await createNote(
      vault,
      LIBRARY_FOLDER[kind],
      slug,
      kind === 'template'
        ? { type: null }
        : kind === 'skill'
          ? { type: 'Skill', slug, description: '' }
          : { type: 'Agent', slug, description: '', paused: true },
      NEW_BODY[kind](title),
    );
    if (useVaultStore.getState().vaultPath !== vault) return null;
    await useVaultStore.getState().rescan();
    return useVaultStore.getState().vaultPath === vault ? path : null;
  } catch {
    useUiStore.getState().toast(`Couldn't create the ${kind}`);
    return null;
  }
}
