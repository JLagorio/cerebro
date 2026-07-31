import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { FieldEditor } from '@/detail/FieldEditor';
import {
  MIN_COL_W,
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
  GroupNode,
  Presentation,
  Schema,
} from '@/engine/types';
import {
  changeFieldKind,
  duplicateFieldOnType,
  insertFieldOnType,
  normalizeFieldName,
  removeFieldFromType,
  renameFieldOnType,
} from '@/app/typeActions';
import { useOpenPath } from '@/app/useOpenPath';
import { QuickAddInline } from '@/views/QuickAdd';
import { useRowKeyboard } from '@/views/useRowKeyboard';
import { useUiStore } from '@/stores/uiStore';

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
            background: ratio >= 100 ? 'var(--success-500, #1F9D61)' : 'var(--cortex-500)',
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
}: {
  entry: Entry;
  def: ColumnDef;
  schema: Schema;
  index: number;
  chips: ChipStyle;
  /** M12.4b: the column's Wrap content setting — values flow onto extra
   * lines instead of clipping, and the row grows to hold them. */
  wrap?: boolean;
}) {
  const resolved = schema.resolveField(entry, def.name);
  const readOnly = READ_ONLY.has(def.kind);
  const isProgress = def.format === 'progress';

  return (
    <div
      role="gridcell"
      className={[
        'flex flex-none overflow-hidden border-r border-[var(--n-100)] px-2',
        wrap ? 'items-start py-1.5' : 'items-center',
      ].join(' ')}
      style={{ width: `var(${widthVar(index)})` }}
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

const TableRow = memo(function TableRow({
  entry,
  cells,
  autoHeight,
  schema,
  depth,
  childCount,
  collapsed,
  chips,
  onToggle,
  selected,
  onSelect,
}: {
  entry: Entry;
  cells: { def: ColumnDef; wrap: boolean }[];
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
}) {
  // M3.5: route by kind — a Project record opens its page, everything else
  // opens the detail panel. No sidebar special-casing needed.
  // M9.3: in-place — the table IS the context, so opening a row must not
  // navigate to the record's project and discard the view you were reading.
  const openPath = useOpenPath('in-place');
  const style = typeStyle(entry.type, schema);

  return (
    <div
      role="row"
      data-testid="table-row"
      data-path={entry.path}
      data-depth={depth}
      onClick={onSelect}
      // `group` sits on the ROW so hovering anywhere reveals Open, not only
      // over the name cell.
      className={[
        'group flex border-b border-[var(--n-100)]',
        autoHeight ? 'min-h-9' : 'h-9',
        selected ? 'bg-[var(--cortex-50)]' : 'hover:bg-[var(--n-25)]',
      ].join(' ')}
    >
      <div
        role="gridcell"
        className={[
          'sticky left-0 z-10 flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] pr-3',
          selected ? 'bg-[var(--cortex-50)]' : 'bg-[var(--n-0)] group-hover:bg-[var(--n-25)]',
        ].join(' ')}
        style={{ width: `var(${TITLE_VAR})`, paddingLeft: 12 + depth * INDENT }}
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
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--n-900)]">
          {entry.title}
        </span>
        {childCount > 0 && (
          <span className="flex-none [font-family:var(--font-mono)] text-[10.5px] text-[var(--n-400)]">
            {childCount}
          </span>
        )}
        <button
          type="button"
          aria-label={`Open ${entry.title}`}
          onClick={(e) => {
            e.stopPropagation();
            openPath(entry.path);
          }}
          className="hidden flex-none items-center gap-1 rounded-md border border-[var(--n-200)] bg-[var(--n-0)] px-1.5 py-px text-[11px] text-[var(--n-600)] hover:border-[var(--n-400)] group-hover:inline-flex"
        >
          <Icon name="maximize-2" size={10} />
          Open
        </button>
      </div>
      {cells.map(({ def, wrap }, i) => (
        <TableCell
          key={def.name}
          entry={entry}
          def={def}
          schema={schema}
          index={i}
          chips={chips}
          wrap={wrap}
        />
      ))}
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
}: {
  label: string;
  /** Called with each intermediate width — paints, never persists. */
  onDrag: (width: number) => void;
  onCommit: (width: number) => void;
  width: number;
  min: number;
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
  /** M12.4b: opens the property's full configuration surface. */
  onEditProperty?: (field: string) => void;
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
      className="sticky left-0 flex h-8 w-full items-center gap-2 border-b border-[var(--n-100)] bg-[var(--n-25)] text-left"
      style={{ paddingLeft: 12 + node.depth * INDENT, paddingRight: 12 }}
    >
      <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} color="var(--n-400)" />
      <span
        className="box-border h-[10px] w-[10px] flex-none rounded-full"
        style={
          node.ghost || !node.color
            ? { border: '1.5px solid var(--n-400)' }
            : { background: node.color, border: `1.5px solid ${node.color}` }
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
    </button>
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
  sourceType,
  onColumnsChange,
  onPresentationChange,
  onFilterField,
  onEditProperty,
}: {
  def: ColumnDef;
  wrap: boolean;
  columns: ColumnSpec[];
  presentation: Presentation;
  sourceType: string | null;
  onColumnsChange?: (next: ColumnSpec[]) => void;
  onPresentationChange?: (next: Presentation) => void;
  onFilterField?: (field: string) => void;
  onEditProperty?: (field: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [changingKind, setChangingKind] = useState(false);
  const [draft, setDraft] = useState(humanize(def.name));
  const name = humanize(def.name);
  // Schema operations need one agreed-on declaration to edit.
  const canEditSchema = sourceType !== null && def.heterogeneous !== true;

  useEffect(() => {
    if (open) {
      setDraft(humanize(def.name));
      setChangingKind(false);
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
  if (onEditProperty !== undefined && canEditSchema) {
    items.push({ label: 'Edit property', icon: 'settings-2', run: () => onEditProperty(def.name) });
  }
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
  if (onColumnsChange !== undefined) {
    items.push(
      {
        label: 'Wrap content',
        icon: 'wrap-text',
        active: wrap,
        section: true,
        run: () => onColumnsChange(setColumnWrap(columns, def.name)),
      },
      { label: 'Hide column', icon: 'eye-off', run: () => onColumnsChange(toggleColumn(columns, def.name)) },
      { label: 'Move left', icon: 'arrow-left', run: () => onColumnsChange(moveColumn(columns, def.name, -1)) },
      { label: 'Move right', icon: 'arrow-right', run: () => onColumnsChange(moveColumn(columns, def.name, 1)) },
    );
    if (canEditSchema && sourceType !== null) {
      const insert = (side: 'left' | 'right') => {
        void (async () => {
          const created = await insertFieldOnType(sourceType, def.name, side);
          if (created !== null) onColumnsChange(insertColumn(columns, created, def.name, side));
        })();
      };
      items.push(
        { label: 'Insert left', icon: 'arrow-left-to-line', section: true, run: () => insert('left') },
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
        type="button"
        aria-label={`${name} column menu`}
        onClick={() => setOpen(!open)}
        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[11.5px] font-medium text-[var(--n-600)] hover:text-[var(--n-900)]"
      >
        {name}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close column menu"
            onClick={close}
            className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
          />
          <div className="absolute left-0 top-6 z-50 w-[224px] rounded-[9px] border border-[var(--n-200)] bg-[var(--n-0)] p-1 shadow-[var(--shadow-lg)]">
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
              <div className="px-2 pb-1 pt-1 text-[12px] font-medium text-[var(--n-800)]">{name}</div>
            )}
            {canEditSchema && sourceType !== null && (
              <button
                type="button"
                data-testid="change-type"
                onClick={() => setChangingKind(!changingKind)}
                className="flex w-full items-center gap-2 rounded-[6px] border-0 bg-transparent px-2 py-1 text-left text-[12.5px] text-[var(--n-700)] hover:bg-[var(--n-50)]"
              >
                <Icon name="repeat-2" size={12} color="var(--n-500)" />
                <span className="min-w-0 flex-1">Change type</span>
                <span className="flex items-center gap-1 text-[11px] text-[var(--n-400)]">
                  {kindMeta(def.kind).label}
                  <Icon name={changingKind ? 'chevron-down' : 'chevron-right'} size={11} />
                </span>
              </button>
            )}
            {changingKind && sourceType !== null && (
              <div className="mb-1 max-h-[180px] overflow-y-auto rounded-[7px] bg-[var(--n-25)] p-0.5">
                {CREATABLE_PROPERTY_KINDS.filter((k) => !k.computed).map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    data-testid={`change-type-${k.kind}`}
                    onClick={() => {
                      close();
                      void changeFieldKind(sourceType, def.name, k.kind);
                    }}
                    className="flex w-full items-center gap-2 rounded-[6px] border-0 bg-transparent px-2 py-1 text-left text-[12.5px] text-[var(--n-700)] hover:bg-[var(--n-50)]"
                  >
                    <Icon name={k.icon} size={12} color="var(--n-500)" />
                    <span className="min-w-0 flex-1">{k.label}</span>
                    {k.kind === def.kind && <Icon name="check" size={12} color="var(--cortex-600)" />}
                  </button>
                ))}
              </div>
            )}
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  item.run();
                  close();
                }}
                className={[
                  'flex w-full items-center gap-2 rounded-[6px] border-0 bg-transparent px-2 py-1 text-left text-[12.5px] hover:bg-[var(--n-50)]',
                  item.danger === true ? 'text-[var(--danger-600,#c5372c)]' : 'text-[var(--n-700)]',
                  item.section === true ? 'mt-1 border-t border-[var(--n-100)] pt-1.5' : '',
                ].join(' ')}
              >
                <Icon
                  name={item.icon}
                  size={12}
                  color={item.danger === true ? 'var(--danger-600, #c5372c)' : 'var(--n-500)'}
                />
                <span className="min-w-0 flex-1">{item.label}</span>
                {item.active === true && <Icon name="check" size={12} color="var(--cortex-600)" />}
              </button>
            ))}
          </div>
        </>
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
  onEditProperty,
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

  // The width the grid has to fill. Observed rather than read once, because
  // the detail panel opening beside the table changes it (M11 item 2).
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setAvailable(entry.contentRect.width);
    });
    observer.observe(node);
    setAvailable(node.clientWidth);
    return () => observer.disconnect();
  }, []);

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
    const content = titleWidth + base.reduce((sum, w) => sum + w, 0);
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

  // Keyboard traverses the record rows only — bands and the create row are not
  // records, so Enter on them has nothing to open.
  const flatRows = useMemo(() => entryRows(rows), [rows]);
  const keyboard = useRowKeyboard({
    count: flatRows.length,
    onOpen: (i) => openPath(flatRows[i].entry.path),
    onToggle: (i) => {
      if (flatRows[i].childCount > 0) toggleCollapsed(scope, flatRows[i].key);
    },
  });

  const primarySort = presentation.sort[0];
  // M12.4b: wrap rides with each cell; any wrapped column releases the rows
  // from their fixed height.
  const cells = useMemo(
    () => resolved.map((c) => ({ def: c.def, wrap: c.spec.wrap === true })),
    [resolved],
  );
  const anyWrap = useMemo(() => cells.some((c) => c.wrap), [cells]);
  const chips: ChipStyle = presentation.chips ?? 'plain';

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
    <div
      ref={scrollRef}
      data-testid="table-view"
      role="grid"
      className="min-h-0 min-w-0 flex-1 overflow-auto outline-none"
      {...keyboard.containerProps}
    >
      <div
        ref={gridRef}
        style={{ width: layout.total, minWidth: '100%', ...widthVars } as React.CSSProperties}
      >
        <div
          role="row"
          className="sticky top-0 z-20 flex h-8 border-b border-[var(--n-200)] bg-[var(--n-25)]"
        >
          <div
            role="columnheader"
            className="sticky left-0 z-30 flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] bg-[var(--n-25)] px-3 text-[11.5px] font-semibold text-[var(--n-600)]"
            style={{ width: `var(${TITLE_VAR})`, position: 'sticky' }}
          >
            <Icon name="type" size={12} color="var(--n-400)" />
            <span className="min-w-0 flex-1 truncate">Name</span>
            {/* M11: the name column resizes too. It is the widest thing on the
                row and was the one width nobody could change. */}
            {onPresentationChange !== undefined && (
              <ColumnResizer
                label="Name"
                width={layout.title}
                min={MIN_TITLE_W}
                onDrag={(w) => paint(TITLE_VAR, w, w - layout.title)}
                onCommit={commitTitle}
              />
            )}
          </div>
          {resolved.map(({ def, spec }, i) => (
            <div
              key={def.name}
              role="columnheader"
              className="group/header relative flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] px-2 text-[11.5px] font-medium text-[var(--n-600)]"
              style={{ width: `var(${widthVar(i)})` }}
            >
              <Icon name={kindMeta(def.kind).icon} size={12} color="var(--n-400)" />
              {/* M12.4b: the label opens the column menu (Notion's header).
                  Sorting lives inside it now, with an explicit direction. */}
              <HeaderMenu
                def={def}
                wrap={spec.wrap === true}
                columns={presentation.columns}
                presentation={presentation}
                sourceType={sourceType ?? null}
                onColumnsChange={onColumnsChange}
                onPresentationChange={onPresentationChange}
                onFilterField={onFilterField}
                onEditProperty={onEditProperty}
              />
              {def.heterogeneous === true && (
                <span
                  title="Declared with different kinds across the types in this view"
                  className="flex-none text-[var(--warn-500)]"
                >
                  <Icon name="triangle-alert" size={10} />
                </span>
              )}
              {primarySort?.field === def.name && (
                <Icon
                  name={primarySort.dir === 'asc' ? 'arrow-up' : 'arrow-down'}
                  size={11}
                  color="var(--cortex-600)"
                />
              )}
              {onColumnsChange !== undefined && (
                <ColumnResizer
                  label={humanize(def.name)}
                  width={layout.columns[i]}
                  min={MIN_COL_W}
                  onDrag={(w) => paint(widthVar(i), w, w - layout.columns[i])}
                  onCommit={(w) => commitColumn(def.name, w)}
                />
              )}
            </div>
          ))}
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
              <div key={row.key} className="sticky left-0" style={{ width: `var(${TITLE_VAR})` }}>
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
              </div>
            );
          }
          const index = flatRows.indexOf(row);
          return (
            <TableRow
              key={row.key}
              entry={row.entry}
              cells={cells}
              autoHeight={anyWrap}
              schema={schema}
              depth={row.depth}
              childCount={row.childCount}
              collapsed={collapsedMap?.[row.key] === true}
              chips={chips}
              onToggle={() => toggleCollapsed(scope, row.key)}
              selected={index === keyboard.index}
              onSelect={() => keyboard.setIndex(index)}
            />
          );
        })}

        {entries.length === 0 && (
          <div className="sticky left-0 px-3 py-8">
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
  );
}
