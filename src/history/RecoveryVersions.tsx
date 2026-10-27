import { sha256Hex } from '@/lib/sha256';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecoveryVersion } from '@/engine/recovery';
import { saveBeforeAction } from '@/app/leaveGuard';
import { announceExternalWrites } from '@/editor/openPages';
import { recoveryOutcomeText } from '@/editor/RecoverySaveStatus';
import { useVaultStore } from '@/stores/vaultStore';
import { Button } from '@/components/ui/Button';
import * as ipc from '@/lib/ipc';

/** UI bound only; read/export still return the exact bounded selected file. */
export const RECOVERY_PREVIEW_CHARS = 20000;
const RECOVERY_STATE_WORDS: Record<RecoveryVersion['state'], string> = {
  committed: 'Retained',
  pending: 'Verification pending',
  ambiguous: 'Save outcome uncertain',
};
export function RecoveryVersions({ path }: { path: string }) {
  const vault = useVaultStore((s) => s.vaultPath);
  return vault === null ? null : (
    <PathRecoveryVersions key={`${vault}:${path}`} vault={vault} path={path} />
  );
}
/** Mermaid's readNote body is the exact whole file, including its own
 * syntax header. The legacy Markdown source door intentionally rejects it. */
async function readRecoveryTarget(vault: string, path: string): Promise<{ hash: string }> {
  if (path.endsWith('.mmd')) return { hash: sha256Hex(await ipc.readNote(vault, path)) };
  return ipc.readNoteSource(vault, path);
}
function PathRecoveryVersions({ vault, path }: { vault: string; path: string }) {
  const [versions, setVersions] = useState<RecoveryVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const listRequest = useRef(0);
  const contentHash = useVaultStore(
    (state) => state.entries.find((entry) => entry.path === path)?.hash,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; text: string; truncated: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [restoreFailure, setRestoreFailure] = useState<{
    id: string;
    hash: string;
    nonce: string;
    expiresAt: number;
    current: () => boolean;
  } | null>(null);
  const startAction = useVaultActionGuard(`${vault}:${path}`);
  const [choice, setChoice] = useState<{ kind: 'delete' | 'restore'; id: string } | null>(null);
  const alive = useRef(true);
  const current = () => alive.current && useVaultStore.getState().vaultPath === vault;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [vault, path]);
  // Every metadata read shares one request order, including save-triggered
  // refreshes and the lane's own restore/delete reloads. Bodies remain lazy.
  const reload = useCallback(
    async (stillCurrent: () => boolean = () => true) => {
      const origin = startAction();
      const request = ++listRequest.current;
      const ownsRead = () =>
        origin() &&
        stillCurrent() &&
        useVaultStore.getState().vaultPath === vault &&
        request === listRequest.current;
      try {
        const rows = await ipc.listRecovery(vault, path);
        if (ownsRead()) {
          setVersions(rows);
          setListError(null);
        }
      } catch {
        if (ownsRead())
          setListError(
            'Recovery copies could not be read. Previously loaded copies may be outdated.',
          );
      }
    },
    [vault, path, startAction],
  );
  useEffect(() => {
    void reload();
  }, [contentHash, reload]);
  useEffect(() => {
    if (!restoreFailure) return;
    const timer = setTimeout(
      () => setRestoreFailure(null),
      Math.max(0, restoreFailure.expiresAt * 1000 - Date.now()),
    );
    const stop = useVaultStore.subscribe((next, previous) => {
      const before = previous.entries.find((entry) => entry.path === path)?.hash;
      const after = next.entries.find((entry) => entry.path === path)?.hash;
      if (!restoreFailure.current() || (before !== after && after !== restoreFailure.hash))
        setRestoreFailure(null);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [restoreFailure, path]);
  const act = async (action: (current: () => boolean) => Promise<void>) => {
    const origin = startAction();
    const stillCurrent = () => current() && origin();
    if (!stillCurrent()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action(stillCurrent);
    } catch (e) {
      if (stillCurrent())
        setError(`Recovery action failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const restore = async (
    id: string,
    current: () => boolean,
    permit: typeof restoreFailure = null,
  ) => {
    setRestoreFailure(null);
    if (permit && (!permit.current() || permit.id !== id || permit.expiresAt * 1000 <= Date.now()))
      throw new Error('Recovery choice expired. Retry restore.');
    if (!(await saveBeforeAction('all', 'block', current)) || !current()) return;
    let failure: unknown;
    let completed = false;
    let expectedHash: string | null = null;
    let outcome: string | null = null;
    // Keep callback refusal explicit: announceExternalWrites deliberately
    // swallows callback errors while releasing every held owner.
    await announceExternalWrites([path], async () => {
      try {
        if (!current()) return;
        const disk = await readRecoveryTarget(vault, path);
        if (!current()) return;
        expectedHash = disk.hash;
        if (permit && (permit.hash !== disk.hash || !permit.current()))
          throw new Error('The current page changed. Retry restore before choosing again.');
        const ack = await ipc.restoreRecovery(vault, path, id, disk.hash, permit?.nonce);
        completed = true;
        outcome = ack.kind === 'file' && ack.recovery ? recoveryOutcomeText(ack.recovery) : null;
        if (current()) await useVaultStore.getState().rescan();
      } catch (e) {
        failure = e;
      }
    });
    if (!current()) return;
    if (failure !== undefined) {
      const code = failure instanceof Error ? failure.message : String(failure);
      if (code.startsWith('recovery_required:') && expectedHash !== null) {
        setError(
          'The recovery copy could not be stored. The current page was not replaced. Retry restore, or explicitly restore without a recovery copy.',
        );
        const nonce = code.slice('recovery_required:'.length);
        const info = await ipc.recoveryFailure(vault, path, nonce);
        if (!current()) return;
        const disk = await readRecoveryTarget(vault, path);
        if (current() && disk.hash === expectedHash && info.expiresAt * 1000 > Date.now())
          setRestoreFailure({ id, hash: expectedHash, nonce, expiresAt: info.expiresAt, current });
        return;
      }
      throw failure;
    }
    if (completed && current()) {
      setNotice(`Restored recovery copy.${outcome ? ` ${outcome}` : ''}`);
      setChoice(null);
      await reload(current);
    }
  };
  return (
    <section
      aria-label="Recovery copies"
      className="flex flex-col gap-2 border-b border-n-200 px-1.5 py-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Recovery copies</h3>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reload()}>
          Refresh recovery copies
        </Button>
      </div>
      <p>
        Local displaced bytes, separate from committed History. Attribution is outside,
        unattributed. Pending or ambiguous copies do not prove a save completed.
      </p>
      {error && (
        <p role="alert" data-testid="section-unavailable">
          {error}
        </p>
      )}
      {listError && (
        <p role="alert" data-testid="section-unavailable">
          {listError}
        </p>
      )}
      {listError && versions === null && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(reload)}>
          Retry recovery read
        </Button>
      )}
      {notice && <p role="status">{notice}</p>}
      {versions === null ? (
        !listError && <p>Reading recovery copies…</p>
      ) : versions.length === 0 && !listError ? (
        <p>No retained recovery copies for this page.</p>
      ) : (
        versions.map((version) => (
          <article key={version.id} className="flex flex-col gap-1 border-l border-n-200 pl-2">
            <p>
              {new Date(version.capturedAt * 1000).toLocaleString()} ·{' '}
              {version.bytes.toLocaleString()} bytes · {RECOVERY_STATE_WORDS[version.state]} ·{' '}
              {version.attribution || 'outside, unattributed'}
            </p>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void act(async (current) => {
                    const raw = await ipc.readRecovery(vault, path, version.id);
                    if (current())
                      setPreview({
                        id: version.id,
                        text: raw.slice(0, RECOVERY_PREVIEW_CHARS),
                        truncated: raw.length > RECOVERY_PREVIEW_CHARS,
                      });
                  })
                }
              >
                Preview
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await ipc.exportRecovery(vault, path, version.id);
                  })
                }
              >
                Export copy
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setRestoreFailure(null);
                  setChoice({ kind: 'restore', id: version.id });
                }}
              >
                Restore copy
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setRestoreFailure(null);
                  setChoice({ kind: 'delete', id: version.id });
                }}
              >
                Delete copy
              </Button>
            </div>
            {choice?.id === version.id && (
              <div role="group" aria-label="Confirm recovery action">
                <p>
                  {choice.kind === 'restore'
                    ? 'Replace the current page with this copy? Unsaved edits must save first.'
                    : 'Delete this recovery copy? The current page is kept.'}
                </p>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(async (current) => {
                      if (choice.kind === 'restore') await restore(version.id, current);
                      else {
                        await ipc.deleteRecovery(vault, path, version.id);
                        if (current()) {
                          setChoice(null);
                          setPreview(null);
                        }
                        await reload(current);
                      }
                    })
                  }
                >
                  {choice.kind === 'restore' ? 'Confirm restore copy' : 'Confirm delete copy'}
                </Button>
                {choice.kind === 'restore' && error && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void act((current) => restore(version.id, current))}
                  >
                    Retry restore
                  </Button>
                )}
                {restoreFailure?.id === version.id && restoreFailure.current() && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      const permit = restoreFailure;
                      setRestoreFailure(null);
                      void act((current) => restore(version.id, current, permit));
                    }}
                  >
                    Restore without a recovery copy
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setRestoreFailure(null);
                    setChoice(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
            {preview?.id === version.id && (
              <div>
                {preview.truncated && (
                  <p>
                    Preview truncated to {RECOVERY_PREVIEW_CHARS.toLocaleString()} characters.
                    Export keeps the exact full copy.
                  </p>
                )}
                <pre
                  aria-label="Recovery copy text"
                  className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono"
                >
                  {preview.text}
                </pre>
                <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                  Close preview
                </Button>
              </div>
            )}
          </article>
        ))
      )}
    </section>
  );
}
