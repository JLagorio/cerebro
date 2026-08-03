import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { createCollection, updateCollection } from '@/app/listActions';
import type { CollectionFile } from '@/engine/types';

/**
 * Name a Collection (M10) — create, or rename an existing one.
 *
 * A rename changes the display name only; the folder keeps its slug. Moving the
 * folder would have to move every List and Doc inside it, and a label is not
 * worth that blast radius — the name on screen and the path on disk are allowed
 * to drift, the same way a note's title and filename already do.
 */
export function CollectionDialog({
  state,
  onClose,
  onCreated,
}: {
  state: { mode: 'new' } | { mode: 'rename'; collection: CollectionFile };
  onClose: () => void;
  onCreated?: (folder: string) => void;
}) {
  const existing = state.mode === 'rename' ? state.collection.definition.name : '';
  const [name, setName] = useState(existing);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    void (async () => {
      // The actions toast their own failures and return falsy (store-layer
      // invariant). The dialog closes only on success — closing on failure
      // would discard the name the user just typed along with the reason it
      // never saved (M14.8).
      let ok: boolean;
      if (state.mode === 'new') {
        const folder = await createCollection(trimmed);
        ok = folder !== null;
        if (folder !== null) onCreated?.(folder);
      } else {
        ok = await updateCollection(state.collection, {
          ...state.collection.definition,
          name: trimmed,
        });
      }
      setBusy(false);
      if (ok) onClose();
    })();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={state.mode === 'new' ? 'New collection' : 'Rename collection'}
      width={420}
      primaryAction={{
        label: state.mode === 'new' ? 'Create' : 'Save',
        onClick: submit,
        disabled: name.trim() === '' || busy,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <Input
        autoFocus
        ariaLabel="Collection name"
        placeholder="Collection name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        width="100%"
      />
      {state.mode === 'rename' && (
        <p className="m-0 mt-2 text-xs text-n-500">
          The folder stays <code>{state.collection.folder}</code> — renaming changes what it is
          called, not where its contents live.
        </p>
      )}
    </Dialog>
  );
}
