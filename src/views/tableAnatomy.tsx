import { Icon } from '@/components/ui/Icon';
import type { RowHeight } from '@/engine/types';
import { resolveOptionColor } from '@/lib/swatch';

/**
 * The table's anatomy, spelled once (M52.5): header row, header cells, row,
 * gutter, cell, the name cell, its title and its Open pill, a select's value
 * and the group band. `TableView` renders from these, and so does the one
 * table that is not a view of a type — Knowledge's concept
 * list (`knowledge/ConceptTable.tsx`), which the owner asked to look exactly
 * like a view's table. Two spellings of the same row would drift by the next
 * milestone; one cannot.
 *
 * Classes, and the two pieces drawn whole (a select's value, a band). The
 * behaviour around them — the cursor, the drag, the frozen run, the editors —
 * stays `TableView`'s own.
 */
export const TABLE_ANATOMY = {
  headerRow: 'group/head sticky top-0 z-20 flex h-8 border-b border-n-200 bg-n-25',
  /** The name column's header: a step heavier than the rest, and opaque. */
  titleHeader:
    'group/header flex flex-none items-center gap-1.5 border-r border-n-100 bg-n-25 px-3 text-xs font-semibold text-n-600',
  header:
    'group/header flex flex-none items-center gap-1.5 border-r border-n-100 px-2 text-xs font-medium text-n-600',
  row: 'group cb-row flex border-b border-n-100',
  /** The cursor row. The --cortex-50 fill alone is 1.13:1 on white, so a
   * left rule carries it. */
  rowSelected: 'bg-cortex-50 shadow-[inset_2px_0_0_var(--cortex-500)]',
  rowHover: 'hover:bg-n-25',
  cell: 'flex flex-none overflow-hidden border-r border-n-100 px-2',
  /** A read-only value, and the clamp that keeps it to one line. */
  value: 'text-sm text-n-600',
  oneLine: 'truncate whitespace-nowrap',
  /** Wrap content (M12.4b): a cell's text breaks onto as many lines as it
   * needs, and the row (`ROW_MIN_HEIGHT`) grows to hold them. A word too
   * long for the column breaks rather than running under the next one. */
  wrap: 'whitespace-normal [overflow-wrap:anywhere]',
  /** A wrapped value's cell: its lines start at the top, padded off the
   * row's rules. */
  wrapCell: 'items-start py-1.5',
  titleCell: 'flex flex-none items-center gap-1.5 border-r border-n-100 pr-3',
  title:
    'min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-sm text-n-900 focus-visible:rounded-sm focus-visible:shadow-[var(--ring)] focus-visible:outline-none',
  /** The row's Open pill (M19.3). `cb-row-open` keeps it laid out and fades
   * it in on the row's hover and focus (`styles/table-chrome.css`). */
  openPill:
    'cb-row-open flex-none rounded-sm border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-[0.04em] text-n-500 hover:bg-n-50 hover:text-n-800',
  /** A single select's value as a cell draws it (M52.5): a coloured dot and a
   * 13px label, no pill — FieldEditor's select button, without the button.
   * The padding is the button's, so a read-only value sits where an editable
   * one does. */
  selectValue:
    'inline-flex min-w-0 max-w-full items-center gap-1 px-2 py-[3px] text-left text-sm text-n-800',
  selectDot: 'box-border h-[9px] w-[9px] flex-none rounded-full',
} as const;

/** The name cell's left padding, before any nesting indent. */
export const TITLE_INSET = 12;

/**
 * Width of a row's leading gutter (M16.16), wide enough for insert + checkbox
 * + grip. It is laid out on every row rather than inserted on hover: a
 * control that pushes the whole grid 46px sideways under the pointer is worse
 * than one that was always there and only faded in.
 *
 * A table with nothing to put there reserves it all the same (M52.5), so a
 * row's title starts where a view's does and switching between them does not
 * move the column you were reading.
 */
export const GUTTER = 46;

/**
 * One select value, read-only: `selectValue`'s dot and label. `strong` sets
 * the label in medium weight — the one emphasis a row that needs its reader
 * gets, never a fill.
 */
