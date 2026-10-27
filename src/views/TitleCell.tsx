import { useEffect, useRef, useState } from 'react';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { FocusedFieldInput } from '@/editor/FocusedFieldInput';
import { SelectedTitleInput } from '@/editor/SelectedTitleInput';
import {
  fieldKey,
  unresolvedField,
  retainedField,
  type FieldSaveParticipant,
} from '@/editor/fieldSaveParticipant';
import { flushOpenPageBodies, heldOpenPageBodies } from '@/editor/openPages';
import { TABLE_ANATOMY } from './tableAnatomy';
// Only an unacknowledged attempted value can be an optimistic echo. Another
// corrected value may still be a true no-op after checking current dependencies.
const attemptedMutations = new WeakMap<FieldSaveParticipant, Map<string, number>>();
export function TitleCell(props: {
  entry: Entry;
  onCommit: (title: string) => Promise<boolean>;
  onEditingChange?: (editing: boolean) => void;
}) {
  const vault = useVaultStore((state) => state.vaultPath);
  return <TitleCellValue key={`${vault}:${props.entry.path}`} {...props} vault={vault} />;
}
function TitleCellValue({
  entry,
  onCommit,
  onEditingChange,
  vault,
}: {
  entry: Entry;
  onCommit: (title: string) => Promise<boolean>;
  onEditingChange?: (editing: boolean) => void;
  vault: string | null;
}) {
  const identity = fieldKey(vault ?? '', entry.path, 'title');
  const [editing, setEditing] = useState(() => unresolvedField(identity) !== undefined);
  const lease = useRef(onEditingChange);
  lease.current = onEditingChange;
  useEffect(() => {
    lease.current?.(editing);
  }, [editing]);
  useEffect(() => () => lease.current?.(false), []);
  if (!editing)
    return (
      <button
        type="button"
        data-cell-primary
        onClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
        className={TABLE_ANATOMY.title}
      >
        {entry.title}
      </button>
    );
  if (entry.authority?.kind === 'sqlite_metadata')
    return vault === null ? <span role="status">Open the original vault to edit this title.</span> :
      <SelectedTitleInput key={entry.authority.workspaceId + ':' + entry.authority.recordId} entry={entry} vault={vault} onEnd={() => setEditing(false)} />;
  return (
    <FocusedFieldInput
      identity={identity}
      initial={entry.title}
      label="Title"
      pendingText="Saving title…"
      validate={(text) =>
        text.trim() === ''
          ? { ok: false, error: 'Enter a title. Your draft is kept.' }
          : { ok: true, value: text.trim() }
      }
      write={async (value) => {
        const currentTarget = () => {
          const state = useVaultStore.getState();
          return vault !== null &&
            state.vaultPath === vault &&
            state.entriesVault === vault &&
            state.status === 'ready'
            ? state.entries.find((target) => target.path === entry.path)
            : undefined;
        };
        const target = currentTarget();
        if (target === undefined) return false;
        const title = String(value),
          owner = retainedField(identity);
        const attemptedGeneration =
          owner === undefined ? undefined : attemptedMutations.get(owner)?.get(title);
        const unacknowledgedAttempt =
          owner !== undefined &&
          attemptedGeneration !== undefined &&
          attemptedGeneration > owner.snapshot().acknowledgedGeneration;
        if (target.title === title && !unacknowledgedAttempt) {
          // An unchanged field still depends on its body. A blocked body or a
          // switched/missing target cannot authorize a semantic clean result.
          const report = await flushOpenPageBodies();
          if (report.unresolvedOwnerIds.length > 0 || heldOpenPageBodies().includes(entry.path))
            return false;
          const settledTarget = currentTarget();
          if (settledTarget === undefined) return false;
          if (settledTarget.title === title) return 'unchanged';
        }
        if (owner !== undefined) {
          const attempts = attemptedMutations.get(owner) ?? new Map<string, number>();
          const state = owner.snapshot();
          attempts.set(title, state.inFlightGeneration ?? state.generation);
          attemptedMutations.set(owner, attempts);
        }
        const result = await onCommit(title);
        if (result && owner !== undefined) attemptedMutations.delete(owner);
        return result;
      }}
      onEnd={() => setEditing(false)}
      className="h-7 min-w-0 flex-1 rounded-md border border-cortex-500 px-1.5 text-ui text-n-900 shadow-[var(--ring)] outline-none"
    />
  );
}
