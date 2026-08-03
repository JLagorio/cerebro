import { resolveOptionColor } from '@/lib/swatch';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { useOpenPath } from '@/app/useOpenPath';
import { QuickAddInline } from '@/views/QuickAdd';
import { EmptyState } from '@/components/ui/EmptyState';
import { FieldChip } from '@/views/FieldChip';
import { Icon } from '@/components/ui/Icon';
import { groupTree } from '@/engine/grouping';
import { visibleColumns } from '@/engine/views';
import { formatWikilink } from '@/engine/wikilink';
import { bandLevels } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type {
  CardSize,
  Entry,
  FieldKind,
  GroupNode,
  GroupSpec,
  Presentation,
  Scalar,
  Schema,
} from '@/engine/types';

export interface BoardViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** Collapse-state namespace for swimlanes (M9.1). */
  scope?: string;
  /**
   * True when the view has filters, so the empty state can say why.
   *
   * Not optional (M16.35). It was, and ViewCanvas's `board` arm never passed
   * it — so the branch below was dead code for the entire life of the prop and
   * a filtered-empty board claimed the collection was empty. The compiler is
   * the only thing that catches a dropped prop; leaving it optional means the
   * next arm to forget also fails silently.
   */
  filtered: boolean;
  /** M9.6: create a card in a column, inheriting its value. */
  onCreate?: (title: string, band: { groupBy: string; groupValue: string }) => Promise<boolean>;
}

/** The key `groupEntries` pins the "No <field>" bucket under (see types.ts). */
const NO_VALUE_KEY = '__none__';

/**
 * What each card size means, in one place (M16.20).
 *
 * Column width and card density move together on purpose: a 240px column
 * with 14px type and 12px padding fits two words per line, so choosing "Small
 * cards" and getting wide columns of cramped text would be the wrong half of
 * the decision.
 */
const CARD_METRICS: Record<
  CardSize,
  { column: number; pad: string; title: string; clamp: string }
> = {
  small: {
    column: 240,
    pad: 'px-2.5 py-1.5',
    title: 'text-[12.5px] leading-[17px]',
    clamp: 'line-clamp-1',
  },
  medium: {
    column: 280,
    pad: 'px-[11px] py-[9px]',
    title: 'text-[13px] leading-[18px]',
    clamp: 'line-clamp-2',
  },
  large: {
    column: 320,
    pad: 'px-3.5 py-3',
    title: 'text-[14px] leading-[20px]',
    clamp: 'line-clamp-3',
  },
};

/**
 * One drop target: a column, inside a lane when the board sub-groups.
 *
 * A column used to be identified by its group KEY, which stops being unique
 * the moment sub-grouping is on — every lane has a "Doing". dnd-kit keys its
 * droppable registry by id (`DroppableContainersMap extends Map`), so N lanes
 * registered N columns under one id and all but one quietly stopped being a
 * drop target at all. `path` — the chain of keys `groupTree` already builds
 * for exactly this reason — is unique per node.
 */
export interface BoardColumnNode {
  /** Unique node identity, and therefore the droppable id. */
  path: string;
  /** The value a card lands on when dropped here. */
  key: string;
  label: string;
  color: string | null;
  ghost: boolean;
  entries: Entry[];
  /** The lane this column sits in; null on a board with no sub-grouping. */
  lane: { field: string; key: string; label: string } | null;
}

/** GroupNodes from one level of the tree, as drop targets in `lane`. */
function toColumns(nodes: GroupNode[], lane: BoardColumnNode['lane']): BoardColumnNode[] {
  return nodes.map((n) => ({
    path: n.path,
    key: n.key,
    label: n.label,
    color: n.color,
    ghost: n.ghost,
    entries: n.entries,
    lane,
  }));
}

