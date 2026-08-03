import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { isFailure } from '@/engine/git';
import { useGit } from '@/git/useGit';
import * as git from '@/lib/gitIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The bottom status bar (M9.7), modelled on tolaria's.
 *
 * Everything ambient about the vault in one strip you never have to open:
 * which vault, which branch, whether there is a remote, what is uncommitted,
 * when it last synced, and whether the agent's MCP endpoint is up.
 *
 * Held to the no-idle-chrome rule by making every segment a control. The
 * changes count navigates to the diff and Sync pulls-then-pushes — none of it
 * is a readout you can only look at.
 *
 * M15: every segment is now also the ONLY door to where it goes. Duplicates of
 * destinations the rail already owns (History, Settings) were removed, and so
 * was "Commit", which navigated instead of committing.
 */

const APP_VERSION = '2026.7.29';

function Segment({
  icon,
  label,
  title,
  tone = 'default',
  onClick,
  testId,
}: {
  icon: string;
  label: string;
  title?: string;
  tone?: 'default' | 'accent' | 'warn' | 'danger';
  onClick?: () => void;
  testId?: string;
}) {
  const color =
    tone === 'accent'
      ? 'var(--cortex-600)'
      : tone === 'warn'
        ? 'var(--warn-600)'
        : tone === 'danger'
          ? 'var(--danger-500)'
          : 'var(--n-500)';
  const className = [
    'inline-flex h-6 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-[11.5px]',
    onClick !== undefined ? 'hover:bg-[var(--n-100)]' : 'cursor-default',
  ].join(' ');

  const body = (
    <>
      <Icon name={icon} size={11} color={color} />
      <span style={{ color: tone === 'default' ? 'var(--n-600)' : color }}>{label}</span>
    </>
  );

  if (onClick === undefined) {
    return (
      <span data-testid={testId} title={title} className={className}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      onClick={onClick}
      className={className}
    >
      {body}
    </button>
  );
}

const Divider = () => <span aria-hidden className="h-3 w-px flex-none bg-[var(--n-200)]" />;

export function StatusBar() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const navigate = useNavStore((s) => s.navigate);
  const agentBusy = useUiStore((s) => s.agentBusy);
  const { isRepo, ready, modified, conflicts, remote, refresh } = useGit();
  // M15: `lastSync` is set ONLY by a completed sync (see `sync` below). An
  // effect that stamped it the moment a repo was detected made the strip read
  // "Synced" on every launch, before anything had been pulled or pushed — a
  // false safety signal on the one control that exists to report sync state.
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  if (vaultPath === null || !ready) return null;

  const vaultName = vaultPath.split('/').filter(Boolean).pop() ?? vaultPath;
  const pending = modified.length + conflicts.length;

  const sync = async () => {
    if (vaultPath === null || remote === null) return;
    setBusy(true);
    try {
      // Pull before push: pushing into a remote you are behind is the
      // rejection this ordering avoids.
      const pulled = await git.gitPull(vaultPath);
      if (isFailure(pulled)) {
        toast(pulled.message);
        return;
      }
      if (pulled.updatedFiles.length > 0) await rescan();
      const pushed = await git.gitPush(vaultPath);
      toast(pushed.message);
      setLastSync(Date.now());
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <footer
      data-testid="status-bar"
      className="flex h-7 flex-none items-center gap-1 border-t border-[var(--n-200)] bg-[var(--n-25)] px-2"
    >
      <Segment
        icon="folder"
        label={vaultName}
        title={vaultPath}
        testId="status-vault"
        onClick={() => navigate({ kind: 'settings' })}
      />
      <Divider />
      <Segment icon="package" label={APP_VERSION} title="Cerebro version" />

      {isRepo && (
        <>
          <Divider />
          <Segment
            icon="git-branch"
            label={remote?.branch !== undefined && remote.branch !== '' ? remote.branch : 'main'}
            testId="status-branch"
          />
          <Divider />
          {remote === null ? (
            <Segment
              icon="cloud-off"
              label="No remote"
              title="Connect one in Settings"
              testId="status-remote"
              onClick={() => navigate({ kind: 'settings' })}
            />
          ) : (
            <Segment
              icon="cloud"
              label={
                remote.ahead === 0 && remote.behind === 0
                  ? (remote.upstream ?? 'origin')
                  : `↑${remote.ahead} ↓${remote.behind}`
              }
              tone={remote.ahead > 0 || remote.behind > 0 ? 'accent' : 'default'}
              testId="status-remote"
              onClick={() => void sync()}
            />
          )}
          <Divider />
          {conflicts.length > 0 ? (
            <Segment
              icon="triangle-alert"
              label={`${conflicts.length} conflicted`}
              tone="danger"
              testId="status-changes"
              onClick={() => navigate({ kind: 'changes' })}
            />
          ) : (
            <Segment
              icon="file-diff"
              label={pending === 0 ? 'No changes' : `${pending} Changes`}
              tone={pending > 0 ? 'warn' : 'default'}
              testId="status-changes"
              onClick={() => navigate({ kind: 'changes' })}
            />
          )}
          {/* M15: the "Commit" segment is gone. It committed nothing — it
              navigated to Changes, which the changes-count segment beside it
              already does — so it was a button that lied about its own verb AND
              the second of three doors to the same page. The commit itself
              belongs where its message is typed. */}
          {remote !== null && (
            <Segment
              icon="refresh-cw"
              label={busy ? 'Syncing…' : lastSync === null ? 'Sync' : 'Synced'}
              testId="status-sync"
              onClick={() => void sync()}
            />
          )}
          {/* M15: the duplicate "History" segment is gone — the rail owns that
              destination, and two chromes offering the same door under
              different chrome means neither reads as authoritative. */}
        </>
      )}

      {!isRepo && (
        <>
          <Divider />
          <Segment
            icon="git-branch"
            label="Not tracked"
            // The tooltip said Settings while the click opened Changes.
            title="Start tracking this vault's history"
            testId="status-changes"
            onClick={() => navigate({ kind: 'changes' })}
          />
        </>
      )}

      <span className="flex-1" />

      {/* The assistant runs turns of its own in the background (M8.6); this
          is the only place that says so without interrupting anything. */}
      {agentBusy && (
        <Segment icon="sparkles" label="Assistant working" tone="accent" testId="status-agent" />
      )}
      {/* M15: no "Settings" segment either. The rail owns it, and the vault
          name and "No remote" segments here are already settings shortcuts
          that say what they will configure. */}
    </footer>
  );
}
