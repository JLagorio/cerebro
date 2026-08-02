import { Dropdown } from '@/components/ui/Dropdown';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { humanize } from '@/engine/schema';
import type { FieldDef, FilterGroup, FilterOp, FilterRule } from '@/engine/types';

/** Operators, with whether they take a value input. */
const OPS: { op: FilterOp; label: string; valueless?: boolean }[] = [
  { op: 'equals', label: 'is' },
  { op: 'not_equals', label: 'is not' },
  { op: 'contains', label: 'contains' },
  { op: 'any_of', label: 'is any of' },
  { op: 'none_of', label: 'is none of' },
  { op: 'is_empty', label: 'is empty', valueless: true },
  { op: 'is_not_empty', label: 'is not empty', valueless: true },
  { op: 'before', label: 'is before' },
  { op: 'after', label: 'is after' },
];

const isGroup = (node: FilterRule | FilterGroup): node is FilterGroup =>
  'all' in node || 'any' in node;

const childrenOfGroup = (group: FilterGroup): (FilterRule | FilterGroup)[] =>
  'all' in group ? group.all : group.any;

const withChildren = (group: FilterGroup, next: (FilterRule | FilterGroup)[]): FilterGroup =>
  'all' in group ? { all: next } : { any: next };

/** Comma-separated text ⇄ the list value the any_of/none_of ops expect. */
const valueToText = (value: FilterRule['value']): string =>
  Array.isArray(value)
    ? value.join(', ')
    : value === undefined || value === null
      ? ''
      : String(value);

function textToValue(text: string, op: FilterOp): FilterRule['value'] {
  if (op === 'any_of' || op === 'none_of') {
    return text
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  return text;
}

function RuleRow({
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
  const meta = OPS.find((o) => o.op === rule.op) ?? OPS[0];
  // `type` and `title` aren't declared properties but are filterable — the
  // engine's fieldValue() resolves them off the entry itself.
  const fieldOptions = [
    { value: 'type', label: 'Type' },
    { value: 'title', label: 'Title' },
    ...fields.map((f) => ({ value: f.name, label: humanize(f.name) })),
  ];

  return (
    <div className="flex items-center gap-1.5" data-testid="filter-rule">
      <Dropdown
        size="sm"
        label="Filter property"
        width={148}
        options={fieldOptions}
        value={rule.field}
        onChange={(field) => onChange({ ...rule, field })}
      />
      <Dropdown
        size="sm"
        label="Filter operator"
        width={128}
        options={OPS.map((o) => ({ value: o.op, label: o.label }))}
        value={rule.op}
        onChange={(op) => {
          const next: FilterRule = { ...rule, op: op as FilterOp };
          const nextMeta = OPS.find((o) => o.op === op);
          if (nextMeta?.valueless === true) delete next.value;
          onChange(next);
        }}
      />
      {meta.valueless !== true && (
        <Input
          size="sm"
          ariaLabel="Filter value"
          placeholder={rule.op === 'any_of' || rule.op === 'none_of' ? 'a, b, c' : 'value'}
          value={valueToText(rule.value)}
          onChange={(e) => onChange({ ...rule, value: textToValue(e.target.value, rule.op) })}
          width={150}
        />
      )}
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
            <RuleRow
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
                { field: fields[0]?.name ?? 'type', op: 'is_not_empty' },
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
