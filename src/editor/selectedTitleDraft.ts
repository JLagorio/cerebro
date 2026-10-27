import { firstH1LineIndex, replaceH1 } from '@/engine/frontmatter';
import type { DocumentOwner } from './documentOwner';
export const TITLE_CHILD = 'selected-title';
/** The complete selected carrier is body; retain its BOM outside the H1 splice. */
export function replaceSelectedTitle(body: string, title: string): string {
  const bom = body.startsWith('\ufeff') ? '\ufeff' : '';
  return bom + replaceH1(body.slice(bom.length), title);
}
export function selectedTitleText(body: string, fallback = ''): string {
  const visible = body.startsWith('\ufeff') ? body.slice(1) : body;
  const at = firstH1LineIndex(visible);
  if (at < 0) return fallback;
  const line = visible.split('\n')[at].replace(/\r$/, '').trimStart();
  return line.slice(2);
}
/** Preparation shares the one body owner; incomplete field text is retained
 * as its child payload and blocks flush instead of creating another writer. */
export function prepareSelectedTitle(owner: DocumentOwner): void {
  const state = owner.snapshot();
  if (state.generation === state.acknowledgedGeneration || owner.recoveryBusy() || state.selectedSave !== undefined) return;
  const held = state.childDrafts?.[TITLE_CHILD];
  if (held !== undefined) return;
  const title = selectedTitleText(state.latestDraft).trim();
  if (title !== '') owner.edit(replaceSelectedTitle(state.latestDraft, title), 'source');
}