/**
 * The kind of the field a band groups by.
 *
 * Resolved the way `groupEntries` resolves it — the FIRST entry that declares
 * the field wins — rather than off `entries[0]`, which is what the board did.
 * On a heterogeneous board (a Collection holds more than one type) the first
 * card is routinely of a type that does not declare the grouped field at all,
 * so the kind came back `undefined` and every write the board made through it
 * took the wrong branch: a person column wrote a bare stem where a wikilink
 * belongs, and the field stopped being a relationship at the next rescan.
 */
export function bandKind(entries: Entry[], field: string, schema: Schema): FieldKind | undefined {
  for (const e of entries) {
    const def = schema.resolveField(e, field).def;
    if (def !== null) return def.kind;
  }
  return undefined;
}

/**
 * The frontmatter value that moves a record into `key`'s bucket of a field.
 *
 * `null` deletes the key — that is what the "No <field>" column means.
 * `undefined` means a drag cannot express this move at all.
 */
function bandValue(key: string, kind: FieldKind | undefined): Scalar | undefined {
  if (key === NO_VALUE_KEY) return null;
  // A multi-select record sits in several columns at once; writing one scalar
  // would silently delete every other value it holds. Refuse until a real
  // add/remove treatment exists (M1.x interim).
  if (kind === 'multiselect') return undefined;
  // Person/relation columns key by the wikilink STEM, so a bare-stem write
  // destroys the link on disk (the field leaves `relationships` after a
  // rescan). Wrap those back up (execution-log note 18).
  return kind === 'person' || kind === 'relation' ? formatWikilink(key) : key;
}

export function handleDragEnd(
  event: DragEndEvent,
  args: {
    groupBy: string;
    /** Every column on the board, across every lane. */
    columns: BoardColumnNode[];
    schema: Schema;
    patchFrontmatter: (path: string, patch: Record<string, unknown>) => Promise<void>;
    toast: (message: string) => void;
  },
): void {
  const { active, over } = event;
  if (!over) return;
  const path = String(active.id);
  const target = args.columns.find((c) => c.path === String(over.id));
  if (target === undefined) return;
  const source = args.columns.find((c) => c.entries.some((e) => e.path === path));
  if (source !== undefined && source.path === target.path) return;

  const dragged = source?.entries.find((e) => e.path === path);
  const kindOf = (field: string): FieldKind | undefined =>
    dragged === undefined ? undefined : args.schema.resolveField(dragged, field).def?.kind;

  const patch: Record<string, unknown> = {};
  if (source === undefined || source.key !== target.key) {
    const value = bandValue(target.key, kindOf(args.groupBy));
    if (value === undefined) {
      args.toast("Can't move cards grouped by a multi-select field");
      return;
    }
    patch[args.groupBy] = value;
  }
  // Sub-grouping: a lane is the SECOND band level, so a card dropped in
  // another lane has changed two values, not one. Writing only the column's
  // left the card visibly snapping back into the lane it came from.
  const lane = target.lane;
  if (lane !== null && source?.lane?.key !== lane.key) {
    const value = bandValue(lane.key, kindOf(lane.field));
    if (value === undefined) {
      args.toast("Can't move cards grouped by a multi-select field");
      return;
    }
    patch[lane.field] = value;
  }
  if (Object.keys(patch).length === 0) return;

  void args.patchFrontmatter(path, patch);
  args.toast(
    `Moved to ${lane !== null && source?.lane?.key !== lane.key ? `${lane.label} · ${target.label}` : target.label}`,
  );
}

