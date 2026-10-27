import { heldOpenPages, prepareOpenPages } from '@/editor/openPages';
import { isAgentEntry } from '@/engine/agents';
import { splitFrontmatter } from '@/engine/frontmatter';
import { isKnowledgePath } from '@/engine/okf';
import type { BatchOp } from '@/engine/batch';
import { readNoteSource } from '@/lib/ipc';
import { applyTemplateBody, applyTemplateFrontmatter, isTemplate, todayIso } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { saveBeforeAction } from './leaveGuard';

/** A conservative raw check prevents a stale blank-page bar from replacing
 * hidden Markdown or an acknowledged edit. The title itself may be empty. */
const blankSource = (body: string): boolean => {
  const lines = body.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.length === 0 || (lines.length === 1 && /^#(?:[\t ]|$)/.test(lines[0]));
};

/** Apply one checked body/metadata batch; the store holds and reconciles the
 * existing editor through dispatch and refresh without dropping its owner. */
export async function applyPageTemplate(
  vault: string,
  path: string,
  templatePath: string,
  stillCurrent: () => boolean = () => true,
): Promise<boolean> {
  const ready = () => {
    const state = useVaultStore.getState();
    return state.vaultPath === vault && state.entriesVault === vault && state.status === 'ready';
  };
  if (!ready() || !stillCurrent() || isKnowledgePath(path)) return false;
  let retired = false;
  const unsubscribe = useVaultStore.subscribe(() => {
    if (!ready()) retired = true;
  });
  const current = () => !retired && ready() && stillCurrent();
  const toast = (message: string) => {
    if (current()) useUiStore.getState().toast(message);
  };
  const mayDispatch = () => {
    if (!current()) return false;
    // The shared batch writer settles bodies again. A field or child buffer
    // can appear during that await, so repeat this check at its final door.
    prepareOpenPages();
    const held = heldOpenPages();
    if (!held.includes(path) && !held.includes(templatePath)) return true;
    toast('The page or template changed. Save it and choose the template again.');
    return false;
  };
  try {
    if (!(await saveBeforeAction('all', 'block', current)) || !current()) return false;
    await useVaultStore.getState().rescan();
    if (!current()) return false;
    const entries = useVaultStore.getState().entries;
    const target = entries.find((entry) => entry.path === path);
    const template = entries.find((entry) => entry.path === templatePath);
    if (
      !target ||
      !template ||
      isAgentEntry(target) ||
      !isTemplate(template) ||
      target.parseError !== null ||
      template.parseError !== null ||
      target.hash === null ||
      template.hash === null
    ) {
      toast("Couldn't read this page and template. Refresh and try again.");
      return false;
    }
    const [source, templateSource] = await Promise.all([
      readNoteSource(vault, path),
      readNoteSource(vault, templatePath),
    ]);
    if (!mayDispatch()) return false;
    if (source.hash !== target.hash || templateSource.hash !== template.hash) {
      toast('The page or template changed. Save it and choose the template again.');
      return false;
    }
    if (!blankSource(splitFrontmatter(source.content).body)) {
      toast('This page now has content. The template was not applied.');
      return false;
    }
    const vars = { title: target.title, date: todayIso() };
    const body = applyTemplateBody(splitFrontmatter(templateSource.content).body, vars);
    const frontmatter = applyTemplateFrontmatter(template, vars);
    const ops: BatchOp[] = [{ op: 'body', path, body, expectHash: source.hash }];
    if (Object.keys(frontmatter).length > 0)
      ops.push({ op: 'patch', path, set: frontmatter, expectHash: source.hash });
    return (
      (await useVaultStore.getState().applyBatch(ops, {
        undo: 'Applied template',
        stillCurrent: mayDispatch,
      })) !== null
    );
  } catch {
    toast("Couldn't apply template");
    return false;
  } finally {
    unsubscribe();
  }
}
