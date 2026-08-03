import { Dropdown } from '@/components/ui/Dropdown';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { humanize } from '@/engine/schema';
import {
  coerceOpForKind,
  coerceRuleToOp,
  filterKindFor,
  filterOpLabel,
  filterOpsFor,
  seedFilterRule,
} from '@/engine/viewFilters';
import type { FieldDef, FilterGroup, FilterOp, FilterRule } from '@/engine/types';
import { FilterValueEditor } from '@/views/FilterValueEditor';

/**
 * `type` and `title` are filterable but undeclared — the engine's `fieldValue`
 * resolves them off the entry itself. They are text, and saying so here is
 * what stops the operator menu offering "is before" on a record's name.
 */
const PSEUDO_FIELDS: FieldDef[] = [
  { name: 'type', kind: 'text' },
  { name: 'title', kind: 'text' },
];

const LABELS: Record<string, string> = { type: 'Type', title: 'Title' };

/** What a rule's field is called on screen — shared with the chip bar. */
export const filterFieldLabel = (name: string): string => LABELS[name] ?? humanize(name);

/** Declared fields plus the two undeclared ones, in picker order. */
export const filterFieldsWithPseudo = (fields: FieldDef[]): FieldDef[] => [
  ...PSEUDO_FIELDS,
  ...fields,
];

const isGroup = (node: FilterRule | FilterGroup): node is FilterGroup =>
  'all' in node || 'any' in node;

const childrenOfGroup = (group: FilterGroup): (FilterRule | FilterGroup)[] =>
  'all' in group ? group.all : group.any;

const withChildren = (group: FilterGroup, next: (FilterRule | FilterGroup)[]): FilterGroup =>
  'all' in group ? { all: next } : { any: next };

/**
 * One `Where <field> <op> <value>` line. Exported because the chip bar edits
 * exactly one rule at a time and must edit it the same way this does — two
 * spellings of the same row is how the two surfaces drift apart.
 */
export function FilterRuleRow({
  rule,
  fields,
  onChange,
  onRemove,
}: {
  rule: FilterRule;
  fields: FieldDef[];
  onChange: (next: FilterRule) => void;
  onRemove: () => void;
}) {
  const all = filterFieldsWithPseudo(fields);
  const def = fields.find((f) => f.name === rule.field);
  const kind = filterKindFor(rule.field, all);
  const ops = filterOpsFor(kind);

  return (
    <div className="flex items-center gap-1.5" data-testid="filter-rule">
      <Dropdown
        size="sm"
        label="Filter property"
        width={148}
        options={all.map((f) => ({ value: f.name, label: filterFieldLabel(f.name) }))}
        value={rule.field}
        onChange={(field) => {
          // The operator is re-resolved against the NEW field's kind. Without
          // it, switching a rule from Due to Status left "is before" selected
          // on a menu that no longer offers it, so the dropdown rendered its
          // first entry while the rule on disk said something else.
          const nextKind = filterKindFor(field, all);
          onChange(coerceRuleToOp({ ...rule, field }, coerceOpForKind(rule.op, nextKind)));
        }}
      />
      <Dropdown
        size="sm"
        label="Filter operator"
        width={140}
        options={ops.map((op) => ({ value: op, label: filterOpLabel(op) }))}
        value={rule.op}
        onChange={(op) => onChange(coerceRuleToOp(rule, op as FilterOp))}
      />
      <FilterValueEditor
        def={def}
        kind={kind}
        op={rule.op}
        value={rule.value}
        onChange={(value) => onChange({ ...rule, value })}
      />
      <IconButton icon="x" label="Remove filter" size="sm" onClick={onRemove} />
    </div>
  );
}

