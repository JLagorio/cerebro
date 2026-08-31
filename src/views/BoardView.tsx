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
import type { CollisionDetection, DragEndEvent } from '@dnd-kit/core';
import { useOpenPath } from '@/app/useOpenPath';
import { useDndGesture } from '@/hooks/useDragGesture';
import { DragGhostLayer, InsertionLine } from '@/components/ui/BlockDrag';
import { alongX, resolveDropTarget } from '@/hooks/dropPartition';
import { QuickAddInline } from '@/views/QuickAdd';
import { EmptyState } from '@/components/ui/EmptyState';
import { FieldChip } from '@/views/FieldChip';
import { Icon } from '@/components/ui/Icon';
import { bandValueFor, groupTree } from '@/engine/grouping';
import { visibleColumns } from '@/engine/views';
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
    title: 'text-sm leading-[17px]',
    clamp: 'line-clamp-1',
  },
  medium: {
    column: 280,
    pad: 'px-[11px] py-[9px]',
    title: 'text-sm leading-[18px]',
    clamp: 'line-clamp-2',
  },
  large: {
    column: 320,
    pad: 'px-3.5 py-3',
    title: 'text-md leading-[20px]',
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

/** One column as the resolver sees it: an axis-aligned box and the lane it
 * belongs to. `DOMRect` and dnd-kit's `ClientRect` both satisfy the rect. */
export interface BoardTarget {
  id: string;
  /** The swimlane's key, or `''` on a board with no sub-grouping. */
  lane: string;
  rect: { top: number; bottom: number; left: number; right: number };
}

/**
 * Which column a card drag is pointing at (M46.2 Task 5) — `dropPartition`'s
 * rule applied once per axis, because a board's targets are laid out in two
 * dimensions.
 *
 * The defect it closes is the one the baseline measured on the canvas
 * (§D7/D9), latent here for a different reason. dnd-kit's default
 * `rectIntersection` scores a target by how much the DRAGGED rect overlaps
 * it, so on a board the winner was decided by where the card's own box had
 * got to rather than by where the user was pointing — a 280px card and 280px
 * columns put those up to 140px apart, and on a sub-grouped board the same
 * rule let a card whose box straddled two lanes land in the wrong one.
 *
 * The partition instead, in two stages, each a column of siblings on one axis:
 *
 * 1. the swimlanes partition Y — a lane is its columns' rects taken together,
 *    so the vertical gap between two lanes still belongs to one of them;
 * 2. inside the resolved lane, the columns partition X, and the flip between
 *    two neighbours is the midpoint of their centres — the middle of the gap
 *    they share, which is Notion's above/below rule read sideways (§C-II.4).
 *
 * Off the ends is still nothing, as everywhere else this rule is spent:
 * carrying a card past the last column and letting go commits no move.
 */
export function resolveBoardColumn(
  point: { x: number; y: number },
  targets: BoardTarget[],
): string | null {
  const lanes = new Map<string, BoardTarget[]>();
  for (const t of targets) {
    const held = lanes.get(t.lane);
    if (held === undefined) lanes.set(t.lane, [t]);
    else held.push(t);
  }
  const laneAt = resolveDropTarget(
    point.y,
    [...lanes].map(([id, members]) => ({
      id,
      rect: {
        top: Math.min(...members.map((m) => m.rect.top)),
        bottom: Math.max(...members.map((m) => m.rect.bottom)),
      },
    })),
  );
  if (laneAt === null) return null;
  return resolveDropTarget(
    point.x,
    (lanes.get(laneAt) ?? []).map((m) => ({ id: m.id, rect: alongX(m.rect) })),
  );
}

/**
 * `resolveBoardColumn` as dnd-kit's collision detection.
 *
 * The POINTER decides, and falls back to the centre of the rect being moved
 * only for a keyboard drag, which reports no pointer at all. That fallback is
 * not the primary here the way it is on the dashboard: what a dashboard drags
 * is a 16x24 grip whose centre is the pointer to within a few pixels, and what
 * a board drags is the whole card.
 */
export const boardCollision: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
  pointerCoordinates,
}) => {
  const targets: BoardTarget[] = [];
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (rect === undefined) continue;
    const lane: unknown = container.data.current?.lane;
    targets.push({ id: String(container.id), lane: typeof lane === 'string' ? lane : '', rect });
  }
  const hit = resolveBoardColumn(
    pointerCoordinates ?? {
      x: collisionRect.left + collisionRect.width / 2,
      y: collisionRect.top + collisionRect.height / 2,
    },
    targets,
  );
  return hit === null ? [] : [{ id: hit }];
};

