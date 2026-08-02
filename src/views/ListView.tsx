import { useOpenPath } from '@/app/useOpenPath';
import { Icon } from '@/components/ui/Icon';
import { FieldEditor } from '@/detail/FieldEditor';
import { FieldChip } from '@/views/FieldChip';
import { QuickAddInline, useQuickAdd } from '@/views/QuickAdd';
import { buildRows } from '@/engine/rows';
import { typeStyle } from '@/engine/typeCatalog';
import { visibleColumns } from '@/engine/views';
import { useUiStore } from '@/stores/uiStore';
import type { Entry, GroupNode, Presentation, Schema } from '@/engine/types';

export interface ListViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** project context enables the quick-add row; pass null outside a project */
  project: Entry | null;
  /**
   * The whole vault (M10) — nested children resolve against it, so a filtered
   * list can still nest under a parent the filter excluded. Defaults to
   * `entries`; unread when the chain has no relation level.
   */
  allEntries?: Entry[];
  /** Collapse-state namespace (M9.1) — `view:<id>`, `project:<path>`, … */
  scope?: string;
  /** Type new records get (M9.6); defaults to the project canvas's type. */
  createType?: string;
}

/** Indent per nesting level, matching the band header's step. */
const INDENT = 16;

function ListRow({
  entry,
  presentation,
  schema,
  depth,
  childCount,
  collapsed,
  onToggle,
}: {
  entry: Entry;
  presentation: Presentation;
  schema: Schema;
  /** M10: nesting depth from the chain's relation levels. */
  depth: number;
  childCount: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  // M9.3: the same in-place rule the table and hierarchy use. This row
  // already called openDetail directly, which was the correct BEHAVIOUR but
  // a second implementation of it — switching a view from List to Table
  // silently changed what clicking a row did. One hook, four layouts.
  const openPath = useOpenPath('in-place');
  const key = typeof entry.properties.key === 'string' ? entry.properties.key : '';

  // The expander sits between the key gutter and the type icon so a nested run
  // reads as an outline rather than as rows that happen to be indented.
  const expander =
    childCount > 0 ? (
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
    );

  if (entry.parseError) {
    return (
      <div
        role="row"
        data-depth={depth}
        onClick={() => openPath(entry.path)}
        className="flex h-10 cursor-pointer items-center gap-2.5 border-b border-[var(--n-100)] pr-5 hover:bg-[var(--n-50)]"
        style={{ paddingLeft: 20 + depth * INDENT }}
      >
        <span className="w-[52px] flex-none" />
        <span className="inline-flex flex-none text-[var(--warn-500)]">
          <Icon name="triangle-alert" size={14} />
        </span>
        <span className="truncate text-[13px] text-[var(--n-700)]">{entry.filename}</span>
        <span className="inline-flex flex-none items-center rounded-md border border-[var(--warn-500)] px-1.5 py-0.5 text-[11px] text-[var(--warn-500)]">
          Cannot parse
        </span>
      </div>
    );
  }

  return (
    <div
      role="row"
      data-depth={depth}
      onClick={() => openPath(entry.path)}
      className="flex h-10 cursor-pointer items-center gap-2.5 border-b border-[var(--n-100)] pr-5 hover:bg-[var(--n-50)]"
      style={{ paddingLeft: 20 + depth * INDENT }}
    >
      <span className="w-[52px] flex-none [font-family:var(--font-mono)] text-[10.5px] text-[var(--n-400)]">
        {key}
      </span>
      {expander}
      <span
        title={entry.type ?? undefined}
        className="inline-flex flex-none"
        style={{ color: typeStyle(entry.type, schema).color ?? 'var(--n-400)' }}
      >
        <Icon name={typeStyle(entry.type, schema).icon} size={14} />
      </span>
      <span className="truncate text-[13px] text-[var(--n-900)]">{entry.title}</span>
      <span className="flex-1" />
      {/* M9.6: editable in place, the same FieldEditor the table and
          hierarchy use. A read-only chip here meant the same property was
          editable or not depending on which layout the view happened to be
          in. stopPropagation so editing a value does not also open the row. */}
      {visibleColumns(presentation)
        .filter((c) => c.field !== 'key')
        .map((c) => {
          const def = entry.type
            ? (schema.types.get(entry.type)?.fields ?? []).find((f) => f.name === c.field)
            : undefined;
          const resolved = schema.resolveField(entry, c.field);
          if (def === undefined) return <FieldChip key={c.field} resolved={resolved} />;
          return (
            <span
              key={c.field}
              className="flex-none"
              onClick={(e) => e.stopPropagation()}
              role="presentation"
            >
              <FieldEditor entry={entry} def={def} schema={schema} compact />
            </span>
          );
        })}
    </div>
  );
}

/**
 * One band's header.
 *
 * M10: this was `GroupSection`, which owned the bands AND the rows under them.
 * `buildRows` flattens both axes, so the recursion — and the reason this view
 * could not nest — is gone.
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
    <header
      data-testid="list-group-header"
      data-depth={node.depth}
      className="sticky z-10 flex h-9 items-center gap-2 border-b border-[var(--n-100)] bg-[var(--n-25)] pr-5"
      style={{ top: node.depth * 36, paddingLeft: 20 + node.depth * INDENT }}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${node.label}`}
        onClick={onToggle}
        className="flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-800)]"
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
      </button>
      <span
        className="box-border h-[11px] w-[11px] rounded-full"
        style={
          node.ghost || !node.color
            ? { border: '1.5px solid var(--n-400)' }
            : { background: node.color, border: `1.5px solid ${node.color}` }
        }
      />
      <span
        className={[
          node.depth === 0 ? 'text-[12.5px] font-semibold' : 'text-[12px] font-medium',
          'text-[var(--n-800)]',
        ].join(' ')}
      >
        {node.label}
      </span>
      {/* Recursive count: a collapsed parent still reports what is inside. */}
      <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
        {node.count}
      </span>
    </header>
  );
}

