import React, { useRef, useState } from 'react';
import { DatePicker } from '@/components/ui/DatePicker';
import { Dropdown } from '@/components/ui/Dropdown';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { MenuItem, MenuSurface } from '@/components/ui/Menu';
import { useDismiss } from '@/components/ui/Popover';
import {
  DEFAULT_TIME_FORMAT,
  makeDateValue,
  parseEndpoint,
  serializeEndpoint,
} from '@/engine/dates';
import { kindMeta } from '@/engine/properties';
import { filterDateLabel, filterOpArity } from '@/engine/viewFilters';
import type { FieldDef, FieldKind, FilterOp, FilterRule, Scalar } from '@/engine/types';

/**
 * The value half of a filter rule, typed to the field (M16.25).
 *
 * It was a bare text `Input` for every operator on every kind. To filter a
 * board by status you had to know the option's SLUG and type it; to filter by
 * date you had to type an ISO string that nothing validated; `is empty` showed
 * a box that did nothing; and `is between` had one box for two bounds. The
 * value the engine reads is the same shape either way — this only changes what
 * the user has to know to produce it.
 */

const asList = (value: FilterRule['value']): Scalar[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

export interface FilterValueEditorProps {
  /** The declared field, when there is one — `type`/`title` have none. */
  def: FieldDef | undefined;
  kind: FieldKind;
  op: FilterOp;
  value: FilterRule['value'];
  onChange: (next: FilterRule['value']) => void;
  width?: number;
}

export function FilterValueEditor({
  def,
  kind,
  op,
  value,
  onChange,
  width = 150,
}: FilterValueEditorProps) {
  const arity = filterOpArity(op);
  if (arity === 'none') return null;

  const family = kindMeta(kind).filters;
  const options = def?.options ?? [];

  if (arity === 'two') {
    const [lo, hi] = [asList(value)[0], asList(value)[1]];
    const setPart = (i: 0 | 1, next: Scalar) => {
      const pair: Scalar[] = [asList(value)[0] ?? '', asList(value)[1] ?? ''];
      pair[i] = next;
      onChange(pair);
    };
    const half = Math.floor((width - 18) / 2);
    return (
      <span className="inline-flex items-center gap-1">
        <SingleValue
          def={def}
          family={family}
          options={options}
          value={lo}
          onChange={(v) => setPart(0, v)}
          width={half}
          ariaLabel="Filter value, from"
        />
        <span className="flex-none text-[11px] text-[var(--n-400)]">and</span>
        <SingleValue
          def={def}
          family={family}
          options={options}
          value={hi}
          onChange={(v) => setPart(1, v)}
          width={half}
          ariaLabel="Filter value, to"
        />
      </span>
    );
  }

  if (arity === 'list') {
    // Only an option-bearing field can offer a checklist. A relation or a
    // loose key has no closed set, so it keeps the comma-separated box —
    // which is what the placeholder has always promised.
    return options.length > 0 ? (
      <OptionChecklist
        options={options}
        selected={asList(value).map(String)}
        onChange={(next) => onChange(next)}
        width={width}
      />
    ) : (
      <Input
        size="sm"
        ariaLabel="Filter value"
        placeholder="a, b, c"
        value={asList(value).join(', ')}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== ''),
          )
        }
        width={width}
      />
    );
  }

  return (
    <SingleValue
      def={def}
      family={family}
      options={options}
      value={asList(value)[0]}
      onChange={onChange}
      width={width}
      ariaLabel="Filter value"
    />
  );
}

