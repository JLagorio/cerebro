import { resolveOptionColor } from '@/lib/swatch';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { MenuBack, MenuItem, MenuLabel, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { AddPropertyPanel, type RelationConfig } from '@/detail/AddPropertyPanel';
import { FieldEditor } from '@/detail/FieldEditor';
import { deleteNote } from '@/lib/ipc';
import { aggregate, aggregateMeta, aggregatesFor, type AggregateCalc } from '@/engine/aggregate';
import {
  MIN_COL_W,
  columnOwner,
  hiddenColumns,
  insertColumn,
  moveColumn,
  resolveColumns,
  setColumnWidth,
  setColumnWrap,
  toggleColumn,
  type ColumnDef,
} from '@/engine/columns';
import { buildRows, entryRows } from '@/engine/rows';
import {
  CREATABLE_PROPERTY_KINDS,
  GROUPABLE_KINDS,
  kindMeta,
  progressRatio,
} from '@/engine/properties';
import { humanize } from '@/engine/schema';
import { typeStyle } from '@/engine/typeCatalog';
import { groupByField, sortBy } from '@/engine/views';
import type {
  ChipStyle,
  ColumnSpec,
  Entry,
  FieldDef,
  FieldKind,
  GroupNode,
  Presentation,
  RowHeight,
  Schema,
} from '@/engine/types';
import {
  addFieldToType,
  addRelationProperty,
  changeFieldKind,
  duplicateFieldOnType,
  insertFieldOnType,
  normalizeFieldName,
  removeFieldFromType,
  renameFieldOnType,
} from '@/app/typeActions';
import { useOpenPath } from '@/app/useOpenPath';
import { ConfirmDeleteProperty, ConfirmKindChange, PropertyEditor } from '@/views/PropertyEditor';
import { duplicateRecord } from '@/app/recordActions';
import { QuickAddInline } from '@/views/QuickAdd';
import {
  CELL_CONTROL,
  primaryControl,
  useRowKeyboard,
  type RowKeyboardCellProps,
  type RowKeyboardRowProps,
} from '@/views/useRowKeyboard';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const TITLE_W = 280;
/**
 * M19.3 raised this from 140. The name cell's fixed chrome is the indent, the
 * nesting expander, the type icon, the gaps and the Open pill — about 117px —
 * so at the old floor a title had roughly 23px to render in. The floor has to
 * clear the chrome the cell always lays out, or the column can be dragged to a
 * width where the one thing it exists to show is the one thing not visible.
 */
const MIN_TITLE_W = 200;

/** CSS custom property carrying a column's width. Index-based, because a
 * frontmatter key is not guaranteed to be a legal custom-property name. */
const widthVar = (index: number) => `--cb-cw-${index}`;
const TITLE_VAR = '--cb-cw-title';

/** Kinds whose editor is a popover/inline control the cell hosts directly. */
const READ_ONLY = new Set(['rollup', 'created_time', 'last_edited_time']);

/**
 * Read-only cell body. Rendered for computed kinds and as the resting state
 * of a progress-formatted number, where the bar carries the meaning.
 */
function ProgressCell({ display }: { display: string }) {
  const ratio = progressRatio(display);
  // The same em-dash the read-only branch draws: one absence, one rendering.
  if (ratio === null)
    return <span className="truncate text-sm">{display === '' ? '—' : display}</span>;
  return (
    // w-full: the bar is flex-1, so without a sized parent it collapses to
    // zero inside a content-width cell.
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-n-100">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${ratio}%`,
            background: ratio >= 100 ? 'var(--success-500)' : 'var(--cortex-500)',
          }}
        />
      </span>
      <span className="flex-none [font-family:var(--font-mono)] text-2xs text-n-600">
        {display}
      </span>
    </span>
  );
}

/**
 * One data cell. Memoized on the values that can change it, because a table
 * of 32 rows × 8 columns re-renders on every keystroke elsewhere otherwise.
 *
 * Its width comes from a CSS variable rather than a number, so dragging a
 * column divider repaints without re-rendering a single row (see the resize
 * handler below).
 */
const TableCell = memo(function TableCell({
  entry,
  def,
  schema,
  index,
  chips,
  wrap = false,
  colIndex,
  cellProps,
  freeze,
  fill,
}: {
  entry: Entry;
  def: ColumnDef;
  schema: Schema;
  index: number;
  chips: ChipStyle;
  /** M12.4b: the column's Wrap content setting — values flow onto extra
   * lines instead of clipping, and the row grows to hold them. */
  wrap?: boolean;
  /** M16.17: this cell's slot in DISPLAY order, which is what the cell
   * cursor traverses — not `index`, which addresses the width variable. */
  colIndex: number;
  cellProps: RowKeyboardCellProps;
  /** M16.18: sticky placement when this slot is inside the frozen run. */
  freeze?: React.CSSProperties;
  /** The row's fill, repeated because a frozen cell has to be opaque. */
  fill: string;
}) {
  const resolved = schema.resolveField(entry, def.name);

  /**
   * Does THIS ROW's own type declare the property this column names (M20.1)?
   *
   * A grouping chain can descend a relation, which puts records of foreign
   * types in one grid — the OKR tree nests Key results and Work items under
   * Objectives. `buildRows` builds rows from the source type plus every
   * relation the chain descends into; `columnUniverse` builds columns from the
   * source type ALONE. So a Work item was laid out under Objective's columns
   * and every one of them offered a full editor.
   *
   * `validatePatch` looks a field up on the record's own type, so grafting a
   * parent's *select* onto a child's *number* field of the same name was
   * already refused. What sailed through was the case with no def to validate
   * against at all: undeclared keys are legal by design (advisory schema), so
   * picking a person in an Objective's "Owner" column wrote `owner: [[…]]`
   * onto a Work item that has never heard of `owner` — beneath the `assignee`
   * it actually declares, which the grid had no column for.
   *
   * `resolveField` already answers this exactly: `def` is the row's own type's
   * declaration, or null. A column the row does not own renders as the
   * resolved display, read-only — no editor, and no click to forward into one.
   * `ListView` has done this per row since M9.6; the table was the surface
   * that disagreed.
   *
   * `undeclared` is the other way a row can fail to declare a column, and it
   * is not this one: a column NO type declares — a hand-written view column, a
   * frontmatter key the advisory schema surfaced — belongs to no type in
   * particular, so no row is trespassing on another's by editing it.
   */
  const owned = resolved.def !== null || def.undeclared === true;

  /**
   * The declaration this CELL renders by (M20.2).
   *
   * `def` is the COLUMN's, which is the first declaration `columnUniverse`
   * found across the types in the grid — and on a chain that descends a
   * relation, or in a typeless view, that is routinely another type's. Two
   * types can each declare `estimate` and mean a select on one and a number on
   * the other; `size` can be a number here and a select there. Rendering every
   * row through the column's def gave those rows the wrong editor, the wrong
   * options, and the wrong format, which is what `heterogeneous` used to
   * suppress by taking the whole column read-only.
   *
   * A row's own declaration is a better answer than refusing: the header still
   * shows one kind (with the warning beside it), and each cell is right.
   */
  const cellDef = resolved.def ?? def;
  const readOnly = !owned || READ_ONLY.has(cellDef.kind);
  /**
   * A progress bar is what a read-only kind LOOKS like here, not what makes a
   * cell read-only (M20.3).
   *
   * `format: 'progress'` used to be part of the read-only test, so a number
   * the record panel let you edit could not be edited in the grid — the format
   * had become a permission. The bar is now the resting state of the ordinary
   * number editor (`FieldEditor`), and this branch draws it only for the kinds
   * that are genuinely computed: a rollup that formats as progress.
   */
  const isProgress = cellDef.format === 'progress';
  const editable = !readOnly;

  /**
   * The whole cell is the hit target (M19.2).
   *
   * The editor is a button sized to its VALUE, so in a 150px column with the
   * word "Todo" in it roughly 100px of cell answered no click at all — and
   * the part that did answer painted its own inset hover fill, which read as
   * a floating box rather than as the cell. Notion's cell is one target from
   * border to border.
   *
   * Only when the click landed on the cell's own padding: a click that
   * already reached the editor — or a link, or a chip's remove button — must
   * not be delivered to it a second time.
   *
   * The containment check is load-bearing, not defensive. `closest` walks up
   * past this cell, and the grid's scroll container carries `tabIndex={0}`
   * from `useRowKeyboard` — which the last clause of CELL_CONTROL matches. So
   * an unbounded `closest` reports a hit for EVERY click in the table and
   * forwards none of them.
   *
   * `label` is in the guard but deliberately NOT in CELL_CONTROL, which would
   * change what Enter targets. A checkbox cell is a `Switch`: a `<label>`
   * around a hidden input. Clicking its track fires on a `<span>` that
   * matches no control, so an unguarded forward clicked the input — and then
   * the label's own activation behaviour clicked it AGAIN. Two writes to
   * disk, ending exactly where they started, so the checkbox looked inert.
   */
  const openEditor = (e: React.MouseEvent<HTMLDivElement>) => {
    // `a[href]` joins the guard and NOT `CELL_CONTROL` (M20.5), the same
    // distinction the `label` note above draws: a URL, email or phone cell
    // renders an anchor plus a pencil, and following the link also flipped the
    // cell into edit mode behind the page you had just opened. Adding it to
    // CELL_CONTROL instead would change what ENTER targets — the anchor is not
    // the control the cell means, the pencil is.
    const hit = (e.target as HTMLElement).closest(`a[href],label,${CELL_CONTROL}`);
    if (hit !== null && e.currentTarget.contains(hit)) return;
    primaryControl(e.currentTarget)?.click();
  };

  return (
    <div
      role="gridcell"
      {...cellProps}
      {...(editable ? { onClick: openEditor } : {})}
      aria-colindex={colIndex + 2}
      className={[
        'flex flex-none overflow-hidden border-r border-n-100 px-2',
        wrap ? 'items-start py-1.5' : 'items-center',
        freeze === undefined ? '' : `z-10 ${fill}`,
        // The ring is inset, not a border: a border would add a pixel to a
        // cell whose width is a shared CSS variable and shear the column.
        'data-[cursor]:shadow-[inset_0_0_0_2px_var(--cortex-500)]',
      ].join(' ')}
      style={{ width: `var(${widthVar(index)})`, ...freeze }}
    >
      {readOnly ? (
        isProgress ? (
          <ProgressCell display={resolved.display} />
        ) : (
          <span
            className={[
              'text-sm text-n-600',
              wrap ? 'whitespace-normal [overflow-wrap:anywhere]' : 'truncate whitespace-nowrap',
            ].join(' ')}
          >
            {resolved.display === '' ? '—' : resolved.display}
          </span>
        )
      ) : (
        // Editing happens in place: the same FieldEditor the panel uses, so
        // validation and popovers behave identically in both surfaces. The
        // wrapper clamps it to one line unless the column wraps (M12.4b).
        //
        // `cb-cell-chrome` is what makes the SAME editor read differently in
        // the two surfaces (M16.35): in the panel an unset property keeps its
        // chevron and its grey "Empty", which is Notion's record page; in a
        // table cell the chrome is un-painted until the row is live, which is
        // Notion's table. The rules live in styles/table-chrome.css rather
        // than in a prop because FieldEditor is a chain of early returns with
        // four separate chevrons, and a class on the wrapper reaches all of
        // them without threading a display mode through any of them.
        <div
          className={[
            'cb-cell-chrome flex min-w-0 flex-1 overflow-hidden [&>*]:max-w-full',
            wrap ? 'items-start' : 'items-center',
          ].join(' ')}
        >
          {/* placeholder="blank": an unset TABLE cell paints nothing at all —
              no ghost "Empty", no chevron, no calendar glyph — which is what
              Notion's table does and what the record panel deliberately does
              NOT do (M16.35). Kept separate from `compact`, which only says
              this column does not wrap: a user toggling Wrap content must not
              change what an empty cell looks like. */}
          <FieldEditor
            entry={entry}
            def={cellDef}
            schema={schema}
            compact={!wrap}
            chips={chips}
            placeholder="blank"
          />
        </div>
      )}
    </div>
  );
});

/**
 * The name cell's value: an ordinary editable cell (M19.3).
 *
 * The title used to BE the opener — a button that navigated on click — which
 * made the name the one cell in the grid you could not edit, and left the
 * `maximize-2` glyph beside it as `aria-hidden` decoration that answered no
 * click at all. That shape came from M15 and fixed a real defect the honest
 * way round would also have fixed: the previous opener was `display:none`
 * until hover, so it was absent from the DOM and from the tab order and there
 * was no keyboard path into a record. Making the title the button removed the
 * affordance instead of making it focusable. The Open pill beside this is
 * focusable, so both can be true now.
 *
 * Modelled on FieldEditor's text branch, minus its `w-40`: a fixed width blows
 * the flex line inside a fixed-width sticky cell.
 */
