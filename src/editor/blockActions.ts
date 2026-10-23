import { NodeSelection, Selection } from 'prosemirror-state';
import type { CerebroEditor } from './MarkdownEditor';
import { inPlace, type AnyBlock } from './reconcile';

export const TEXT_BLOCK_CHOICES = [
  { label: 'Text', type: 'paragraph', props: {} },
  { label: 'Heading 1', type: 'heading', props: { level: 1 } },
  { label: 'Heading 2', type: 'heading', props: { level: 2 } },
  { label: 'Heading 3', type: 'heading', props: { level: 3 } },
  { label: 'Bulleted list', type: 'bulletListItem', props: {} },
  { label: 'Numbered list', type: 'numberedListItem', props: {} },
  { label: 'Checklist', type: 'checkListItem', props: {} },
  { label: 'Quote', type: 'quote', props: {} },
] as const;

export const canConvertBlock = (block: AnyBlock): boolean =>
  Array.isArray(block.content) &&
  [
    'paragraph',
    'heading',
    'bulletListItem',
    'numberedListItem',
    'checkListItem',
    'quote',
    'callout',
  ].includes(block.type);

export function duplicationProblem(block: AnyBlock): string | null {
  if (block.type === 'sheet')
    return 'Sheets need a unique workbook name; duplicate their cells instead.';
  for (const child of block.children ?? []) {
    const problem = duplicationProblem(child);
    if (problem !== null) return problem;
  }
  return null;
}

/** Block identifiers are editor identities, never copied with a subtree. */
export function duplicateTree(block: AnyBlock): AnyBlock {
  const copy = structuredClone(block);
  delete copy.id;
  copy.children = copy.children?.map(duplicateTree);
  return copy;
}

export function duplicateBlock(editor: CerebroEditor, id: string): void {
  const block = editor.getBlock(id);
  if (block === undefined || duplicationProblem(block) !== null) return;
  inPlace(editor, () => {
    const [inserted] = editor.insertBlocks([duplicateTree(block) as never], id, 'after');
    editor.setTextCursorPosition(inserted.id, 'start');
  });
  editor.focus();
}

export function siblingOf(blocks: readonly AnyBlock[], id: string, delta: number): AnyBlock | null {
  const index = blocks.findIndex((block) => block.id === id);
  if (index >= 0) return blocks[index + delta] ?? null;
  for (const block of blocks) {
    const found = siblingOf(block.children ?? [], id, delta);
    if (found !== null) return found;
  }
  return null;
}

/** Preserve both selection ends by stable block identity, including node and
 * table selections. Absolute positions cannot survive remove/insert moves. */
export function moveWithSelection(editor: CerebroEditor, mutate: () => void): void {
  let selection = editor.prosemirrorState.selection;
  // BlockNote's cursor API can select an unselectable inner node (the sheet
  // grid). History's NodeBookmark cannot restore it. Select its owning block
  // container instead, retaining the same block through both move and undo.
  if (selection instanceof NodeSelection && selection.node.type.spec.selectable === false) {
    for (let depth = selection.$anchor.depth; depth > 0; depth--) {
      if (typeof selection.$anchor.node(depth).attrs.id !== 'string') continue;
      editor.transact((tr) =>
        tr.setSelection(NodeSelection.create(tr.doc, selection.$anchor.before(depth))),
      );
      selection = editor.prosemirrorState.selection;
      break;
    }
  }
  const json = selection.toJSON();
  const address = (offset: number) => {
    const position = editor.prosemirrorState.doc.resolve(offset);
    // A whole-block NodeSelection starts BEFORE its container, so that
    // container is nodeAfter rather than one of the resolved ancestors.
    if (json.type === 'node' && typeof position.nodeAfter?.attrs.id === 'string')
      return { id: position.nodeAfter.attrs.id as string, offset: 0 };
    for (let depth = position.depth; depth > 0; depth--) {
      const id = position.node(depth).attrs.id;
      if (typeof id === 'string') return { id, offset: position.pos - position.before(depth) };
    }
    return null;
  };
  // CellSelection's JSON uses cell boundaries; its generic $anchor/$head
  // point inside the cells and cannot be passed back to its constructor.
  const anchor = typeof json.anchor === 'number' ? address(json.anchor) : null;
  const head = typeof json.head === 'number' ? address(json.head) : anchor;
  inPlace(editor, () => {
    mutate();
    if (anchor === null || head === null) return;
    editor.transact((tr) => {
      const positionOf = (point: { id: string; offset: number }) => {
        let result: number | null = null;
        tr.doc.descendants((node, position) => {
          if (node.attrs.id === point.id) {
            result = position + Math.min(point.offset, node.nodeSize - 1);
            return false;
          }
          return result === null;
        });
        return result;
      };
      const nextAnchor = positionOf(anchor);
      const nextHead = positionOf(head);
      if (nextAnchor !== null && nextHead !== null)
        tr.setSelection(
          Selection.fromJSON(tr.doc, { ...json, anchor: nextAnchor, head: nextHead }),
        );
    });
  });
}

export function moveBlock(editor: CerebroEditor, id: string, delta: -1 | 1): void {
  const block = editor.getBlock(id);
  const sibling = siblingOf(editor.document, id, delta);
  if (block === undefined || sibling?.id === undefined) return;
  moveWithSelection(editor, () => {
    editor.removeBlocks([block]);
    editor.insertBlocks([block as never], sibling.id!, delta < 0 ? 'before' : 'after');
  });
  editor.focus();
}
