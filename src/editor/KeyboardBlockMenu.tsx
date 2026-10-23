import { useMemo, useState } from 'react';
import { MenuItem, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import type { CerebroEditor } from './MarkdownEditor';
import {
  canConvertBlock,
  duplicateBlock,
  duplicationProblem,
  moveBlock,
  siblingOf,
  TEXT_BLOCK_CHOICES,
} from './blockActions';
import { inPlace } from './reconcile';

/** The context-menu key reaches the same carried operations as the pointer
 * grip, without manufacturing a hover or touching BlockNote's private view. */
export function KeyboardBlockMenu({
  editor,
  blockId,
  anchor,
  onClose,
  onPromote,
  onAssign,
}: {
  editor: CerebroEditor;
  blockId: string;
  anchor: HTMLElement;
  onClose: () => void;
  onPromote?: () => void;
  onAssign?: () => void;
}) {
  const [converting, setConverting] = useState(false);
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const block = editor.getBlock(blockId);
  if (block === undefined || !editor.isEditable) return null;
  const duplication = duplicationProblem(block);
  const run = (action: () => void) => {
    action();
    onClose();
    editor.focus();
  };
  return (
    <Popover
      anchorRef={anchorRef}
      role="menu"
      ariaLabel={converting ? 'Turn block into' : 'Block actions'}
      onClose={onClose}
      onEscape={converting ? () => setConverting(false) : onClose}
      trapFocus
    >
      <MenuSurface key={converting ? 'types' : 'actions'} width={240}>
        {converting ? (
          <>
            <MenuItem
              label="Back to block actions"
              icon="arrow-left"
              onSelect={() => setConverting(false)}
            />
            {TEXT_BLOCK_CHOICES.map((choice) => (
              <MenuItem
                key={choice.label}
                label={choice.label}
                onSelect={() =>
                  run(() =>
                    inPlace(editor, () =>
                      editor.updateBlock(block.id, {
                        type: choice.type,
                        props: choice.props,
                      } as never),
                    ),
                  )
                }
              />
            ))}
          </>
        ) : (
          <>
            <MenuItem
              label="Turn into"
              submenu
              disabled={!canConvertBlock(block)}
              title={
                canConvertBlock(block)
                  ? undefined
                  : 'This block cannot become text without losing its content.'
              }
              onSelect={() => setConverting(true)}
            />
            <MenuItem
              label="Duplicate"
              disabled={duplication !== null}
              title={duplication ?? undefined}
              onSelect={() => run(() => duplicateBlock(editor, block.id))}
            />
            {duplication !== null && (
              <p className="m-0 px-2 py-1 text-metadata text-n-500">{duplication}</p>
            )}
            <MenuItem
              label="Move up"
              disabled={siblingOf(editor.document, block.id, -1) === null}
              onSelect={() => run(() => moveBlock(editor, block.id, -1))}
            />
            <MenuItem
              label="Move down"
              disabled={siblingOf(editor.document, block.id, 1) === null}
              onSelect={() => run(() => moveBlock(editor, block.id, 1))}
            />
            {onAssign && <MenuItem label="Assign & set due date" onSelect={onAssign} />}
            {onPromote && <MenuItem label="Promote to work item…" onSelect={onPromote} />}
            <MenuItem
              label="Delete"
              danger
              onSelect={() => run(() => inPlace(editor, () => editor.removeBlocks([block.id])))}
            />
          </>
        )}
      </MenuSurface>
    </Popover>
  );
}
