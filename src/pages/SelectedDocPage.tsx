import { useEffect, useMemo, useRef, useState } from 'react';
import type { Entry } from '@/engine/types';
import { PageToolbar, Crumb } from '@/components/PageToolbar';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { NoteBodyEditor, type SaveState } from '@/editor/NoteBodyEditor';
import { readNote, supportsSelectedEditor } from '@/lib/ipc';
import { sha256Hex } from '@/lib/sha256';
import { useVaultStore } from '@/stores/vaultStore';

const SAVE_LABEL: Record<SaveState, string | null> = {
  idle: null,
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  failed: 'Unsaved changes',
};

/** The native page uses the existing selected body owner; the browser stays read only. */
export function SelectedDocPage({ entry }: { entry: Entry }) {
  const vault = useVaultStore((state) => state.vaultPath);
  const entriesVault = useVaultStore((state) => state.entriesVault);
  const status = useVaultStore((state) => state.status);
  const patch = useVaultStore((state) => state.patchFrontmatter);
  const workspaceId = entry.authority?.workspaceId;
  const recordId = entry.authority?.recordId;
  const target = useMemo(
    () => (workspaceId === undefined || recordId === undefined ? null : { workspaceId, recordId }),
    [workspaceId, recordId],
  );
  const identity = JSON.stringify([vault, entry.path, workspaceId, recordId]);
  const [save, setSave] = useState<{ identity: string; state: SaveState } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuButton = useRef<HTMLDivElement>(null);
  const nativeEditor = supportsSelectedEditor();
  const ready = vault !== null && entriesVault === vault && status === 'ready';
  const fullWidth = entry.properties.full_width === true;
  const saveLabel = SAVE_LABEL[save?.identity === identity ? save.state : 'idle'];
  return (
    <div className="cb-document cb-page-frame flex-1" data-testid="doc-page">
      <PageToolbar
        crumbs={
          <span data-testid="doc-title">
            <Crumb label={entry.title} strong />
          </span>
        }
        status={
          !nativeEditor ? (
            <span className="text-metadata text-n-500">Read only</span>
          ) : saveLabel === null ? null : (
            <span className="text-metadata text-n-500" data-testid="doc-save-state">
              {saveLabel}
            </span>
          )
        }
        actions={
          <div ref={menuButton}>
            <IconButton
              icon="ellipsis"
              label="Page options"
              size="sm"
              onClick={() => {
                const rect = menuButton.current?.getBoundingClientRect();
                setMenu({ x: rect?.right ?? 0, y: rect?.bottom ?? 0 });
              }}
            />
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          data-testid="doc-content"
          className={
            fullWidth ? 'cb-document-content cb-document-content-wide' : 'cb-document-content'
          }
        >
          {!ready ? (
            <div role="status">Loading page body…</div>
          ) : target === null ? (
            <div role="alert" className="section-unavailable">
              Page body unavailable
            </div>
          ) : nativeEditor ? (
            <NoteBodyEditor
              path={entry.path}
              selectedTarget={target}
              onSaveState={(state) => setSave({ identity, state })}
            />
          ) : (
            <SelectedReadOnlyBody vault={vault} entry={entry} />
          )}
        </div>
      </div>
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              icon: fullWidth ? 'minimize-2' : 'maximize-2',
              label: fullWidth ? 'Center content' : 'Full width',
              onSelect: () => void patch(entry.path, { full_width: fullWidth ? null : true }),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** Exact browser presentation; no selected editor transport or writer fallback. */
function SelectedReadOnlyBody({ vault, entry }: { vault: string; entry: Entry }) {
  const bodyHash = entry.authority?.bodyHash;
  const [body, setBody] = useState<{
    vault: string;
    path: string;
    hash: string;
    text: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (bodyHash === undefined) return;
    let cancelled = false;
    void readNote(vault, entry.path)
      .then((text) => {
        if (sha256Hex(text) !== bodyHash) throw new Error('The paired page body changed.');
        const current = useVaultStore.getState();
        const observed = current.entries.find((item) => item.path === entry.path);
        if (!cancelled && current.vaultPath === vault && observed?.authority?.bodyHash === bodyHash)
          setBody({ vault, path: entry.path, hash: bodyHash, text });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [vault, entry.path, bodyHash]);
  const currentBody =
    body?.vault === vault && body.path === entry.path && body.hash === bodyHash ? body.text : null;
  return failed ? (
    <div role="alert" className="section-unavailable">
      Page body unavailable
    </div>
  ) : currentBody === null ? (
    <div role="status">Loading page body…</div>
  ) : (
    <section aria-label="Page body, read only">
      <pre
        data-testid="selected-body"
        className="m-0 whitespace-pre-wrap break-words text-prose text-n-900"
        style={{ fontFamily: 'inherit' }}
      >
        {currentBody}
      </pre>
    </section>
  );
}
