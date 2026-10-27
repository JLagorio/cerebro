import { useEffect, useRef, useState } from 'react';
import type { Entry } from '@/engine/types';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { readEditorBody, supportsSelectedEditor } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import type { DocumentOwner } from './documentOwner';
import { flushOpenPageBodies, heldOpenPageBodies, retainedDocumentOwner } from './openPages';
import { selectedSnapshotFor } from './selectedSnapshot';
import { attachSelectedTitleOwner, selectedTitleOwner } from './selectedTaskOwner';
import { acceptSelectedTitleOutcome } from './selectedTitleOutcome';
import {
  prepareSelectedTitle,
  replaceSelectedTitle,
  selectedTitleText,
  TITLE_CHILD,
} from './selectedTitleDraft';
export function SelectedTitleInput({
  entry,
  vault,
  onEnd,
}: {
  entry: Entry;
  vault: string;
  onEnd: () => void;
}) {
  const [owner, setOwner] = useState<DocumentOwner | null>(null);
  const [, render] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const startAction = useVaultActionGuard(
    vault + ':' + entry.path + ':' + entry.authority?.recordId,
  );
  const original = useRef(entry); // the render's later entry cannot replace a captured attempt
  useEffect(() => {
    const source = original.current;
    const version = source.authority;
    const current = startAction();
    let release: (() => void) | undefined;
    let stop: (() => void) | undefined;
    const attach = (next: DocumentOwner) => {
      release = attachSelectedTitleOwner(next);
      stop = next.subscribe(() => render((value) => value + 1));
      setOwner(next);
    };
    const load = async () => {
      if (!version || version.kind !== 'sqlite_metadata' || !supportsSelectedEditor())
        throw new Error('Selected title editing is unavailable.');
      const target = { workspaceId: version.workspaceId, recordId: version.recordId };
      const key = {
        vaultId: vault,
        path: source.path,
        ownerId: 'title:' + target.workspaceId + ':' + target.recordId,
      };
      const retained = retainedDocumentOwner(key);
      if (retained) {
        if (current()) attach(retained);
        return;
      }
      const report = await flushOpenPageBodies();
      if (!current()) return;
      if (report.unresolvedOwnerIds.length || heldOpenPageBodies().includes(source.path))
        throw new Error('Finish the open page save before editing its title.');
      const observed = await readEditorBody(vault, source.path, target);
      if (!current()) return;
      const active = useVaultStore.getState();
      const row = active.entries.find((item) => item.path === source.path);
      if (
        active.vaultPath !== vault ||
        active.entriesVault !== vault ||
        active.status !== 'ready' ||
        row?.authority?.workspaceId !== target.workspaceId ||
        row.authority.recordId !== target.recordId ||
        !selectedSnapshotFor(observed, source.path, target)
      )
        throw new Error('The original selected page changed. Reopen its title.');
      const difference =
        BigInt(observed.version.metadataRevision) - BigInt(version.metadataRevision);
      if (
        difference < 0n ||
        (difference === 0n &&
          (observed.version.metadataHash !== version.metadataHash ||
            observed.version.bodyHash !== version.bodyHash))
      )
        throw new Error('The original selected page changed. Reopen its title.');
      if (!observed.editable || observed.coherence !== 'paired')
        throw new Error(
          observed.readOnlyReason ??
            'The page needs a paired editable body before its title can change.',
        );
      const next = selectedTitleOwner(vault, observed);
      if (!next.expectSelectedVersion(observed.version))
        throw new Error('An earlier title save still owns this page.');
      attach(next);
    };
    void load().catch((failure) => {
      if (current())
        setError(
          failure instanceof Error ? failure.message : 'The original page title could not be read.',
        );
    });
    return () => {
      stop?.();
      release?.();
    };
  }, [vault, startAction]);
  useEffect(() => {
    if (owner) {
      input.current?.focus();
      input.current?.select();
    }
  }, [owner]);
  const state = owner?.snapshot();
  const blocked =
    owner !== null &&
    (owner.recoveryBusy() ||
      state?.selectedSave !== undefined ||
      state?.reconcileRequired === true);
  const save = (keyboard = false) => {
    if (!owner || blocked) return;
    prepareSelectedTitle(owner);
    if (Object.keys(owner.snapshot().childDrafts ?? {}).length) {
      setError('Enter a title. Your draft is kept.');
      return;
    }
    const current = startAction();
    const field = input.current;
    const grid = field?.closest<HTMLElement>('[role="grid"]');
    void owner
      .flush()
      .then((outcome) => {
        if (!current()) return;
        acceptSelectedTitleOutcome(owner, outcome);
        if (outcome.kind === 'acknowledged' || outcome.kind === 'clean') {
          onEnd();
          if (
            keyboard &&
            (document.activeElement === field || document.activeElement === document.body)
          )
            queueMicrotask(() => {
              if (grid?.isConnected) grid.focus();
            });
        } else if (outcome.kind === 'failed')
          setError(
            'The title was not saved. Your draft is kept; compare the current page before changing this attempt.',
          );
      })
      .catch(() => {
        if (current()) setError('The title save could not be checked. Its original draft is kept.');
      });
  };
  if (!owner || !state)
    return (
      <span>
        <span role="status">{error ?? 'Reading title…'}</span>
        {error && (
          <button type="button" onClick={onEnd}>
            Done
          </button>
        )}
      </span>
    );
  const text =
    state.childDrafts?.[TITLE_CHILD] ?? selectedTitleText(state.latestDraft, entry.title);
  return (
    <span className="min-w-0 flex-1">
      <input
        ref={input}
        aria-label="Title"
        value={text}
        readOnly={blocked}
        className="h-7 min-w-0 w-full rounded-md border border-cortex-500 px-1.5 text-ui text-n-900 shadow-[var(--ring)] outline-none"
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          if (blocked) return;
          const value = event.target.value;
          setError(null);
          if (value.trim() === '' || /[\r\n]/.test(value)) owner.setChildDrafts(TITLE_CHILD, value);
          else {
            owner.setChildDrafts(TITLE_CHILD, null);
            owner.edit(replaceSelectedTitle(owner.snapshot().latestDraft, value), 'source');
          }
        }}
        onBlur={() => {
          if (owner.snapshot().failure === null) save();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            save(true);
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (blocked) return;
            const raw = owner.snapshot().mergeBase?.raw;
            const grid = input.current?.closest<HTMLElement>('[role="grid"]');
            if (raw !== undefined) {
              owner.setChildDrafts(TITLE_CHILD, null);
              owner.acceptExternal(raw);
              onEnd();
              grid?.focus();
            }
          }
        }}
      />
      {error && <span role="status">{error}</span>}
    </span>
  );
}
