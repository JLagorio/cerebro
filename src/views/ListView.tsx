import { resolveOptionColor } from '@/lib/swatch';
import { useMemo } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { FieldEditor } from '@/detail/FieldEditor';
import { FieldChip } from '@/views/FieldChip';
import { QuickAddInline, useQuickAdd } from '@/views/QuickAdd';
import { RecordRowMenu } from '@/views/RecordRowMenu';
import { buildRows, entryRows } from '@/engine/rows';
import { typeStyle } from '@/engine/typeCatalog';
import { visibleColumns } from '@/engine/views';
import { useRowKeyboard, type RowKeyboardRowProps } from '@/views/useRowKeyboard';
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
  /**
   * M15: the same create contract the other layouts get. `project` alone gated
   * this, and nothing outside the project canvas passed one — so switching a
   * view tab from Table to List silently removed the only way to add a record
   * from the canvas.
   */
  onCreate?: (title: string, band: { groupBy: string; groupValue: string }) => Promise<boolean>;
  /** True when the view has filters, so the empty state can say why. */
  filtered?: boolean;
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
  selected,
  onSelect,
  rowProps,
}: {
  entry: Entry;
  presentation: Presentation;
  schema: Schema;
  /** M10: nesting depth from the chain's relation levels. */
  depth: number;
  childCount: number;
  collapsed: boolean;
  onToggle: () => void;
  /** True when the roving cursor is on this row. */
  selected: boolean;
  onSelect: () => void;
  rowProps: RowKeyboardRowProps;
}) {
  // M9.3: the same in-place rule the table and hierarchy use. This row
  // already called openDetail directly, which was the correct BEHAVIOUR but
  // a second implementation of it — switching a view from List to Table
  // silently changed what clicking a row did. One hook, every surface that
  // opens a record — counting them here only dated the comment (M29.49).
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
        className="flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-n-400 hover:bg-n-100 hover:text-n-800"
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
        {...rowProps}
        data-testid="list-row"
        data-depth={depth}
        onClick={() => {
          onSelect();
          openPath(entry.path);
        }}
        className={[
          'flex h-10 cursor-pointer items-center gap-2.5 border-b border-n-100 pr-5 hover:bg-n-50',
          selected ? 'bg-cortex-50 shadow-[inset_2px_0_0_var(--cortex-500)]' : '',
        ].join(' ')}
        style={{ paddingLeft: 20 + depth * INDENT }}
      >
        <span className="w-[52px] flex-none" />
        <span className="inline-flex flex-none text-warn-500">
          <Icon name="triangle-alert" size={14} />
        </span>
        <span className="truncate text-sm text-n-700">{entry.filename}</span>
        <span className="inline-flex flex-none items-center rounded-md border border-warn-500 px-1.5 py-0.5 text-2xs text-warn-500">
          Cannot parse
        </span>
      </div>
    );
  }

  return (
    <div
      role="row"
      {...rowProps}
      data-testid="list-row"
      data-depth={depth}
      onClick={() => {
        onSelect();
        openPath(entry.path);
      }}
      className={[
        'group flex h-10 cursor-pointer items-center gap-2.5 border-b border-n-100 pr-5 hover:bg-n-50',
        selected ? 'bg-cortex-50 shadow-[inset_2px_0_0_var(--cortex-500)]' : '',
      ].join(' ')}
      style={{ paddingLeft: 20 + depth * INDENT }}
    >
      <span className="w-[52px] flex-none [font-family:var(--font-mono)] text-2xs text-n-400">
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
      <span className="truncate text-sm text-n-900">{entry.title}</span>
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
      {/* M16.21: the row's own controls.
          The row is a `<div role="row">` with an onClick — clickable with a
          mouse and openable with the grid's Enter key, but carrying no NAMED
          control anywhere, so assistive tech saw a strip of text with no
          announced way to act on it. And the only thing a list could do to a
          record was open it: copying a link to one, duplicating it, or
          deleting it all meant opening it first to reach the panel's header.
          Reserved with opacity rather than mounted on hover, so rows do not
          reflow under the pointer as it moves down the list. */}
      <span
        className="ml-1 flex flex-none items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <button
          type="button"
          data-testid="row-open-affordance"
          aria-label={`Open ${entry.title}`}
          onClick={() => {
            onSelect();
            openPath(entry.path);
          }}
          className="rounded-sm border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-[0.04em] text-n-500 hover:bg-n-50 hover:text-n-800"
        >
          Open
        </button>
        <RecordRowMenu
          entry={entry}
          onOpen={() => {
            onSelect();
            openPath(entry.path);
          }}
        />
      </span>
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
      className="sticky z-10 flex h-9 items-center gap-2 border-b border-n-100 bg-n-25 pr-5"
      style={{ top: node.depth * 36, paddingLeft: 20 + node.depth * INDENT }}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${node.label}`}
        onClick={onToggle}
        className="flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-n-400 hover:bg-n-100 hover:text-n-800"
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
      </button>
      {/* flex-none: without it a long band label squeezed the swatch from a
          circle into a thin ellipse, and the colour coding the grouping
          depends on quietly vanished. 10px matches the table's. */}
      <span
        className="box-border h-2.5 w-2.5 flex-none rounded-full"
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
        className={[
          node.depth === 0 ? 'text-sm font-semibold' : 'text-xs font-medium',
          'min-w-0 truncate text-n-800',
        ].join(' ')}
      >
        {node.label}
      </span>
      {/* Recursive count: a collapsed parent still reports what is inside. */}
      <span className="[font-family:var(--font-mono)] text-2xs text-n-400">{node.count}</span>
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
  onCreate,
  filtered,
}: ListViewProps) {
  const quickAdd = useQuickAdd(createType, project);
  const collapsedMap = useUiStore((s) => s.collapsed[scope]);
  const toggle = useUiStore((s) => s.toggleCollapsed);
  const openPath = useOpenPath('in-place');

  // M15: create where a create contract exists — `project !== null` alone meant
  // no caller outside the project canvas could ever create from this layout.
  const canCreate = onCreate !== undefined || project !== null;

  // M10: one row list — bands, nesting, and the create row. The list no longer
  // needs a separate flat-fallback branch either: buildRows already emits a
  // bare run when there is nothing to band (execution-log note 17a — an empty
  // project used to render a blank canvas with no Add-item row).
  const rows = buildRows({
    entries,
    group: presentation.group,
    schema,
    allEntries,
    addRows: canCreate,
    isCollapsed: (key) => collapsedMap?.[key] === true,
  });
  const bandless = rows.every((r) => r.kind !== 'band');

  // M15: the same roving cursor the table has. Rows were `<div role="row">`
  // with an onClick and no tabIndex, and the hook was imported by TableView
  // alone — so on this layout there was no keyboard path to a record at all.
  const flatRows = useMemo(() => entryRows(rows), [rows]);
  const keyboard = useRowKeyboard({
    count: flatRows.length,
    onOpen: (i) => openPath(flatRows[i].entry.path),
    onToggle: (i) => {
      if (flatRows[i].childCount > 0) toggle(scope, flatRows[i].key);
    },
  });

  return (
    // Deviation from the plan's verbatim root (reported): the shared contract
    // requires data-testid="list-view" on the root, and ProjectPage/App
    // provide no scrolling ancestor (App is overflow-hidden) — so the root
    // keeps the placeholder's scroll-container classes; the plan's
    // min-w-[720px] block sits inside it.
    <div
      data-testid="list-view"
      role="grid"
      aria-label="Records"
      aria-rowcount={flatRows.length}
      className="min-h-0 min-w-0 flex-1 overflow-auto focus-visible:shadow-[inset_var(--ring)] focus-visible:outline-none"
      {...keyboard.containerProps}
    >
      <div className="min-w-[720px]">
        {/* An ungrouped run still gets a header: it carries the count, and a
            canvas that opens with rows and no header reads as half-loaded. */}
        {bandless && (
          <header
            data-testid="list-group-header"
            data-depth={0}
            className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-n-100 bg-n-25 px-5"
          >
            <span
              className="box-border h-2.5 w-2.5 flex-none rounded-full"
              style={{ border: '1.5px solid var(--n-400)' }}
            />
            <span className="text-sm font-semibold text-n-800">All items</span>
            <span className="[font-family:var(--font-mono)] text-2xs text-n-400">
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
                  onCreate !== undefined
                    ? onCreate(title, {
                        groupBy: row.band?.field ?? '',
                        groupValue: row.band?.key ?? '',
                      })
                    : row.band === null
                      ? quickAdd(title)
                      : quickAdd(title, { groupBy: row.band.field, groupValue: row.band.key })
                }
              />
            );
          }
          const index = flatRows.indexOf(row);
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
              selected={index === keyboard.index}
              onSelect={() => keyboard.setIndex(index)}
              rowProps={keyboard.rowProps(index)}
            />
          );
        })}
        {entries.length === 0 && (
          // A bare "All items 0" strip over an empty canvas reads as a load
          // failure, not as an empty result — and said nothing about the
          // filter that caused it.
          <div role="row" className="px-3 py-8">
            <EmptyState
              icon="list"
              title={filtered === true ? 'Nothing matches these filters' : 'No records yet'}
              description={
                filtered === true
                  ? 'Adjust the filters in view settings to widen the query.'
                  : canCreate
                    ? 'Create the first one below.'
                    : 'Records that land in this view appear here.'
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
