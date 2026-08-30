import React, { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Tooltip } from '@/components/ui/Tooltip';
import { moveOption, optionId } from '@/engine/properties';
import type { FieldOption } from '@/engine/types';
import { useSortableList, type GripProps } from '@/hooks/useSortableList';
import { OPTION_COLORS, PICKABLE_OPTION_COLORS, resolveOptionColor } from '@/lib/swatch';
import { useUiStore } from '@/stores/uiStore';

// `optionId` moved to engine/properties (M16.12) — a domain slug exported from
// a .tsx file is why FieldPopover's create row could not see it and compared
// labels instead. Re-exported so the existing importers keep working.
export { optionId };

/**
 * Swatch grid used by both the option editor and the status editor.
 *
 * Notion's ten NAMED colours (M16.12), where this was eight unnamed hexes —
 * one of them `#A8AFC2`, the exact value M15 pulled out of the neutral ramp
 * for failing even the 3:1 non-text floor, still shipping as a pickable
 * option colour.
 *
 * `Default` picks NULL, never the word: `optionToSpec` drops a null colour so
 * an uncoloured option round-trips through YAML as a bare string rather than
 * growing into a mapping.
 */
function ColorPicker({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (color: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 pt-1.5">
      {OPTION_COLORS.map((name) => {
        const sw = resolveOptionColor(name);
        const picked = name === 'default' ? value === null || value === 'default' : value === name;
        return (
          <Tooltip key={name} label={name === 'default' ? 'Default' : name} delayMs={250}>
            <button
              type="button"
              // The name, not a hex — "Use color #DE3B4E" was never readable.
              aria-label={`Use color ${name}`}
              aria-pressed={picked}
              onClick={() => onPick(name === 'default' ? null : name)}
              className="h-4 w-4 rounded-full border-0 p-0"
              style={{
                background: sw.solid,
                outline: picked ? '2px solid var(--n-900)' : 'none',
                outlineOffset: 1,
              }}
            />
          </Tooltip>
        );
      })}
    </div>
  );
}

/** The colour a fresh option gets, cycling the nine real hues — `default` is
 * the absence of a choice, not a step in the rotation. */
function nextOptionColor(index: number): string {
  return PICKABLE_OPTION_COLORS[index % PICKABLE_OPTION_COLORS.length];
}

/** One option row: grip to reorder, click the label to rename, the dot to
 * recolor, x to drop. */
function OptionRow({
  option,
  onChange,
  onRemove,
  grip,
  style,
}: {
  option: FieldOption;
  onChange: (next: FieldOption) => void;
  onRemove: () => void;
  grip?: GripProps;
  style?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(option.label);
  const [picking, setPicking] = useState(false);

  const commit = () => {
    const label = draft.trim();
    setEditing(false);
    if (label === '' || label === option.label) {
      setDraft(option.label);
      return;
    }
    // The id stays put: records already store it, and renaming the label is
    // a display change, not a data migration.
    onChange({ ...option, label });
  };

  return (
    <div style={style} className="group flex flex-col rounded-md px-1 py-1 hover:bg-n-25">
      <div className="flex items-center gap-2">
        {grip !== undefined && (
          <span
            {...grip}
            className="flex flex-none cursor-grab items-center justify-center rounded-xs text-n-300 opacity-0 hover:text-n-600 focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Icon name="grip-vertical" size={12} />
          </span>
        )}
        <button
          type="button"
          aria-label={`Change color of ${option.label}`}
          onClick={() => setPicking(!picking)}
          className="h-3.5 w-3.5 flex-none rounded-full border-0 p-0"
          style={{
            background:
              option.color === null ? 'var(--n-200)' : resolveOptionColor(option.color).solid,
            outline: picking ? '2px solid var(--cortex-500)' : 'none',
            outlineOffset: 1,
          }}
        />
        {editing ? (
          <Input
            autoFocus
            size="sm"
            ariaLabel={`Rename ${option.label}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setDraft(option.label);
                setEditing(false);
              }
            }}
            className="min-w-0 flex-1"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="min-w-0 flex-1 truncate rounded-md border-0 bg-transparent px-0 py-0.5 text-left text-sm text-n-800"
          >
            {option.label}
          </button>
        )}
        {/* Revealed on hover OR focus. `hidden group-hover:` kept the button
            out of the tab order entirely, so an option could not be removed
            from the keyboard at all. */}
        <span className="inline-flex flex-none opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <IconButton icon="x" label={`Remove ${option.label}`} size="sm" onClick={onRemove} />
        </span>
      </div>
      {picking && (
        <ColorPicker
          value={option.color}
          onPick={(color) => {
            onChange({ ...option, color });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Editable option set for select / multi-select fields (M3.1): rename,
 * recolor, remove, and append. The caller owns persistence — it receives the
 * whole next list, matching the `options:` YAML the Type doc stores.
 */
export function OptionListEditor({
  options,
  label,
  onChange,
}: {
  options: FieldOption[];
  /** Field name, for accessible labels on the add input. */
  label: string;
  onChange: (next: FieldOption[]) => void;
}) {
  const [adding, setAdding] = useState('');

  // Reordering is the option set's ORDER on the type — it drives the picker,
  // the board's columns and every group band. Persistence is free:
  // setFieldOptions already writes the whole list.
  const sortable = useSortableList({
    ids: options.map((o) => o.id),
    labelFor: (id) => options.find((o) => o.id === id)?.label ?? id,
    onReorder: (id, to) =>
      onChange(
        moveOption(
          options,
          options.findIndex((o) => o.id === id),
          to,
        ),
      ),
  });

  const append = () => {
    const text = adding.trim();
    if (text === '') return;
    const id = optionId(text);
    // A collision used to clear the input and return silently, which read as
    // the app dropping input at random. Keep the draft and say what happened
    // — ids are slugged, so "In Progress" and "in-progress" collide.
    if (options.some((o) => o.id === id)) {
      useUiStore.getState().toast(`"${text}" already exists`);
      return;
    }
    setAdding('');
    onChange([...options, { id, label: text, color: nextOptionColor(options.length) }]);
  };

  return (
    <div className="flex flex-col gap-0.5 pl-0.5">
      {/* The rows get their OWN container: useSortableList measures
          `containerRef.current.children` as the rows, and the empty-state
          span and the add-row below are siblings — dropping the ref on the
          outer column would make the add input a droppable slot. */}
      <div
        ref={sortable.containerRef as React.RefObject<HTMLDivElement>}
        className="flex flex-col gap-0.5"
        style={sortable.containerStyle}
      >
        {options.map((o, i) => (
          <OptionRow
            key={o.id}
            option={o}
            grip={sortable.gripProps(o.id, i)}
            style={sortable.rowStyle(i)}
            onChange={(next) => onChange(options.map((x, xi) => (xi === i ? next : x)))}
            onRemove={() => onChange(options.filter((_, xi) => xi !== i))}
          />
        ))}
      </div>
      {options.length === 0 && (
        <span className="px-1 py-0.5 text-xs text-n-400">
          No options yet — add the first one below.
        </span>
      )}
      <div className="flex items-center gap-1.5 pl-1 pt-1">
        <Icon name="plus" size={12} color="var(--n-400)" />
        <Input
          size="sm"
          ariaLabel={`Add option to ${label}`}
          placeholder="Add option…"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onBlur={append}
          onKeyDown={(e) => {
            if (e.key === 'Enter') append();
          }}
          width={160}
        />
      </div>
    </div>
  );
}

export { ColorPicker };