function TitleCell({
  entry,
  onCommit,
}: {
  entry: Entry;
  onCommit: (title: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  // Rows are memoized and reordered by the view's sort chain, and the rename
  // itself triggers a rescan — so without a path-keyed reset a mounted input
  // could survive onto a different record and commit the draft onto it.
  useEffect(() => setDraft(null), [entry.path]);

  if (draft === null) {
    return (
      <button
        type="button"
        // The accessible name is the title itself, so no aria-label: "Open X"
        // moved to the pill, which is the thing that now opens.
        data-cell-primary
        onClick={(e) => {
          e.stopPropagation();
          setDraft(entry.title);
        }}
        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-sm text-n-900 focus-visible:rounded-sm focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
      >
        {entry.title}
      </button>
    );
  }

  const commit = () => {
    const next = draft.trim();
    setDraft(null);
    void onCommit(next);
  };

  return (
    <input
      autoFocus
      type="text"
      aria-label="Title"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        // stopPropagation, like FieldEditor's text branch — useRowKeyboard's
        // capture-phase recovery is written against exactly that behaviour.
        if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className="h-[26px] min-w-0 flex-1 rounded-md border border-cortex-500 px-1.5 text-sm text-n-900 shadow-[var(--ring)] outline-none"
    />
  );
}

/** Indent per nesting level, matching the group-band step. */
const INDENT = 16;

/**
 * Width of the leading gutter (M16.16), wide enough for insert + checkbox +
 * grip. It is laid out on every row rather than inserted on hover: a control
 * that pushes the whole grid 46px sideways under the pointer is worse than
 * one that was always there and only faded in.
 */
const GUTTER = 46;

/**
 * Row heights (M16.18). `presentation.rowHeight` has been parsed since M9.1
 * and serialized since M11 and was read by NOTHING — a saved view carried the
 * setting round-trip and the table ignored it. Tailwind classes rather than
 * numbers because the row is also `min-h-` when a column wraps, and one map
 * per spelling is one map too many.
 *
 * `Record<RowHeight, …>` since M16.29, when the height list moved to
 * `engine/types` — the settings page offering the choices and this map
 * rendering them cannot list different ones.
 */
const ROW_HEIGHT: Record<RowHeight, string> = { compact: 'h-8', default: 'h-9', tall: 'h-12' };
const ROW_MIN_HEIGHT: Record<RowHeight, string> = {
  compact: 'min-h-8',
  default: 'min-h-9',
  tall: 'min-h-12',
};

/** Widest a fit-to-content column may become. Past this the column stops
 * being a column and becomes the table. */
const FIT_MAX_W = 520;

/** The header's trailing "+" slot. Part of the content width, like GUTTER. */
const ADD_W = 34;

/** What a row's own menu can do. Per-row, so the handlers stay in the table
 * where the vault and the confirm dialog already live. */
export type RowAction = 'open' | 'copy-link' | 'copy-path' | 'delete';

/**
 * The row's leading gutter (M16.16): select, insert, and the row menu.
 *
 * `TableRow` had none of these. The `maximize-2` glyph in the title cell was
 * `aria-hidden` decoration, and bulk selection did not exist anywhere in the
 * app — `useRowKeyboard` holds a scalar cursor index, not a set.
 *
 * The grip is Notion's `⠿`, and here it OPENS the row menu rather than
 * reordering. Row order in this app is the view's sort chain; there is no
 * stored per-row index for a drag to write to, so a grip that moved a row
 * would put it back on the next render. Clicking Notion's grip opens the same
 * menu, which is the half of it that means something here.
 */
function RowGutter({
  entry,
  checked,
  selecting,
  frozen,
  fill,
  onCheck,
  onInsert,
  onAction,
}: {
  entry: Entry;
  checked: boolean;
  /** Pins left with the name column — a gutter that scrolls out from under a
   * frozen name column leaves the row with no way to select it. */
  frozen: boolean;
  /** The row's own background, repeated because a sticky cell is opaque. */
  fill: string;
  /** True while anything is selected — the boxes stay visible then, so the
   * selection you are building does not vanish when the pointer leaves. */
  selecting: boolean;
  onCheck: (range: boolean) => void;
  /** Absent on a surface that cannot create. */
  onInsert?: () => void;
  onAction: (action: RowAction, entry: Entry) => void;
}) {
  const [open, setOpen] = useState(false);
  const gripRef = useRef<HTMLButtonElement | null>(null);
  // Laid out always, faded in on hover — see GUTTER.
  const reveal = checked || selecting || open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';

  return (
    <div
      role="gridcell"
      // M20.4: it holds the row's checkbox, insert and menu, so it IS a cell —
      // but it declared no index, and a cell without one takes its position
      // from the DOM, which made the gutter and the first data cell both
      // column 1. Every data slot is offset by it.
      aria-colindex={1}
      className={[
        frozen ? 'sticky left-0 z-10' : '',
        'flex flex-none items-center justify-end gap-0.5 pl-1 pr-1',
        fill,
      ].join(' ')}
      style={{ width: GUTTER }}
      // The gutter's controls all act on the row; a click here must not also
      // move the keyboard cursor to it.
      onClick={(e) => e.stopPropagation()}
    >
      {onInsert !== undefined && (
        <Tooltip label="Insert a record here">
          <button
            type="button"
            data-testid="row-insert"
            aria-label={`Insert a record after ${entry.title}`}
            onClick={onInsert}
            className={`flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-n-400 hover:bg-n-100 hover:text-n-800 ${reveal}`}
          >
            <Icon name="plus" size={12} />
          </button>
        </Tooltip>
      )}
      <input
        type="checkbox"
        data-testid="row-select"
        aria-label={`Select ${entry.title}`}
        checked={checked}
        onChange={() => undefined}
        // onClick, not onChange: shift-extend needs the modifier, and a
        // change event does not carry one.
        onClick={(e) => onCheck(e.shiftKey)}
        className={`h-3.5 w-3.5 flex-none accent-cortex-500 ${reveal}`}
      />
      <button
        ref={gripRef}
        type="button"
        data-testid="row-menu"
        aria-label={`Actions for ${entry.title}`}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        className={`flex h-5 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-n-400 hover:bg-n-100 hover:text-n-800 ${reveal}`}
      >
        <Icon name="grip-vertical" size={12} />
      </button>
      {open && (
        <Popover
          anchorRef={gripRef}
          onClose={() => setOpen(false)}
          role="menu"
          ariaLabel={`Actions for ${entry.title}`}
          trapFocus
        >
          <MenuSurface width={208}>
            <MenuItem
              icon="maximize-2"
              label="Open"
              testId="row-open"
              onSelect={() => {
                setOpen(false);
                onAction('open', entry);
              }}
            />
            <MenuItem
              icon="link"
              label="Copy link"
              onSelect={() => {
                setOpen(false);
                onAction('copy-link', entry);
              }}
            />
            <MenuItem
              icon="file-text"
              label="Copy path"
              onSelect={() => {
                setOpen(false);
                onAction('copy-path', entry);
              }}
            />
            <MenuSeparator />
            <MenuItem
              icon="trash-2"
              label="Delete"
              danger
              testId="row-delete"
              onSelect={() => {
                setOpen(false);
                onAction('delete', entry);
              }}
            />
          </MenuSurface>
        </Popover>
      )}
    </div>
  );
}

/**
 * The inline create the gutter's `+` opens (M16.16).
 *
 * It is NOT `QuickAddInline`, whose two-state shape starts as a button — the
 * `+` was already that click, and asking for a second one to reach the input
 * is the affordance failing. Only the editing half is duplicated, and only
 * because the button half is what makes it wrong here.
 *
 * Where the record LANDS is the view's sort chain, not this position: a
 * markdown vault has no stored per-row index, so "insert here" means "create
 * here, in this band" and the row appears wherever the sort puts it.
 */
function InsertRow({
  gutter,
  frozen,
  indent,
  onCreate,
  onCancel,
}: {
  gutter: number;
  frozen: boolean;
  indent: number;
  onCreate: (title: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  // Double-Enter while the write is pending must not create two records.
  const [submitting, setSubmitting] = useState(false);

  const submit = () => {
    if (submitting || title.trim() === '') return;
    setSubmitting(true);
    void (async () => {
      const ok = await onCreate(title);
      setSubmitting(false);
      // On failure the draft stays editable for retry.
      if (ok) setTitle('');
    })();
  };

  return (
    <div
      role="row"
      data-testid="insert-row"
      className={[
        frozen ? 'sticky left-0' : '',
        'flex h-9 items-center border-b border-n-100 bg-n-0',
      ].join(' ')}
      style={{ width: `calc(var(${TITLE_VAR}) + ${gutter}px)` }}
    >
      <span className="flex flex-none items-center justify-end pr-1" style={{ width: gutter }}>
        <Icon name="plus" size={12} color="var(--n-400)" />
      </span>
      <span className="min-w-0 flex-1 pr-2" style={{ paddingLeft: indent }}>
        <Input
          autoFocus
          size="sm"
          ariaLabel="New record title"
          placeholder="New record"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onCancel();
          }}
          onBlur={onCancel}
          width="100%"
        />
      </span>
    </div>
  );
}

const TableRow = memo(function TableRow({
  entry,
  cells,
  titlePos,
  titleFrozen,
  freezeStyle,
  rowHeight,
  autoHeight,
  schema,
  depth,
  childCount,
  collapsed,
  chips,
  onToggle,
  selected,
  onSelect,
  rowProps,
  checked,
  selecting,
  onCheck,
  onInsert,
  onAction,
  onRename,
  cellProps,
}: {
  entry: Entry;
  cells: { def: ColumnDef; wrap: boolean }[];
  /** M12.8: the name column's index among the visible columns. */
  titlePos: number;
  /** M12.8: false lets the name column scroll with the grid. */
  titleFrozen: boolean;
  /** M16.18: sticky placement for a display slot, or nothing when it scrolls. */
  freezeStyle: (displayIndex: number) => React.CSSProperties | undefined;
  /** M16.18: the view's row height, at last consumed by something. */
  rowHeight: NonNullable<Presentation['rowHeight']>;
  /** True when any column wraps — rows grow instead of clipping (M12.4b). */
  autoHeight: boolean;
  schema: Schema;
  /** M10: nesting depth from the grouping chain's relation levels. */
  depth: number;
  childCount: number;
  collapsed: boolean;
  chips: ChipStyle;
  onToggle: () => void;
  selected: boolean;
  /** The display slot clicked, or -1 for "the row itself". */
  onSelect: (col: number) => void;
  /** Roving-tabindex bookkeeping from useRowKeyboard — id, aria-selected and
   * the ref the cursor scrolls into view. */
  rowProps: RowKeyboardRowProps;
  /** M16.16: bulk selection, which is a different thing from the keyboard
   * cursor above — one row is under the cursor, any number are checked. */
  checked: boolean;
  selecting: boolean;
  onCheck: (range: boolean) => void;
  onInsert?: () => void;
  onAction: (action: RowAction, entry: Entry) => void;
  /** M19.3: commit an in-place title edit. Its own prop rather than a
   * `RowAction`, because `onAction`'s `(action, entry)` shape has no slot to
   * carry the new title. */
  onRename: (entry: Entry, title: string) => Promise<boolean>;
  /** M16.17: the cursor's bookkeeping for one cell of THIS row, by display
   * slot. Bound to the row so the cells never have to know their row index. */
  cellProps: (col: number) => RowKeyboardCellProps;
}) {
  // M3.5: route by kind — a Project record opens its page, everything else
  // opens the detail panel. No sidebar special-casing needed.
  // M9.3: in-place — the table IS the context, so opening a row must not
  // navigate to the record's project and discard the view you were reading.
  const openPath = useOpenPath('in-place');
  const style = typeStyle(entry.type, schema);
  // The fill the sticky cells repeat. Checked rows tint like the cursor row:
  // the two states are different, but both mean "this row is picked out".
  const fill = selected || checked ? 'bg-cortex-50' : 'bg-n-0 group-hover:bg-n-25';

  return (
    <div
      role="row"
      {...rowProps}
      data-testid="table-row"
      data-path={entry.path}
      data-depth={depth}
      // M20.4: a click puts the cursor on the CELL it landed in, not just on
      // the row. `useRowKeyboard` has exported `setCell` for exactly this since
      // M16.17 and nothing had ever called it, so clicking a cell and then
      // pressing an arrow moved a cursor that was somewhere else entirely —
      // usually back at the top of the grid.
      onClick={(e) => {
        const cell = (e.target as HTMLElement).closest<HTMLElement>('[role="gridcell"]');
        const index = cell?.getAttribute('aria-colindex');
        // The gutter is column 1 and holds the row's own controls, so a click
        // there means the row, not a cell (it stops propagation anyway).
        onSelect(index == null || index === '1' ? -1 : Number(index) - 2);
      }}
      // `group` sits on the ROW so hovering anywhere reveals Open, not only
      // over the name cell.
      //
      // `cb-row` is the same idea for the cell chrome (M16.35), in plain CSS
      // rather than a Tailwind group: the chevrons and calendar glyphs it
      // un-paints live inside FieldEditor, several components down, and the
      // reveal has to fire on the KEYBOARD cursor too — `data-focused`, which
      // rowProps sets above — because this grid drives itself with
      // aria-activedescendant and DOM focus never reaches a row at all. See
      // styles/table-chrome.css.
      className={[
        'group cb-row flex border-b border-n-100',
        autoHeight ? ROW_MIN_HEIGHT[rowHeight] : ROW_HEIGHT[rowHeight],
        // The cursor row needs to survive a bright screen: the --cortex-50
        // fill alone was 1.13:1 against white, so a left rule carries it.
        selected
          ? 'bg-cortex-50 shadow-[inset_2px_0_0_var(--cortex-500)]'
          : checked
            ? 'bg-cortex-50'
            : 'hover:bg-n-25',
      ].join(' ')}
    >
      <RowGutter
        entry={entry}
        checked={checked}
        selecting={selecting}
        // The gutter pins whenever anything does: a gutter that scrolls out
        // from under a frozen column leaves the row with no way to select it.
        frozen={freezeStyle(0) !== undefined}
        fill={fill}
        onCheck={onCheck}
        onInsert={onInsert}
        onAction={onAction}
      />
      {cells.slice(0, titlePos).map(({ def, wrap }, i) => (
        <TableCell
          key={def.name}
          entry={entry}
          def={def}
          schema={schema}
          index={i}
          chips={chips}
          wrap={wrap}
          colIndex={i}
          cellProps={cellProps(i)}
          freeze={freezeStyle(i)}
          fill={fill}
        />
      ))}
      <div
        role="gridcell"
        {...cellProps(titlePos)}
        aria-colindex={titlePos + 2}
        /**
         * The whole cell is the hit target here too (M20.5).
         *
         * M19.2 made every DATA cell one target from border to border and this
         * is the cell it missed — which is the one with the most dead space in
         * it: the depth indent, the gaps either side of the type icon, and the
         * strip between the title and the Open pill all answered no click at
         * all. Same forwarder, same guard, and `primaryControl` already knows
         * the name cell leads with its nesting expander and that the title
         * beside it is what a gesture on the cell means (`data-cell-primary`).
         */
        onClick={(e) => {
          const hit = (e.target as HTMLElement).closest(`a[href],label,${CELL_CONTROL}`);
          if (hit !== null && e.currentTarget.contains(hit)) return;
          primaryControl(e.currentTarget)?.click();
        }}
        className={[
          titleFrozen ? 'z-10' : '',
          'data-[cursor]:shadow-[inset_0_0_0_2px_var(--cortex-500)]',
          'flex flex-none items-center gap-1.5 border-r border-n-100 pr-3',
          // The name cell is opaque because it is sticky — it has to hide the
          // columns sliding under it, so it repeats the row's own fill.
          fill,
        ].join(' ')}
        style={{
          width: `var(${TITLE_VAR})`,
          paddingLeft: 12 + depth * INDENT,
          ...freezeStyle(titlePos),
        }}
      >
        {/* M10: a table nests when the chain has a relation level, so the
            expander belongs here rather than in a separate hierarchy view. A
            fixed-size spacer keeps childless rows' titles aligned. */}
        {childCount > 0 ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${entry.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-n-400 hover:bg-n-100 hover:text-n-800"
          >
            <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
          </button>
        ) : (
          <span className="h-4 w-4 flex-none" />
        )}
        <Icon name={style.icon} size={13} color={style.color ?? 'var(--n-400)'} />
        <TitleCell entry={entry} onCommit={(title) => onRename(entry, title)} />
        {childCount > 0 && (
          <span className="flex-none [font-family:var(--font-mono)] text-2xs text-n-400">
            {childCount}
          </span>
        )}
        {/* Reserved space, not inserted space: the pill is always laid out and
            only its opacity changes, so the title never reflows under the
            pointer — hover-INSERTED chrome stealing ~62px from the name you
            are reading is the defect the reserved slot exists to prevent.
            M19.3: a real control, where an `aria-hidden` glyph used to sit.
            `cb-row-open` fades with OPACITY rather than the `visibility` the
            inert chrome uses, because a `visibility: hidden` button cannot be
            focused — and this is the row's only opener, so hiding it from the
            tab order would recreate exactly the M15 defect that made the
            title the opener in the first place. */}
        <button
          type="button"
          data-testid="row-open-affordance"
          aria-label={`Open ${entry.title}`}
          onClick={(e) => {
            e.stopPropagation();
            openPath(entry.path);
          }}
          className="cb-row-open flex-none rounded-sm border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-[0.04em] text-n-500 hover:bg-n-50 hover:text-n-800"
        >
          Open
        </button>
      </div>
      {cells.slice(titlePos).map(({ def, wrap }, i) => (
        <TableCell
          key={def.name}
          entry={entry}
          def={def}
          schema={schema}
          index={titlePos + i}
          chips={chips}
          wrap={wrap}
          // One past the width index: the name column sits between the two
          // runs in DISPLAY order but owns no width variable.
          colIndex={titlePos + 1 + i}
          cellProps={cellProps(titlePos + 1 + i)}
          freeze={freezeStyle(titlePos + 1 + i)}
          fill={fill}
        />
      ))}
      {/* Absorbs the header's "+" slot, so the row's hover fill reaches the
          right edge instead of stopping 34px short of it. */}
      <span aria-hidden className="flex-1" />
    </div>
  );
});

/**
 * Draggable divider that resizes the column to its left (M11 rewrite).
 *
 * The old one wrote the new width to the view's YAML on every mousemove — a
 * disk write and a full vault rescan per pixel — which is why resizing "barely
 * worked": the drag fought a stream of re-renders carrying stale widths.
 *
 * This one paints through a CSS variable during the drag (no React state, no
 * row re-render, no write) and persists once, on release. It also compares
 * against the width the drag STARTED at rather than accumulating per-event
 * deltas, so a fast drag that outruns a repaint lands where the pointer is.
 */
function ColumnResizer({
  label,
  onDrag,
  onCommit,
  width,
  min,
  onFit,
}: {
  label: string;
  /** Called with each intermediate width — paints, never persists. */
  onDrag: (width: number) => void;
  onCommit: (width: number) => void;
  width: number;
  min: number;
  /** M16.18: fit to content — double-click, or Enter on the focused handle. */
  onFit?: () => void;
}) {
  const start = useRef({ x: 0, w: 0 });
  const [active, setActive] = useState(false);
  /**
   * The width an arrow key is building, before it is persisted (M20.5).
   *
   * Each arrow press called `onCommit`, which writes the view file and
   * rescans the vault — so holding the key down ran one full write-and-rescan
   * per repeat, which is the exact failure the POINTER path was rewritten to
   * avoid (paint on move, persist on up). `null` means "nothing pending".
   */
  const pending = useRef<number | null>(null);
  const nudge = (next: number) => {
    pending.current = next;
    onDrag(next);
  };
  const settle = () => {
    if (pending.current === null) return;
    onCommit(pending.current);
    pending.current = null;
  };

  const begin = (clientX: number) => {
    // A pointer grab supersedes a half-built keyboard nudge — without this,
    // the blur after the drag would settle the stale pending as a second
    // write on top of the drag's own.
    pending.current = null;
    start.current = { x: clientX, w: width };
    setActive(true);
    const at = (x: number) => Math.max(min, Math.round(start.current.w + (x - start.current.x)));
    const move = (e: PointerEvent) => onDrag(at(e.clientX));
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('cb-resizing');
      setActive(false);
      onCommit(at(e.clientX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    // Kills text selection and keeps the col-resize cursor while the pointer
    // is outside the 9px handle, which is most of any real drag.
    document.body.classList.add('cb-resizing');
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        begin(e.clientX);
      }}
      onDoubleClick={(e) => {
        // Notion's gesture, and the only one that needs no menu: the divider
        // that sets a width by hand also computes the right one.
        e.preventDefault();
        e.stopPropagation();
        onFit?.();
      }}
      // Blur is the keyboard's pointerup: the arrows paint, leaving the handle
      // persists. Enter also settles first, so a nudge-then-fit does not lose
      // the nudge (M20.5).
      onBlur={settle}
      onKeyDown={(e) => {
        // Keyboard resize: a pointer-only affordance is unreachable without one.
        const step = e.shiftKey ? 40 : 8;
        const from = pending.current ?? width;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          nudge(Math.max(min, from - step));
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          nudge(from + step);
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          settle();
          onFit?.();
        }
        // Committing on Escape would be the opposite of what it means
        // everywhere else in this app, so it abandons what the arrows built.
        if (e.key === 'Escape') {
          e.preventDefault();
          pending.current = null;
          onDrag(width);
        }
      }}
      // A 1px target was most of the problem: the pointer had to land on a
      // hairline. This one is 9px wide, centred on the border, and only paints
      // the 2px indicator.
      className="absolute -right-[4px] top-0 z-20 flex h-full w-[9px] cursor-col-resize touch-none items-stretch justify-center"
    >
      <span
        className={[
          'w-[2px] rounded-full transition-colors',
          active ? 'bg-cortex-500' : 'bg-transparent hover:bg-cortex-300',
        ].join(' ')}
      />
    </span>
  );
}

export interface TableViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /**
   * The whole vault (M10). Nested children resolve against it, so a filtered
   * table can still nest under a parent the filter excluded. Defaults to
   * `entries` — a table with no relation level in its chain never reads it.
   */
  allEntries?: Entry[];
  /** Declared fields of the collection's type — the column universe. */
  fields: ColumnDef[];
  onOrderBy?: (field: string) => void;
  /** M9.2: persists column order, width, and visibility to the view. Omit on
   * surfaces with no view file to write to — the header menu hides. */
  onColumnsChange?: (next: ColumnSpec[]) => void;
  /** M11: persists presentation-level table state (the name column's width). */
  onPresentationChange?: (next: Presentation) => void;
  /** Collapse-state namespace (M9.1). */
  scope?: string;
  /** M9.6: create a record from the grid, inheriting the band's value. */
  onCreate?: (title: string, band: { groupBy: string; groupValue: string }) => Promise<boolean>;
  /** True when the view has filters, so an empty state can say WHY. */
  filtered?: boolean;
  /** M12.4b: the single type behind this table, which is what makes the
   * header menu's property operations (rename, change type, insert,
   * duplicate, delete) possible. Null on mixed/typeless views. */
  sourceType?: string | null;
  /** M12.4b: adds a starter filter rule for the field to the open view. */
  onFilterField?: (field: string) => void;
}

