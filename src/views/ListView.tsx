import { useOpenPath } from '@/app/useOpenPath';
import { Icon } from '@/components/ui/Icon';
import { FieldEditor } from '@/detail/FieldEditor';
import { FieldChip } from '@/views/FieldChip';
import { QuickAddInline, useQuickAdd } from '@/views/QuickAdd';
import { groupTree } from '@/engine/grouping';
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
  /** Collapse-state namespace (M9.1) — `view:<id>`, `project:<path>`, … */
  scope?: string;
  /** Type new records get (M9.6); defaults to the project canvas's type. */
  createType?: string;
}


function ListRow({ entry, presentation, schema }: { entry: Entry; presentation: Presentation; schema: Schema }) {
  // M9.3: the same in-place rule the table and hierarchy use. This row
  // already called openDetail directly, which was the correct BEHAVIOUR but
  // a second implementation of it — switching a view from List to Table
  // silently changed what clicking a row did. One hook, four layouts.
  const openPath = useOpenPath('in-place');
  const key = typeof entry.properties.key === 'string' ? entry.properties.key : '';

  if (entry.parseError) {
    return (
      <div
        role="row"
        onClick={() => openPath(entry.path)}
        className="flex h-10 cursor-pointer items-center gap-2.5 border-b border-[var(--n-100)] px-5 hover:bg-[var(--n-50)]"
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
      onClick={() => openPath(entry.path)}
      className="flex h-10 cursor-pointer items-center gap-2.5 border-b border-[var(--n-100)] px-5 hover:bg-[var(--n-50)]"
    >
      <span className="w-[52px] flex-none [font-family:var(--font-mono)] text-[10.5px] text-[var(--n-400)]">{key}</span>
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

/** One band and everything under it. Recursive so a chain of any depth
 * renders without the view knowing how deep it goes. */
function GroupSection({
  node,
  presentation,
  schema,
  project,
  scope,
  quickAdd,
}: {
  node: GroupNode;
  presentation: Presentation;
  schema: Schema;
  project: Entry | null;
  scope: string;
  quickAdd: QuickAdd;
}) {
  const collapsed = useUiStore((s) => s.collapsed[scope]?.[node.path] === true);
  const toggle = useUiStore((s) => s.toggleCollapsed);
  const isLeaf = node.children.length === 0;

  return (
    <section data-testid="list-group" data-depth={node.depth}>
      <header
        data-testid="list-group-header"
        data-depth={node.depth}
        className="sticky z-10 flex h-9 items-center gap-2 border-b border-[var(--n-100)] bg-[var(--n-25)] px-5"
        style={{ top: node.depth * 36, paddingLeft: 20 + node.depth * 16 }}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${node.label}`}
          onClick={() => toggle(scope, node.path)}
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
      {!collapsed &&
        (isLeaf ? (
          <>
            {node.entries.map((e) => (
              <ListRow key={e.path} entry={e} presentation={presentation} schema={schema} />
            ))}
            {project && (
              <QuickAddInline
                ariaLabel={`New item in ${node.label}`}
                label="Add item"
                onCreate={(title) =>
                  quickAdd(title, { groupBy: node.field, groupValue: node.key })
                }
              />
            )}
          </>
        ) : (
          node.children.map((child) => (
            <GroupSection
              key={child.path}
              node={child}
              presentation={presentation}
              schema={schema}
              project={project}
              scope={scope}
              quickAdd={quickAdd}
            />
          ))
        ))}
    </section>
  );
}

type QuickAdd = (
  title: string,
  band?: { groupBy?: string | null; groupValue?: string | null },
) => Promise<boolean>;

export function ListView({
  entries,
  presentation,
  schema,
  project,
  scope = 'list',
  createType = 'Work item',
}: ListViewProps) {
  const quickAdd = useQuickAdd(createType, project);
  // M9.1: a chain, not a single field — groupTree recurses so this view does
  // not need to know how deep the nesting goes.
  const nodes = groupTree(entries, presentation.group, schema);

  // Fix (execution-log note 17a): grouping an empty list yields no bands — an
  // empty project rendered a blank canvas with no headers and no Add-item
  // row. Fall back to a flat run so quick-add stays reachable. Same fallback
  // covers an explicitly ungrouped view.
  const flat = nodes.length === 0;

  return (
    // Deviation from the plan's verbatim root (reported): the shared contract
    // requires data-testid="list-view" on the root, and ProjectPage/App
    // provide no scrolling ancestor (App is overflow-hidden) — so the root
    // keeps the placeholder's scroll-container classes; the plan's
    // min-w-[720px] block sits inside it.
    <div data-testid="list-view" className="min-h-0 min-w-0 flex-1 overflow-auto">
      <div className="min-w-[720px]">
        {flat ? (
          <section>
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
            {entries.map((e) => (
              <ListRow key={e.path} entry={e} presentation={presentation} schema={schema} />
            ))}
            {project && (
              <QuickAddInline ariaLabel="New item" label="Add item" onCreate={(t) => quickAdd(t)} />
            )}
          </section>
        ) : (
          nodes.map((node) => (
            <GroupSection
              key={node.path}
              node={node}
              presentation={presentation}
              schema={schema}
              project={project}
              scope={scope}
              quickAdd={quickAdd}
            />
          ))
        )}
      </div>
    </div>
  );
}