function GroupEditor({
  group,
  fields,
  depth,
  onChange,
  onRemove,
}: {
  group: FilterGroup;
  fields: FieldDef[];
  depth: number;
  onChange: (next: FilterGroup) => void;
  onRemove?: () => void;
}) {
  const children = childrenOfGroup(group);
  const conjunction = 'all' in group ? 'all' : 'any';

  const replaceChild = (i: number, next: FilterRule | FilterGroup) =>
    onChange(
      withChildren(
        group,
        children.map((c, ci) => (ci === i ? next : c)),
      ),
    );

  return (
    <div
      data-testid="filter-group"
      className={
        depth === 0
          ? 'flex flex-col gap-1.5'
          : 'flex flex-col gap-1.5 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-25)] p-2'
      }
    >
      <div className="flex items-center gap-2">
        <Dropdown
          size="sm"
          label="Match mode"
          width={132}
          options={[
            { value: 'all', label: 'Match all' },
            { value: 'any', label: 'Match any' },
          ]}
          value={conjunction}
          onChange={(mode) =>
            onChange(mode === 'all' ? { all: [...children] } : { any: [...children] })
          }
        />
        <span className="text-[11.5px] text-[var(--n-400)]">
          {conjunction === 'all' ? 'every condition below' : 'at least one condition below'}
        </span>
        <span className="flex-1" />
        {onRemove !== undefined && (
          <IconButton icon="x" label="Remove group" size="sm" onClick={onRemove} />
        )}
      </div>
      <div className="flex flex-col gap-1.5 pl-1">
        {children.map((child, i) =>
          isGroup(child) ? (
            <GroupEditor
              key={i}
              group={child}
              fields={fields}
              depth={depth + 1}
              onChange={(next) => replaceChild(i, next)}
              onRemove={() =>
                onChange(
                  withChildren(
                    group,
                    children.filter((_, ci) => ci !== i),
                  ),
                )
              }
            />
          ) : (
            <FilterRuleRow
              key={i}
              rule={child}
              fields={fields}
              onChange={(next) => replaceChild(i, next)}
              onRemove={() =>
                onChange(
                  withChildren(
                    group,
                    children.filter((_, ci) => ci !== i),
                  ),
                )
              }
            />
          ),
        )}
        {children.length === 0 && (
          // The hint has to name what THIS group does. It used to promise
          // "shows everything" for an empty Match-any group, which hides every
          // record — so the one line on screen contradicted the empty canvas.
          <span
            className={[
              'px-1 text-[11.5px]',
              conjunction === 'any' ? 'text-[var(--warn-600)]' : 'text-[var(--n-400)]',
            ].join(' ')}
          >
            {conjunction === 'any'
              ? 'No conditions — Match any with nothing to match hides every record. Add a condition, or switch to Match all.'
              : depth === 0
                ? 'No conditions — this view shows everything in its source.'
                : 'No conditions — this group narrows nothing.'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 pl-1">
        <button
          type="button"
          onClick={() =>
            onChange(
              withChildren(group, [
                ...children,
                // Seeded NON-exclusionary. `equals ''` matched essentially no
                // record, so pressing "Add filter" blanked the view before the
                // user had chosen a field or a value — and the only text on
                // screen still said the filter showed everything. `is_not_empty`
                // is the same rule the column-header path seeds.
                seedFilterRule(fields[0]?.name ?? 'type', fields[0]?.kind ?? 'text'),
              ]),
            )
          }
          className="inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-[12px] text-[var(--n-500)] hover:bg-[var(--n-100)] hover:text-[var(--n-800)]"
        >
          <Icon name="plus" size={12} />
          Add filter
        </button>
        {depth < 2 && (
          <button
            type="button"
            // Seeded as `all`, not `any`: `[].some()` is false, so an empty
            // `any` group nested in the default top-level `all` matched
            // NOTHING and emptied the view the instant it appeared — while the
            // group's own hint said it showed everything. `[].every()` is true,
            // so an empty `all` group really is the no-op the hint promises.
            onClick={() => onChange(withChildren(group, [...children, { all: [] }]))}
            className="inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-[12px] text-[var(--n-500)] hover:bg-[var(--n-100)] hover:text-[var(--n-800)]"
          >
            <Icon name="plus" size={12} />
            Add group
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Nested AND/OR filter editor (M3.5). The engine has evaluated these groups
 * since M1 — this is the first UI that can author them, so views stop being
 * YAML-only. `null` means "no filters".
 */
export function FilterBuilder({
  filters,
  fields,
  onChange,
}: {
  filters: FilterGroup | null;
  fields: FieldDef[];
  onChange: (next: FilterGroup | null) => void;
}) {
  const group: FilterGroup = filters ?? { all: [] };
  return (
    <GroupEditor
      group={group}
      fields={fields}
      depth={0}
      onChange={(next) => onChange(childrenOfGroup(next).length === 0 ? null : next)}
    />
  );
}
