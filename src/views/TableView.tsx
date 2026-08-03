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
import { CREATABLE_PROPERTY_KINDS, kindMeta, progressRatio } from '@/engine/properties';
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
import { ConfirmKindChange, PropertyEditor } from '@/views/PropertyEditor';
import { QuickAddInline } from '@/views/QuickAdd';
import {
  useRowKeyboard,
  type RowKeyboardCellProps,
  type RowKeyboardRowProps,
} from '@/views/useRowKeyboard';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const TITLE_W = 280;
const MIN_TITLE_W = 140;

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
  if (ratio === null) return <span className="truncate text-[12.5px]">{display}</span>;
  return (
    // w-full: the bar is flex-1, so without a sized parent it collapses to
    // zero inside a content-width cell.
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--n-100)]">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${ratio}%`,
            background: ratio >= 100 ? 'var(--success-500)' : 'var(--cortex-500)',
          }}
        />
      </span>
      <span className="flex-none [font-family:var(--font-mono)] text-[11px] text-[var(--n-600)]">
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
  const readOnly = READ_ONLY.has(def.kind);
  const isProgress = def.format === 'progress';

  return (
    <div
      role="gridcell"
      {...cellProps}
      aria-colindex={colIndex + 1}
      className={[
        'flex flex-none overflow-hidden border-r border-[var(--n-100)] px-2',
        wrap ? 'items-start py-1.5' : 'items-center',
        freeze === undefined ? '' : `z-10 ${fill}`,
        // The ring is inset, not a border: a border would add a pixel to a
        // cell whose width is a shared CSS variable and shear the column.
        'data-[cursor]:shadow-[inset_0_0_0_2px_var(--cortex-500)]',
      ].join(' ')}
      style={{ width: `var(${widthVar(index)})`, ...freeze }}
    >
      {readOnly || isProgress ? (
        isProgress ? (
          <ProgressCell display={resolved.display} />
        ) : (
          <span
            className={[
              'text-[12.5px] text-[var(--n-600)]',
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
        <div
          className={[
            'flex min-w-0 flex-1 overflow-hidden [&>*]:max-w-full',
            wrap ? 'items-start' : 'items-center',
          ].join(' ')}
        >
          <FieldEditor entry={entry} def={def} schema={schema} compact={!wrap} chips={chips} />
        </div>
      )}
    </div>
  );
});

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
 */
const ROW_HEIGHT = { compact: 'h-8', default: 'h-9', tall: 'h-12' } as const;
const ROW_MIN_HEIGHT = { compact: 'min-h-8', default: 'min-h-9', tall: 'min-h-12' } as const;

type RowHeight = NonNullable<Presentation['rowHeight']>;

/** Derived from the class map, so the menu cannot offer a height the rows
 * cannot render. */
const ROW_HEIGHT_CHOICES: { value: RowHeight; label: string }[] = (
  Object.keys(ROW_HEIGHT) as RowHeight[]
).map((value) => ({ value, label: `${value[0].toUpperCase()}${value.slice(1)}` }));

const rowHeightLabel = (h: RowHeight): string =>
  ROW_HEIGHT_CHOICES.find((c) => c.value === h)?.label ?? 'Default';

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
            className={`flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-800)] ${reveal}`}
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
        className={`h-3.5 w-3.5 flex-none accent-[var(--cortex-500)] ${reveal}`}
      />
      <button
        ref={gripRef}
        type="button"
        data-testid="row-menu"
        aria-label={`Actions for ${entry.title}`}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        className={`flex h-5 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-800)] ${reveal}`}
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
        'flex h-9 items-center border-b border-[var(--n-100)] bg-[var(--n-0)]',
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
  onSelect: () => void;
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
  const fill =
    selected || checked ? 'bg-[var(--cortex-50)]' : 'bg-[var(--n-0)] group-hover:bg-[var(--n-25)]';

  return (
    <div
      role="row"
      {...rowProps}
      data-testid="table-row"
      data-path={entry.path}
      data-depth={depth}
      onClick={onSelect}
      // `group` sits on the ROW so hovering anywhere reveals Open, not only
      // over the name cell.
      className={[
        'group flex border-b border-[var(--n-100)]',
        autoHeight ? ROW_MIN_HEIGHT[rowHeight] : ROW_HEIGHT[rowHeight],
        // The cursor row needs to survive a bright screen: the --cortex-50
        // fill alone was 1.13:1 against white, so a left rule carries it.
        selected
          ? 'bg-[var(--cortex-50)] shadow-[inset_2px_0_0_var(--cortex-500)]'
          : checked
            ? 'bg-[var(--cortex-50)]'
            : 'hover:bg-[var(--n-25)]',
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
        aria-colindex={titlePos + 1}
        className={[
          titleFrozen ? 'z-10' : '',
          'data-[cursor]:shadow-[inset_0_0_0_2px_var(--cortex-500)]',
          'flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] pr-3',
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
            className="flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-800)]"
          >
            <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
          </button>
        ) : (
          <span className="h-4 w-4 flex-none" />
        )}
        <Icon name={style.icon} size={13} color={style.color ?? 'var(--n-400)'} />
        {/* The title IS the opener. It used to be an inert <span> beside a
            chip that was `display:none` until hover — so the only way into a
            record was a control absent from the DOM and from the tab order,
            and hovering it stole ~62px from the title you were reading. */}
        <button
          type="button"
          aria-label={`Open ${entry.title}`}
          onClick={(e) => {
            e.stopPropagation();
            openPath(entry.path);
          }}
          className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[13px] text-[var(--n-900)] hover:underline focus-visible:rounded-sm focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
        >
          {entry.title}
        </button>
        {childCount > 0 && (
          <span className="flex-none [font-family:var(--font-mono)] text-[10.5px] text-[var(--n-400)]">
            {childCount}
          </span>
        )}
        {/* Reserved space, not inserted space: the glyph is always laid out
            and only its opacity changes, so the title never reflows under the
            pointer. */}
        <span
          aria-hidden
          className="flex-none text-[var(--n-400)] opacity-0 group-hover:opacity-100"
        >
          <Icon name="maximize-2" size={11} />
        </span>
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

  const begin = (clientX: number) => {
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
      onKeyDown={(e) => {
        // Keyboard resize: a pointer-only affordance is unreachable without one.
        const step = e.shiftKey ? 40 : 8;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onCommit(Math.max(min, width - step));
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          onCommit(width + step);
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          onFit?.();
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
          active ? 'bg-[var(--cortex-500)]' : 'bg-transparent hover:bg-[var(--cortex-300)]',
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
    <button
      type="button"
      role="row"
      data-testid="table-group-header"
      data-depth={node.depth}
      onClick={onToggle}
      className="flex h-8 w-full items-center border-b border-[var(--n-100)] bg-[var(--n-25)] text-left"
    >
      {/* The band spans the full scroll width, so the band itself cannot be
          sticky (a sticky box as wide as its container has no room to shift).
          The label cluster is the sticky part instead. */}
      <span
        className="sticky left-0 flex items-center gap-2 pr-3"
        style={{ paddingLeft: GUTTER + node.depth * INDENT }}
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} color="var(--n-400)" />
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
            node.depth === 0
              ? 'text-[12.5px] font-semibold text-[var(--n-800)]'
              : 'text-[12px] font-medium text-[var(--n-700)]'
          }
        >
          {node.label}
        </span>
        <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
          {node.count}
        </span>
      </span>
    </button>
  );
}

/**
 * One footer cell of the calculation row (M16.15).
 *
 * Notion's shape, and the reason the row is not a wall of numbers: a column
 * with no calculation set shows nothing until the footer is hovered, and then
 * offers "Calculate". Only what someone asked for is on screen.
 */
function CalcCell({
  field,
  label,
  kind,
  calc,
  result,
  onChange,
  className,
  style,
}: {
  field: string;
  label: string;
  kind: FieldKind;
  calc: AggregateCalc | undefined;
  /** Already computed by the table — one pass over the rows, not one per cell. */
  result: string;
  /** Absent on a surface with no view file to persist the choice to. */
  onChange?: (next: AggregateCalc | null) => void;
  className: string;
  style: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const meta = calc === undefined ? null : aggregateMeta(calc);

  const body =
    meta === null ? (
      <span className="text-[var(--n-400)] opacity-0 group-hover/footer:opacity-100">
        Calculate
      </span>
    ) : (
      <>
        <span className="truncate text-[var(--n-400)]">{meta.short}</span>
        <span className="flex-none font-medium text-[var(--n-700)] [font-variant-numeric:tabular-nums]">
          {result === '' ? '—' : result}
        </span>
      </>
    );

  return (
    <div role="gridcell" className={className} style={style}>
      {onChange === undefined ? (
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{body}</span>
      ) : (
        <button
          ref={ref}
          type="button"
          data-testid={`calc-${field}`}
          aria-label={`${label} calculation`}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center justify-end gap-1.5 rounded-[5px] border-0 bg-transparent px-1 py-0.5 text-[11.5px] hover:bg-[var(--n-100)] focus-visible:shadow-[var(--ring)] focus-visible:outline-none"
        >
          {body}
        </button>
      )}
      {open && onChange !== undefined && (
        <Popover
          anchorRef={ref}
          onClose={() => setOpen(false)}
          role="menu"
          ariaLabel={`${label} calculation`}
        >
          <MenuSurface width={200}>
            <MenuLabel>Calculate</MenuLabel>
            <MenuItem
              label="None"
              icon="minus"
              checked={calc === undefined}
              testId="calc-option-none"
              onSelect={() => {
                setOpen(false);
                onChange(null);
              }}
            />
            <MenuSeparator />
            {aggregatesFor(kind).map((a) => (
              <MenuItem
                key={a.calc}
                label={a.label}
                checked={calc === a.calc}
                testId={`calc-option-${a.calc}`}
                onSelect={() => {
                  setOpen(false);
                  onChange(a.calc);
                }}
              />
            ))}
          </MenuSurface>
        </Popover>
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
        className="flex flex-none items-center text-[var(--cortex-600)]"
      >
        <Icon name={spec.dir === 'asc' ? 'arrow-up' : 'arrow-down'} size={11} />
        {multi && <span className="[font-family:var(--font-mono)] text-[9.5px]">{at + 1}</span>}
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
  const [step, setStep] = useState<'closed' | 'menu' | 'new'>('closed');
  const ref = useRef<HTMLButtonElement | null>(null);
  const hidden = useMemo(() => hiddenColumns(columns, fields), [columns, fields]);

  const declare = (name: string, kind: FieldKind, relation?: RelationConfig) => {
    setStep('closed');
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

  return (
    <div
      className="relative flex flex-none items-center justify-center border-r border-[var(--n-100)]"
      style={{ width: ADD_W }}
    >
      <button
        ref={ref}
        type="button"
        data-testid="add-column"
        aria-label="Add a column"
        aria-haspopup="menu"
        onClick={() => setStep(step === 'closed' ? 'menu' : 'closed')}
        className="flex h-5 w-5 items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-800)]"
      >
        <Icon name="plus" size={13} />
      </button>
      {step === 'menu' && (
        <Popover
          anchorRef={ref}
          onClose={() => setStep('closed')}
          role="menu"
          ariaLabel="Add a column"
          trapFocus
        >
          <MenuSurface width={232}>
            {sourceType !== null && (
              <MenuItem
                icon="plus"
                label="New property"
                testId="add-column-new"
                onSelect={() => setStep('new')}
              />
            )}
            {hidden.length > 0 && (
              <>
                {sourceType !== null && <MenuSeparator />}
                <MenuLabel>Hidden</MenuLabel>
                {hidden.map((f) => (
                  <MenuItem
                    key={f.name}
                    icon={kindMeta(f.kind).icon}
                    label={humanize(f.name)}
                    testId={`show-column-${f.name}`}
                    onSelect={() => {
                      setStep('closed');
                      // toggleColumn re-shows in place when the view already
                      // holds a hidden spec, and appends when it does not.
                      onColumnsChange(toggleColumn(columns, f.name));
                    }}
                  />
                ))}
              </>
            )}
            {hidden.length === 0 && sourceType === null && (
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
      {step === 'new' && sourceType !== null && (
        <AddPropertyPanel
          anchorRef={ref}
          existingNames={fields.map((f) => f.name)}
          ownerType={sourceType}
          onAdd={declare}
          onCancel={() => setStep('closed')}
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
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [changingKind, setChangingKind] = useState(false);
  const [pendingKind, setPendingKind] = useState<FieldDef['kind'] | null>(null);
  // M12.8: the full property editor, flown out IN this popover next to the
  // column it configures — config never docks a side panel.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(humanize(def.name));
  const allEntriesForCount = useVaultStore((s) => s.entries);
  const name = humanize(def.name);
  // Schema operations need one agreed-on declaration to edit.
  const canEditSchema = sourceType !== null && def.heterogeneous !== true;

  useEffect(() => {
    if (open) {
      setDraft(humanize(def.name));
      setChangingKind(false);
      setEditing(false);
    }
  }, [open, def.name]);

  const close = () => setOpen(false);

  const commitRename = () => {
    const next = draft.trim();
    if (!canEditSchema || sourceType === null || next === '' || humanize(def.name) === next) return;
    void (async () => {
      if (await renameFieldOnType(sourceType, def.name, next)) {
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
      {
        label: 'Group by',
        icon: 'rows-3',
        active: presentation.group.some((g) => g.descend === undefined && g.field === def.name),
        run: () => onPresentationChange(groupByField(presentation, def.name)),
      },
    );
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
    if (canEditSchema && sourceType !== null) {
      const insert = (side: 'left' | 'right') => {
        void (async () => {
          const created = await insertFieldOnType(sourceType, def.name, side);
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
              const copy = await duplicateFieldOnType(sourceType, def.name);
              if (copy !== null) onColumnsChange(insertColumn(columns, copy, def.name, 'right'));
            })();
          },
        },
        {
          label: 'Delete property',
          icon: 'trash-2',
          danger: true,
          run: () => {
            void (async () => {
              if (await removeFieldFromType(sourceType, def.name)) {
                onColumnsChange(columns.filter((c) => c.field !== def.name));
              }
            })();
          },
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
        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[11.5px] font-medium text-[var(--n-600)] hover:text-[var(--n-900)]"
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
            {editing && canEditSchema && sourceType !== null && onColumnsChange !== undefined ? (
              // The Notion flyout: the menu becomes the property editor,
              // anchored where the column is (M12.8).
              <div className="cb-panel-in">
                <MenuBack title="Edit property" onBack={() => setEditing(false)} />
                <PropertyEditor
                  key={def.name}
                  def={def}
                  sourceType={sourceType}
                  schema={schema}
                  columns={columns}
                  onColumnsChange={onColumnsChange}
                  onDeleted={close}
                />
              </div>
            ) : (
              <>
                {canEditSchema && sourceType !== null ? (
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
                  <div className="px-2 pb-1 pt-1 text-[12px] font-medium text-[var(--n-800)]">
                    {name}
                  </div>
                )}
                {canEditSchema && sourceType !== null && onColumnsChange !== undefined && (
                  <MenuItem
                    icon="settings-2"
                    label="Edit property"
                    submenu
                    testId="edit-property"
                    onSelect={() => setEditing(true)}
                  />
                )}
                {canEditSchema && sourceType !== null && (
                  <MenuItem
                    icon="repeat-2"
                    label="Change type"
                    hint={kindMeta(def.kind).label}
                    submenu
                    testId="change-type"
                    onSelect={() => setChangingKind(!changingKind)}
                  />
                )}
                {changingKind && sourceType !== null && (
                  <div className="mb-1 max-h-[180px] overflow-y-auto rounded-[7px] bg-[var(--n-25)] p-0.5">
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
                {items.map((item) => (
                  <Fragment key={item.label}>
                    {item.section === true && <MenuSeparator />}
                    <MenuItem
                      icon={item.icon}
                      label={item.label}
                      danger={item.danger}
                      checked={item.active}
                      onSelect={() => {
                        item.run();
                        close();
                      }}
                    />
                  </Fragment>
                ))}
              </>
            )}
          </MenuSurface>
        </Popover>
      )}
      {pendingKind !== null && sourceType !== null && (
        <ConfirmKindChange
          name={name}
          from={def.kind}
          to={pendingKind}
          count={allEntriesForCount.filter((e) => e.type === sourceType).length}
          onCancel={() => setPendingKind(null)}
          onConfirm={() => {
            setPendingKind(null);
            close();
            void changeFieldKind(sourceType, def.name, pendingKind);
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
  rowHeight,
  allWrapped,
  onPresentationChange,
  onFilterField,
  onMove,
  onFreeze,
  onWrapAll,
}: {
  presentation: Presentation;
  frozen: boolean;
  atStart: boolean;
  atEnd: boolean;
  /** M16.18: the two settings that are about the WHOLE table rather than one
   * column, hosted on the name column's menu — the table's own settings
   * surface since M12.8, and the only one that needs no capability flag to
   * say "this is a table". */
  rowHeight: NonNullable<Presentation['rowHeight']>;
  allWrapped: boolean;
  onPresentationChange?: (next: Presentation) => void;
  onFilterField?: (field: string) => void;
  onMove: (delta: -1 | 1) => void;
  onFreeze: () => void;
  onWrapAll?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [heights, setHeights] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (open) setHeights(false);
  }, [open]);

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
      {
        // Freezing means "up to here" now, so it is offered wherever the name
        // column sits rather than only while it leads (M16.18).
        label: frozen ? 'Unfreeze up to here' : 'Freeze up to this column',
        icon: frozen ? 'pin-off' : 'pin',
        section: true,
        run: onFreeze,
      },
    );
    if (!atStart) items.push({ label: 'Move left', icon: 'arrow-left', run: () => onMove(-1) });
    if (!atEnd) items.push({ label: 'Move right', icon: 'arrow-right', run: () => onMove(1) });
  }

  if (items.length === 0 && onWrapAll === undefined) {
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
        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[11.5px] font-semibold text-[var(--n-600)] hover:text-[var(--n-900)]"
      >
        Name
      </button>
      {open && (
        <Popover
          anchorRef={triggerRef}
          onClose={close}
          onEscape={heights ? () => setHeights(false) : close}
          role="menu"
          ariaLabel="Name column menu"
          trapFocus
        >
          <MenuSurface width={224}>
            {heights ? (
              <>
                <MenuBack title="Row height" onBack={() => setHeights(false)} />
                {ROW_HEIGHT_CHOICES.map((choice) => (
                  <MenuItem
                    key={choice.value}
                    label={choice.label}
                    checked={rowHeight === choice.value}
                    testId={`row-height-${choice.value}`}
                    onSelect={() => {
                      close();
                      onPresentationChange?.({ ...presentation, rowHeight: choice.value });
                    }}
                  />
                ))}
              </>
            ) : (
              <>
                <MenuLabel>Name</MenuLabel>
                {items.map((item) => (
                  <Fragment key={item.label}>
                    {item.section === true && <MenuSeparator />}
                    <MenuItem
                      icon={item.icon}
                      label={item.label}
                      checked={item.active}
                      onSelect={() => {
                        item.run();
                        close();
                      }}
                    />
                  </Fragment>
                ))}
                {(onPresentationChange !== undefined || onWrapAll !== undefined) && (
                  <MenuSeparator />
                )}
                {onPresentationChange !== undefined && (
                  <MenuItem
                    icon="rows-2"
                    label="Row height"
                    hint={rowHeightLabel(rowHeight)}
                    submenu
                    testId="row-height"
                    onSelect={() => setHeights(true)}
                  />
                )}
                {onWrapAll !== undefined && (
                  <MenuItem
                    icon="wrap-text"
                    label="Wrap all columns"
                    checked={allWrapped}
                    testId="wrap-all"
                    onSelect={() => {
                      close();
                      onWrapAll();
                    }}
                  />
                )}
              </>
            )}
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
    const content = GUTTER + ADD_W + titleWidth + base.reduce((sum, w) => sum + w, 0);
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
  }, [resolved, titleWidth, available]);

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
        `[aria-colindex="${displayIndex + 1}"]`,
      )) {
        widest = Math.max(widest, cell.scrollWidth);
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
  const keyboard = useRowKeyboard({
    count: flatRows.length,
    onOpen: (i) => openPath(flatRows[i].entry.path),
    onToggle: (i) => {
      if (flatRows[i].childCount > 0) toggleCollapsed(scope, flatRows[i].key);
    },
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

  const checked = useMemo(
    () => flatRows.filter((r) => checkedPaths.has(r.entry.path)).map((r) => r.entry),
    [flatRows, checkedPaths],
  );

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
  const allChecked = flatRows.length > 0 && checkedPaths.size >= flatRows.length;

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
  const allWrapped = resolved.length > 0 && resolved.every((c) => c.spec.wrap === true);

  /** Wrap every column, or unwrap them all when they already are. */
  const wrapAll = useCallback(() => {
    if (onColumnsChange === undefined) return;
    onColumnsChange(
      presentation.columns.map((c) => {
        if (!allWrapped) return { ...c, wrap: true };
        const { wrap: _drop, ...rest } = c;
        return rest;
      }),
    );
  }, [allWrapped, onColumnsChange, presentation.columns]);

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
        aria-rowcount={flatRows.length}
        // M16.17: a grid whose cells carry aria-colindex has to say how many
        // there are, or a screen reader reports "column 3 of ?".
        aria-colcount={displayKeys.length}
        className="min-h-0 min-w-0 flex-1 overflow-auto focus-visible:shadow-[inset_var(--ring)] focus-visible:outline-none"
        {...keyboard.containerProps}
      >
        <div
          ref={gridRef}
          style={{ width: layout.total, minWidth: '100%', ...widthVars } as React.CSSProperties}
        >
          <div
            ref={headerRowRef}
            role="row"
            className="group/head sticky top-0 z-20 flex h-8 border-b border-[var(--n-200)] bg-[var(--n-25)]"
          >
            {/* M16.16: the gutter's header slot. Deliberately not a
                columnheader — it holds no column, and the header drag
                measures slots by that role. */}
            <div
              className={[
                frozenCount > 0 ? 'sticky left-0 z-30 bg-[var(--n-25)]' : '',
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
                  className={`h-3.5 w-3.5 flex-none accent-[var(--cortex-500)] ${
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
                    aria-colindex={d + 1}
                    className={[
                      titleFrozen ? 'z-30' : 'relative',
                      'group/header flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] bg-[var(--n-25)] px-3 text-[11.5px] font-semibold text-[var(--n-600)]',
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
                      rowHeight={rowHeight}
                      allWrapped={allWrapped}
                      onPresentationChange={onPresentationChange}
                      onFilterField={onFilterField}
                      onMove={(delta) => moveDisplay('title', delta)}
                      onFreeze={() => freezeThrough(d)}
                      onWrapAll={onColumnsChange === undefined ? undefined : wrapAll}
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
                  aria-colindex={d + 1}
                  className={[
                    'group/header flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] px-2 text-[11.5px] font-medium text-[var(--n-600)]',
                    d < frozenCount ? 'z-30 bg-[var(--n-25)]' : 'relative',
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
                  />
                  {def.heterogeneous === true && (
                    <Tooltip label="Declared with different kinds across the types in this view">
                      <span className="flex-none text-[var(--warn-500)]">
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
            const index = flatRows.indexOf(row);
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
                  onSelect={() => keyboard.setIndex(index)}
                  // Without this the hook's `rows` ref stayed empty, so arrowing
                  // past the fold moved an invisible cursor off-screen and the
                  // scroller never followed it.
                  rowProps={keyboard.rowProps(index)}
                  checked={checkedPaths.has(row.entry.path)}
                  selecting={checkedPaths.size > 0}
                  onCheck={(range) => toggleChecked(index, range)}
                  onInsert={
                    onCreate === undefined
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
              do not read. */}
          {flatRows.length > 0 && (
            <div
              role="row"
              data-testid="table-footer"
              className="group/footer sticky bottom-0 z-20 flex h-8 border-t border-[var(--n-200)] bg-[var(--n-25)]"
            >
              <span
                className={[
                  frozenCount > 0 ? 'sticky left-0 z-10 bg-[var(--n-25)]' : '',
                  'flex-none',
                ].join(' ')}
                style={{ width: GUTTER }}
              />
              {displayKeys.map((key, d) => {
                const i = d < titlePos ? d : d - 1;
                const column = key === 'title' ? null : resolved[i];
                const persists = column === null ? onPresentationChange : onColumnsChange;
                return (
                  <CalcCell
                    key={key}
                    field={key}
                    label={column === null ? 'Name' : humanize(column.def.name)}
                    // The name column holds titles: text, so the numeric
                    // calculations are correctly absent from its menu.
                    kind={column === null ? 'text' : column.def.kind}
                    calc={column === null ? presentation.titleCalc : column.spec.calc}
                    result={calcResults[key] ?? ''}
                    onChange={
                      persists === undefined ? undefined : (next) => setColumnCalc(key, next)
                    }
                    className={[
                      d < frozenCount ? 'z-10 bg-[var(--n-25)]' : '',
                      'flex flex-none items-center border-r border-[var(--n-100)] px-2 text-[11.5px]',
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
          className="absolute bottom-12 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] px-2 py-1.5 shadow-[var(--shadow-lg)]"
        >
          <span className="px-1 text-[12.5px] font-medium text-[var(--n-700)]">
            {checked.length} selected
          </span>
          <span className="h-4 w-px bg-[var(--n-200)]" />
          <Button size="sm" variant="ghost" icon="link" onClick={copyLinks}>
            Copy links
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
        <p className="m-0 text-[13px] leading-relaxed text-[var(--n-600)]">
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
        <p className="m-0 text-[13px] leading-relaxed text-[var(--n-600)]">
          The file leaves the vault.
        </p>
      </Dialog>
    </div>
  );
}