function BoardCard({
  entry,
  column,
  presentation,
  schema,
  bandFields,
}: {
  entry: Entry;
  column: BoardColumnNode;
  presentation: Presentation;
  schema: Schema;
  /** The fields the board itself bands by — the column axis, and the lane's. */
  bandFields: string[];
}) {
  // M9.3: one open rule across all four layouts (see useOpenPath).
  const openPath = useOpenPath('in-place');
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: entry.path,
  });
  const dragKeyDown = listeners?.onKeyDown as ((e: React.KeyboardEvent) => void) | undefined;
  const key = typeof entry.properties.key === 'string' ? entry.properties.key : '';
  const metrics = CARD_METRICS[presentation.cardSize ?? 'medium'];
  // M16.19: the card shows what the view says it shows. It used to resolve
  // `priority` and `assignee` by NAME, so the shared Properties page — the eye
  // toggles every other layout obeys — was a visible no-op here, and a vault
  // whose fields are called something else got a card with nothing on it.
  // `key` keeps its own gutter slot, exactly as a list row does, and the
  // fields the board BANDS by are left off: the column header and the lane
  // heading already state them, so repeating them once per card is the same
  // word printed N times down a column. Notion's board omits them too.
  const chips = visibleColumns(presentation)
    .filter((c) => c.field !== 'key' && !bandFields.includes(c.field))
    .map((c) => ({ field: c.field, resolved: schema.resolveField(entry, c.field) }))
    .filter((c) => c.resolved.display !== '');

  return (
    <div
      ref={setNodeRef}
      data-testid="board-card"
      data-path={entry.path}
      {...listeners}
      {...attributes}
      onClick={() => openPath(entry.path)}
      // dnd-kit's `attributes` stamp role="button" and tabIndex=0 on this div,
      // so the card advertises itself as a button and takes focus — but a
      // <div role="button"> gets no native Enter/Space activation, and onClick
      // was the only handler. The card was a dead focus stop. Space is left to
      // the drag sensor.
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          openPath(entry.path);
          return;
        }
        // Everything else (Space to pick up, arrows to move, Escape) belongs
        // to the keyboard drag sensor, whose own handler this prop shadows.
        dragKeyDown?.(e);
      }}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        borderLeft: `3px solid ${
          column.ghost || !column.color ? 'var(--n-300)' : resolveOptionColor(column.color).solid
        }`,
        opacity: isDragging ? 0.6 : 1,
        zIndex: isDragging ? 20 : undefined,
      }}
      className={`relative cursor-pointer rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] shadow-[var(--shadow-xs)] hover:border-[var(--n-300)] hover:shadow-[var(--shadow-sm)] ${metrics.pad}`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span
          data-testid="card-key"
          className="[font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]"
        >
          {key}
        </span>
      </div>
      <div className={`font-medium text-[var(--n-900)] ${metrics.title}`}>{entry.title}</div>
      {/* M16.20: Notion's "Card preview › Page content". `Entry.snippet` has
          been produced by the scanner since v1 and, outside the Inbox
          queue's rows, rendered nowhere. */}
      {presentation.cardPreview === 'content' && entry.snippet !== '' && (
        <p
          data-testid="card-preview"
          className={`m-0 mt-1 text-[11.5px] leading-[16px] text-[var(--n-500)] ${metrics.clamp}`}
        >
          {entry.snippet}
        </p>
      )}
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          {chips.map((c) => (
            <FieldChip key={c.field} resolved={c.resolved} />
          ))}
        </div>
      )}
    </div>
  );
}