/**
 * One group band's header.
 *
 * M10: this used to be `TableGroup`, a recursive component that owned both the
 * bands AND the rows beneath them — which is why nesting could not be added to
 * it without duplicating TreeView's graph walk inside. `buildRows` flattens
 * both axes, so all that is left here is the header itself.
 */
function BandHeader({
  node,
  collapsed,
  onToggle,
}: {
  node: GroupNode;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    /**
     * A `role="row"` with cells in it, holding a real button (M20.4).
     *
     * This was a `<button role="row">` with no cells and no `aria-expanded`:
     * a row that contains no gridcell is malformed to a screen reader, the
     * grid's `aria-rowcount` did not count it, and nothing announced whether
     * it was open or shut — the one fact a band header exists to carry.
     * `ListView` has had this right since M10; this mirrors it.
     */
    <div
      role="row"
      data-testid="table-group-header"
      data-depth={node.depth}
      // M20.5: sticky under the column header, offset by depth so a nested
      // band parks below its parent instead of on top of it — ListView has
      // done this since M10, and without it you scroll into a run of rows with
      // nothing on screen saying which band you are in. `top-8` is the header
      // row's own height.
      className="sticky z-[15] flex h-8 w-full items-center border-b border-n-100 bg-n-25 text-left"
      style={{ top: 32 + node.depth * 32 }}
    >
      {/* The band spans the full scroll width, so the band itself cannot be
          sticky (a sticky box as wide as its container has no room to shift).
          The label cluster is the sticky part instead. */}
      <span
        role="gridcell"
        className="sticky left-0 flex items-center gap-2 pr-3"
        style={{ paddingLeft: GUTTER + node.depth * INDENT }}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${node.label}`}
          onClick={onToggle}
          className="flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-n-400 hover:bg-n-100 hover:text-n-800"
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        </button>
        <span
          className="box-border h-[10px] w-[10px] flex-none rounded-full"
          style={
            node.ghost || !node.color
              ? { border: '1.5px solid var(--n-400)' }
              : {
                  background: resolveOptionColor(node.color).solid,
                  border: `1.5px solid ${resolveOptionColor(node.color).solid}`,
                }
          }
        />
        <span
          className={
            node.depth === 0 ? 'text-sm font-semibold text-n-800' : 'text-xs font-medium text-n-700'
          }
        >
          {node.label}
        </span>
        <span className="[font-family:var(--font-mono)] text-2xs text-n-400">{node.count}</span>
      </span>
    </div>
  );
}

/**
 * The Calculate picker (M19.5), shown inline inside a column's header menu.
 *
 * Deliberately the shape "Change type" already uses — an expanding sub-list in
 * the same `MenuSurface` — rather than the `MenuBack` drill-in "Edit property"
 * uses. Both are bounded single-selects with a checkmark; MenuBack replaces the
 * whole surface and belongs to a titled FORM. Inline also inherits
 * MenuSurface's arrow-key walker for free, which queries the whole subtree.
 *
 * One component, two callers: a data column's menu and the name column's. Two
 * copies of the same picker would eventually disagree about which aggregates a
 * kind offers.
 */
function CalcSubmenu({
  kind,
  calc,
  onPick,
}: {
  kind: FieldKind;
  calc: AggregateCalc | undefined;
  onPick: (next: AggregateCalc | null) => void;
}) {
  return (
    <div className="mb-1 max-h-[180px] overflow-y-auto rounded-md bg-n-25 p-0.5">
      <MenuItem
        label="None"
        icon="minus"
        checked={calc === undefined}
        testId="calc-option-none"
        onSelect={() => onPick(null)}
      />
      <MenuSeparator />
      {aggregatesFor(kind).map((a) => (
        <MenuItem
          key={a.calc}
          label={a.label}
          checked={calc === a.calc}
          testId={`calc-option-${a.calc}`}
          onSelect={() => onPick(a.calc)}
        />
      ))}
    </div>
  );
}

/**
 * One footer cell of the calculation row (M16.15, retriggered M19.5).
 *
 * It REPORTS; it does not offer. M16.15 read Notion's footer as "hover it to
 * be offered a calculation", so every column grew a ghost "Calculate" the
 * moment the pointer crossed the last row — N affordances nobody asked for,
 * the same "the affordances outnumber the data" problem `table-chrome.css`
 * was written to fix one row further up. Notion's footer shows results that
 * have been set, and the OFFER lives in the column header menu beside filter,
 * sort, group, freeze, wrap and hide — which is where Calculate now is, and
 * where it was the only per-column setting missing.
 */
function CalcCell({
  field,
  calc,
  result,
  className,
  style,
}: {
  field: string;
  calc: AggregateCalc | undefined;
  /** Already computed by the table — one pass over the rows, not one per cell. */
  result: string;
  className: string;
  style: React.CSSProperties;
}) {
  const meta = calc === undefined ? null : aggregateMeta(calc);
  return (
    // A cell per column even when that column calculates nothing: the footer
    // repeats the grid's widths, and skipping the empty ones would slide every
    // result out from under the column it belongs to.
    <div role="gridcell" data-testid={`calc-${field}`} className={className} style={style}>
      {meta !== null && (
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          <span className="truncate text-n-400">{meta.short}</span>
          <span className="flex-none font-medium text-n-700 [font-variant-numeric:tabular-nums]">
            {result === '' ? '—' : result}
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * The sort indicator (M16.18).
 *
 * It used to read `presentation.sort[0]` only, so a two-key sort marked one
 * column and left the other looking unsorted — with no way to tell from the
 * grid that it was participating at all.
 */
function SortMark({ presentation, field }: { presentation: Presentation; field: string }) {
  const at = presentation.sort.findIndex((s) => s.field === field);
  if (at === -1) return null;
  const spec = presentation.sort[at];
  const multi = presentation.sort.length > 1;
  return (
    <Tooltip
      label={`Sorted ${spec.dir === 'asc' ? 'ascending' : 'descending'}${multi ? `, key ${at + 1} of ${presentation.sort.length}` : ''}`}
    >
      <span
        data-testid={`sort-mark-${field}`}
        className="flex flex-none items-center text-cortex-600"
      >
        <Icon name={spec.dir === 'asc' ? 'arrow-up' : 'arrow-down'} size={11} />
        {multi && <span className="[font-family:var(--font-mono)] text-2xs">{at + 1}</span>}
      </span>
    </Tooltip>
  );
}

/**
 * The header's trailing "+" (M16.18).
 *
 * The header simply stopped after the last column. `hiddenColumns` has been
 * exported from `engine/columns.ts` since M9.2 with no call site in the app —
 * so a column hidden from the table could only be brought back through the
 * view settings panel, three clicks away from the header it belongs to.
 *
 * M19.4: the "+" opens the property panel ITSELF, not a menu whose first item
 * opens it. The three-state machine here made adding a column a two-click
 * errand through a menu that had exactly one command on a type with nothing
 * hidden — and the detail panel's own "+ Add property" has always gone
 * straight to the same panel, so the table was the surface disagreeing. The
 * hidden columns ride along inside it, because this is still the only place
 * in the header that can bring one back.
 */
function AddColumnButton({
  columns,
  fields,
  sourceType,
  onColumnsChange,
}: {
  columns: ColumnSpec[];
  fields: ColumnDef[];
  sourceType: string | null;
  onColumnsChange: (next: ColumnSpec[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const hidden = useMemo(() => hiddenColumns(columns, fields), [columns, fields]);

  const declare = (name: string, kind: FieldKind, relation?: RelationConfig) => {
    setOpen(false);
    if (sourceType === null) return;
    void (async () => {
      const ok =
        relation === undefined
          ? await addFieldToType(sourceType, name, kind)
          : await addRelationProperty(
              sourceType,
              name,
              relation,
              kind === 'person' ? 'person' : 'relation',
            );
      // The actions toast their own failures and return false (store-layer
      // invariant); a column for a property that was not created would name
      // nothing.
      if (ok) onColumnsChange([...columns, { field: normalizeFieldName(name) }]);
    })();
  };

  const showColumn = (field: string) => {
    setOpen(false);
    // toggleColumn re-shows in place when the view already holds a hidden
    // spec, and appends when it does not.
    onColumnsChange(toggleColumn(columns, field));
  };

  /** The hidden columns, styled as the panel's other lists are so the one
   * surface reads as one surface. */
  const hiddenSection =
    hidden.length === 0 ? null : (
      <>
        <span className="px-1 pt-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
          Hidden
        </span>
        <div className="max-h-[140px] overflow-y-auto">
          {hidden.map((f) => (
            <button
              key={f.name}
              type="button"
              data-testid={`show-column-${f.name}`}
              onClick={() => showColumn(f.name)}
              className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-[5px] text-left text-sm text-n-800 hover:bg-n-50"
            >
              <Icon name={kindMeta(f.kind).icon} size={13} color="var(--n-500)" />
              <span className="min-w-0 flex-1 truncate">{humanize(f.name)}</span>
            </button>
          ))}
        </div>
      </>
    );

  return (
    <div
      className="relative flex flex-none items-center justify-center border-r border-n-100"
      style={{ width: ADD_W }}
    >
      <button
        ref={ref}
        type="button"
        data-testid="add-column"
        aria-label="Add a column"
        aria-haspopup={sourceType === null ? 'menu' : 'dialog'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-5 w-5 items-center justify-center rounded border-0 bg-transparent p-0 text-n-400 hover:bg-n-100 hover:text-n-800"
      >
        <Icon name="plus" size={13} />
      </button>
      {/* A typeless ("Everything") view has no schema to declare a property
          ON — `declare` would return without writing — so there the "+" can
          only offer the hidden columns back, and says so when there are
          none. */}
      {open && sourceType === null && (
        <Popover
          anchorRef={ref}
          onClose={() => setOpen(false)}
          role="menu"
          ariaLabel="Add a column"
        >
          <MenuSurface width={232}>
            {hidden.length > 0 ? (
              <>
                <MenuLabel>Hidden</MenuLabel>
                {hidden.map((f) => (
                  <MenuItem
                    key={f.name}
                    icon={kindMeta(f.kind).icon}
                    label={humanize(f.name)}
                    testId={`show-column-${f.name}`}
                    onSelect={() => showColumn(f.name)}
                  />
                ))}
              </>
            ) : (
              <MenuItem
                icon="info"
                label="No properties left to show"
                disabled
                onSelect={() => undefined}
              />
            )}
          </MenuSurface>
        </Popover>
      )}
      {open && sourceType !== null && (
        <AddPropertyPanel
          anchorRef={ref}
          // Humanized, like both detail panels pass (RecordProperties,
          // DocProperties). Raw names meant the panel's duplicate guard never
          // fired for a multi-word field: typing "Due date" against an
          // existing `due_date` sailed past it and failed at the write.
          existingNames={fields.map((f) => humanize(f.name))}
          ownerType={sourceType}
          onAdd={declare}
          onCancel={() => setOpen(false)}
          footer={hiddenSection}
        />
      )}
    </div>
  );
}

interface HeaderItem {
  label: string;
  icon: string;
  run: () => void;
  danger?: boolean;
  /** Renders a trailing check — used for stateful toggles like Wrap. */
  active?: boolean;
  /** Starts a new visual section. */
  section?: boolean;
  /** Right-aligned current value, e.g. the calculation a column already runs. */
  hint?: string;
  /** Draws the chevron that says this opens another surface. */
  submenu?: boolean;
  testId?: string;
  /**
   * This item toggles the sub-list below rather than acting — closing the menu
   * on select would close the very thing the click just opened.
   */
  keepOpen?: boolean;
  /** The expanded sub-list, rendered directly beneath the item. */
  sub?: React.ReactNode;
}

/**
 * Both header menus' item list, rendered once (M19.5).
 *
 * The two menus carried byte-identical maps, so `keepOpen`/`sub` would have
 * had to be taught twice — and the name column would have been the copy that
 * quietly missed the next thing added to the other.
 */
function HeaderItems({ items, onClose }: { items: HeaderItem[]; onClose: () => void }) {
  return (
    <>
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.section === true && <MenuSeparator />}
          <MenuItem
            icon={item.icon}
            label={item.label}
            hint={item.hint}
            submenu={item.submenu}
            testId={item.testId}
            danger={item.danger}
            checked={item.active}
            onSelect={() => {
              item.run();
              if (item.keepOpen !== true) onClose();
            }}
          />
          {item.sub}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The column header menu (M12.4b): Notion's, for a markdown vault. The
 * LABEL is the trigger now — sorting moved inside, where it can say which
 * direction it means instead of silently toggling.
 *
 * Property operations (rename, change type, insert, duplicate, delete) write
 * the type's schema and need a single source type behind the table; view
 * operations (sort, group, filter, wrap, hide, move) write the open view and
 * work everywhere a view file exists.
 */
function HeaderMenu({
  def,
  wrap,
  columns,
  presentation,
  schema,
  sourceType,
  onColumnsChange,
  onPresentationChange,
  onFilterField,
  onMove,
  frozen,
  onFreeze,
  onFit,
  calc,
  onCalcChange,
}: {
  def: ColumnDef;
  wrap: boolean;
  columns: ColumnSpec[];
  presentation: Presentation;
  schema: Schema;
  sourceType: string | null;
  onColumnsChange?: (next: ColumnSpec[]) => void;
  onPresentationChange?: (next: Presentation) => void;
  onFilterField?: (field: string) => void;
  /** M12.8: display-aware move — steps across the name column too. */
  onMove?: (field: string, delta: -1 | 1) => void;
  /** M16.18: this column is inside the frozen run. */
  frozen: boolean;
  onFreeze?: () => void;
  onFit: () => void;
  /** M19.5: what this column already calculates, and how to change it. */
  calc?: AggregateCalc;
  /** Absent on a surface with no view file to persist the choice to. */
  onCalcChange?: (next: AggregateCalc | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [changingKind, setChangingKind] = useState(false);
  const [calcOpen, setCalcOpen] = useState(false);
  const [pendingKind, setPendingKind] = useState<FieldDef['kind'] | null>(null);
  // The third unguarded delete. `PropertyMenu` and `PropertyEditor` were
  // guarded; this menu has its OWN "Delete property" item that called
  // `removeFieldFromType` on one click, from a surface that already tells you
  // it edits N records. Same dialog, so all three say the same thing.
  const [confirmDelete, setConfirmDelete] = useState(false);
  // M12.8: the full property editor, flown out IN this popover next to the
  // column it configures — config never docks a side panel.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(humanize(def.name));
  const allEntriesForCount = useVaultStore((s) => s.entries);
  const name = humanize(def.name);
  /**
   * Schema operations need one agreed-on declaration to edit — and they need
   * to edit the type that HOLDS it (M20.2).
   *
   * This used to pass the view's SOURCE type to every one of them, which is
   * right only while every column belongs to the source. Under a chain that
   * descends a relation it routinely does not: the OKR tree's grid now carries
   * Work item's `estimate`, and renaming that column would have written
   * `estimate` onto Objective — a field on a type that never had one, with the
   * column it was renamed from left exactly as it was. `columnOwner` answers
   * null when several types declare the name, which is the same case the
   * warning triangle beside the header marks.
   */
  const ownerType = columnOwner(def) ?? (def.undeclared === true ? sourceType : null);

  useEffect(() => {
    if (open) {
      setDraft(humanize(def.name));
      setChangingKind(false);
      setCalcOpen(false);
      setEditing(false);
      setConfirmDelete(false);
    }
  }, [open, def.name]);

  const close = () => setOpen(false);

  const commitRename = () => {
    const next = draft.trim();
    if (ownerType === null || next === '' || humanize(def.name) === next) return;
    void (async () => {
      if (await renameFieldOnType(ownerType, def.name, next)) {
        // The view addresses the column by field name — follow the rename.
        onColumnsChange?.(
          columns.map((c) =>
            c.field === def.name ? { ...c, field: normalizeFieldName(next) } : c,
          ),
        );
      }
    })();
  };

  const items: HeaderItem[] = [];
  if (onFilterField !== undefined) {
    items.push({ label: 'Filter', icon: 'list-filter', run: () => onFilterField(def.name) });
  }
  if (onPresentationChange !== undefined) {
    items.push(
      {
        label: 'Sort ascending',
        icon: 'arrow-up',
        run: () => onPresentationChange(sortBy(presentation, def.name, 'asc')),
      },
      {
        label: 'Sort descending',
        icon: 'arrow-down',
        run: () => onPresentationChange(sortBy(presentation, def.name, 'desc')),
      },
    );
    // M20.5: the toolbar filters its Group menu to GROUPABLE_KINDS and this
    // menu offered the item on anything, so a date or a number column could
    // band a table by a value with no buckets in it — and creating inside one
    // of those bands is what seeded the malformed writes M20.1e had to coerce.
    // Two spellings of "can this be grouped" will always drift; there is one.
    if (GROUPABLE_KINDS.has(def.kind)) {
      items.push({
        label: 'Group by',
        icon: 'rows-3',
        active: presentation.group.some((g) => g.descend === undefined && g.field === def.name),
        run: () => onPresentationChange(groupByField(presentation, def.name)),
      });
    }
  }
  // Last of the "what does this column tell me" cluster, before the Freeze
  // section break — where Notion's own column menu carries it. Gated on
  // `onCalcChange` and NOT on `canEditSchema`: a calculation is a VIEW setting
  // like Filter and Sort, so a heterogeneous column in an "Everything" view
  // gets one too even though nothing there may edit a schema.
  if (onCalcChange !== undefined) {
    items.push({
      label: 'Calculate',
      icon: 'sigma',
      testId: 'calculate',
      submenu: true,
      keepOpen: true,
      hint: calc === undefined ? undefined : aggregateMeta(calc).label,
      run: () => setCalcOpen(!calcOpen),
      sub: calcOpen ? (
        <CalcSubmenu
          kind={def.kind}
          calc={calc}
          onPick={(next) => {
            onCalcChange(next);
            close();
          }}
        />
      ) : undefined,
    });
  }
  if (onFreeze !== undefined) {
    items.push({
      label: frozen ? 'Unfreeze up to here' : 'Freeze up to this column',
      icon: frozen ? 'pin-off' : 'pin',
      section: true,
      run: onFreeze,
    });
  }
  if (onColumnsChange !== undefined) {
    items.push(
      {
        label: 'Fit to content',
        icon: 'move-horizontal',
        section: onFreeze === undefined,
        run: onFit,
      },
      {
        label: 'Wrap content',
        icon: 'wrap-text',
        active: wrap,
        run: () => onColumnsChange(setColumnWrap(columns, def.name)),
      },
      {
        label: 'Hide column',
        icon: 'eye-off',
        run: () => onColumnsChange(toggleColumn(columns, def.name)),
      },
      {
        label: 'Move left',
        icon: 'arrow-left',
        run: () =>
          onMove !== undefined
            ? onMove(def.name, -1)
            : onColumnsChange(moveColumn(columns, def.name, -1)),
      },
      {
        label: 'Move right',
        icon: 'arrow-right',
        run: () =>
          onMove !== undefined
            ? onMove(def.name, 1)
            : onColumnsChange(moveColumn(columns, def.name, 1)),
      },
    );
    if (ownerType !== null) {
      const insert = (side: 'left' | 'right') => {
        void (async () => {
          const created = await insertFieldOnType(ownerType, def.name, side);
          if (created !== null) onColumnsChange(insertColumn(columns, created, def.name, side));
        })();
      };
      items.push(
        {
          label: 'Insert left',
          icon: 'arrow-left-to-line',
          section: true,
          run: () => insert('left'),
        },
        { label: 'Insert right', icon: 'arrow-right-to-line', run: () => insert('right') },
        {
          label: 'Duplicate property',
          icon: 'copy',
          run: () => {
            void (async () => {
              const copy = await duplicateFieldOnType(ownerType, def.name);
              if (copy !== null) onColumnsChange(insertColumn(columns, copy, def.name, 'right'));
            })();
          },
        },
        {
          label: 'Delete property',
          icon: 'trash-2',
          danger: true,
          run: () => setConfirmDelete(true),
        },
      );
    }
  }

  return (
    <span className="relative inline-flex min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${name} column menu`}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-xs font-medium text-n-600 hover:text-n-900"
      >
        {name}
      </button>
      {open && (
        // M16.18: the one anchored-surface primitive. This was a hand-rolled
        // `fixed inset-0` scrim plus an `absolute top-6` card — one of the
        // two inside this file that M16.1 was written to replace, and the
        // reason a 15-item menu had no keyboard navigation at all.
        <Popover
          anchorRef={triggerRef}
          onClose={close}
          onEscape={editing ? () => setEditing(false) : close}
          role="menu"
          ariaLabel={`${name} column menu`}
          trapFocus
        >
          <MenuSurface
            width={editing ? 300 : 224}
            autoFocus={!editing}
            className={editing ? 'p-2' : ''}
          >
            {editing && ownerType !== null && onColumnsChange !== undefined ? (
              // The Notion flyout: the menu becomes the property editor,
              // anchored where the column is (M12.8).
              <div className="cb-panel-in">
                <MenuBack title="Edit property" onBack={() => setEditing(false)} />
                <PropertyEditor
                  key={def.name}
                  def={def}
                  sourceType={ownerType}
                  schema={schema}
                  columns={columns}
                  onColumnsChange={onColumnsChange}
                  onDeleted={close}
                />
              </div>
            ) : (
              <>
                {ownerType !== null ? (
                  <div className="px-1 pb-1 pt-0.5">
                    <Input
                      size="sm"
                      ariaLabel={`Rename ${name}`}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setDraft(humanize(def.name));
                      }}
                      width="100%"
                    />
                  </div>
                ) : (
                  <div className="px-2 pb-1 pt-1 text-xs font-medium text-n-800">{name}</div>
                )}
                {ownerType !== null && onColumnsChange !== undefined && (
                  <MenuItem
                    icon="settings-2"
                    label="Edit property"
                    submenu
                    testId="edit-property"
                    onSelect={() => setEditing(true)}
                  />
                )}
                {ownerType !== null && (
                  <MenuItem
                    icon="repeat-2"
                    label="Change type"
                    hint={kindMeta(def.kind).label}
                    submenu
                    testId="change-type"
                    onSelect={() => setChangingKind(!changingKind)}
                  />
                )}
                {changingKind && ownerType !== null && (
                  <div className="mb-1 max-h-[180px] overflow-y-auto rounded-md bg-n-25 p-0.5">
                    {CREATABLE_PROPERTY_KINDS.filter((k) => !k.computed).map((k) => (
                      <MenuItem
                        key={k.kind}
                        icon={k.icon}
                        label={k.label}
                        checked={k.kind === def.kind}
                        testId={`change-type-${k.kind}`}
                        onSelect={() => setPendingKind(k.kind)}
                      />
                    ))}
                  </div>
                )}
                <HeaderItems items={items} onClose={close} />
              </>
            )}
          </MenuSurface>
        </Popover>
      )}
      {confirmDelete && ownerType !== null && onColumnsChange !== undefined && (
        <ConfirmDeleteProperty
          name={name}
          kind={def.kind}
          sourceType={ownerType}
          count={allEntriesForCount.filter((e) => e.type === ownerType).length}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void (async () => {
              if (await removeFieldFromType(ownerType, def.name)) {
                onColumnsChange(columns.filter((c) => c.field !== def.name));
              }
            })();
          }}
        />
      )}
      {pendingKind !== null && ownerType !== null && (
        <ConfirmKindChange
          name={name}
          from={def.kind}
          to={pendingKind}
          count={allEntriesForCount.filter((e) => e.type === ownerType).length}
          onCancel={() => setPendingKind(null)}
          onConfirm={() => {
            setPendingKind(null);
            close();
            void changeFieldKind(ownerType, def.name, pendingKind);
          }}
        />
      )}
    </span>
  );
}

