import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { FieldEditor } from '@/detail/FieldEditor';
import { groupEntries } from '@/engine/grouping';
import { kindMeta, progressRatio } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import { typeStyle } from '@/engine/typeCatalog';
import type { Entry, FieldDef, Group, Presentation, Schema } from '@/engine/types';
import { useOpenPath } from '@/app/useOpenPath';

const TITLE_W = 280;
const DEFAULT_W = 150;
const MIN_W = 88;

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
 */
const TableCell = memo(function TableCell({
  entry,
  def,
  schema,
  width,
}: {
  entry: Entry;
  def: FieldDef;
  schema: Schema;
  width: number;
}) {
  const resolved = schema.resolveField(entry, def.name);
  const readOnly = READ_ONLY.has(def.kind);
  const isProgress = def.format === 'progress';

  return (
    <div
      role="gridcell"
      className="flex flex-none items-center overflow-hidden border-r border-[var(--n-100)] px-2"
      style={{ width }}
    >
      {readOnly || isProgress ? (
        isProgress ? (
          <ProgressCell display={resolved.display} />
        ) : (
          <span className="truncate text-[12.5px] text-[var(--n-600)]">
            {resolved.display === '' ? '—' : resolved.display}
          </span>
        )
      ) : (
        // Editing happens in place: the same FieldEditor the panel uses, so
        // validation and popovers behave identically in both surfaces. The
        // wrapper clamps it to one line — cells are a fixed 36px tall.
        <div className="flex min-w-0 flex-1 items-center overflow-hidden [&>*]:max-w-full">
          <FieldEditor entry={entry} def={def} schema={schema} compact />
        </div>
      )}
    </div>
  );
});

const TableRow = memo(function TableRow({
  entry,
  columns,
  widths,
  schema,
}: {
  entry: Entry;
  columns: FieldDef[];
  widths: Record<string, number>;
  schema: Schema;
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
      // `group` sits on the ROW so hovering anywhere reveals Open, not only
      // over the name cell.
      className="group flex h-9 border-b border-[var(--n-100)] hover:bg-[var(--n-25)]"
    >
      <div
        role="gridcell"
        className="sticky left-0 z-10 flex flex-none items-center gap-2 border-r border-[var(--n-100)] bg-[var(--n-0)] px-3"
        style={{ width: TITLE_W }}
      >
        <Icon name={style.icon} size={13} color={style.color ?? 'var(--n-400)'} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--n-900)]">
          {entry.title}
        </span>
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
        <TableCell
          key={def.name}
          entry={entry}
          def={def}
          schema={schema}
          width={widths[def.name] ?? DEFAULT_W}
        />
      ))}
    </div>
  );
});

/** Draggable divider that resizes the column to its left. */
function ColumnResizer({ onResize }: { onResize: (delta: number) => void }) {
  const startX = useRef(0);
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      onMouseDown={(e) => {
        e.preventDefault();
        startX.current = e.clientX;
        const onMove = (ev: MouseEvent) => {
          onResize(ev.clientX - startX.current);
          startX.current = ev.clientX;
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }}
      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[var(--cortex-500)]"
    />
  );
}

export interface TableViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** Declared fields of the collection's type — the column universe. */
  fields: FieldDef[];
  onOrderBy?: (field: string) => void;
}

/**
 * Table view (M3.4): the spreadsheet surface — one row per record, one
 * column per visible property, edited in place. Columns come from the view's
 * `visibleFields`, so the property-visibility control and this view share one
 * source of truth. Grouping renders as collapsible section bands.
 */
export function TableView({ entries, presentation, schema, fields, onOrderBy }: TableViewProps) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const columns = useMemo(
    () =>
      presentation.visibleFields
        .map((name) => fields.find((f) => f.name === name) ?? { name, kind: 'text' as const })
        .filter((f) => f.name !== 'title'),
    [presentation.visibleFields, fields],
  );

  const groups: Group[] = useMemo(() => {
    if (presentation.groupBy === null) {
      return [{ key: '', label: '', color: null, ghost: false, entries }];
    }
    return groupEntries(entries, presentation.groupBy, schema);
  }, [entries, presentation.groupBy, schema]);

  const resize = useCallback((name: string, delta: number) => {
    setWidths((w) => ({
      ...w,
      [name]: Math.max(MIN_W, (w[name] ?? DEFAULT_W) + delta),
    }));
  }, []);

  const totalWidth = TITLE_W + columns.reduce((sum, c) => sum + (widths[c.name] ?? DEFAULT_W), 0);

  return (
    <div data-testid="table-view" role="grid" className="min-h-0 min-w-0 flex-1 overflow-auto">
      <div style={{ width: totalWidth, minWidth: '100%' }}>
        <div
          role="row"
          className="sticky top-0 z-20 flex h-8 border-b border-[var(--n-200)] bg-[var(--n-25)]"
        >
          <div
            role="columnheader"
            className="sticky left-0 z-10 flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] bg-[var(--n-25)] px-3 text-[11.5px] font-semibold text-[var(--n-600)]"
            style={{ width: TITLE_W }}
          >
            <Icon name="type" size={12} color="var(--n-400)" />
            Name
          </div>
          {columns.map((def) => (
            <div
              key={def.name}
              role="columnheader"
              className="relative flex flex-none items-center gap-1.5 border-r border-[var(--n-100)] px-2 text-[11.5px] font-medium text-[var(--n-600)]"
              style={{ width: widths[def.name] ?? DEFAULT_W }}
            >
              <Icon name={kindMeta(def.kind).icon} size={12} color="var(--n-400)" />
              <button
                type="button"
                onClick={() => onOrderBy?.(def.name)}
                className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[11.5px] font-medium text-[var(--n-600)] hover:text-[var(--n-900)]"
              >
                {humanize(def.name)}
              </button>
              {presentation.orderBy.field === def.name && (
                <Icon
                  name={presentation.orderBy.dir === 'asc' ? 'arrow-up' : 'arrow-down'}
                  size={11}
                  color="var(--cortex-600)"
                />
              )}
              <ColumnResizer onResize={(d) => resize(def.name, d)} />
            </div>
          ))}
        </div>

        {groups.map((g) => {
          const isCollapsed = collapsed[g.key] === true;
          return (
            <section key={g.key || 'all'}>
              {presentation.groupBy !== null && (
                <button
                  type="button"
                  data-testid="table-group-header"
                  onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !isCollapsed }))}
                  className="sticky left-0 flex h-8 w-full items-center gap-2 border-b border-[var(--n-100)] bg-[var(--n-25)] px-3 text-left"
                >
                  <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} color="var(--n-400)" />
                  <span
                    className="box-border h-[10px] w-[10px] flex-none rounded-full"
                    style={
                      g.ghost || !g.color
                        ? { border: '1.5px solid var(--n-400)' }
                        : { background: g.color, border: `1.5px solid ${g.color}` }
                    }
                  />
                  <span className="text-[12.5px] font-semibold text-[var(--n-800)]">{g.label}</span>
                  <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
                    {g.entries.length}
                  </span>
                </button>
              )}
              {!isCollapsed &&
                g.entries.map((e) => (
                  <TableRow
                    key={e.path}
                    entry={e}
                    columns={columns}
                    widths={widths}
                    schema={schema}
                  />
                ))}
            </section>
          );
        })}

        {entries.length === 0 && (
          <div className="px-3 py-6 text-[12.5px] text-[var(--n-400)]">No records yet.</div>
        )}
      </div>
    </div>
  );
}
