import { useEffect, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import type { FileStatus, ModifiedFile } from '@/engine/git';
import { DiffView } from '@/git/DiffView';
import { checkpointMessage, useGit } from '@/git/useGit';
import * as git from '@/lib/gitIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const STATUS_STYLE: Record<FileStatus, { icon: string; color: string; label: string }> = {
  added: { icon: 'file-plus', color: 'var(--success-600)', label: 'Added' },
  untracked: { icon: 'file-plus', color: 'var(--success-600)', label: 'New' },
  modified: { icon: 'file-pen', color: 'var(--warn-600)', label: 'Modified' },
  deleted: { icon: 'file-minus', color: 'var(--danger-500)', label: 'Deleted' },
  renamed: { icon: 'file-symlink', color: 'var(--n-500)', label: 'Renamed' },
  conflicted: { icon: 'triangle-alert', color: 'var(--danger-500)', label: 'Conflict' },
};

/**
 * Uncommitted work (M9.4): what has changed, what it changed to, and a way
 * to commit or discard it.
 *
 * The conflict banner sits at the top rather than in a dialog: a conflicted
 * vault cannot be committed until it is resolved, so the thing blocking you
 * belongs above the thing it blocks.
 */
export function ChangesPage() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const openPath = useOpenPath();
  const { isRepo, modified, conflicts, conflictMode, ready, refresh } = useGit();

  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  // Prefill a message that describes the change, so committing costs one
  // click when you have nothing to add.
  useEffect(() => {
    if (message === '' && modified.length > 0) setMessage(checkpointMessage(modified));
    // `message` is read only to avoid clobbering a hand-typed draft; keyed on
    // it, this would re-fire per keystroke and re-prefill the moment the
    // field is cleared. Prefill belongs to the change set, so it keys on that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modified.length]);

  useEffect(() => {
    if (selected === null || vaultPath === null) {
      setDiff('');
      return;
    }
    let cancelled = false;
    void git
      .getFileDiff(vaultPath, selected)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch(() => {
        if (!cancelled) setDiff('');
      });
    return () => {
      cancelled = true;
    };
  }, [selected, vaultPath]);

  const enableHistory = async () => {
    if (vaultPath === null) return;
    setBusy(true);
    try {
      await git.initGitRepo(vaultPath);
      await refresh();
      toast('History is on. Every change from here is tracked.');
    } catch (err) {
      toast(`Couldn't start tracking: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (vaultPath === null || message.trim() === '') return;
    setBusy(true);
    try {
      const hash = await git.gitCommit(vaultPath, message.trim());
      if (hash === null) {
        toast('Nothing to commit.');
      } else {
        toast(`Committed ${hash}`);
        setMessage('');
        setSelected(null);
      }
      await refresh();
    } catch (err) {
      toast(`Couldn't commit: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const discard = async (file: ModifiedFile) => {
    if (vaultPath === null) return;
    try {
      await git.gitDiscardFile(vaultPath, file.path);
      if (selected === file.path) setSelected(null);
      await refresh();
      await rescan();
      toast(`Discarded changes to ${file.path}`);
    } catch (err) {
      toast(`Couldn't discard: ${String(err)}`);
    }
  };

  const resolve = async (path: string, keep: 'ours' | 'theirs') => {
    if (vaultPath === null) return;
    try {
      await git.gitResolveConflict(vaultPath, path, keep);
      await refresh();
      await rescan();
    } catch (err) {
      toast(`Couldn't resolve: ${String(err)}`);
    }
  };

  const finishMerge = async () => {
    if (vaultPath === null) return;
    try {
      await git.gitCommitConflictResolution(vaultPath);
      await refresh();
      toast('Merge resolved.');
    } catch (err) {
      toast(String(err));
    }
  };

  if (!ready) return null;

  if (!isRepo) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon="git-branch"
          title="This vault has no history yet"
          description="Turn on tracking and cerebro keeps a full history of every change — including the ones the assistant makes on its own, so you can read and undo them."
          action={
            <Button variant="primary" disabled={busy} onClick={() => void enableHistory()}>
              Enable history
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="changes-page">
      <div className="flex-none px-5 pb-2 pt-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="file-diff" size={16} color="var(--n-600)" />
          <h1 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.005em]">Changes</h1>
          <span className="[font-family:var(--font-mono)] text-[11.5px] text-n-400">
            {modified.length}
          </span>
        </div>
      </div>

      {conflicts.length > 0 && (
        <div
          data-testid="conflict-banner"
          className="mx-5 mb-2 flex-none rounded-lg border border-danger-200 bg-danger-50 p-3"
        >
          <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-danger-700">
            <Icon name="triangle-alert" size={13} />
            {conflicts.length} file{conflicts.length === 1 ? '' : 's'} conflict
            {conflictMode !== 'none' && ` (${conflictMode} in progress)`}
          </div>
          {conflicts.map((path) => (
            <div key={path} className="flex items-center gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate text-xs text-n-800">{path}</span>
              <Button size="sm" variant="secondary" onClick={() => void resolve(path, 'ours')}>
                Keep mine
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void resolve(path, 'theirs')}>
                Keep theirs
              </Button>
            </div>
          ))}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => void finishMerge()}>
              Finish merge
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (vaultPath !== null) void git.gitAbortConflict(vaultPath).then(refresh);
              }}
            >
              Abort
            </Button>
          </div>
        </div>
      )}

      {modified.length === 0 ? (
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <EmptyState
            icon="check"
            title="Nothing uncommitted"
            description="Every change in this vault is saved to history."
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[320px] min-w-0 flex-none flex-col border-r border-n-200">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {modified.map((file) => {
                const style = STATUS_STYLE[file.status];
                const active = selected === file.path;
                return (
                  // M15: the row's two actions are revealed by opacity rather
                  // than `display:none`. Hidden they were out of the tab order
                  // entirely — discarding an unwanted change had no keyboard
                  // path at all, which is the most destructive thing in the app
                  // to make mouse-only.
                  <div
                    key={file.path}
                    data-testid="changed-file"
                    className={[
                      'group flex h-9 items-center gap-2 border-b border-n-100 px-3',
                      active ? 'bg-cortex-50' : 'hover:bg-n-25',
                    ].join(' ')}
                  >
                    <Icon name={style.icon} size={13} color={style.color} />
                    <button
                      type="button"
                      onClick={() => setSelected(file.path)}
                      title={file.path}
                      className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[12.5px] text-n-800"
                    >
                      {file.path}
                    </button>
                    <button
                      type="button"
                      aria-label={`Open ${file.path}`}
                      onClick={() => openPath(file.path)}
                      className="inline-flex flex-none rounded border-0 bg-transparent p-0.5 text-n-400 opacity-0 hover:text-n-800 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <Icon name="maximize-2" size={11} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Discard changes to ${file.path}`}
                      onClick={() => void discard(file)}
                      className="inline-flex flex-none rounded border-0 bg-transparent p-0.5 text-n-400 opacity-0 hover:text-danger-500 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <Icon name="undo-2" size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex-none border-t border-n-200 p-2.5">
              <Input
                ariaLabel="Commit message"
                placeholder="What changed?"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                width="100%"
              />
              <div className="mt-1.5 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  icon="check"
                  disabled={busy || message.trim() === '' || conflicts.length > 0}
                  onClick={() => void commit()}
                >
                  Commit {modified.length}
                </Button>
              </div>
            </div>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
            {selected === null ? (
              <p className="m-0 text-[12.5px] text-n-400">Pick a file to see what changed.</p>
            ) : (
              <DiffView diff={diff} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