/**
 * The name column's menu (M12.8). The first column stopped being the one
 * header without controls: it sorts, filters, freezes, and moves like the
 * rest. What it cannot do is hide or delete — a table of records with no
 * names is not a table, and the title is not a schema property to remove.
 */
function TitleHeaderMenu({
  presentation,
  frozen,
  atStart,
  atEnd,
  onPresentationChange,
  onFilterField,
  onMove,
  onFreeze,
  onCalcChange,
}: {
  presentation: Presentation;
  frozen: boolean;
  atStart: boolean;
  atEnd: boolean;
  onPresentationChange?: (next: Presentation) => void;
  onFilterField?: (field: string) => void;
  onMove: (delta: -1 | 1) => void;
  onFreeze: () => void;
  /** M19.5: the name column calculates too — into `presentation.titleCalc`. */
  onCalcChange?: (next: AggregateCalc | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [calcOpen, setCalcOpen] = useState(false);
  // This menu has no open-reset effect and stays mounted, so the sub-list
  // would otherwise be pre-expanded the next time it opens.
  const close = () => {
    setOpen(false);
    setCalcOpen(false);
  };

  const items: HeaderItem[] = [];
  if (onFilterField !== undefined) {
    items.push({ label: 'Filter', icon: 'list-filter', run: () => onFilterField('title') });
  }
  if (onPresentationChange !== undefined) {
    items.push(
      {
        label: 'Sort ascending',
        icon: 'arrow-up',
        run: () => onPresentationChange(sortBy(presentation, 'title', 'asc')),
      },
      {
        label: 'Sort descending',
        icon: 'arrow-down',
        run: () => onPresentationChange(sortBy(presentation, 'title', 'desc')),
      },
    );
    if (onCalcChange !== undefined) {
      items.push({
        label: 'Calculate',
        icon: 'sigma',
        testId: 'calculate',
        submenu: true,
        keepOpen: true,
        hint:
          presentation.titleCalc === undefined
            ? undefined
            : aggregateMeta(presentation.titleCalc).label,
        run: () => setCalcOpen(!calcOpen),
        // The name column holds titles: text, so the numeric calculations are
        // correctly absent from what `aggregatesFor` offers here.
        sub: calcOpen ? (
          <CalcSubmenu
            kind="text"
            calc={presentation.titleCalc}
            onPick={(next) => {
              onCalcChange(next);
              close();
            }}
          />
        ) : undefined,
      });
    }
    items.push({
      // Freezing means "up to here" now, so it is offered wherever the name
      // column sits rather than only while it leads (M16.18).
      label: frozen ? 'Unfreeze up to here' : 'Freeze up to this column',
      icon: frozen ? 'pin-off' : 'pin',
      section: true,
      run: onFreeze,
    });
    if (!atStart) items.push({ label: 'Move left', icon: 'arrow-left', run: () => onMove(-1) });
    if (!atEnd) items.push({ label: 'Move right', icon: 'arrow-right', run: () => onMove(1) });
  }

  if (items.length === 0) {
    return <span className="min-w-0 flex-1 truncate">Name</span>;
  }

  return (
    <span className="relative inline-flex min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Name column menu"
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-xs font-semibold text-n-600 hover:text-n-900"
      >
        Name
      </button>
      {open && (
        <Popover
          anchorRef={triggerRef}
          onClose={close}
          onEscape={close}
          role="menu"
          ariaLabel="Name column menu"
          trapFocus
        >
          {/* M16.29: "Row height" and "Wrap all columns" are gone from here.
              Both are settings for the WHOLE table, and this menu was the only
              place either could be reached — a menu whose every other item acts
              on the name column, and which no other column's header carries. So
              someone looking for row height opened Priority's menu, found
              sort/filter/hide/freeze and no height, and had no way to know
              Name's menu was different. They live in view settings › Rows,
              beside every other setting for the whole view. */}
          <MenuSurface width={224}>
            <MenuLabel>Name</MenuLabel>
            <HeaderItems items={items} onClose={close} />
          </MenuSurface>
        </Popover>
      )}
    </span>
  );
}

/**
 * Table view (M3.4): the spreadsheet surface — one row per record, one
 * column per visible property, edited in place. Columns come from the view's
 * `columns`, so the property-visibility control and this view share one
 * source of truth. Grouping renders as collapsible section bands, nested to
 * the depth of the view's grouping chain (M9.1).
 *
 * M11 made the grid RESPONSIVE. It used to lay out at exactly the sum of its
 * column widths and stop: in a wide window that left a dead strip to the right
 * of the last column where the rows simply ended, and in a narrow one the
 * columns kept their pixel widths and the horizontal scrollbar did all the
 * work. Now the columns share out any slack, so the table always fills the
 * space it is given and still scrolls when it genuinely needs to.
 */
export function TableView({
  entries,
  presentation,
  schema,
  allEntries = entries,
  fields,
  onColumnsChange,
  onPresentationChange,
  scope = 'table',
  onCreate,
  filtered,
  sourceType = null,
  onFilterField,
}: TableViewProps) {
  // M9.1: collapse lives in the store, keyed by surface — it used to be
  // component state and reset on every navigation.
  const collapsedMap = useUiStore((s) => s.collapsed[scope]);
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  // M12.1: keyboard Enter follows the same routing rule as the hover Open
  // button — it used to force the panel open for docs too.
  const openPath = useOpenPath('in-place');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(0);
  // True while columns remain to the right of the fold. The horizontal
  // scrollbar sits at the bottom of the viewport, which on a four-row table is
  // hundreds of pixels below the last row — so nothing at the edge said the
  // half-clipped date column continued.
  const [moreRight, setMoreRight] = useState(false);

  // The width the grid has to fill. Observed rather than read once, because
  // the detail panel opening beside the table changes it (M11 item 2).
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      // Deferred out of the callback, and rounded. Setting state synchronously
      // inside a ResizeObserver whose own element is affected by the result is
      // the classic "loop completed with undelivered notifications": narrower
      // columns wrap text, taller content toggles the vertical scrollbar, the
      // scrollbar changes this element's content width, and round it goes.
      // Rounding also stops sub-pixel width jitter from re-laying-out columns.
      const width = Math.round(entry.contentRect.width);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setAvailable(width));
    });
    observer.observe(node);
    setAvailable(Math.round(node.clientWidth));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const syncOverflow = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    // A whole-pixel tolerance, not 1px: column widths are fractional, so
    // `scrollLeft + clientWidth` lands a fraction under `scrollWidth` at the
    // real right edge. Below that threshold the comparison flipped on rounding
    // alone, and because this runs after EVERY render and sets state, a flip
    // re-rendered, which re-ran it, which flipped it back — a render loop that
    // pins the main thread and stops the table responding to scrolling at all.
    setMoreRight(Math.ceil(node.scrollLeft + node.clientWidth) < Math.floor(node.scrollWidth) - 2);
  }, []);
  // Deliberately every render: column widths, the row set and the panel beside
  // the table all change the overflow answer, and none of them is a dependency
  // this component can name. Safe only because the setter above is stable —
  // `setMoreRight` bails out when the value is unchanged, so the common case
  // renders once and stops.
  useEffect(syncOverflow);

  const resolved = useMemo(
    () => resolveColumns(presentation.columns, fields),
    [presentation.columns, fields],
  );

  // M10: ONE row list covering bands, nesting, and the create row. The table
  // no longer knows how deep either axis goes — that is buildRows' problem.
  const rows = useMemo(
    () =>
      buildRows({
        entries,
        group: presentation.group,
        schema,
        allEntries,
        addRows: onCreate !== undefined,
        isCollapsed: (key) => collapsedMap?.[key] === true,
      }),
    [entries, presentation.group, schema, allEntries, onCreate, collapsedMap],
  );

  const titleWidth = presentation.titleWidth ?? TITLE_W;

  /**
   * Widths as laid out, with any slack shared between the columns.
   *
   * Only ever GROWS a column: shrinking to fit would silently discard widths
   * the user set by hand, and the horizontal scrollbar is the honest answer to
   * a table that is genuinely wider than its window.
   */
  const layout = useMemo(() => {
    const base = resolved.map((c) => c.width);
    // GUTTER is part of the content width (M16.16), and so is the header's
    // trailing "+" (M16.18): leave either out and the slack calculation hands
    // the columns pixels that are already spoken for, so the last column runs
    // off the right edge.
    // M20.5: only when the "+" is actually rendered. `AddColumnButton` is
    // gated on `onColumnsChange`, so on a read-only surface — a dashboard
    // block, a table with no view file to write to — 34px of the width was
    // reserved for a control that is not there, and the last column stopped
    // that far short of the right edge.
    const addSlot = onColumnsChange === undefined ? 0 : ADD_W;
    const content = GUTTER + addSlot + titleWidth + base.reduce((sum, w) => sum + w, 0);
    const slack = available - content;
    if (slack <= 0 || base.length === 0) {
      return { title: titleWidth, columns: base, total: content };
    }
    const share = Math.floor(slack / base.length);
    const columns = base.map((w, i) =>
      // The remainder lands on the last column so the grid ends flush with its
      // container rather than a pixel or two short of it.
      i === base.length - 1 ? w + slack - share * (base.length - 1) : w + share,
    );
    return { title: titleWidth, columns, total: available };
  }, [resolved, titleWidth, available, onColumnsChange]);

  /** Paint a width mid-drag: straight to the DOM, so no row re-renders. */
  const paint = useCallback(
    (variable: string, width: number, delta: number) => {
      const node = gridRef.current;
      if (node === null) return;
      node.style.setProperty(variable, `${width}px`);
      node.style.width = `${Math.max(0, layout.total + delta)}px`;
    },
    [layout.total],
  );

  const commitColumn = useCallback(
    (name: string, width: number) => {
      if (onColumnsChange === undefined) return;
      onColumnsChange(setColumnWidth(presentation.columns, name, width));
    },
    [onColumnsChange, presentation.columns],
  );

  const commitTitle = useCallback(
    (width: number) => {
      onPresentationChange?.({ ...presentation, titleWidth: Math.max(MIN_TITLE_W, width) });
    },
    [onPresentationChange, presentation],
  );

  /**
   * Fit a column to its widest content (M16.18).
   *
   * Measured off the DOM rather than estimated from the values: the cells
   * hold chips, avatars and progress bars, and a character count would be
   * wrong for all three. `aria-colindex` is what makes one query enough —
   * the header, every cell, and the footer of one column all carry it, so a
   * fit never clips the header label.
   */
  const fitColumn = useCallback(
    (field: string, displayIndex: number) => {
      const node = gridRef.current;
      if (node === null) return;
      let widest = 0;
      for (const cell of node.querySelectorAll<HTMLElement>(
        `[aria-colindex="${displayIndex + 2}"]`,
      )) {
        /**
         * The cell's own `scrollWidth` is the clipped width (M20.5).
         *
         * A cell is `overflow-hidden` around an inner `truncate` span, and a
         * truncating child shrinks to its parent — so the parent never
         * overflows and `scrollWidth` reports exactly the width the column
         * already has. "Fit to content" therefore widened a clipped column by
         * the +4 padding below and nothing else, which is the one case anyone
         * reaches for it.
         *
         * Measured against each descendant's own scroll width, offset by where
         * it starts inside the cell — the name cell's indent, expander and
         * type icon are real width the title has to clear.
         */
        const left = cell.getBoundingClientRect().left;
        widest = Math.max(widest, cell.scrollWidth);
        for (const child of cell.querySelectorAll<HTMLElement>('*')) {
          const offset = child.getBoundingClientRect().left - left;
          widest = Math.max(widest, offset + child.scrollWidth);
        }
      }
      // Nothing measurable (an unlaid-out grid) is not a reason to slam the
      // column to its minimum.
      if (widest === 0) return;
      const next = Math.min(Math.round(widest) + 4, FIT_MAX_W);
      if (field === 'title') commitTitle(Math.max(MIN_TITLE_W, next));
      else commitColumn(field, Math.max(MIN_COL_W, next));
    },
    [commitColumn, commitTitle],
  );

  // Keyboard traverses the record rows only — bands and the create row are not
  // records, so Enter on them has nothing to open.
  const flatRows = useMemo(() => entryRows(rows), [rows]);
  /** Row key → its position among the RECORD rows, which is what the keyboard
   * cursor counts. */
  const rowIndex = useMemo(() => new Map(flatRows.map((r, i) => [r.key, i])), [flatRows]);
  const keyboard = useRowKeyboard({
    count: flatRows.length,
    onOpen: (i) => openPath(flatRows[i].entry.path),
    onToggle: (i) => {
      if (flatRows[i].childCount > 0) toggleCollapsed(scope, flatRows[i].key);
    },
    // M20.5: the hook has accepted this since M9.6 and the table never passed
    // it, so a bulk selection could only be dismissed by finding the × on a
    // floating bar — Escape, which clears every other transient state in the
    // app, did nothing at all. Last in the one-press-one-step-out chain the
    // hook already documents: cell → row → selection.
    onEscape: () => setCheckedPaths(new Set()),
    // M16.17: +1 for the name column, which is a display slot with no
    // ColumnSpec behind it.
    colCount: resolved.length + 1,
  });

  // --- M16.16: bulk selection -------------------------------------------
  //
  // A SET of paths, distinct from the keyboard cursor above: one row is under
  // the cursor, any number are checked. Paths rather than indices, because a
  // rescan renumbers the rows and would otherwise slide the selection onto
  // whatever now occupies those slots.
  const [checkedPaths, setCheckedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const anchorRow = useRef(-1);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);

  const rowPaths = useMemo(() => flatRows.map((r) => r.entry.path), [flatRows]);
  // A record the filter, a delete, or a rename removed is not selected — it
  // is gone, and a bulk delete must not be holding a path that resolves to
  // nothing.
  useEffect(() => {
    setCheckedPaths((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(rowPaths);
      const next = new Set([...prev].filter((p) => live.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [rowPaths]);

  /**
   * The selected records, de-duplicated by path (M20.5).
   *
   * A nesting chain can draw one record at two positions — a Work item that
   * serves two key results is a row under each — and this counted ROWS. So
   * ticking one box reported "2 selected", the bulk delete removed the file
   * once and reported a failure for the second attempt, and `allChecked`
   * compared a Set of distinct paths against a row count that included the
   * duplicate, so Select all never read as checked.
   */
  const checked = useMemo(() => {
    const seen = new Set<string>();
    const out: Entry[] = [];
    for (const r of flatRows) {
      if (!checkedPaths.has(r.entry.path) || seen.has(r.entry.path)) continue;
      seen.add(r.entry.path);
      out.push(r.entry);
    }
    return out;
  }, [flatRows, checkedPaths]);

  /** Distinct records on screen — what "all" means when a row can repeat. */
  const distinctPaths = useMemo(() => new Set(rowPaths).size, [rowPaths]);

  const toggleChecked = useCallback(
    (index: number, range: boolean) => {
      setCheckedPaths((prev) => {
        const next = new Set(prev);
        // Shift extends from the last box you touched, the way every file
        // list does — without an anchor a range select is a second click.
        const from = range && anchorRow.current >= 0 ? anchorRow.current : index;
        const [lo, hi] = from <= index ? [from, index] : [index, from];
        const add = !prev.has(rowPaths[index]);
        for (let i = lo; i <= hi; i += 1) {
          if (add) next.add(rowPaths[i]);
          else next.delete(rowPaths[i]);
        }
        return next;
      });
      anchorRow.current = index;
    },
    [rowPaths],
  );

  const clearChecked = useCallback(() => setCheckedPaths(new Set()), []);

  /**
   * M20.5: the bulk bar could delete twenty records and duplicate none — the
   * only Duplicate in the app was in the record panel's header, so copying one
   * meant opening it first. The write itself lives in `app/recordActions`,
   * shared with that header rather than written twice.
   */
  const duplicateChecked = useCallback(() => {
    const targets = checked;
    void (async () => {
      let made = 0;
      for (const entry of targets) {
        if ((await duplicateRecord(entry)) !== null) made += 1;
      }
      // The copies are new records; keeping the originals ticked would leave a
      // selection that no longer describes what is on screen.
      clearChecked();
      if (made > 0) toast(`Duplicated ${made} ${made === 1 ? 'record' : 'records'}`);
    })();
  }, [checked, clearChecked, toast]);
  const allChecked = distinctPaths > 0 && checkedPaths.size >= distinctPaths;

  const copyLinks = useCallback(() => {
    const text = checked.map((e) => `[[${e.title}]]`).join('\n');
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast(`${checked.length === 1 ? 'Link' : `${checked.length} links`} copied`);
      } catch {
        // Clipboard access is a permission, not a certainty — a silent
        // failure here reads as "the button does nothing".
        toast("Couldn't copy to the clipboard");
      }
    })();
  }, [checked, toast]);

  /** Delete a set of records. Never throws — it reports and returns, like
   * every other action that touches the vault. */
  const deleteRecords = useCallback(
    (targets: Entry[]) => {
      setConfirmBulkDelete(false);
      void (async () => {
        if (vaultPath === null || targets.length === 0) return;
        const failed: string[] = [];
        for (const entry of targets) {
          try {
            await deleteNote(vaultPath, entry.path);
          } catch {
            failed.push(entry.title);
          }
        }
        // Cleared before the rescan: leaving the paths checked would flash a
        // bulk bar counting records that are already gone.
        setCheckedPaths(new Set());
        if (failed.length > 0) {
          toast(
            failed.length === 1
              ? `Couldn't delete "${failed[0]}"`
              : `Couldn't delete ${failed.length} records`,
          );
        } else {
          toast(
            targets.length === 1
              ? `Deleted "${targets[0].title}"`
              : `Deleted ${targets.length} records`,
          );
        }
        try {
          await rescan();
        } catch {
          toast("Couldn't refresh vault");
        }
      })();
    },
    [rescan, toast, vaultPath],
  );

  const [confirmRow, setConfirmRow] = useState<Entry | null>(null);

  const onRowAction = useCallback(
    (action: RowAction, entry: Entry) => {
      switch (action) {
        case 'open':
          openPath(entry.path);
          break;
        case 'copy-link':
        case 'copy-path': {
          const text = action === 'copy-link' ? `[[${entry.title}]]` : entry.path;
          void (async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast(action === 'copy-link' ? 'Link copied' : 'Path copied');
            } catch {
              toast("Couldn't copy to the clipboard");
            }
          })();
          break;
        }
        case 'delete':
          setConfirmRow(entry);
          break;
      }
    },
    [openPath, toast],
  );

  /** Commit an in-place title edit (M19.3). The store action never throws —
   * it toasts and returns false — so this hands the result straight back to
   * the cell rather than wrapping it in a try/catch of its own. */
  const renameRow = useCallback(
    (entry: Entry, title: string) => useVaultStore.getState().setTitle(entry.path, title),
    [],
  );

  /** The row an inline create is open under — its key, and the band it
   * inherits. Null when nothing is being inserted. */
  const [inserting, setInserting] = useState<{
    key: string;
    band: { groupBy: string; groupValue: string };
  } | null>(null);

  // M12.4b: wrap rides with each cell; any wrapped column releases the rows
  // from their fixed height.
  const cells = useMemo(
    () => resolved.map((c) => ({ def: c.def, wrap: c.spec.wrap === true })),
    [resolved],
  );
  const anyWrap = useMemo(() => cells.some((c) => c.wrap), [cells]);
  const chips: ChipStyle = presentation.chips ?? 'plain';

  // --- M12.8: the name column is a peer of the data columns --------------
  const titlePos = Math.max(0, Math.min(presentation.titlePosition ?? 0, resolved.length));

  /** Header keys in display order — the data fields with 'title' interleaved. */
  const displayKeys = useMemo(() => {
    const keys = resolved.map((c) => c.def.name);
    keys.splice(titlePos, 0, 'title');
    return keys;
  }, [resolved, titlePos]);

  /**
   * How many leading display slots pin to the left edge (M16.18). The default
   * is the M12.8 one — the name column, if it leads — stated once here rather
   * than recomputed by every reader.
   */
  const frozenCount = Math.max(
    0,
    Math.min(presentation.frozenColumns ?? (titlePos === 0 ? 1 : 0), displayKeys.length),
  );
  const titleFrozen = titlePos < frozenCount;

  /**
   * The `left` a frozen slot pins at: the gutter, plus every frozen slot
   * before it. Widths are CSS variables, so this is a `calc` rather than a
   * number — which is also what lets a resize drag repaint the frozen run
   * without a single re-render.
   */
  const stickyLeft = useCallback(
    (d: number): string => {
      const parts = [`${GUTTER}px`];
      for (let k = 0; k < d; k += 1) {
        parts.push(
          k === titlePos ? `var(${TITLE_VAR})` : `var(${widthVar(k < titlePos ? k : k - 1)})`,
        );
      }
      return parts.length === 1 ? `${GUTTER}px` : `calc(${parts.join(' + ')})`;
    },
    [titlePos],
  );

  /** Sticky style for display slot `d`, or nothing when it scrolls. */
  const freezeStyle = useCallback(
    (d: number): React.CSSProperties | undefined =>
      d < frozenCount ? { position: 'sticky', left: stickyLeft(d) } : undefined,
    [frozenCount, stickyLeft],
  );

  /** Freeze through slot `d`, or back to it when it is already frozen. */
  const freezeThrough = useCallback(
    (d: number) => {
      onPresentationChange?.({ ...presentation, frozenColumns: d < frozenCount ? d : d + 1 });
    },
    [frozenCount, onPresentationChange, presentation],
  );

  const rowHeight = presentation.rowHeight ?? 'default';
  /**
   * Reorder by display slot: remove `key`, re-insert at `slot` (an index into
   * the display list). Writes titlePosition AND the column order in ONE
   * presentation update, so a drag across the name column cannot tear them
   * into two writes that disagree.
   */
  const reorderDisplay = useCallback(
    (key: string, slot: number) => {
      if (onPresentationChange === undefined) return;
      const from = displayKeys.indexOf(key);
      if (from === -1) return;
      const next = [...displayKeys];
      next.splice(from, 1);
      next.splice(Math.max(0, Math.min(slot > from ? slot - 1 : slot, next.length)), 0, key);
      const order = next.filter((k) => k !== 'title');
      const visible = [...presentation.columns.filter((c) => c.hidden !== true)].sort(
        (a, b) => order.indexOf(a.field) - order.indexOf(b.field),
      );
      onPresentationChange({
        ...presentation,
        titlePosition: next.indexOf('title'),
        columns: [...visible, ...presentation.columns.filter((c) => c.hidden === true)],
      });
    },
    [displayKeys, onPresentationChange, presentation],
  );

  /** One-step move for the header menus' Move left / Move right. */
  const moveDisplay = useCallback(
    (key: string, delta: -1 | 1) => {
      const from = displayKeys.indexOf(key);
      if (from === -1) return;
      reorderDisplay(key, delta === -1 ? from - 1 : from + 2);
    },
    [displayKeys, reorderDisplay],
  );

  // --- M12.8: drag a header to reorder -----------------------------------
  const headerRowRef = useRef<HTMLDivElement | null>(null);
  // The header label doubles as the menu trigger, so a completed drag must
  // swallow the click that follows its pointerup.
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<{ key: string; slot: number } | null>(null);

  const startHeaderDrag = useCallback(
    (key: string) => (e: React.PointerEvent) => {
      if (onPresentationChange === undefined || e.button !== 0) return;
      const row = headerRowRef.current;
      if (row === null) return;
      // Cell midpoints decide which slot the pointer is over. Measured once at
      // drag start — the cells do not move during the drag.
      //
      // By ROLE, not by child index (M16.16): the row's first child is the
      // gutter now, and counting it as a slot shifted every drop one column
      // to the left.
      const mids = [...row.querySelectorAll<HTMLElement>('[role="columnheader"]')].map((c) => {
        const r = c.getBoundingClientRect();
        return r.left + r.width / 2;
      });
      const startX = e.clientX;
      const startY = e.clientY;
      const slotAt = (x: number) => mids.filter((m) => x > m).length;
      let started = false;
      const move = (ev: PointerEvent) => {
        // 5px threshold keeps a plain click on the label opening the menu.
        if (!started && Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) {
          return;
        }
        if (!started) {
          started = true;
          suppressClick.current = true;
          document.body.classList.add('cb-col-dragging');
        }
        setDrag({ key, slot: slotAt(ev.clientX) });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        document.body.classList.remove('cb-col-dragging');
        setDrag(null);
        if (!started) return;
        reorderDisplay(key, slotAt(ev.clientX));
        // Cleared on a timeout so the click event this pointerup produces is
        // still inside the suppression window.
        setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [onPresentationChange, reorderDisplay],
  );

  const swallowDraggedClick = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /** Insert-line painted on the cell at the drop slot. */
  const dropStyle = (displayIndex: number): React.CSSProperties | undefined => {
    if (drag === null) return undefined;
    if (drag.slot === displayIndex) return { boxShadow: 'inset 2px 0 0 var(--cortex-500)' };
    if (drag.slot === displayKeys.length && displayIndex === displayKeys.length - 1) {
      return { boxShadow: 'inset -2px 0 0 var(--cortex-500)' };
    }
    return undefined;
  };

  /**
   * The footer's numbers (M16.15). Computed for the columns that ASKED for a
   * calculation — resolving every field of every row to fill a row nobody
   * configured would cost a rollup evaluation per cell.
   *
   * Over `flatRows`, not `entries`: the footer reports the rows on screen,
   * including the ones nesting pulled in from outside the query.
   */
  const calcResults = useMemo(() => {
    const out: Record<string, string> = {};
    const shown = flatRows.map((r) => r.entry);
    if (presentation.titleCalc !== undefined) {
      out.title = aggregate(
        presentation.titleCalc,
        shown.map((e) => ({ raw: e.title, display: e.title })),
      );
    }
    for (const { spec, def } of resolved) {
      if (spec.calc === undefined) continue;
      out[spec.field] = aggregate(
        spec.calc,
        shown.map((e) => {
          const r = schema.resolveField(e, spec.field);
          return { raw: r.raw, display: r.display };
        }),
        def,
      );
    }
    return out;
  }, [flatRows, resolved, schema, presentation.titleCalc]);

  /** A footer is a place to READ results, so it exists only once there are
   * results to read (M19.5). Gated on `resolved`, which already drops hidden
   * columns: a calculation on a column you then hide takes the footer with
   * it rather than leaving a 32px rule under a table that totals nothing. */
  const anyCalc =
    presentation.titleCalc !== undefined || resolved.some((r) => r.spec.calc !== undefined);

  const setColumnCalc = useCallback(
    (field: string, next: AggregateCalc | null) => {
      if (field === 'title') {
        if (onPresentationChange === undefined) return;
        const { titleCalc: _drop, ...rest } = presentation;
        onPresentationChange(next === null ? rest : { ...rest, titleCalc: next });
        return;
      }
      if (onColumnsChange === undefined) return;
      onColumnsChange(
        presentation.columns.map((c) => {
          if (c.field !== field) return c;
          const { calc: _clear, ...rest } = c;
          return next === null ? rest : { ...rest, calc: next };
        }),
      );
    },
    [onColumnsChange, onPresentationChange, presentation],
  );

  /**
   * The leaf band each record row sits in (M16.16), so the gutter's insert
   * can inherit it. `EntryRow` does not carry a band, and `buildRows` emits a
   * leaf header immediately before its run — so the last header walked is the
   * run's band. Computed here rather than tracked through the render, which
   * is a mutation the compiler rules rightly refuse.
   */
  const bandForRow = useMemo(() => {
    const out = new Map<string, GroupNode>();
    let current: GroupNode | null = null;
    for (const row of rows) {
      if (row.kind === 'band') current = row.node;
      else if (row.kind === 'row' && current !== null) out.set(row.key, current);
    }
    return out;
  }, [rows]);

  // Widths ride as custom properties on the grid so a drag can repaint them
  // without React seeing anything.
  const widthVars = useMemo(() => {
    const vars: Record<string, string> = { [TITLE_VAR]: `${layout.title}px` };
    layout.columns.forEach((w, i) => {
      vars[widthVar(i)] = `${w}px`;
    });
    return vars;
  }, [layout]);

  return (
    // The wrapper exists only to hang the right-edge overflow fade off the
    // scroller; the scroller itself keeps every class it had.
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={syncOverflow}
        data-testid="table-view"
        role="grid"
        // The grid is the sole tab stop, so it has to say what it is and how
        // big it is; `outline-none` with nothing replacing it meant Tabbing in
        // changed nothing on screen at all.
        aria-label={sourceType === null ? 'Records' : `${sourceType} records`}
        // M20.4: every row in the DOM, which is what `aria-rowcount` names.
        // It counted only the RECORD rows, so on a grouped table a screen
        // reader was told "row 9 of 4" — bands and the create row are rows,
        // and so is the header.
        aria-rowcount={rows.length + 1}
        // M16.17: a grid whose cells carry aria-colindex has to say how many
        // there are, or a screen reader reports "column 3 of ?".
        // M20.4: +1 for the gutter, which is a cell and now says so.
        aria-colcount={displayKeys.length + 1}
        className="min-h-0 min-w-0 flex-1 overflow-auto focus-visible:shadow-[inset_var(--ring)] focus-visible:outline-none"
        {...keyboard.containerProps}
      >
        <div
          ref={gridRef}
          style={
            {
              width: layout.total,
              minWidth: '100%',
              // M20.5: the bulk bar floats rather than docking, which is right
              // — docking shifts the table you are reading by 40px — but it
              // then sat on top of the last two rows with no way to scroll
              // them clear. Room appears only while it is on screen.
              ...(checked.length > 0 ? { paddingBottom: 72 } : {}),
              ...widthVars,
            } as React.CSSProperties
          }
        >
          <div
            ref={headerRowRef}
            role="row"
            className="group/head sticky top-0 z-20 flex h-8 border-b border-n-200 bg-n-25"
          >
            {/* M16.16: the gutter's header slot. Deliberately not a
                columnheader — it holds no column, and the header drag
                measures slots by that role. */}
            <div
              className={[
                frozenCount > 0 ? 'sticky left-0 z-30 bg-n-25' : '',
                'flex flex-none items-center justify-end pl-1 pr-1',
              ].join(' ')}
              style={{ width: GUTTER }}
            >
              {flatRows.length > 0 && (
                <input
                  type="checkbox"
                  data-testid="select-all"
                  aria-label={allChecked ? 'Clear selection' : 'Select all records'}
                  checked={allChecked}
                  ref={(el) => {
                    // Partial selection is neither checked nor unchecked, and
                    // `indeterminate` is a DOM property with no attribute.
                    if (el !== null) el.indeterminate = checked.length > 0 && !allChecked;
                  }}
                  onChange={() => setCheckedPaths(allChecked ? new Set() : new Set(rowPaths))}
                  className={`h-3.5 w-3.5 flex-none accent-cortex-500 ${
                    checked.length > 0 ? 'opacity-100' : 'opacity-0 group-hover/head:opacity-100'
                  }`}
                />
              )}
            </div>
            {/* M12.8: headers render in DISPLAY order — the name column is one
              of them now, not a fixture bolted to the front. */}
            {displayKeys.map((key, d) => {
              if (key === 'title') {
                return (
                  <div
                    key="title"
                    role="columnheader"
                    onPointerDown={startHeaderDrag('title')}
                    onClickCapture={swallowDraggedClick}
                    aria-colindex={d + 2}
                    className={[
                      titleFrozen ? 'z-30' : 'relative',
                      'group/header flex flex-none items-center gap-1.5 border-r border-n-100 bg-n-25 px-3 text-xs font-semibold text-n-600',
                      drag?.key === 'title' ? 'opacity-60' : '',
                    ].join(' ')}
                    style={{
                      width: `var(${TITLE_VAR})`,
                      ...freezeStyle(d),
                      ...dropStyle(d),
                    }}
                  >
                    <Icon name="type" size={12} color="var(--n-400)" />
                    <TitleHeaderMenu
                      presentation={presentation}
                      frozen={titleFrozen}
                      atStart={titlePos === 0}
                      atEnd={titlePos === resolved.length}
                      onPresentationChange={onPresentationChange}
                      onFilterField={onFilterField}
                      onMove={(delta) => moveDisplay('title', delta)}
                      onFreeze={() => freezeThrough(d)}
                      onCalcChange={
                        onPresentationChange === undefined
                          ? undefined
                          : (next) => setColumnCalc('title', next)
                      }
                    />
                    <SortMark presentation={presentation} field="title" />
                    <Icon
                      name="chevron-down"
                      size={11}
                      color="var(--n-400)"
                      className="flex-none opacity-0 group-hover/header:opacity-100"
                    />
                    {/* M11: the name column resizes too. It is the widest thing
                      on the row and was the one width nobody could change. */}
                    {onPresentationChange !== undefined && (
                      <ColumnResizer
                        label="Name"
                        width={layout.title}
                        min={MIN_TITLE_W}
                        onDrag={(w) => paint(TITLE_VAR, w, w - layout.title)}
                        onCommit={commitTitle}
                        onFit={() => fitColumn('title', d)}
                      />
                    )}
                  </div>
                );
              }
              const i = d < titlePos ? d : d - 1;
              const { def, spec } = resolved[i];
              return (
                <div
                  key={def.name}
                  role="columnheader"
                  onPointerDown={startHeaderDrag(def.name)}
                  onClickCapture={swallowDraggedClick}
                  aria-colindex={d + 2}
                  className={[
                    'group/header flex flex-none items-center gap-1.5 border-r border-n-100 px-2 text-xs font-medium text-n-600',
                    d < frozenCount ? 'z-30 bg-n-25' : 'relative',
                    drag?.key === def.name ? 'opacity-60' : '',
                  ].join(' ')}
                  style={{ width: `var(${widthVar(i)})`, ...freezeStyle(d), ...dropStyle(d) }}
                >
                  <Icon name={kindMeta(def.kind).icon} size={12} color="var(--n-400)" />
                  {/* M12.4b: the label opens the column menu (Notion's header).
                    Sorting lives inside it now, with an explicit direction. */}
                  <HeaderMenu
                    def={def}
                    wrap={spec.wrap === true}
                    columns={presentation.columns}
                    presentation={presentation}
                    schema={schema}
                    sourceType={sourceType ?? null}
                    onColumnsChange={onColumnsChange}
                    onPresentationChange={onPresentationChange}
                    onFilterField={onFilterField}
                    onMove={onPresentationChange !== undefined ? moveDisplay : undefined}
                    frozen={d < frozenCount}
                    onFreeze={
                      onPresentationChange === undefined ? undefined : () => freezeThrough(d)
                    }
                    onFit={() => fitColumn(def.name, d)}
                    calc={spec.calc}
                    onCalcChange={
                      onColumnsChange === undefined
                        ? undefined
                        : (next) => setColumnCalc(def.name, next)
                    }
                  />
                  {def.heterogeneous === true && (
                    <Tooltip label="Declared with different kinds across the types in this view">
                      <span className="flex-none text-warn-500">
                        <Icon name="triangle-alert" size={10} />
                      </span>
                    </Tooltip>
                  )}
                  <SortMark presentation={presentation} field={def.name} />
                  <Icon
                    name="chevron-down"
                    size={11}
                    color="var(--n-400)"
                    className="flex-none opacity-0 group-hover/header:opacity-100"
                  />
                  {onColumnsChange !== undefined && (
                    <ColumnResizer
                      label={humanize(def.name)}
                      width={layout.columns[i]}
                      min={MIN_COL_W}
                      onDrag={(w) => paint(widthVar(i), w, w - layout.columns[i])}
                      onCommit={(w) => commitColumn(def.name, w)}
                      onFit={() => fitColumn(def.name, d)}
                    />
                  )}
                </div>
              );
            })}
            {/* M16.18: the header used to simply stop after the last column.
                `hiddenColumns` has been exported since M9.2 with no call
                site — this is it. */}
            {onColumnsChange !== undefined && (
              <AddColumnButton
                columns={presentation.columns}
                fields={fields}
                sourceType={sourceType ?? null}
                onColumnsChange={onColumnsChange}
              />
            )}
          </div>

          {/* M20.5: ABOVE the create row, which is what "below" refers to.
              `buildRows` emits the add row even for an empty source, and this
              block sat after it — so the one instruction on screen pointed at
              a control that was already above it. */}
          {entries.length === 0 && (
            <div role="row" className="sticky left-0 px-3 py-8">
              {/* An empty that only reports emptiness occupies the space where
                the next action belongs (M9.6). */}
              <EmptyState
                icon="table-2"
                title={filtered === true ? 'Nothing matches these filters' : 'No records yet'}
                description={
                  filtered === true
                    ? 'Adjust the filters in view settings to widen the query.'
                    : 'Create the first one below.'
                }
              />
            </div>
          )}

          {rows.map((row) => {
            if (row.kind === 'band') {
              return (
                <BandHeader
                  key={row.key}
                  node={row.node}
                  collapsed={collapsedMap?.[row.key] === true}
                  onToggle={() => toggleCollapsed(scope, row.key)}
                />
              );
            }
            if (row.kind === 'add') {
              // M9.6: a listing surface can create, inheriting its band.
              return (
                <div
                  key={row.key}
                  role="row"
                  className="sticky left-0 flex"
                  // Offset by the gutter, not started at it: the create row's
                  // input has to line up with the names it is creating.
                  style={{ width: `calc(var(${TITLE_VAR}) + ${GUTTER}px)` }}
                >
                  <span className="flex-none" style={{ width: GUTTER }} />
                  <span className="min-w-0 flex-1">
                    <QuickAddInline
                      compact
                      label="New"
                      ariaLabel={
                        row.band === null ? 'New record' : `New record in ${row.band.label}`
                      }
                      onCreate={(title) =>
                        onCreate!(title, {
                          groupBy: row.band?.field ?? '',
                          groupValue: row.band?.key ?? '',
                        })
                      }
                    />
                  </span>
                </div>
              );
            }
            // M20.5: `flatRows.indexOf(row)` — a linear scan per row, so a
            // 1,000-row grid ran ~500,000 comparisons per render just to
            // discover a number the loop could have carried. Built once.
            const index = rowIndex.get(row.key) ?? 0;
            const rowBand = bandForRow.get(row.key) ?? null;
            return (
              <Fragment key={row.key}>
                <TableRow
                  entry={row.entry}
                  cells={cells}
                  titlePos={titlePos}
                  titleFrozen={titleFrozen}
                  freezeStyle={freezeStyle}
                  rowHeight={rowHeight}
                  autoHeight={anyWrap}
                  schema={schema}
                  depth={row.depth}
                  childCount={row.childCount}
                  collapsed={collapsedMap?.[row.key] === true}
                  chips={chips}
                  onToggle={() => toggleCollapsed(scope, row.key)}
                  selected={index === keyboard.index}
                  onSelect={(col) =>
                    col < 0 ? keyboard.setIndex(index) : keyboard.setCell(index, col)
                  }
                  // Without this the hook's `rows` ref stayed empty, so arrowing
                  // past the fold moved an invisible cursor off-screen and the
                  // scroller never followed it.
                  rowProps={keyboard.rowProps(index)}
                  checked={checkedPaths.has(row.entry.path)}
                  selecting={checkedPaths.size > 0}
                  onCheck={(range) => toggleChecked(index, range)}
                  // Nested rows get no insert affordance (M20.1). `onCreate` is
                  // bound to the SURFACE's type, so "insert a record after this
                  // one" on a depth-2 Work item in the OKR tree created an
                  // Objective at depth 0 — a record of the wrong type, in the
                  // wrong folder, that jumped to the top of the grid. Creating
                  // the type at that depth also has to link the new record back
                  // through the relation that produced the level, and for a
                  // FORWARD descent (`deliverables`) the parent holds the link,
                  // so the child cannot express it at all and the parent needs
                  // patching too. That belongs with the nesting model; until it
                  // exists, offering nothing beats offering the wrong thing.
                  onInsert={
                    onCreate === undefined || row.depth > 0
                      ? undefined
                      : () =>
                          setInserting({
                            key: row.key,
                            band: {
                              groupBy: rowBand?.field ?? '',
                              groupValue: rowBand?.key ?? '',
                            },
                          })
                  }
                  onAction={onRowAction}
                  onRename={renameRow}
                  cellProps={(c) => keyboard.cellProps(index, c)}
                />
                {inserting?.key === row.key && onCreate !== undefined && (
                  <InsertRow
                    gutter={GUTTER}
                    frozen={titleFrozen}
                    indent={row.depth * INDENT}
                    onCancel={() => setInserting(null)}
                    onCreate={async (title) => {
                      const ok = await onCreate(title, inserting.band);
                      if (ok) setInserting(null);
                      return ok;
                    }}
                  />
                )}
              </Fragment>
            );
          })}

          {/* M16.15: the calculation footer. Pinned to the bottom of the
              scroller, because a total you have to scroll to is a total you
              do not read.
              M19.5: it REPORTS what the column header menus were asked for.
              It used to be present on every table with a row in it, offering
              a ghost "Calculate" per column on hover — so the commonest state
              of this row was a rule under the grid advertising a feature
              nobody had used. */}
          {flatRows.length > 0 && anyCalc && (
            <div
              role="row"
              data-testid="table-footer"
              className="sticky bottom-0 z-20 flex h-8 border-t border-n-200 bg-n-25"
            >
              <span
                className={[frozenCount > 0 ? 'sticky left-0 z-10 bg-n-25' : '', 'flex-none'].join(
                  ' ',
                )}
                style={{ width: GUTTER }}
              />
              {displayKeys.map((key, d) => {
                const i = d < titlePos ? d : d - 1;
                const column = key === 'title' ? null : resolved[i];
                return (
                  <CalcCell
                    key={key}
                    field={key}
                    calc={column === null ? presentation.titleCalc : column.spec.calc}
                    result={calcResults[key] ?? ''}
                    className={[
                      d < frozenCount ? 'z-10 bg-n-25' : '',
                      'flex flex-none items-center border-r border-n-100 px-2 text-xs',
                    ].join(' ')}
                    style={{
                      width: `var(${column === null ? TITLE_VAR : widthVar(i)})`,
                      ...freezeStyle(d),
                    }}
                  />
                );
              })}
              <span aria-hidden className="flex-1" />
            </div>
          )}
        </div>
      </div>
      {moreRight && (
        <div
          aria-hidden
          data-testid="table-overflow-right"
          className="pointer-events-none absolute inset-y-0 right-0 w-6"
          style={{ background: 'linear-gradient(to left, var(--n-200), transparent)' }}
        />
      )}
      {/* M16.16: the bulk bar. It floats over the rows rather than docking a
          strip above them, so selecting does not shift the table you are
          reading by 40px. */}
      {checked.length > 0 && (
        <div
          role="toolbar"
          data-testid="bulk-bar"
          aria-label={`${checked.length} selected`}
          className="absolute bottom-12 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-lg border border-n-200 bg-n-0 px-2 py-1.5 shadow-[var(--shadow-lg)]"
        >
          <span className="px-1 text-sm font-medium text-n-700">{checked.length} selected</span>
          <span className="h-4 w-px bg-n-200" />
          <Button size="sm" variant="ghost" icon="link" onClick={copyLinks}>
            Copy links
          </Button>
          <Button size="sm" variant="ghost" icon="copy" onClick={duplicateChecked}>
            Duplicate
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon="trash-2"
            onClick={() => setConfirmBulkDelete(true)}
          >
            Delete
          </Button>
          <IconButton icon="x" label="Clear selection" size="sm" onClick={clearChecked} />
        </div>
      )}
      <Dialog
        open={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        title={`Delete ${checked.length} ${checked.length === 1 ? 'record' : 'records'}?`}
        width={420}
        footerNote="Recoverable from git history, not from the app."
        secondaryAction={{ label: 'Cancel', onClick: () => setConfirmBulkDelete(false) }}
        primaryAction={{ label: 'Delete', onClick: () => deleteRecords(checked) }}
      >
        <p className="m-0 text-sm leading-relaxed text-n-600">
          {checked.length === 1
            ? 'The file leaves the vault.'
            : 'The files leave the vault. Links pointing at them will point at nothing.'}
        </p>
      </Dialog>
      <Dialog
        open={confirmRow !== null}
        onClose={() => setConfirmRow(null)}
        title={`Delete "${confirmRow?.title ?? ''}"?`}
        width={420}
        footerNote="Recoverable from git history, not from the app."
        secondaryAction={{ label: 'Cancel', onClick: () => setConfirmRow(null) }}
        primaryAction={{
          label: 'Delete',
          onClick: () => {
            const target = confirmRow;
            setConfirmRow(null);
            if (target !== null) deleteRecords([target]);
          },
        }}
      >
        <p className="m-0 text-sm leading-relaxed text-n-600">The file leaves the vault.</p>
      </Dialog>
    </div>
  );
}
