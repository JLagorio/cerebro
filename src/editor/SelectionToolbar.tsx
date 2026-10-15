import { useRef, useState, type ReactElement } from 'react';
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
import { MenuItem, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { usePageCommentsContext } from './PageCommentsContext';

/**
 * The AI controls you can actually see (M18).
 *
 * M17.16 built the rewrite surface and bound it to Cmd-K, and nothing on
 * screen said so. An affordance whose only advertisement is a keystroke is one
 * that exists for the person who wrote it: selecting a paragraph looked exactly
 * as it had before the assistant was built.
 *
 * ## Inside BlockNote's toolbar, not beside it
 *
 * The first version of this floated its own dark pill on selection — and
 * BlockNote already floats one, so selecting a sentence produced TWO bars
 * fighting for the same few pixels. Bold and Ask AI are the same kind of act
 * ("do this to what I selected"), so they belong on the same bar, with AI
 * first because it is the one you came for.
 *
 * ## Why the presets are here and not only in the popover
 *
 * "Improve writing" and "Make it shorter" are the overwhelming majority of what
 * anyone asks of selected text, and each is one word typed into a box that then
 * has to be submitted. Putting them on the bar collapses three actions into one
 * and, more usefully, TEACHES the feature: someone who has never opened the
 * popover can see what it is for without composing an instruction first.
 *
 * Comment and Promote are non-AI actions on the same selected text.
 * Every preset lands in the same per-hunk decision surface — a preset is a
 * pre-written instruction, never a different path with fewer safeguards.
 */

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
 * a save would drop can leave it: today that leaves Delete.
 */
export function blockMenuItems(dict: Dictionary): ReactElement[] {
  return [
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
 * The formatting toolbar, with AI at its head.
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
          <AiToolbarButtons key="cerebro-ai" onAsk={onAsk} onPromote={onPromote} />
          {/* What BlockNote would have rendered on its own, less what a save
              would drop (`formattingToolbarItems`). Listed after the AI group
              rather than replaced: this is an addition to the editor's
              toolbar, not a fork of it. */}
          {formattingToolbarItems()}
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
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLSpanElement>(null);
  if (Components === undefined) return null;
  const Button = Components.FormattingToolbar.Button;

  return (
    <>
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
      {PRESETS.slice(0, 2).map((preset) => (
        <Button
          key={preset.label}
          className="bn-button"
          data-testid="selection-preset"
          label={preset.label}
          mainTooltip={preset.instruction}
          icon={<Icon name={preset.icon} size={14} />}
          onClick={() => onAsk(preset)}
        />
      ))}
      <span ref={moreRef} className="inline-flex">
        <Button
          className="bn-button"
          label="More AI actions"
          mainTooltip="More AI actions"
          icon={<Icon name="chevron-down" size={13} />}
          isSelected={more}
          onClick={() => setMore((v) => !v)}
        />
      </span>
      {more && (
        // A real floating layer, not `absolute` inside the toolbar. The
        // toolbar is a positioned, clipping, transform-placed element, so an
        // absolutely-positioned child rendered THERE is cropped at its edge —
        // which is exactly what it did: the button lit up and no menu
        // appeared. Popover portals out and anchors to the button.
        <Popover
          anchorRef={moreRef}
          role="menu"
          ariaLabel="More AI actions"
          onClose={() => setMore(false)}
        >
          <MenuSurface width={210}>
            {PRESETS.map((preset) => (
              <MenuItem
                key={preset.label}
                icon={preset.icon}
                label={preset.label}
                testId="selection-preset"
                title={preset.instruction}
                // The selection has to survive the click, and mousedown is
                // where it would be lost.
                onMouseDown={(e) => e.preventDefault()}
                onSelect={() => {
                  setMore(false);
                  onAsk(preset);
                }}
              />
            ))}
          </MenuSurface>
        </Popover>
      )}
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
