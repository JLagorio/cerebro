import { useState } from 'react';
import { TYPE_COLORS } from '@/app/TypeDialogs';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import type { FieldOption } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';

/** Stable id for a freshly typed label; ids are what records store. */
export const optionId = (label: string) => label.trim().replace(/\s+/g, '-').toLowerCase();

/** Swatch grid used by both the option editor and the status editor. */
function ColorPicker({ value, onPick }: { value: string | null; onPick: (color: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1 pt-1.5">
      {TYPE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Use color ${c}`}
          onClick={() => onPick(c)}
          className="h-4 w-4 rounded-full border-0 p-0"
          style={{
            background: c,
            outline: value === c ? '2px solid var(--n-900)' : 'none',
            outlineOffset: 1,
          }}
        />
      ))}
    </div>
  );
}

/** One option row: click the label to rename, the dot to recolor, x to drop. */
function OptionRow({
  option,
  onChange,
  onRemove,
}: {
  option: FieldOption;
  onChange: (next: FieldOption) => void;
  onRemove: () => void;
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
    <div className="group flex flex-col rounded-md px-1 py-1 hover:bg-[var(--n-25)]">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Change color of ${option.label}`}
          onClick={() => setPicking(!picking)}
          className="h-3.5 w-3.5 flex-none rounded-full border-0 p-0"
          style={{
            background: option.color ?? 'var(--n-200)',
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
            className="min-w-0 flex-1 truncate rounded-md border-0 bg-transparent px-0 py-0.5 text-left text-[12.5px] text-[var(--n-800)]"
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
    onChange([
      ...options,
      { id, label: text, color: TYPE_COLORS[options.length % TYPE_COLORS.length] },
    ]);
  };

  return (
    <div className="flex flex-col gap-0.5 pl-0.5">
      {options.map((o, i) => (
        <OptionRow
          key={o.id}
          option={o}
          onChange={(next) => onChange(options.map((x, xi) => (xi === i ? next : x)))}
          onRemove={() => onChange(options.filter((_, xi) => xi !== i))}
        />
      ))}
      {options.length === 0 && (
        <span className="px-1 py-0.5 text-[11.5px] text-[var(--n-400)]">
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
