import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { useOpenPath } from '@/app/useOpenPath';
import { Avatar } from '@/components/ui/Avatar';
import { QuickAddInline } from '@/views/QuickAdd';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { StatusFlag } from '@/components/ui/StatusFlag';
import { groupEntries } from '@/engine/grouping';
import { formatWikilink } from '@/engine/wikilink';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { Entry, Group, Presentation, Schema } from '@/engine/types';

export interface BoardViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** Collapse-state namespace for swimlanes (M9.1). */
  scope?: string;
  /** M9.6: create a card in a column, inheriting its value. */
  onCreate?: (title: string, band: { groupBy: string; groupValue: string }) => Promise<boolean>;
}

/** Droppable id used for the trailing "No <field>" group (dnd-kit ids must be non-empty). */
export const NO_VALUE_COLUMN_ID = '::none';

export function handleDragEnd(
  event: DragEndEvent,
  args: {
    groupBy: string;
    groups: Group[];
    schema: Schema;
    patchFrontmatter: (path: string, patch: Record<string, unknown>) => Promise<void>;
    toast: (message: string) => void;
  },
): void {
  const { active, over } = event;
  if (!over) return;
  const path = String(active.id);
  // Deviation from the plan's verbatim body (reported): the plan mapped
  // NO_VALUE_COLUMN_ID to '' here, but the no-value group's key is '__none__'
  // (BoardColumn maps '__none__' → NO_VALUE_COLUMN_ID), so '' never matched a
  // group and the plan's own "writes null" test failed. Reverse the mapping
  // faithfully instead.
  const overKey = String(over.id) === NO_VALUE_COLUMN_ID ? '__none__' : String(over.id);
  const target = args.groups.find((g) => g.key === overKey);
  if (!target) return;
  const source = args.groups.find((g) => g.entries.some((e) => e.path === path));
  if (source && source.key === target.key) return;
  // Fix (execution-log note 18): person/relation groups key by wikilink stem,
  // so a bare-stem write would destroy the wikilink on disk (the field leaves
  // relationships after rescan). Wrap those writes as [[wikilinks]]; the
  // '__none__' drop keeps writing plain null (delete).
  const dragged = source?.entries.find((e) => e.path === path);
  const kind = dragged ? args.schema.resolveField(dragged, args.groupBy).def?.kind : undefined;
  // Multi-select fields group one entry into several columns; a drop would
  // overwrite the whole array with one scalar. Refuse with a toast until a
  // real add/remove treatment exists (M1.x interim).
  if (kind === 'multiselect') {
    args.toast("Can't move cards grouped by a multi-select field");
    return;
  }
  const value =
    target.key === '__none__'
      ? null
      : kind === 'person' || kind === 'relation'
        ? formatWikilink(target.key)
        : target.key;
  void args.patchFrontmatter(path, { [args.groupBy]: value });
  args.toast(`Moved to ${target.label}`);
}

function BoardCard({ entry, group, schema }: { entry: Entry; group: Group; schema: Schema }) {
  // M9.3: one open rule across all four layouts (see useOpenPath).
  const openPath = useOpenPath('in-place');
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: entry.path,
  });
  const key = typeof entry.properties.key === 'string' ? entry.properties.key : '';
  const priority = schema.resolveField(entry, 'priority');
  const assignee = schema.resolveField(entry, 'assignee');

  return (
    <div
      ref={setNodeRef}
      data-testid="board-card"
      data-path={entry.path}
      {...listeners}
      {...attributes}
      onClick={() => openPath(entry.path)}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        borderLeft: `3px solid ${group.ghost || !group.color ? 'var(--n-300)' : group.color}`,
        opacity: isDragging ? 0.6 : 1,
        zIndex: isDragging ? 20 : undefined,
      }}
      className="relative cursor-pointer rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] px-[11px] py-[9px] shadow-[var(--shadow-xs)] hover:border-[var(--n-300)] hover:shadow-[var(--shadow-sm)]"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span
          data-testid="card-key"
          className="[font-family:var(--font-mono)] text-[10px] text-[var(--n-400)]"
        >
          {key}
        </span>
      </div>
      <div className="mb-2 text-[13px] font-medium leading-[18px] text-[var(--n-900)]">
        {entry.title}
      </div>
      <div className="flex items-center gap-[7px]">
        {priority.display !== '' && (
          <span title={`Priority: ${priority.display}`} className="inline-flex">
            <StatusFlag
              bare
              size="sm"
              label={priority.display}
              color={priority.color ?? 'var(--n-400)'}
            />
          </span>
        )}
        <span className="flex-1" />
        {assignee.display !== '' && <Avatar name={assignee.display} size={18} />}
      </div>
    </div>
  );
}