function BoardColumn({
  column,
  presentation,
  schema,
  groupBy,
  groupKind,
  bandFields,
  onCreate,
}: {
  column: BoardColumnNode;
  presentation: Presentation;
  schema: Schema;
  groupBy: string;
  /** Kind of the field the columns band by — decides how the column's value is
   * written when a card is created in it. */
  groupKind?: FieldKind;
  bandFields: string[];
  onCreate?: (title: string, band: { groupBy: string; groupValue: string }) => Promise<boolean>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.path });
  const metrics = CARD_METRICS[presentation.cardSize ?? 'medium'];
  // M16.20 — Notion's "Color columns". A ghost or uncoloured column gets the
  // neutral tint rather than nothing: half a board painted and half of it
  // transparent reads as a rendering fault, not as a setting.
  const tinted = presentation.colorColumns === true;
  // `resolveOptionColor` answers neutral for a ghost or uncoloured column, so
  // the tint is never a hex with an alpha suffix glued on (the M16.12 bug).
  const tint = column.ghost ? 'var(--n-100)' : resolveOptionColor(column.color).tint;

  return (
    <div
      data-testid="board-column"
      data-group-key={column.key}
      // The droppable id, exposed so a test can prove the board never
      // registers two of them under one id (see BoardColumnNode).
      data-column-path={column.path}
      className="flex-none"
      style={{ width: metrics.column }}
    >
      <div className="flex items-center gap-[7px] px-1 pb-[9px]">
        <span
          className="box-border h-2.5 w-2.5 rounded-full"
          style={
            column.ghost || !column.color
              ? { border: '1.5px solid var(--n-400)' }
              : {
                  background: resolveOptionColor(column.color).solid,
                  border: `1.5px solid ${resolveOptionColor(column.color).solid}`,
                }
          }
        />
        <span className="text-[12.5px] font-semibold text-[var(--n-800)]">{column.label}</span>
        <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
          {column.entries.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        data-tinted={tinted ? 'true' : undefined}
        className={`flex min-h-[60px] flex-col gap-2 rounded-[10px] ${tinted ? 'p-1.5' : 'p-0.5'}`}
        style={{
          background: isOver ? 'var(--cortex-50)' : tinted ? tint : 'transparent',
        }}
      >
        {column.entries.map((e) => (
          <BoardCard
            key={e.path}
            entry={e}
            column={column}
            presentation={presentation}
            schema={schema}
            bandFields={bandFields}
          />
        ))}
        {/* M9.6: creating here presets the column's own value, so a card
            lands in the column you pressed rather than in triage. */}
        {onCreate !== undefined && (
          <QuickAddInline
            compact
            label="New"
            ariaLabel={`New record in ${column.label}`}
            onCreate={(title) => {
              // The create path writes the band value verbatim, so it needs
              // the same wikilink wrapping a drop does. The no-value column
              // and a refused kind both mean "inherit nothing".
              const value = bandValue(column.key, groupKind);
              return onCreate(title, {
                groupBy,
                groupValue: typeof value === 'string' ? value : '',
              });
            }}
          />
        )}
      </div>
    </div>
  );
}

/** A sub-group band: one horizontal strip of columns under its own heading.
 * This is Notion's board sub-grouping, and it falls straight out of the
 * grouping chain — `group[0]` is the columns, `group[1]` is the swimlane. */
function Swimlane({
  label,
  count,
  scope,
  path,
  children,
}: {
  label: string;
  count: number;
  scope: string;
  path: string;
  children: React.ReactNode;
}) {
  const collapsed = useUiStore((s) => s.collapsed[scope]?.[path] === true);
  const toggle = useUiStore((s) => s.toggleCollapsed);
  return (
    <section data-testid="board-swimlane" className="mb-4">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => toggle(scope, path)}
        className="mb-2 inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-[12.5px] font-semibold text-[var(--n-800)] hover:bg-[var(--n-100)]"
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        {label}
        <span className="[font-family:var(--font-mono)] text-[11px] font-normal text-[var(--n-400)]">
          {count}
        </span>
      </button>
      {!collapsed && children}
    </section>
  );
}

