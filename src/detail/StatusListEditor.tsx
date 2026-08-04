import React, { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Tooltip } from '@/components/ui/Tooltip';
import { ColorPicker } from '@/detail/OptionListEditor';
import { moveOption, optionId } from '@/engine/properties';
import type { StatusDef } from '@/engine/types';
import { useSortableList, type GripProps } from '@/hooks/useSortableList';
import { PICKABLE_OPTION_COLORS, resolveOptionColor } from '@/lib/swatch';
import { useUiStore } from '@/stores/uiStore';

/** The three lifecycle buckets every status belongs to (engine contract). */
const GROUPS: { group: StatusDef['group']; label: string; hint: string }[] = [
  { group: 'active', label: 'To do / In progress', hint: 'Work that is still open' },
  { group: 'done', label: 'Complete', hint: 'Finished successfully' },
  { group: 'closed', label: 'Closed', hint: 'Dropped, cancelled, or duplicate' },
];

function StatusRow({
  status,
  onChange,
  onRemove,
  grip,
  dragging = false,
  style,
}: {
  status: StatusDef;
  onChange: (next: StatusDef) => void;
  onRemove: () => void;
  grip?: GripProps;
  dragging?: boolean;
  style?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(status.label);
  const [picking, setPicking] = useState(false);

  const commit = () => {
    const label = draft.trim();
    setEditing(false);
    if (label === '' || label === status.label) {
      setDraft(status.label);
      return;
    }
    // Renaming is display-only — the id is what records store.
    onChange({ ...status, label });
  };

  const dot = status.color === null ? 'var(--n-300)' : resolveOptionColor(status.color).solid;
  return (
    <div
      style={style}
      className={`group flex flex-col rounded-md px-1 py-1 hover:bg-n-25 ${dragging ? 'opacity-40' : ''}`}
    >
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
          aria-label={`Change color of ${status.label}`}
          onClick={() => setPicking(!picking)}
          className="box-border h-3.5 w-3.5 flex-none rounded-full border-0 p-0"
          style={
            status.hollow === true
              ? { background: 'transparent', border: `2px solid ${dot}` }
              : { background: dot }
          }
        />
        {editing ? (
          <Input
            autoFocus
            size="sm"
            ariaLabel={`Rename ${status.label}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setDraft(status.label);
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
            {status.label}
          </button>
        )}
        <span className="[font-family:var(--font-mono)] text-2xs text-n-300">{status.id}</span>
        {/* Revealed on hover OR focus — see OptionListEditor: `hidden` took
            the remove button out of the tab order entirely. */}
        <span className="inline-flex flex-none opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <IconButton icon="x" label={`Remove ${status.label}`} size="sm" onClick={onRemove} />
        </span>
      </div>
      {picking && (
        <ColorPicker
          value={status.color}
          onPick={(color) => {
            onChange({ ...status, color });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Status set editor (M3.1): the workflow a type's records move through,
 * grouped by lifecycle bucket the way boards and rollups read them. Statuses
 * are stored on the Type doc as `statuses:`; the caller persists the whole
 * next list.
 */
/**
 * Put a reordered lifecycle bucket back into the flat list, in the slots that
 * bucket already occupied (M16.12).
 *
 * The engine contract is one flat `statuses:` array whose ORDER is the
 * workflow; the editor renders it as three buckets. Reordering inside a
 * bucket must not disturb where the buckets interleave, so the positions are
 * held and only their contents are replaced.
 */
export function spliceGroup(
  all: StatusDef[],
  group: StatusDef['group'],
  reordered: StatusDef[],
): StatusDef[] {
  let take = 0;
  return all.map((s) => (s.group === group ? (reordered[take++] ?? s) : s));
}

/**
 * One lifecycle bucket. Extracted from the `GROUPS.map` body because
 * `useSortableList` cannot be called inside a loop — one hook per bucket is
 * the only shape the rules of hooks allow, and it is also the right one:
 * dragging a status across buckets would change its lifecycle meaning, which
 * is a different action from reordering.
 */
function StatusGroup({
  label,
  hint,
  rows,
  adding,
  draft,
  onDraft,
  onStartAdd,
  onCancelAdd,
  onCommitAdd,
  onChangeRow,
  onRemoveRow,
  onReorder,
}: {
  label: string;
  hint: string;
  rows: StatusDef[];
  adding: boolean;
  draft: string;
  onDraft: (v: string) => void;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  onCommitAdd: () => void;
  onChangeRow: (target: StatusDef, next: StatusDef) => void;
  onRemoveRow: (target: StatusDef) => void;
  onReorder: (next: StatusDef[]) => void;
}) {
  const sortable = useSortableList({
    ids: rows.map((s) => s.id),
    labelFor: (id) => rows.find((s) => s.id === id)?.label ?? id,
    onReorder: (id, to) =>
      onReorder(
        moveOption(
          rows,
          rows.findIndex((s) => s.id === id),
          to,
        ),
      ),
  });

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 px-1">
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
          {label}
        </span>
        <Tooltip label={hint}>
          <span className="inline-flex text-n-300">
            <Icon name="info" size={11} />
          </span>
        </Tooltip>
        <span className="flex-1" />
        <IconButton icon="plus" label={`Add status to ${label}`} size="sm" onClick={onStartAdd} />
      </div>
      <div ref={sortable.containerRef as React.RefObject<HTMLDivElement>} className="flex flex-col">
        {rows.map((s, i) => (
          <StatusRow
            key={s.id}
            status={s}
            grip={sortable.gripProps(s.id, i)}
            dragging={sortable.dragging === s.id}
            style={sortable.dropIndicator(i)}
            onChange={(next) => onChangeRow(s, next)}
            onRemove={() => onRemoveRow(s)}
          />
        ))}
      </div>
      {rows.length === 0 && !adding && (
        <span className="px-1 py-0.5 text-xs text-n-400">None yet</span>
      )}
      {adding && (
        <div className="px-1 py-1">
          <Input
            autoFocus
            size="sm"
            ariaLabel={`New status in ${label}`}
            placeholder="Status name…"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onBlur={onCommitAdd}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') onCancelAdd();
            }}
            width={180}
          />
        </div>
      )}
    </div>
  );
}

export function StatusListEditor({
  statuses,
  onChange,
}: {
  statuses: StatusDef[];
  onChange: (next: StatusDef[]) => void;
}) {
  const [addingIn, setAddingIn] = useState<StatusDef['group'] | null>(null);
  const [draft, setDraft] = useState('');

  const append = (group: StatusDef['group']) => {
    const text = draft.trim();
    const id = optionId(text);
    // A collision used to clear the input and return silently. The colliding
    // status is often in a different lifecycle group and off-screen, so the
    // only signal the user got was their text vanishing. Keep it, and say so.
    if (text !== '' && statuses.some((s) => s.id === id)) {
      useUiStore.getState().toast(`"${text}" already exists`);
      return;
    }
    setDraft('');
    setAddingIn(null);
    if (text === '') return;
    onChange([
      ...statuses,
      {
        id,
        label: text,
        color: PICKABLE_OPTION_COLORS[statuses.length % PICKABLE_OPTION_COLORS.length],
        group,
      },
    ]);
  };

  const replace = (target: StatusDef, next: StatusDef) =>
    onChange(statuses.map((s) => (s.id === target.id ? next : s)));

  return (
    <div className="flex flex-col gap-2 pl-0.5">
      {GROUPS.map(({ group, label, hint }) => {
        const rows = statuses.filter((s) => s.group === group);
        return (
          <StatusGroup
            key={group}
            label={label}
            hint={hint}
            rows={rows}
            adding={addingIn === group}
            draft={draft}
            onDraft={setDraft}
            onStartAdd={() => {
              setDraft('');
              setAddingIn(group);
            }}
            onCancelAdd={() => {
              setDraft('');
              setAddingIn(null);
            }}
            onCommitAdd={() => append(group)}
            onChangeRow={replace}
            onRemoveRow={(s) => onChange(statuses.filter((x) => x.id !== s.id))}
            onReorder={(next) => onChange(spliceGroup(statuses, group, next))}
          />
        );
      })}
    </div>
  );
}