function BoardColumn({
  group,
  schema,
  groupBy,
  onCreate,
}: {
  group: Group;
  schema: Schema;
  groupBy: string;
  onCreate?: (title: string, band: { groupBy: string; groupValue: string }) => Promise<boolean>;
}) {
  const droppableId = group.key === '__none__' ? NO_VALUE_COLUMN_ID : group.key;
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  return (
    <div data-testid="board-column" data-group-key={group.key} className="w-[280px] flex-none">
      <div className="flex items-center gap-[7px] px-1 pb-[9px]">
        <span
          className="box-border h-2.5 w-2.5 rounded-full"
          style={
            group.ghost || !group.color
              ? { border: '1.5px solid var(--n-400)' }
              : { background: group.color, border: `1.5px solid ${group.color}` }
          }
        />
        <span className="text-[12.5px] font-semibold text-[var(--n-800)]">{group.label}</span>
        <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
          {group.entries.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className="flex min-h-[60px] flex-col gap-2 rounded-[10px] p-0.5"
        style={{ background: isOver ? 'var(--cortex-50)' : 'transparent' }}
      >
        {group.entries.map((e) => (
          <BoardCard key={e.path} entry={e} group={group} schema={schema} />
        ))}
        {/* M9.6: creating here presets the column's own value, so a card
            lands in the column you pressed rather than in triage. */}
        {onCreate !== undefined && (
          <QuickAddInline
            compact
            label="New"
            ariaLabel={`New record in ${group.label}`}
            onCreate={(title) => onCreate(title, { groupBy, groupValue: group.key })}
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
  onCreate,
}: BoardViewProps) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const toast = useUiStore((s) => s.toast);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // A board's columns ARE its first grouping level, so it always has one.
  const groupBy = presentation.group[0]?.field ?? 'status';
  const swimlaneBy = presentation.group[1]?.field ?? null;
  const parseable = entries.filter((e) => e.parseError === null);
  const hiddenCount = entries.length - parseable.length;
  const groups = groupEntries(parseable, groupBy, schema);

  // M9.1: sub-grouping partitions the ROWS first, then columns within each
  // band — the reverse would produce columns that don't line up across lanes.
  const lanes =
    swimlaneBy === null
      ? null
      : groupEntries(parseable, swimlaneBy, schema)
          .filter((lane) => lane.entries.length > 0)
          .map((lane) => ({ lane, columns: groupEntries(lane.entries, groupBy, schema) }));

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
      {groups.length === 0 ? (
        // Fix (execution-log note 17a): groupEntries([], …) returns [] — an
        // empty project rendered a blank canvas with no columns and no empty
        // state.
        <EmptyState
          icon="square-kanban"
          title="No items yet"
          description="Create an item to see it here as a card."
        />
      ) : (
        <DndContext
          sensors={sensors}
          onDragEnd={(event) =>
            handleDragEnd(event, { groupBy, groups, schema, patchFrontmatter, toast })
          }
        >
          {lanes === null ? (
            <div className="flex items-start gap-3 overflow-x-auto">
              {groups.map((g) => (
                <BoardColumn
                  key={g.key || g.label}
                  group={g}
                  schema={schema}
                  groupBy={groupBy}
                  onCreate={onCreate}
                />
              ))}
            </div>
          ) : (
            lanes.map(({ lane, columns }) => (
              <Swimlane
                key={lane.key || lane.label}
                label={lane.label}
                count={lane.entries.length}
                scope={scope}
                path={lane.key}
              >
                <div className="flex items-start gap-3 overflow-x-auto">
                  {columns.map((g) => (
                    <BoardColumn
                      key={g.key || g.label}
                      group={g}
                      schema={schema}
                      groupBy={groupBy}
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
