import { type ReactElement } from 'react';
import { SideMenuExtension } from '@blocknote/core/extensions';
import {
  BlockColorsItem,
  DragHandleMenu,
  FormattingToolbar,
  FileDownloadButton,
  useSelectedBlocks,
  FormattingToolbarController,
  getFormattingToolbarItems,
  RemoveBlockItem,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useComponentsContext,
  useDictionary,
  useBlockNoteEditor,
  useExtensionState,
} from '@blocknote/react';
import { Icon } from '@/components/ui/Icon';
import { usePageCommentsContext } from './PageCommentsContext';
import {
  canConvertBlock,
  duplicateBlock,
  duplicationProblem,
  moveBlock,
  siblingOf,
  TEXT_BLOCK_CHOICES,
} from './blockActions';
import type { CerebroEditor } from './MarkdownEditor';
import { inPlace } from './reconcile';

/** Selection actions share one toolbar. Writing presets live inside Ask AI,
 * preserving their instructions and the same per-hunk decision path. */

export interface Preset {
  label: string;
  icon: string;
  /** Sent verbatim as the instruction, so what a preset does is readable. */
  instruction: string;
}

export const PRESETS: Preset[] = [
  {
    label: 'Improve writing',
    icon: 'wand-sparkles',
    instruction: 'Improve the writing. Keep the meaning, the voice and the formatting.',
  },
  {
    label: 'Make it shorter',
    icon: 'minimize-2',
    instruction: 'Make it shorter without dropping a fact or a caveat.',
  },
  {
    label: 'Fix spelling & grammar',
    icon: 'spell-check',
    instruction:
      'Fix spelling, grammar and punctuation. Change nothing else — not the wording, not the tone.',
  },
  {
    label: 'As action items',
    icon: 'list-checks',
    instruction:
      'Rewrite this as a markdown checklist of concrete action items, one per line, starting each with "- [ ] ". Drop anything that is not something to do.',
  },
  {
    label: 'Summarize',
    icon: 'text-quote',
    instruction: 'Replace the passage with a two-sentence summary of it.',
  },
];

/**
 * The editor actions a save would drop, by key, each with why (M55.4, M55.15).
 *
 * Every control the editor offers keeps what it does through a save, or it is
 * not offered: the rule the `/` menu follows (`DROPPED_SLASH_KEYS`), applied
 * to the formatting toolbar and the block menu. Each of these was measured
 * (`markdown.test.ts`): a page reopened without what it did, and nothing said
 * so. The toolbar's keys are BlockNote's (`getFormattingToolbarItems`); the
 * block menu's are ours (`blockMenuItems`), since BlockNote names none there.
 *
 * Bold, italic, strike, links, nesting, captions, names and the block type
 * all round-trip, so they stay. The table controls below are also off in the
 * editor's settings (`TABLE_SETTINGS`), which hides the table handles' own
 * copies of them.
 */
export const UNCARRIED_ACTIONS: Readonly<Record<string, string>> = {
  filePreviewButton: "a media block's hidden preview: markdown has no attribute for it",
  underlineStyleButton: 'underline: markdown has none',
  colorStyleButton: 'text and highlight colour: markdown has none',
  textAlignLeftButton: 'alignment: markdown has none, so left is all a page can be',
  textAlignCenterButton: 'alignment: markdown has none',
  textAlignRightButton: 'alignment: markdown has none',
  tableCellMergeButton: 'merged cells: a markdown table cell spans one column',
  blockColorsItem: 'block colour: markdown has none',
  tableRowHeaderItem:
    'the header row toggle: a markdown table always has one, so off comes back on',
  tableColumnHeaderItem: 'a header column: a markdown table has none',
};

/** Whether the editor offers a keyed toolbar or menu item at all. */
const offered = (item: ReactElement): boolean =>
  item.key === null || !Object.hasOwn(UNCARRIED_ACTIONS, item.key);

/** BlockNote's formatting toolbar items, less the ones a save would drop. */
export function formattingToolbarItems(): ReactElement[] {
  return getFormattingToolbarItems()
    .filter(offered)
    .map((item) =>
      item.key === 'fileDownloadButton' ? <RemoteFileDownload key="fileDownloadButton" /> : item,
    );
}

/** The navigation guard cannot download a vault scheme URL. */
export function canDownloadFile(url: unknown): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}
function RemoteFileDownload() {
  const blocks = useSelectedBlocks();
  const block = blocks.length === 1 ? blocks[0] : undefined;
  return block !== undefined && 'url' in block.props && canDownloadFile(block.props.url) ? (
    <FileDownloadButton />
  ) : null;
}

type Dictionary = ReturnType<typeof useDictionary>;

/**
 * BlockNote's block menu (its `DragHandleMenu` default), keyed so the actions
 * a save would drop can leave it; carried structural actions join Delete.
 */
export function blockMenuItems(dict: Dictionary): ReactElement[] {
  return [
    <CarriedBlockAction key="turnIntoItem" action="convert" />,
    <CarriedBlockAction key="duplicateBlockItem" action="duplicate" />,
    <CarriedBlockAction key="moveBlockUpItem" action="up" />,
    <CarriedBlockAction key="moveBlockDownItem" action="down" />,
    <RemoveBlockItem key="removeBlockItem">{dict.drag_handle.delete_menuitem}</RemoveBlockItem>,
    <BlockColorsItem key="blockColorsItem">{dict.drag_handle.colors_menuitem}</BlockColorsItem>,
    <TableRowHeaderItem key="tableRowHeaderItem">
      {dict.drag_handle.header_row_menuitem}
    </TableRowHeaderItem>,
    <TableColumnHeaderItem key="tableColumnHeaderItem">
      {dict.drag_handle.header_column_menuitem}
    </TableColumnHeaderItem>,
  ].filter(offered);
}