function SingleValue({
  def,
  family,
  options,
  value,
  onChange,
  width,
  ariaLabel,
}: {
  def: FieldDef | undefined;
  family: ReturnType<typeof kindMeta>['filters'];
  options: NonNullable<FieldDef['options']>;
  value: Scalar | undefined;
  onChange: (next: Scalar) => void;
  width: number;
  ariaLabel: string;
}) {
  if (family === 'boolean') {
    // Stored as a real boolean, because that is what a checkbox property holds
    // and `is` compares against the stored value.
    return (
      <Dropdown
        size="sm"
        label={ariaLabel}
        width={width}
        options={[
          { value: 'true', label: 'Checked' },
          { value: 'false', label: 'Unchecked' },
        ]}
        value={value === true || value === 'true' ? 'true' : 'false'}
        onChange={(v) => onChange(v === 'true')}
      />
    );
  }

  if (family === 'date') {
    return (
      <DateValue def={def} value={value} onChange={onChange} width={width} ariaLabel={ariaLabel} />
    );
  }

  if (family === 'choice' && options.length > 0) {
    return (
      <Dropdown
        size="sm"
        label={ariaLabel}
        width={width}
        options={[
          { value: '', label: 'Choose…' },
          ...options.map((o) => ({ value: o.id, label: o.label })),
        ]}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={onChange}
      />
    );
  }

  return (
    <Input
      size="sm"
      ariaLabel={ariaLabel}
      placeholder={family === 'number' ? '0' : 'value'}
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => {
        const text = e.target.value;
        if (family !== 'number') {
          onChange(text);
          return;
        }
        // Stored as a number when it is one. The engine compares numerically
        // either way, but a rule that round-trips through YAML as `5` rather
        // than `"5"` is the one a human reading the file expects.
        const n = Number(text);
        onChange(text.trim() !== '' && Number.isFinite(n) ? n : text);
      }}
      width={width}
    />
  );
}

/**
 * A date bound, picked rather than typed.
 *
 * Writes the M16.14 storage shape through `serializeEndpoint`, so a bound with
 * a time reads `2026-08-01 14:30` — the same spelling a date PROPERTY uses,
 * which is what makes the comparison in `viewFilters` meaningful.
 *
 * READS in the field's persisted format (M16.29). Storage spelling and display
 * spelling are different questions, and answering both with the stored string
 * is how one date came to render three ways on one screen: `18/08/2026` in the
 * grid, `2026-08-03` here, `Aug 3, 2026` in the picker.
 */