export function BoardView({
  entries,
  presentation,
  schema,
  scope = 'board',
  filtered,
  onCreate,
}: BoardViewProps) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const toast = useUiStore((s) => s.toast);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Moving a card between columns is the board's entire purpose and was
    // pointer-only. Space picks up and drops (Enter stays the card's open
    // gesture), arrows move, Escape cancels.
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );

  // A board's columns are a BAND level. `presentation.group[0]` was read
  // blindly, so a chain that starts with a relation — a nest level, which
  // bands nothing — silently became the column axis and the board grouped by
  // a field it was never asked to group by.
  const bands = bandLevels(presentation.group);
  const columnSpec: GroupSpec = bands[0] ?? { field: 'status' };
  const laneSpec = bands[1];
  const groupBy = columnSpec.field;

  const parseable = entries.filter((e) => e.parseError === null);
  const hiddenCount = entries.length - parseable.length;

  // M16.19: `groupTree`, not `groupEntries`. The engine honours `dir` and
  // `hideEmpty` per level (grouping.ts:135,140) and the board called straight
  // past both — so the Group page's direction toggle wrote the view file and
  // then changed nothing on screen.
  //
  // An empty SWIMLANE is a full-width strip of empty columns rather than one
  // more column, so lanes default to hiding themselves when empty — which is
  // what the board already did, unconditionally, before this.
  const tree = groupTree(
    parseable,
    laneSpec === undefined
      ? [columnSpec]
      : [{ ...laneSpec, hideEmpty: laneSpec.hideEmpty ?? true }, columnSpec],
    schema,
  );
  const lanes =
    laneSpec === undefined
      ? null
      : tree.map((lane) => ({
          lane,
          columns: toColumns(lane.children, {
            field: laneSpec.field,
            key: lane.key,
            label: lane.label,
          }),
        }));
  const columns = lanes === null ? toColumns(tree, null) : lanes.flatMap((l) => l.columns);

  // One resolution for the whole board: every column bands by the same field,
  // and an empty column has no entry of its own to resolve it from.
  const groupKind = bandKind(parseable, groupBy, schema);
  const bandFields = laneSpec === undefined ? [groupBy] : [groupBy, laneSpec.field];

  return (
    // Deviation from the plan's verbatim root (reported): the shared contract
    // requires data-testid="board-view" on the root (the plan's block omitted
    // it), and — as adjudicated for ListView — ProjectPage/App provide no
    // scrolling ancestor (App is overflow-hidden), so the root swaps the
    // plan's min-h-full for the placeholder's scroll-container classes.
    <div
      data-testid="board-view"
      className="box-border min-h-0 min-w-0 flex-1 overflow-auto bg-[var(--n-25)] px-5 py-4"
    >
      {columns.length === 0 ? (
        // Fix (execution-log note 17a): groupEntries([], …) returns [] — an
        // empty project rendered a blank canvas with no columns and no empty
        // state. M16.19: and a board emptied by its own FILTERS said "No items
        // yet", which reads as "this collection is empty" and sent people
        // looking for the records instead of for the filter.
        <EmptyState
          icon="square-kanban"
          title={filtered ? 'Nothing matches these filters' : 'No items yet'}
          description={
            filtered
              ? 'Adjust the filters in view settings to widen the query.'
              : 'Create an item to see it here as a card.'
          }
        />
      ) : (
        <DndContext
          sensors={sensors}
          onDragEnd={(event) =>
            handleDragEnd(event, { groupBy, columns, schema, patchFrontmatter, toast })
          }
        >
          {lanes === null ? (
            <div className="flex items-start gap-3 overflow-x-auto">
              {columns.map((c) => (
                <BoardColumn
                  key={c.path}
                  column={c}
                  presentation={presentation}
                  schema={schema}
                  groupBy={groupBy}
                  groupKind={groupKind}
                  bandFields={bandFields}
                  onCreate={onCreate}
                />
              ))}
            </div>
          ) : (
            lanes.map(({ lane, columns: laneColumns }) => (
              <Swimlane
                key={lane.path}
                label={lane.label}
                count={lane.count}
                scope={scope}
                path={lane.path}
              >
                <div className="flex items-start gap-3 overflow-x-auto">
                  {laneColumns.map((c) => (
                    <BoardColumn
                      key={c.path}
                      column={c}
                      presentation={presentation}
                      schema={schema}
                      groupBy={groupBy}
                      groupKind={groupKind}
                      bandFields={bandFields}
                      onCreate={onCreate}
                    />
                  ))}
                </div>
              </Swimlane>
            ))
          )}
        </DndContext>
      )}
      {hiddenCount > 0 && (
        <div className="pt-3 text-[12px] text-[var(--n-400)]">
          {hiddenCount} unparseable item{hiddenCount === 1 ? '' : 's'} hidden
        </div>
      )}
    </div>
  );
}
