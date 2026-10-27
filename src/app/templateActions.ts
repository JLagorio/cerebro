import { prepareOpenPages, heldOpenPages } from '@/editor/openPages';
import { firstH1LineIndex, replaceH1, splitFrontmatter } from '@/engine/frontmatter';
import { isKnowledgePath } from '@/engine/okf';
import { createFolder, readNoteSource } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { TEMPLATES_DIR } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { saveBeforeAction } from './leaveGuard';

/** Copy a page through the existing human creation door. */
export async function savePageAsTemplate(vault: string, path: string): Promise<string | null> {
  const ready = () => {
    const state = useVaultStore.getState();
    return state.vaultPath === vault && state.entriesVault === vault && state.status === 'ready';
  };
  if (!ready() || isKnowledgePath(path)) return null;
  // A → B → A must not revive an action started by the old page. Rescans do
  // not change status to scanning; opening even the same vault does.
  let retired = false;
  const unsubscribe = useVaultStore.subscribe(() => {
    if (!ready()) retired = true;
  });
  const current = () => !retired && ready();
  const { toast } = useUiStore.getState();
  try {
    if (!(await saveBeforeAction('all', 'block', current)) || !current()) return null;
    // Body and metadata must describe the same acknowledged file, including
    // focused fields captured by the leave preparation, not the old render.
    await useVaultStore.getState().rescan();
    if (!current()) return null;
    const entry = useVaultStore.getState().entries.find((candidate) => candidate.path === path);
    if (entry === undefined || entry.parseError !== null || entry.hash === null) {
      toast("Couldn't read this page for a template");
      return null;
    }
    const source = await readNoteSource(vault, path);
    const stillMatches = () => {
      prepareOpenPages();
      return (
        current() &&
        !heldOpenPages().includes(path) &&
        useVaultStore.getState().entries.find((candidate) => candidate.path === path)?.hash ===
          source.hash
      );
    };
    if (!current()) return null;
    if (source.hash !== entry.hash || !stillMatches()) {
      toast('This page changed. Save it and try making the template again.');
      return null;
    }
    const body = splitFrontmatter(source.content).body;
    const frontmatter: Record<string, unknown> = {};
    if (entry.type !== null) frontmatter.type = entry.type;
    for (const [key, value] of Object.entries(entry.properties)) {
      if (key !== 'full_width') frontmatter[key] = value;
    }
    for (const [key, targets] of Object.entries(entry.relationships)) {
      frontmatter[key] = targets.map((target) => `[[${target}]]`);
    }
    await createFolder(vault, TEMPLATES_DIR);
    if (!current()) return null;
    if (!stillMatches()) {
      toast('This page changed. Save it and try making the template again.');
      return null;
    }
    // createItem captures the checked vault synchronously before its write.
    const created = await useVaultStore.getState().createItem({
      folder: TEMPLATES_DIR,
      slug: slugify(entry.title) || 'template',
      frontmatter,
      body: firstH1LineIndex(body) < 0 ? body : replaceH1(body, '{{title}}'),
    });
    if (current()) toast(`Saved as template — find it under ${TEMPLATES_DIR}/`);
    return created;
  } catch {
    if (current()) toast("Couldn't save template");
    return null;
  } finally {
    unsubscribe();
  }
}