function DateValue({
  def,
  value,
  onChange,
  width,
  ariaLabel,
}: {
  def: FieldDef | undefined;
  value: Scalar | undefined;
  onChange: (next: Scalar) => void;
  width: number;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const parsed = parseEndpoint(value);
  const format = def?.dateFormat ?? 'short';
  const timeFormat = def?.timeFormat ?? DEFAULT_TIME_FORMAT;
  const label =
    parsed === null
      ? 'Pick a date…'
      : ((def !== undefined && value !== undefined ? filterDateLabel(value, def) : null) ??
        serializeEndpoint(parsed.date, parsed.time));

  return (
    <InlineSurface
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Filter date"
      trigger={
        <>
          <Icon name="calendar" size={12} color="var(--n-400)" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </>
      }
      triggerLabel={ariaLabel}
      empty={parsed === null}
      width={width}
      panelWidth={260}
    >
      <DatePicker
        value={{
          ...makeDateValue(parsed?.date ?? new Date().toISOString().slice(0, 10)),
          startTime: parsed?.time ?? null,
          format,
          timeFormat,
        }}
        // A filter bound is one endpoint, never a range: a range bound would
        // need the rule to say which end it meant, and `is between` already
        // says it with two bounds.
        showEndToggle={false}
        showRemind={false}
        // Date format and Time format configure the PROPERTY — the detail
        // panel writes them to the type note. There is no type note behind a
        // filter bound, so they were two controls that changed nothing; the
        // format they display now comes from the field instead (M16.29).
        showFormat={false}
        onChange={(v) => onChange(serializeEndpoint(v.start, v.startTime))}
        onClear={() => {
          onChange('');
          setOpen(false);
        }}
      />
    </InlineSurface>
  );
}

/** `is any of` over a closed option set — Notion's checklist, not a CSV box. */
function OptionChecklist({
  options,
  selected,
  onChange,
  width,
}: {
  options: NonNullable<FieldDef['options']>;
  selected: string[];
  onChange: (next: string[]) => void;
  width: number;
}) {
  const [open, setOpen] = useState(false);
  const chosen = options.filter((o) => selected.includes(o.id));

  return (
    <InlineSurface
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Filter values"
      role="menu"
      trigger={
        <>
          <span className="min-w-0 flex-1 truncate">
            {chosen.length === 0 ? 'Choose…' : chosen.map((o) => o.label).join(', ')}
          </span>
          <Icon name="chevron-down" size={12} color="var(--n-400)" />
        </>
      }
      triggerLabel="Filter values"
      empty={chosen.length === 0}
      width={width}
      panelWidth={200}
    >
      <MenuSurface>
        {options.map((o) => (
          <MenuItem
            key={o.id}
            label={o.label}
            checked={selected.includes(o.id)}
            // Stays open on select: choosing "is any of" means choosing
            // several, and a menu that closes after each one makes the second
            // choice cost a second trip.
            onSelect={() =>
              onChange(
                selected.includes(o.id) ? selected.filter((s) => s !== o.id) : [...selected, o.id],
              )
            }
          />
        ))}
      </MenuSurface>
    </InlineSurface>
  );
}

/**
 * An anchored surface that stays in its own DOM subtree.
 *
 * `Popover` PORTALS to `document.body`, which is right for a surface opened
 * from the page and wrong for one opened from inside another popover: the
 * outer surface's outside-press check is `surfaceRef.contains(target)`, and a
 * portalled child is not a descendant. Pressing a day in a portalled date
 * picker therefore closed the rule editor it was opened from, unmounting the
 * picker mid-gesture. `useDismiss` is the same contract without the
 * positioning — the split M16.1 made for exactly this — and the panel renders
 * in place, the way `Dropdown`'s listbox already does.
 */
function InlineSurface({
  open,
  onOpenChange,
  trigger,
  triggerLabel,
  ariaLabel,
  role = 'dialog',
  empty,
  width,
  panelWidth,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  triggerLabel: string;
  ariaLabel: string;
  role?: 'dialog' | 'menu';
  empty: boolean;
  width: number;
  panelWidth: number;
  children: React.ReactNode;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  return (
    <span className="relative inline-flex">
      <button
        ref={anchor}
        type="button"
        aria-label={triggerLabel}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        style={{ width }}
        className={[
          'inline-flex h-7 items-center gap-1.5 overflow-hidden rounded-md border border-[var(--n-200)] bg-[var(--n-0)] px-2 text-left text-[12px] hover:border-[var(--n-400)]',
          empty ? 'text-[var(--n-400)]' : 'text-[var(--n-800)]',
        ].join(' ')}
      >
        {trigger}
      </button>
      {open && (
        <SurfacePanel
          panelRef={panel}
          anchorRef={anchor}
          onClose={() => onOpenChange(false)}
          role={role}
          ariaLabel={ariaLabel}
          width={panelWidth}
        >
          {children}
        </SurfacePanel>
      )}
    </span>
  );
}

/** Split so `useDismiss` mounts with the panel and unregisters its layer when
 * the panel closes — a hook called unconditionally in the parent would keep a
 * layer open for a surface that is not. */
function SurfacePanel({
  panelRef,
  anchorRef,
  onClose,
  role,
  ariaLabel,
  width,
  children,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  role: 'dialog' | 'menu';
  ariaLabel: string;
  width: number;
  children: React.ReactNode;
}) {
  useDismiss({ onClose, surfaceRef: panelRef, anchorEl: () => anchorRef.current });
  return (
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      style={{ width }}
      className="absolute left-0 top-full z-50 mt-1 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-2 shadow-[var(--shadow-lg)]"
    >
      {children}
    </div>
  );
}
