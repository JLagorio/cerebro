import { useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import type { ColumnDef } from '@/engine/columns';
import { describeFilterRule, filterFieldDefs, seedFilterRule } from '@/engine/viewFilters';
import type { FieldOption, FilterGroup, FilterRule } from '@/engine/types';
import { FilterBuilder, FilterRuleRow, filterFieldLabel } from '@/views/FilterBuilder';

/**
 * The filter bar, one chip per rule (M16.25).
 *
 * It was a single `Filter 3` pill: the only way to see WHICH three conditions
 * a view carried was to open the builder, and the only way to drop one was to
 * find it in there. A saved view you inherited was therefore filtered in ways
 * that took a click to discover — the failure the M15 audit logged as records
 * "missing" from a list nobody had configured.
 *
 * A chip states its rule in words and opens that rule alone. Nested groups
 * stay authorable through the full builder behind "Advanced", which is where
 * the two-level AND/OR nesting we have and Notion does not still lives.
 */

const isGroup = (node: FilterRule | FilterGroup): node is FilterGroup =>
  'all' in node || 'any' in node;

const childrenOf = (group: FilterGroup): (FilterRule | FilterGroup)[] =>
  'all' in group ? group.all : group.any;

const withChildren = (group: FilterGroup, next: (FilterRule | FilterGroup)[]): FilterGroup =>
  'all' in group ? { all: next } : { any: next };

/** Leaf conditions anywhere in the tree — what a group chip counts. */
export function countRules(group: FilterGroup | null): number {
  if (group === null) return 0;
  return childrenOf(group).reduce((sum, node) => sum + (isGroup(node) ? countRules(node) : 1), 0);
}

/** Stable identity: a `[]` default would rebuild the defs on every render. */
const NO_STATUSES: FieldOption[] = [];

export function FilterChips({
  filters,
  fields,
  statuses = NO_STATUSES,
  onChange,
}: {
  filters: FilterGroup | null;
  fields: ColumnDef[];
  /**
   * The view's status set (M16.29). A `status` field declares no `options:`
   * of its own, so without this the value editor has no choices to offer and
   * falls back to a text box you have to type the slug into.
   */
  statuses?: FieldOption[];
  onChange: (next: FilterGroup | null) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const advancedRef = useRef<HTMLButtonElement>(null);

  // THE seam. Every row below — the chip's own rule editor, and the whole
  // builder behind a group chip or "Advanced" — reads this one array, so the
  // nested path cannot drift from the top-level one (M16.29).
  const defs = useMemo(() => filterFieldDefs(fields, statuses), [fields, statuses]);

  const group: FilterGroup = filters ?? { all: [] };
  const children = childrenOf(group);
  const conjunction = 'all' in group ? 'and' : 'or';

  /** Empty means "no filters", so an emptied bar leaves nothing in the YAML. */
  const commit = (next: (FilterRule | FilterGroup)[]) =>
    onChange(next.length === 0 ? null : withChildren(group, next));

  const replace = (i: number, node: FilterRule | FilterGroup) =>
    commit(children.map((c, ci) => (ci === i ? node : c)));

  const remove = (i: number) => {
    setEditing(null);
    commit(children.filter((_, ci) => ci !== i));
  };

  const add = () => {
    const first = fields[0];
    commit([...children, seedFilterRule(first?.name ?? 'title', first?.kind ?? 'text')]);
    setEditing(children.length);
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="filter-chips">
      {children.map((node, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i === 0 ? (
            <span className="text-2xs text-n-400">Where</span>
          ) : (
            <Tooltip
              label={
                conjunction === 'and'
                  ? 'Every condition must match — press for “or”'
                  : 'Any condition may match — press for “and”'
              }
            >
              <button
                type="button"
                data-testid="filter-conjunction"
                // Only offered from the second chip onward: with one condition
                // "and" and "or" mean the same thing, and a control whose two
                // states are indistinguishable teaches that it does nothing.
                onClick={() =>
                  onChange(conjunction === 'and' ? { any: [...children] } : { all: [...children] })
                }
                className="rounded border-0 bg-transparent px-1 text-2xs text-n-500 hover:bg-n-100 hover:text-n-800"
              >
                {conjunction}
              </button>
            </Tooltip>
          )}
          <Chip
            index={i}
            node={node}
            fields={defs}
            open={editing === i}
            onOpenChange={(open) => setEditing(open ? i : null)}
            onChange={(next) => replace(i, next)}
            onRemove={() => remove(i)}
          />
        </span>
      ))}

      <button
        type="button"
        data-testid="filter-add"
        onClick={add}
        className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-dashed border-n-300 bg-transparent px-2 text-xs text-n-500 hover:border-n-400 hover:text-n-800"
      >
        <Icon name="plus" size={12} />
        Filter
      </button>

      <span className="relative inline-flex">
        <Tooltip label="Nested conditions and groups">
          <button
            ref={advancedRef}
            type="button"
            data-testid="filter-control"
            aria-label="Advanced filters"
            aria-expanded={advanced}
            onClick={() => setAdvanced(!advanced)}
            className="flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent text-n-500 hover:bg-n-50 hover:text-n-800"
          >
            <Icon name="sliders-horizontal" size={13} />
          </button>
        </Tooltip>
        {advanced && (
          <Popover
            onClose={() => setAdvanced(false)}
            anchorRef={advancedRef}
            role="dialog"
            ariaLabel="Filter this view"
          >
            <div className="w-[560px] max-w-[calc(100vw-32px)] rounded-lg border border-n-200 bg-n-0 p-2.5 shadow-[var(--shadow-lg)]">
              <div className="px-0.5 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-n-400">
                Filter this view
              </div>
              <FilterBuilder filters={filters} fields={defs} onChange={onChange} />
            </div>
          </Popover>
        )}
      </span>
    </span>
  );
}

function Chip({
  index,
  node,
  fields,
  open,
  onOpenChange,
  onChange,
  onRemove,
}: {
  index: number;
  node: FilterRule | FilterGroup;
  fields: ColumnDef[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (next: FilterRule | FilterGroup) => void;
  onRemove: () => void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const nested = isGroup(node);
  const count = nested ? countRules(node) : 0;
  const label = nested
    ? `${count} ${count === 1 ? 'condition' : 'conditions'}`
    : // The def is what lets the chip say "Status is In progress" rather than
      // "Status is progress" — a chip states its rule in words, and a slug is
      // not one (M16.29).
      describeFilterRule(
        node,
        filterFieldLabel(node.field),
        fields.find((f) => f.name === node.field),
      );

  return (
    <span
      ref={anchor}
      className="inline-flex h-7 items-center overflow-hidden rounded-md border border-cortex-300 bg-cortex-50"
    >
      <button
        type="button"
        data-testid={`filter-chip-${index}`}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="inline-flex h-full max-w-[240px] items-center gap-1 border-0 bg-transparent pl-2 pr-1 text-xs text-cortex-700 hover:bg-cortex-100"
      >
        {nested && <Icon name="brackets" size={11} color="var(--cortex-600)" />}
        <span className="min-w-0 truncate">{label}</span>
        <Icon name="chevron-down" size={11} color="var(--cortex-600)" />
      </button>
      <IconButton icon="x" label={`Remove filter: ${label}`} size="sm" onClick={onRemove} />
      {open && (
        <Popover
          onClose={() => onOpenChange(false)}
          anchorRef={anchor}
          role="dialog"
          ariaLabel="Edit filter"
        >
          <div className="rounded-lg border border-n-200 bg-n-0 p-2 shadow-[var(--shadow-lg)]">
            {nested ? (
              <div className="w-[520px] max-w-[calc(100vw-32px)]">
                <FilterBuilder
                  filters={node}
                  fields={fields}
                  onChange={(next) => onChange(next ?? { all: [] })}
                />
              </div>
            ) : (
              <FilterRuleRow rule={node} fields={fields} onChange={onChange} onRemove={onRemove} />
            )}
          </div>
        </Popover>
      )}
    </span>
  );
}