export function ListView({
  entries,
  presentation,
  schema,
  project,
  allEntries = entries,
  scope = 'list',
  createType = 'Work item',
}: ListViewProps) {
  const quickAdd = useQuickAdd(createType, project);
  const collapsedMap = useUiStore((s) => s.collapsed[scope]);
  const toggle = useUiStore((s) => s.toggleCollapsed);

  // M10: one row list — bands, nesting, and the create row. The list no longer
  // needs a separate flat-fallback branch either: buildRows already emits a
  // bare run when there is nothing to band (execution-log note 17a — an empty
  // project used to render a blank canvas with no Add-item row).
  const rows = buildRows({
    entries,
    group: presentation.group,
    schema,
    allEntries,
    addRows: project !== null,
    isCollapsed: (key) => collapsedMap?.[key] === true,
  });
  const bandless = rows.every((r) => r.kind !== 'band');

  return (
    // Deviation from the plan's verbatim root (reported): the shared contract
    // requires data-testid="list-view" on the root, and ProjectPage/App
    // provide no scrolling ancestor (App is overflow-hidden) — so the root
    // keeps the placeholder's scroll-container classes; the plan's
    // min-w-[720px] block sits inside it.
    <div data-testid="list-view" className="min-h-0 min-w-0 flex-1 overflow-auto">
      <div className="min-w-[720px]">
        {/* An ungrouped run still gets a header: it carries the count, and a
            canvas that opens with rows and no header reads as half-loaded. */}
        {bandless && (
          <header
            data-testid="list-group-header"
            data-depth={0}
            className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-[var(--n-100)] bg-[var(--n-25)] px-5"
          >
            <span
              className="box-border h-[11px] w-[11px] rounded-full"
              style={{ border: '1.5px solid var(--n-400)' }}
            />
            <span className="text-[12.5px] font-semibold text-[var(--n-800)]">All items</span>
            <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
              {entries.length}
            </span>
          </header>
        )}
        {rows.map((row) => {
          if (row.kind === 'band') {
            return (
              <BandHeader
                key={row.key}
                node={row.node}
                collapsed={collapsedMap?.[row.key] === true}
                onToggle={() => toggle(scope, row.key)}
              />
            );
          }
          if (row.kind === 'add') {
            return (
              <QuickAddInline
                key={row.key}
                ariaLabel={row.band === null ? 'New item' : `New item in ${row.band.label}`}
                label="Add item"
                onCreate={(title) =>
                  row.band === null
                    ? quickAdd(title)
                    : quickAdd(title, { groupBy: row.band.field, groupValue: row.band.key })
                }
              />
            );
          }
          return (
            <ListRow
              key={row.key}
              entry={row.entry}
              presentation={presentation}
              schema={schema}
              depth={row.depth}
              childCount={row.childCount}
              collapsed={collapsedMap?.[row.key] === true}
              onToggle={() => toggle(scope, row.key)}
            />
          );
        })}
      </div>
    </div>
  );
}
