import { inPlace } from '@/editor/reconcile';
import type { CerebroEditor } from '@/editor/MarkdownEditor';
import type { SheetSource } from '@/engine/sheet/gridEdit';

/** One semantic grid change is one isolated step in the page's history. */
export function commitSheetEdits(editor: CerebroEditor, edits: readonly SheetSource[]): boolean {
  if (!editor.isEditable) return false;
  const changed = edits.filter(({ id, source }) => {
    const block = editor.getBlock(id);
    if (!block || block.type !== 'sheet') throw new Error('The sheet is no longer on this page.');
    return block.props.source !== source;
  });
  if (!changed.length) return false;
  inPlace(editor, () => {
    for (const { id, source } of changed) editor.updateBlock(id, { props: { source } });
  });
  return true;
}
