import { useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Icon } from '@/components/ui/Icon';
import { FieldChip } from '@/views/FieldChip';
import { groupTree } from '@/engine/grouping';
import { nextItemKey } from '@/engine/itemKeys';
import { visibleColumns } from '@/engine/views';
import { slugify } from '@/lib/slug';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import type { Entry, Group, GroupNode, Presentation, Schema } from '@/engine/types';

export interface ListViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** project context enables the quick-add row; pass null outside a project */
  project: Entry | null;
  /** Collapse-state namespace (M9.1) — `view:<id>`, `project:<path>`, … */
  scope?: string;
}


function QuickAddRow({ group, groupBy, project }: { group: Group; groupBy: string | null; project: Entry }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  // Double-Enter while the write is pending must not create two files with
  // the same key (M1.x, same guard as the CreateMenu dialogs).
  const [submitting, setSubmitting] = useState(false);
  const createItem = useVaultStore((s) => s.createItem);
  const allEntries = useVaultStore((s) => s.entries);

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed === '' || submitting) return;
    setSubmitting(true);
    const prefix = typeof project.properties.key === 'string' ? project.properties.key : 'WRK';
    const key = nextItemKey(prefix, allEntries);
    // v2 containment: no `project:` wikilink — membership comes from the file
    // landing inside the project's folder.
    const frontmatter: Record<string, unknown> = { type: 'Work item', key };
    // The empty-key check covers the flat "All items" fallback group (note
    // 17a): a grouped-but-empty list must not preset `field: ''`.
    if (groupBy && group.key !== '__none__' && group.key !== '') frontmatter[groupBy] = group.key;
    try {
      // slug falls back to the key for all-symbol titles (slugify → '', which
      // create_note rejects); body carries the typed title verbatim so the H1
      // keeps its capitalization instead of the humanized slug (M1.x).
      await createItem({
        folder: `${project.path.replace(/\/project\.md$/, '')}/items`,
        slug: slugify(trimmed) || key.toLowerCase(),
        frontmatter,
        body: `# ${trimmed}\n`,
      });
    } catch {
      // createItem throws to callers by design — surface the failure and keep
      // the draft instead of leaving an unhandled rejection (16a).
      useUiStore.getState().toast(`Couldn't create "${trimmed}"`);
      setSubmitting(false); // draft stays editable for retry
      return;
    }
    setTitle('');
    setEditing(false);
    setSubmitting(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex h-[34px] w-full items-center gap-2 border-b border-[var(--n-100)] px-5 text-[12.5px] text-[var(--n-400)] hover:bg-[var(--n-25)] hover:text-[var(--n-700)]"
      >
        <Icon name="plus" size={13} />
        Add item
      </button>
    );
  }
  return (
    <div className="flex h-[34px] items-center gap-2 border-b border-[var(--n-100)] px-5">
      <Icon name="plus" size={13} color="var(--n-400)" />
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') {
            setTitle('');
            setEditing(false);
          }
        }}
        placeholder="Item title — Enter to create"
        aria-label={`New item in ${group.label}`}
        className="h-6 flex-1 border-none bg-transparent text-[13px] text-[var(--n-900)] outline-none"
      />
    </div>
  );
}

function ListRow({ entry, presentation, schema }: { entry: Entry; presentation: Presentation; schema: Schema }) {
  // M9.3: the same in-place rule the table and hierarchy use. This row
  // already called openDetail directly, which was the correct BEHAVIOUR but
  // a second implementation of it — switching a view from List to Table
  // silently changed what clicking a row did. One hook, four layouts.
  const openPath = useOpenPath('in-place');
  const typeDef = entry.type ? (schema.types.get(entry.type) ?? null) : null;
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
      <span title={entry.type ?? undefined} className="inline-flex flex-none" style={{ color: typeDef?.color ?? 'var(--n-400)' }}>
        <Icon name={typeDef?.icon ?? 'file-text'} size={14} />
      </span>
      <span className="truncate text-[13px] text-[var(--n-900)]">{entry.title}</span>
      <span className="flex-1" />
      {visibleColumns(presentation)
        .filter((c) => c.field !== 'key')
        .map((c) => (
          <FieldChip key={c.field} resolved={schema.resolveField(entry, c.field)} />
        ))}
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
}: {
  node: GroupNode;
  presentation: Presentation;
  schema: Schema;
  project: Entry | null;
  scope: string;
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
            {project && <QuickAddRow group={node} groupBy={node.field} project={project} />}
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
            />
          ))
        ))}
    </section>
  );
}

export function ListView({ entries, presentation, schema, project, scope = 'list' }: ListViewProps) {
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
              <QuickAddRow
                group={{ key: '', label: 'All items', color: null, ghost: false, entries }}
                groupBy={null}
                project={project}
              />
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
            />
          ))
        )}
      </div>
    </div>
  );
}
