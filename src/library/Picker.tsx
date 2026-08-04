import { useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { quickOpenScore } from '@/lib/quickOpenScore';

/**
 * Pick from what exists, instead of typing it from memory (M18.4).
 *
 * Every boundary in the agent builder was a comma-separated text box: folders,
 * tools, connectors. That is the same mistake as the generic property table one
 * level in — it asks the person to hold the vault's folder list and thirteen
 * tool identifiers in their head, and it fails SILENTLY when they get one
 * wrong. `allowed-tools: [get_notes]` (plural, and wrong) does not error; it
 * narrows the run to nothing, which on screen is indistinguishable from a model
 * that decided not to act.
 *
 * So: one picker, three uses. Search, grouped options, a whole group in one
 * click, chips for what is chosen, and — the part a text box can never do —
 * anything already in the file that this vault does not recognise is shown as
 * unrecognised rather than quietly dropped on the next save.
 */

export interface PickerOption {
  value: string;
  label: string;
  /** One line under the label. What this option MEANS, not what it is called. */
  hint?: string;
  /** Right-aligned, for a count or a kind. */
  meta?: string;
  icon?: string;
  /** Groups render with a header that selects the whole group. */
  group?: string;
}

export function Picker({
  options,
  selected,
  onChange,
  addLabel,
  emptyLabel,
  ariaLabel,
  testId,
  groupHint,
}: {
  options: PickerOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** The button when nothing is chosen — say what will be picked. */
  addLabel: string;
  /** Shown in place of chips when the list is empty AND that means something. */
  emptyLabel: string;
  ariaLabel: string;
  testId?: string;
  /** Per-group explanation, keyed by group name. */
  groupHint?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchor = useRef<HTMLButtonElement>(null);

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  // Anything selected that this vault does not offer. Kept, shown, and
  // removable — never silently dropped, because dropping one would rewrite
  // the user's policy behind their back on the next save.
  const unknown = selected.filter((v) => !byValue.has(v));

  const groups = useMemo(() => {
    const shown = options.filter(
      (o) => query.trim() === '' || quickOpenScore(query.trim(), `${o.label} ${o.hint ?? ''}`) > 0,
    );
    const out = new Map<string, PickerOption[]>();
    for (const option of shown) {
      const key = option.group ?? '';
      out.set(key, [...(out.get(key) ?? []), option]);
    }
    return [...out.entries()];
  }, [options, query]);

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  const toggleGroup = (members: PickerOption[]) => {
    const values = members.map((m) => m.value);
    const allOn = values.every((v) => selected.includes(v));
    onChange(
      allOn
        ? selected.filter((v) => !values.includes(v))
        : [...selected, ...values.filter((v) => !selected.includes(v))],
    );
  };

  return (
    <div data-testid={testId}>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.length === 0 && (
          <span className="text-xs text-n-500" data-testid="picker-empty">
            {emptyLabel}
          </span>
        )}
        {selected.map((value) => {
          const option = byValue.get(value);
          return (
            <span
              key={value}
              data-testid="picker-chip"
              data-unknown={option === undefined}
              className={`inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-1 text-2xs ${
                option === undefined
                  ? 'border-danger-300 bg-danger-50 text-danger-700'
                  : 'border-n-200 bg-n-25 text-n-700'
              }`}
              title={option?.hint ?? 'Not something this vault has — it will do nothing.'}
            >
              {option?.icon !== undefined && <Icon name={option.icon} size={11} />}
              <span className="truncate">{option?.label ?? value}</span>
              <button
                type="button"
                aria-label={`Remove ${option?.label ?? value}`}
                onClick={() => onChange(selected.filter((v) => v !== value))}
                className="rounded border-0 bg-transparent p-0 text-n-400 hover:text-n-700"
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          ref={anchor}
          data-testid="picker-add"
          onClick={() => {
            setQuery('');
            setOpen(true);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-n-300 bg-transparent px-1.5 py-1 text-2xs text-n-600 hover:border-n-400 hover:bg-n-25"
        >
          <Icon name="plus" size={11} />
          {addLabel}
        </button>
      </div>

      {unknown.length > 0 && (
        <p className="m-0 mt-1.5 text-2xs leading-[15px] text-danger-600" role="alert">
          {unknown.length === 1 ? 'This name is' : 'These names are'} not something this vault has:{' '}
          {unknown.join(', ')}. Kept as written — remove {unknown.length === 1 ? 'it' : 'them'} or
          fix the file.
        </p>
      )}

      {open && (
        <Popover
          anchorRef={anchor}
          role="dialog"
          ariaLabel={ariaLabel}
          trapFocus
          onClose={() => setOpen(false)}
          // Popover owns placement and dismissal, never chrome — the surface
          // is the caller's, the same way MenuSurface supplies it for menus.
          className="w-[330px] overflow-hidden rounded-lg border border-n-200 bg-n-0 shadow-[var(--shadow-lg)]"
        >
          <div className="border-b border-n-100 p-1.5">
            <input
              autoFocus
              value={query}
              aria-label={`Search ${ariaLabel.toLowerCase()}`}
              placeholder="Search…"
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-md border border-n-200 px-2 py-1.5 text-xs text-n-800 outline-none placeholder:text-n-400 focus-visible:border-cortex-400"
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto p-1">
            {groups.length === 0 && (
              <p className="m-0 px-2 py-3 text-center text-xs text-n-500">Nothing matches that.</p>
            )}
            {groups.map(([group, members]) => (
              <div key={group}>
                {group !== '' && (
                  <button
                    type="button"
                    data-testid="picker-group"
                    onClick={() => toggleGroup(members)}
                    className="mt-1 flex w-full items-baseline gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-left hover:bg-n-50"
                  >
                    <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
                      {group}
                    </span>
                    <span className="text-2xs text-n-400">
                      {members.every((m) => selected.includes(m.value)) ? 'none' : 'all'}
                    </span>
                    {groupHint?.[group] !== undefined && (
                      <span className="min-w-0 flex-1 truncate text-2xs text-n-400">
                        {groupHint[group]}
                      </span>
                    )}
                  </button>
                )}
                {members.map((option) => (
                  <label
                    key={option.value}
                    data-testid="picker-option"
                    className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-n-50"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(option.value)}
                      onChange={() => toggle(option.value)}
                      className="mt-0.5 h-3.5 w-3.5 flex-none accent-[var(--cortex-500)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        {option.icon !== undefined && (
                          <Icon name={option.icon} size={12} color="var(--n-500)" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-xs text-n-800">
                          {option.label}
                        </span>
                        {option.meta !== undefined && (
                          <span className="flex-none text-2xs text-n-400">{option.meta}</span>
                        )}
                      </span>
                      {option.hint !== undefined && (
                        <span className="mt-0.5 block text-2xs leading-[15px] text-n-500">
                          {option.hint}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-n-100 px-2 py-1.5">
            <span className="flex-1 text-2xs text-n-500">{selected.length} selected</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border-0 bg-transparent px-2 py-1 text-2xs text-n-600 hover:bg-n-50 hover:text-n-900"
            >
              Done
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}