export function SelectValue({
  color,
  label,
  strong = false,
  title,
  testId,
  data,
}: {
  /** A CSS colour for the dot. */
  color: string;
  label: string;
  strong?: boolean;
  title?: string;
  testId?: string;
  data?: Record<string, string>;
}) {
  return (
    <span
      data-testid={testId}
      title={title}
      {...data}
      className={`${TABLE_ANATOMY.selectValue} ${strong ? 'font-medium' : ''}`}
    >
      <span className={TABLE_ANATOMY.selectDot} style={{ background: color }} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

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
export const ROW_HEIGHT: Record<RowHeight, string> = {
  compact: 'h-8',
  default: 'h-9',
  tall: 'h-12',
};
export const ROW_MIN_HEIGHT: Record<RowHeight, string> = {
  compact: 'min-h-8',
  default: 'min-h-9',
  tall: 'min-h-12',
};

/**
 * The band itself — chevron, dot, name, count — as props rather than a
 * `GroupNode`, so a table that is not a view of a type can group under the
 * same header (M52.5: Knowledge files concepts under their folders with it).
 *
 * `onOpen` makes the name a way into the group, for a group that is also a
 * place; a view's bands are not, and pass nothing.
 */
export function GroupBand({
  label,
  count,
  color,
  depth = 0,
  collapsed,
  onToggle,
  onOpen,
  inset,
  note,
  testId = 'table-group-header',
}: {
  label: string;
  count: number;
  /** An option colour, or null for the hollow dot of a group with none. */
  color: string | null;
  depth?: number;
  collapsed: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  /** Where the cluster starts: the gutter plus the depth indent. */
  inset: number;
  /** A quiet line after the count, for a band that heads a list of its own
   * rather than a group of a view's. */
  note?: string;
  testId?: string;
}) {
  // Beside a note, the name and count hold their width and the note is what
  // truncates.
  const hold = note === undefined ? '' : ' flex-none whitespace-nowrap';
  const labelClass =
    (depth === 0 ? 'text-sm font-semibold text-n-800' : 'text-xs font-medium text-n-700') + hold;
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
      data-testid={testId}
      data-depth={depth}
      // M20.5: sticky under the column header, offset by depth so a nested
      // band parks below its parent instead of on top of it — ListView has
      // done this since M10, and without it you scroll into a run of rows with
      // nothing on screen saying which band you are in. `top-8` is the header
      // row's own height.
      className="sticky z-[15] flex h-8 w-full items-center border-b border-n-100 bg-n-25 text-left"
      style={{ top: 32 + depth * 32 }}
    >
      {/* The band spans the full scroll width, so the band itself cannot be
          sticky (a sticky box as wide as its container has no room to shift).
          The label cluster is the sticky part instead. */}
      <span
        role="gridcell"
        className={`sticky left-0 flex items-center gap-2 pr-3 ${note === undefined ? '' : 'min-w-0'}`}
        style={{ paddingLeft: inset }}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
          onClick={onToggle}
          className="flex h-4 w-4 flex-none items-center justify-center rounded-xs border-0 bg-transparent p-0 text-n-400 hover:bg-n-100 hover:text-n-800"
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        </button>
        <span
          className="box-border h-[10px] w-[10px] flex-none rounded-full"
          style={
            color === null || color === ''
              ? { border: '1.5px solid var(--n-400)' }
              : {
                  background: resolveOptionColor(color).solid,
                  border: `1.5px solid ${resolveOptionColor(color).solid}`,
                }
          }
        />
        {onOpen === undefined ? (
          <span className={labelClass}>{label}</span>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            className={`${labelClass} border-0 bg-transparent p-0 underline-offset-2 hover:underline`}
          >
            {label}
          </button>
        )}
        <span className={`[font-family:var(--font-mono)] text-2xs text-n-400${hold}`}>{count}</span>
        {note !== undefined && <span className="min-w-0 truncate text-xs text-n-500">{note}</span>}
      </span>
    </div>
  );
}