export function handleDragEnd(
  event: DragEndEvent,
  args: {
    groupBy: string;
    /** Every column on the board, across every lane. */
    columns: BoardColumnNode[];
    schema: Schema;
    patchFrontmatter: (path: string, patch: Record<string, unknown>) => Promise<unknown>;
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
    const value = bandValueFor(target.key, kindOf(args.groupBy));
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
    const value = bandValueFor(lane.key, kindOf(lane.field));
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
  const { attributes, listeners, setNodeRef } = useDraggable({
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
      /**
       * What `DragGhostLayer` clones (M46.2 Task 5, reference §C-II.2).
       *
       * The card used to be its own ghost: the REAL element translated at 1:1
       * pointer delta while dimming to `opacity: 0.6` under a `z-index: 20`
       * lift, so the thing under the cursor was a 60%-opaque original and the
       * place it came from was an empty hole. That is neither of Notion's two
       * grammars — it crosses C-I's mechanism with a bad ghost — and the
       * baseline named it a third one (§D2/D3). A card moving between columns
       * is a block move, so it takes C-II: the card stays exactly where it is
       * at full strength, and a 40% copy of it follows the cursor.
       */
      data-drag-id={entry.path}
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
        borderLeft: `3px solid ${
          column.ghost || !column.color ? 'var(--n-300)' : resolveOptionColor(column.color).solid
        }`,
      }}
      className={`relative cursor-pointer rounded-lg border border-n-200 bg-n-0 shadow-[var(--shadow-xs)] hover:border-n-300 hover:shadow-[var(--shadow-sm)] ${metrics.pad}`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span data-testid="card-key" className="[font-family:var(--font-mono)] text-2xs text-n-400">
          {key}
        </span>
      </div>
      <div className={`font-medium text-n-900 ${metrics.title}`}>{entry.title}</div>
      {/* M16.20: Notion's "Card preview › Page content". `Entry.snippet` has
          been produced by the scanner since v1 and, outside the Inbox
          queue's rows, rendered nowhere. */}
      {presentation.cardPreview === 'content' && entry.snippet !== '' && (
        <p
          data-testid="card-preview"
          className={`m-0 mt-1 text-xs leading-[16px] text-n-500 ${metrics.clamp}`}
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
  bandFields,
  onCreate,
}: {
  column: BoardColumnNode;
  presentation: Presentation;
  schema: Schema;
  groupBy: string;
  bandFields: string[];
  onCreate?: (title: string, band: { groupBy: string; groupValue: string }) => Promise<boolean>;
}) {
  const { setNodeRef } = useDroppable({
    id: column.path,
    // Which swimlane this column sits in, so `boardCollision` can partition Y
    // by lane before it partitions X by column. Carried as data rather than
    // parsed back out of `column.path`: the path's shape is `groupTree`'s
    // business and a key may contain anything a frontmatter value may.
    data: { lane: column.lane?.key ?? '' },
  });
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
      ref={setNodeRef}
      data-testid="board-column"
      data-group-key={column.key}
      // The droppable id, exposed so a test can prove the board never
      // registers two of them under one id (see BoardColumnNode).
      data-column-path={column.path}
      className="relative flex-none"
      style={{ width: metrics.column }}
    >
      {/* The drop indicator (M46.2 Task 5), replacing a 280 x 2040px wash of
          `--cortex-50` at full opacity with the reference's measured COLUMN
          variant (§C-II.3): 4px wide, full height, on the target's leading
          edge, accent at 43%, radius 0, `z-index: 88`, cross-fading against
          the column being left over the same `motion-move`.

          It is a child of the column and not of a card, and that is a claim
          about what a board drop DECIDES. A card's only stored position is
          which band it is in: `handleDragEnd` writes the column's field (and
          the lane's), and the rank inside a column is the view's own sort
          chain — `groupEntries` preserves the caller's order and the caller
          sorted (`grouping.ts`, `surface.ts:sortEntries`). There is no
          per-card index to write, exactly as there is none for table rows
          (`TableView.tsx:451`), and minting one is a schema decision rather
          than a drag-polish one. So a line hung between two cards would draw
          a rank the drop cannot honour — the card would land wherever the
          sort put it — and a mark that names the column is the whole truth
          about where the card is going. It is also why the empty column and
          the space below the last card need no special case: the column IS
          the target, cards or not, and it lights identically either way. */}
      <InsertionLine gap={column.path} side="start" />
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
        <span className="text-sm font-semibold text-n-800">{column.label}</span>
        <span className="[font-family:var(--font-mono)] text-2xs text-n-400">
          {column.entries.length}
        </span>
      </div>
      <div
        data-tinted={tinted ? 'true' : undefined}
        className={`flex min-h-[60px] flex-col gap-2 rounded-lg ${tinted ? 'p-1.5' : 'p-0.5'}`}
        // The "Color columns" tint only. The drag-over wash that used to
        // override it is the line above now: a target is told by a 4px mark,
        // not by repainting a screen-height area, and a column that IS tinted
        // could not show the wash and its own colour at once anyway.
        style={{ background: tinted ? tint : 'transparent' }}
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
            // The column's RAW key (M20.1). This used to pre-wrap the value
            // itself, because `createTarget` wrote whatever it was handed
            // verbatim; that is now the create path's own rule, applied to
            // every surface rather than to the one that remembered — so
            // wrapping here as well would write `[[[[stem]]]]`.
            onCreate={(title) => onCreate(title, { groupBy, groupValue: column.key })}
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
        className="mb-2 inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-sm font-semibold text-n-800 hover:bg-n-100"
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        {label}
        <span className="[font-family:var(--font-mono)] text-2xs font-normal text-n-400">
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
  const bandFields = laneSpec === undefined ? [groupBy] : [groupBy, laneSpec.field];

  /**
   * The drag's claim on Escape (M46.2). dnd-kit cancels correctly on its own,
   * but from a `document` bubble listener that neither prevents the default nor
   * stops propagation — so the keystroke also reached the record panel or
   * dialog behind the board. The layer makes those defer through the
   * `ownsEscape` they already ask, and dnd-kit's cancel still runs. A capture
   * listener that swallowed the key would beat dnd-kit to it and cancel
   * nothing.
   */
  const gesture = useDndGesture<DragEndEvent>((event) =>
    handleDragEnd(event, { groupBy, columns, schema, patchFrontmatter, toast }),
  );

  return (
    // Deviation from the plan's verbatim root (reported): the shared contract
    // requires data-testid="board-view" on the root (the plan's block omitted
    // it), and — as adjudicated for ListView — ProjectPage/App provide no
    // scrolling ancestor (App is overflow-hidden), so the root swaps the
    // plan's min-h-full for the placeholder's scroll-container classes.
    <div
      data-testid="board-view"
      className="box-border min-h-0 min-w-0 flex-1 overflow-auto bg-n-25 px-5 py-4"
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
        <DndContext sensors={sensors} collisionDetection={boardCollision} {...gesture}>
          {/* The C-II ghost (M46.2 Task 5): a 40% clone of the dragged card
              follows the cursor while the card itself stays put. */}
          <DragGhostLayer />
          {lanes === null ? (
            <div className="flex items-start gap-3 overflow-x-auto">
              {columns.map((c) => (
                <BoardColumn
                  key={c.path}
                  column={c}
                  presentation={presentation}
                  schema={schema}
                  groupBy={groupBy}
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
        <div className="pt-3 text-xs text-n-400">
          {hiddenCount} unparseable item{hiddenCount === 1 ? '' : 's'} hidden
        </div>
      )}
    </div>
  );
}
