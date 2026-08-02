import { useState } from 'react';
import { TYPE_COLORS } from '@/app/TypeDialogs';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { ColorPicker, optionId } from '@/detail/OptionListEditor';
import type { StatusDef } from '@/engine/types';
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
}: {
  status: StatusDef;
  onChange: (next: StatusDef) => void;
  onRemove: () => void;
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

  return (
    <div className="group flex flex-col rounded-md px-1 py-1 hover:bg-[var(--n-25)]">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Change color of ${status.label}`}
          onClick={() => setPicking(!picking)}
          className="box-border h-3.5 w-3.5 flex-none rounded-full border-0 p-0"
          style={
            status.hollow === true
              ? { background: 'transparent', border: `2px solid ${status.color ?? 'var(--n-300)'}` }
              : { background: status.color ?? 'var(--n-300)' }
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
            className="min-w-0 flex-1 truncate rounded-md border-0 bg-transparent px-0 py-0.5 text-left text-[12.5px] text-[var(--n-800)]"
          >
            {status.label}
          </button>
        )}
        <span className="[font-family:var(--font-mono)] text-[10.5px] text-[var(--n-300)]">
          {status.id}
        </span>
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
      { id, label: text, color: TYPE_COLORS[statuses.length % TYPE_COLORS.length], group },
    ]);
  };

  const replace = (target: StatusDef, next: StatusDef) =>
    onChange(statuses.map((s) => (s.id === target.id ? next : s)));

  return (
    <div className="flex flex-col gap-2 pl-0.5">
      {GROUPS.map(({ group, label, hint }) => {
        const rows = statuses.filter((s) => s.group === group);
        return (
          <div key={group} className="flex flex-col">
            <div className="flex items-center gap-1.5 px-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
                {label}
              </span>
              <span title={hint} className="inline-flex text-[var(--n-300)]">
                <Icon name="info" size={11} />
              </span>
              <span className="flex-1" />
              <IconButton
                icon="plus"
                label={`Add status to ${label}`}
                size="sm"
                onClick={() => {
                  setDraft('');
                  setAddingIn(group);
                }}
              />
            </div>
            {rows.map((s) => (
              <StatusRow
                key={s.id}
                status={s}
                onChange={(next) => replace(s, next)}
                onRemove={() => onChange(statuses.filter((x) => x.id !== s.id))}
              />
            ))}
            {rows.length === 0 && addingIn !== group && (
              <span className="px-1 py-0.5 text-[11.5px] text-[var(--n-400)]">None yet</span>
            )}
            {addingIn === group && (
              <div className="px-1 py-1">
                <Input
                  autoFocus
                  size="sm"
                  ariaLabel={`New status in ${label}`}
                  placeholder="Status name…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => append(group)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') {
                      setDraft('');
                      setAddingIn(null);
                    }
                  }}
                  width={180}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
