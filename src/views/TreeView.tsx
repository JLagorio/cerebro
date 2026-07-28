import { memo, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { FieldEditor } from '@/detail/FieldEditor';
import { kindMeta, progressRatio } from '@/engine/properties';
import { childrenOf } from '@/engine/relations';
import { humanize } from '@/engine/schema';
import { typeStyle } from '@/engine/typeCatalog';
import type { Entry, FieldDef, Presentation, Schema } from '@/engine/types';
import { useOpenPath } from '@/app/useOpenPath';

const NAME_W = 340;
const COL_W = 150;
const INDENT = 18;
/** Depth guard: relation graphs can contain cycles (A → B → A). */
const MAX_DEPTH = 6;

export interface TreeViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** All entries — children are looked up across the whole vault, not just
   * the rows the view's source selected. */
  allEntries: Entry[];
  /** Declared fields of the ROOT type (column universe for the header). */
  fields: FieldDef[];
}

interface Row {
  entry: Entry;
  depth: number;
  childCount: number;
  /** Key includes the ancestor path so the same record can appear under two
   * parents without React key collisions. */
  key: string;
}

/** One value cell, read-only for computed kinds and progress-formatted numbers. */
const TreeCell = memo(function TreeCell({
  entry,
  def,
  schema,
}: {
  entry: Entry;
  def: FieldDef;
  schema: Schema;
}) {
  const resolved = schema.resolveField(entry, def.name);
  const ratio = def.format === 'progress' ? progressRatio(resolved.display) : null;
  // Columns belong to the ROOT type; a child of a different type usually
  // doesn't declare them. Render those blank rather than offering an editor
  // that would graft the parent's property onto the child.
  const declared =
    entry.type !== null && (schema.types.get(entry.type)?.fields ?? []).some((f) => f.name === def.name);

  if (!declared && resolved.display === '') {
    return (
      <div
        role="gridcell"
        className="flex flex-none items-center border-r border-[var(--n-100)] px-2"
        style={{ width: COL_W }}
      >
        <span className="text-[12px] text-[var(--n-300)]">—</span>
      </div>
    );
  }

  return (
    <div
      role="gridcell"
      className="flex flex-none items-center overflow-hidden border-r border-[var(--n-100)] px-2"
      style={{ width: COL_W }}
    >
      {ratio !== null ? (
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
            {resolved.display}
          </span>
        </span>
      ) : (
        <div className="flex min-w-0 flex-1 items-center overflow-hidden [&>*]:max-w-full">
          <FieldEditor entry={entry} def={def} schema={schema} compact />
        </div>
      )}
    </div>
  );
});

/**
 * Hierarchy view (M3.5): root rows come from the view's source, child rows
 * from `childrenVia` — a relation followed forward (the parent lists them) or
 * in reverse (the children point back). Children can be a different type than
 * the root, which is what makes Objective → Key result → Work item work.
 */
export function TreeView({ entries, presentation, schema, allEntries, fields }: TreeViewProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // M3.5: route by kind — a Project record opens its page, everything else
  // opens the detail panel. No sidebar special-casing needed.
  const openPath = useOpenPath();
  const spec = presentation.childrenVia ?? null;

  const columns = useMemo(
    () =>
      presentation.visibleFields
        .map((name) => fields.find((f) => f.name === name) ?? { name, kind: 'text' as const })
        .filter((f) => f.name !== 'title'),
    [presentation.visibleFields, fields],
  );

  // Flatten the tree once per render: expansion is just a filter on this list,
  // so toggling a row doesn't re-walk the graph.
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (list: Entry[], depth: number, keyPrefix: string, seen: Set<string>) => {
      for (const entry of list) {
        const key = `${keyPrefix}/${entry.path}`;
        const kids =
          spec === null || depth >= MAX_DEPTH || seen.has(entry.path)
            ? []
            : childrenOf(entry, spec, allEntries, schema.relations);
        out.push({ entry, depth, childCount: kids.length, key });
        if (kids.length > 0 && collapsed[key] !== true) {
          walk(kids, depth + 1, key, new Set([...seen, entry.path]));
        }
      }
    };
    walk(entries, 0, '', new Set());
    return out;
  }, [entries, spec, allEntries, schema, collapsed]);

  const totalWidth = NAME_W + columns.length * COL_W;

  return (
    <div data-testid="tree-view" role="grid" className="min-h-0 min-w-0 flex-1 overflow-auto">
      <div style={{ width: totalWidth, minWidth: '100%' }}>
        <div
          role="row"
          className="sticky top-0 z-20 flex h-8 border-b border-[var(--n-200)] bg-[var(--n-25)]"
        >
          <div
            role="columnheader"
            className="flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] px-3 text-[11.5px] font-semibold text-[var(--n-600)]"
            style={{ width: NAME_W }}
          >
            <Icon name="list-tree" size={12} color="var(--n-400)" />
            Name
          </div>
          {columns.map((def) => (
            <div
              key={def.name}
              role="columnheader"
              className="flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] px-2 text-[11.5px] font-medium text-[var(--n-600)]"
              style={{ width: COL_W }}
            >
              <Icon name={kindMeta(def.kind).icon} size={12} color="var(--n-400)" />
              <span className="truncate">{humanize(def.name)}</span>
            </div>
          ))}
        </div>

        {rows.map(({ entry, depth, childCount, key }) => {
          const style = typeStyle(entry.type, schema);
          const isCollapsed = collapsed[key] === true;
          return (
            <div
              key={key}
              role="row"
              data-testid="tree-row"
              data-depth={depth}
              data-path={entry.path}
              className="group flex h-9 border-b border-[var(--n-100)] hover:bg-[var(--n-25)]"
            >
              <div
                role="gridcell"
                className="flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] pr-2"
                style={{ width: NAME_W, paddingLeft: 10 + depth * INDENT }}
              >
                {childCount > 0 ? (
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${entry.title}`}
                    onClick={() => setCollapsed((c) => ({ ...c, [key]: !isCollapsed }))}
                    className="flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-800)]"
                  >
                    <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                  </button>
                ) : (
                  <span className="h-4 w-4 flex-none" />
                )}
                <Icon name={style.icon} size={13} color={style.color ?? 'var(--n-400)'} />
                <span
                  className={[
                    'min-w-0 flex-1 truncate text-[13px]',
                    depth === 0 ? 'font-medium text-[var(--n-900)]' : 'text-[var(--n-700)]',
                  ].join(' ')}
                >
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
                  onClick={() => openPath(entry.path)}
                  className="hidden flex-none items-center gap-1 rounded-md border border-[var(--n-200)] bg-[var(--n-0)] px-1.5 py-px text-[11px] text-[var(--n-600)] hover:border-[var(--n-400)] group-hover:inline-flex"
                >
                  <Icon name="maximize-2" size={10} />
                  Open
                </button>
              </div>
              {columns.map((def) => (
                <TreeCell key={def.name} entry={entry} def={def} schema={schema} />
              ))}
            </div>
          );
        })}

        {rows.length === 0 && (
          <div className="px-3 py-6 text-[12.5px] text-[var(--n-400)]">No records yet.</div>
        )}
        {spec === null && rows.length > 0 && (
          <div className="px-3 py-3 text-[12px] text-[var(--n-400)]">
            This view has no child relation set — pick one in the toolbar to nest rows.
          </div>
        )}
      </div>
    </div>
  );
}