function CarriedBlockAction({ action }: { action: 'convert' | 'duplicate' | 'up' | 'down' }) {
  const editor = useBlockNoteEditor() as CerebroEditor;
  const Components = useComponentsContext();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  if (Components === undefined || block === undefined) return null;
  const Menu = Components.Generic.Menu;
  if (action === 'convert') {
    if (!canConvertBlock(block)) return null;
    return (
      <Menu.Root position="right" sub>
        <Menu.Trigger sub>
          <Menu.Item className="bn-menu-item" subTrigger>
            Turn into
          </Menu.Item>
        </Menu.Trigger>
        <Menu.Dropdown sub className="bn-menu-dropdown">
          {TEXT_BLOCK_CHOICES.map((choice) => (
            <Menu.Item
              key={choice.label}
              className="bn-menu-item"
              onClick={() => {
                inPlace(editor, () =>
                  editor.updateBlock(block.id, { type: choice.type, props: choice.props } as never),
                );
                editor.focus();
              }}
            >
              {choice.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu.Root>
    );
  }
  if (action === 'duplicate') {
    const problem = duplicationProblem(block);
    if (problem !== null)
      return (
        <Menu.Label className="bn-menu-label">
          <span title={problem}>Duplicate unavailable for sheets</span>
        </Menu.Label>
      );
    return (
      <Menu.Item className="bn-menu-item" onClick={() => duplicateBlock(editor, block.id)}>
        Duplicate
      </Menu.Item>
    );
  }
  const delta = action === 'up' ? -1 : 1;
  if (siblingOf(editor.document, block.id, delta) === null) return null;
  return (
    <Menu.Item className="bn-menu-item" onClick={() => moveBlock(editor, block.id, delta)}>
      Move {action}
    </Menu.Item>
  );
}

/** The menu the block grip opens, holding only what a save keeps. */
export function CarriedBlockMenu({ onPromote }: { onPromote?: (id: string) => void } = {}) {
  const dict = useDictionary();
  const Components = useComponentsContext();
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  return (
    <DragHandleMenu>
      {blockMenuItems(dict)}
      {Components !== undefined && onPromote !== undefined && block?.type === 'checkListItem' && (
        <Components.Generic.Menu.Item
          className="bn-menu-item"
          data-testid="promote-line-item"
          onClick={() => onPromote(block.id)}
        >
          Promote to record…
        </Components.Generic.Menu.Item>
      )}
    </DragHandleMenu>
  );
}

/**
 * The formatting toolbar, with one Ask AI action after the carried editing tools.
 *
 * `ask` receives the preset the user chose, or undefined for "open the box and
 * let me type". The caller captures the selection — this component never reads
 * it, because by the time a click handler runs the range still exists but the
 * moment focus moves it will not.
 */
export function AiFormattingToolbar({
  onAsk,
  onPromote,
}: {
  onAsk: (preset?: Preset) => void;
  onPromote?: () => void;
}) {
  return (
    <FormattingToolbarController
      formattingToolbar={() => (
        <FormattingToolbar>
          {formattingToolbarItems()}
          <AiToolbarButtons key="cerebro-ai" onAsk={onAsk} onPromote={onPromote} />
        </FormattingToolbar>
      )}
    />
  );
}

/** The AI group, then Comment where a page provides it. Exported for its test. */
export function AiToolbarButtons({
  onAsk,
  onPromote,
}: {
  onAsk: (preset?: Preset) => void;
  onPromote?: () => void;
}) {
  const Components = useComponentsContext();
  const comments = usePageCommentsContext();
  if (Components === undefined) return null;
  const Button = Components.FormattingToolbar.Button;

  return (
    <>
      <span className="inline-flex" onMouseDown={(event) => event.preventDefault()}>
        <Button
          className="bn-button"
          data-testid="selection-ask-ai"
          label="Ask AI"
          mainTooltip="Ask AI about the selection"
          onClick={() => onAsk()}
        >
          {/* The icon is in the children rather than in `icon`, which the
            Mantine button only honours for a label-only button. */}
          <span className="inline-flex items-center gap-1.5">
            <Icon name="sparkles" size={14} color="var(--synapse-500)" />
            Ask AI
          </span>
        </Button>
      </span>
      <span className="mx-1 h-4 w-px flex-none self-center bg-n-200" aria-hidden="true" />
      {/* M70.2b — comment on the selection. Only where a page provides
          PageCommentsContext: DocPage does, the record peek and read-only
          pages do not. The span keeps the selection: mousedown is where a
          click would move it. */}
      {comments !== null && (
        <>
          <span className="inline-flex" onMouseDown={(e) => e.preventDefault()}>
            <Button
              className="bn-button"
              data-testid="selection-comment"
              label="Comment"
              mainTooltip="Comment on the selection"
              onClick={() => comments.start()}
            >
              <span className="inline-flex items-center gap-1.5">
                <Icon name="message-square-plus" size={14} />
                Comment
              </span>
            </Button>
          </span>
          <span className="mx-1 h-4 w-px flex-none self-center bg-n-200" aria-hidden="true" />
        </>
      )}
      {onPromote !== undefined && (
        <span className="inline-flex" onMouseDown={(event) => event.preventDefault()}>
          <Button
            className="bn-button"
            data-testid="selection-promote"
            label="Promote to records"
            mainTooltip="Promote checklist lines to records"
            onClick={onPromote}
          >
            <span className="inline-flex items-center gap-1.5">
              <Icon name="square-arrow-out-up-right" size={14} />
              Promote
            </span>
          </Button>
        </span>
      )}
    </>
  );
}
