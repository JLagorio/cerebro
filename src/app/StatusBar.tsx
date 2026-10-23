import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { RunList } from '@/agent/RunList';
import { countsUnknown, isFailure, UNCOUNTED_WORDS, type RemoteResult } from '@/engine/git';
import { useGit } from '@/git/useGit';
import { APP_VERSION } from '@/lib/appVersion';
import * as git from '@/lib/gitIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import './statusBar.css';

/** Quiet workspace identity and actions. Passive repository facts live in the
 * identity disclosure; changes, failed syncs, a history read that failed and
 * running assistants stay visible. */
function StatusAction({
  icon,
  label,
  title,
  tone = 'default',
  disabled = false,
  onClick,
  testId,
}: {
  icon: string;
  label: string;
  title?: string;
  tone?: 'default' | 'accent' | 'warn' | 'danger';
  disabled?: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      tabIndex={0}
      data-testid={testId}
      data-tone={tone}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="cb-status-action"
    >
      <Icon name={icon} size={12} />
      <span>{label}</span>
    </button>
  );
}

function syncRefused(result: RemoteResult): boolean {
  return isFailure(result) || result.status === 'conflict' || result.status === 'no_remote';
}

export function StatusBar() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const navigate = useNavStore((s) => s.navigate);
  const { isRepo, ready, readError, branch, modified, conflicts, remote, refresh } = useGit();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLButtonElement>(null);
  // A completed sync belongs to the vault it ran against. Switching vaults
  // must never carry its success or failure into the new workspace.
  const [syncResult, setSyncResult] = useState<{
    vault: string;
    at: number | null;
    error: string | null;
  } | null>(null);
  const [busyVault, setBusyVault] = useState<string | null>(null);
  const inFlight = useRef(false);
  useEffect(() => setDetailsOpen(false), [vaultPath]);

  if (vaultPath === null || !ready) return null;
  const vaultName = vaultPath.split('/').filter(Boolean).pop() ?? vaultPath;
  const pending = modified.length + conflicts.length;
  const busy = busyVault === vaultPath;
  const lastSync = syncResult?.vault === vaultPath ? syncResult.at : null;
  const syncError = syncResult?.vault === vaultPath ? syncResult.error : null;
  const changeLabel =
    conflicts.length > 0
      ? `${conflicts.length} conflicted`
      : `${pending} change${pending === 1 ? '' : 's'}`;

  const sync = async () => {
    if (remote === null || inFlight.current) return;
    inFlight.current = true;
    setBusyVault(vaultPath);
    setSyncResult({ vault: vaultPath, at: null, error: null });
    const refuse = (message: string) => {
      setSyncResult({ vault: vaultPath, at: null, error: message });
      toast(message);
    };
    try {
      const pulled = await git.gitPull(vaultPath);
      if (syncRefused(pulled)) {
        refuse(pulled.message);
        await refresh();
        return;
      }
      if (pulled.updatedFiles.length > 0) await rescan();
      const pushed = await git.gitPush(vaultPath);
      if (syncRefused(pushed)) refuse(pushed.message);
      else {
        setSyncResult({ vault: vaultPath, at: Date.now(), error: null });
        toast(pushed.message);
      }
      await refresh();
    } catch (error) {
      refuse(error instanceof Error ? error.message : 'The workspace could not sync. Try again.');
    } finally {
      inFlight.current = false;
      setBusyVault(null);
    }
  };

  // M92.9: a read that failed claims nothing it read before, and never that
  // the vault keeps no history: there is nothing here to start tracking.
  const unread = readError !== null;
  const tracked = isRepo === true && !unread;
  const goTo = (kind: 'settings' | 'changes') => {
    setDetailsOpen(false);
    navigate({ kind });
  };
  // M92.10: a count git did not take is said in words, never as 0, so it
  // never reads as nothing to sync.
  const unknown = remote === null ? null : countsUnknown(remote);
  const ahead = remote?.ahead ?? null;
  const behind = remote?.behind ?? null;
  const remoteChanges =
    remote === null
      ? null
      : unknown !== null
        ? UNCOUNTED_WORDS[unknown]
        : `${ahead} to push · ${behind} to pull`;
  const divergence =
    ahead !== null && behind !== null && (ahead > 0 || behind > 0)
      ? [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].filter(Boolean).join(' ')
      : '';
  const syncLabel = busy
    ? 'Syncing…'
    : syncError !== null
      ? 'Sync failed'
      : divergence !== ''
        ? `Sync ${divergence}`
        : lastSync === null
          ? 'Sync'
          : 'Synced';

  return (
    <footer data-testid="status-bar" data-key-neutral className="cb-workspace-status">
      <button
        ref={detailsRef}
        type="button"
        tabIndex={0}
        data-testid="status-vault"
        aria-label={`Workspace status: ${vaultName}`}
        aria-haspopup="dialog"
        aria-expanded={detailsOpen}
        onClick={(event) => {
          // Safari does not focus every native button on pointer click. Capture
          // this explicit opener before the disclosure records focus to restore.
          event.currentTarget.focus();
          setDetailsOpen(!detailsOpen);
        }}
        className="cb-status-action cb-status-workspace"
      >
        <Icon name="folder" size={12} />
        <span>{vaultName}</span>
        <Icon name="chevron-down" size={11} />
      </button>
      {detailsOpen && (
        <Popover
          anchorRef={detailsRef}
          onClose={() => setDetailsOpen(false)}
          role="dialog"
          ariaLabel="Workspace status"
          trapFocus
          className="cb-status-details"
        >
          <h2>{vaultName}</h2>
          <p className="cb-status-path">{vaultPath}</p>
          <dl>
            <div>
              <dt>Version</dt>
              <dd title="Cerebro version">{APP_VERSION}</dd>
            </div>
            <div>
              <dt>History</dt>
              <dd data-testid="status-history">
                {unread ? 'Couldn’t read' : isRepo === true ? 'Tracked locally' : 'Not tracked'}
              </dd>
            </div>
            {tracked && (
              <>
                <div>
                  <dt>Branch</dt>
                  <dd data-testid="status-branch">{branch ?? 'Not recorded'}</dd>
                </div>
                <div>
                  <dt>Remote</dt>
                  <dd data-testid="status-remote">
                    {remote === null ? 'No remote' : remote.upstream || 'Connected'}
                  </dd>
                </div>
                <div>
                  <dt>Changes</dt>
                  <dd>{pending === 0 ? 'No changes' : changeLabel}</dd>
                </div>
                {remoteChanges !== null && (
                  <div>
                    <dt>Remote changes</dt>
                    <dd data-testid="status-remote-changes">{remoteChanges}</dd>
                  </div>
                )}
                {lastSync !== null && (
                  <div>
                    <dt>Last synced</dt>
                    <dd>
                      {new Date(lastSync).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </dd>
                  </div>
                )}
              </>
            )}
          </dl>
          {unread && (
            <p data-testid="status-history-error" className="cb-status-error">
              Couldn’t read this vault’s history: {readError}
            </p>
          )}
          {syncError !== null && (
            <p role="alert" className="cb-status-error">
              {syncError}
            </p>
          )}
          <div className="cb-status-details-actions">
            <StatusAction
              icon="settings"
              label="Workspace settings"
              testId="workspace-settings"
              onClick={() => goTo('settings')}
            />
            {(tracked || (isRepo === false && !unread)) && (
              <StatusAction
                icon={tracked ? 'file-diff' : 'git-branch'}
                label={tracked ? 'View changes' : 'Start tracking history'}
                testId={pending > 0 && tracked ? 'workspace-changes' : 'status-changes'}
                onClick={() => goTo('changes')}
              />
            )}
          </div>
        </Popover>
      )}
      {unread && (
        <StatusAction
          icon="circle-alert"
          label="History unavailable"
          title={`Couldn’t read this vault’s history: ${readError}`}
          tone="warn"
          testId="status-history-unavailable"
          onClick={() => setDetailsOpen(true)}
        />
      )}
      {tracked && pending > 0 && (
        <StatusAction
          icon={conflicts.length > 0 ? 'triangle-alert' : 'file-diff'}
          label={changeLabel}
          tone={conflicts.length > 0 ? 'danger' : 'warn'}
          testId="status-changes"
          onClick={() => navigate({ kind: 'changes' })}
        />
      )}
      {tracked && (remote !== null || syncError !== null) && (
        <StatusAction
          icon={syncError !== null ? 'triangle-alert' : 'refresh-cw'}
          label={syncLabel}
          title={
            syncError ??
            (unknown !== null
              ? UNCOUNTED_WORDS[unknown]
              : divergence !== ''
                ? `${ahead} to push, ${behind} to pull`
                : undefined)
          }
          tone={syncError !== null ? 'danger' : divergence !== '' ? 'accent' : 'default'}
          disabled={busy}
          testId="status-sync"
          onClick={() => (remote === null ? setDetailsOpen(true) : void sync())}
        />
      )}
      <span className="cb-status-space" />
      <RunList />
    </footer>
  );
}
