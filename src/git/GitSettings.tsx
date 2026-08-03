import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import type { GitAuthorIdentity, GitProviderStatus, GitRemoteStatus } from '@/engine/git';
import { useGit } from '@/git/useGit';
import * as git from '@/lib/gitIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Git configuration (M9.4).
 *
 * Gated on two separate things by design: `autoCheckpoint` is intent (does
 * the user want unattended commits) and `isRepo` is fact (is there anywhere
 * to put them). A setting that claims to be on while nothing is tracked
 * would be a lie the UI tells about itself.
 */
export function GitSettings() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);
  const autoCheckpoint = useUiStore((s) => s.autoCheckpoint);
  const setAutoCheckpoint = useUiStore((s) => s.setAutoCheckpoint);
  const { isRepo, ready, remote, refresh } = useGit();

  const [provider, setProvider] = useState<GitProviderStatus | null>(null);
  const [identity, setIdentity] = useState<GitAuthorIdentity | null>(null);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void git
      .gitProviderStatus()
      .then(setProvider)
      .catch(() => setProvider(null));
  }, []);

  useEffect(() => {
    if (vaultPath === null || !isRepo) return;
    void git
      .gitAuthorIdentity(vaultPath)
      .then(setIdentity)
      .catch(() => setIdentity(null));
  }, [vaultPath, isRepo]);

  const guarded = (task: () => Promise<void>) => () => {
    setBusy(true);
    task()
      .catch((err: unknown) => toast(String(err)))
      .finally(() => setBusy(false));
  };

  const enable = async () => {
    if (vaultPath === null) return;
    await git.initGitRepo(vaultPath);
    await refresh();
    toast('History is on.');
  };

  const connect = async () => {
    if (vaultPath === null || remoteUrl.trim() === '') return;
    const result = await git.gitAddRemote(vaultPath, remoteUrl.trim());
    toast(result.message);
    if (result.status === 'ok') setRemoteUrl('');
    await refresh();
  };

  const disconnect = async () => {
    if (vaultPath === null) return;
    await git.gitDisconnectRemote(vaultPath);
    await refresh();
    toast('Remote disconnected.');
  };

  if (!ready) return null;

  return (
    <section data-testid="git-settings" className="flex flex-col gap-3">
      <h2 className="m-0 text-[13px] font-semibold text-[var(--n-900)]">History</h2>

      {provider !== null && !provider.native.available && (
        <div className="flex items-start gap-2 rounded-[10px] border border-[var(--warn-300)] bg-[var(--warn-50)] px-3 py-2.5 text-[12.5px] leading-[18px] text-[var(--n-700)]">
          <Icon name="triangle-alert" size={13} style={{ marginTop: 2 }} />
          <span>{provider.native.message}</span>
        </div>
      )}

      {!isRepo ? (
        <div className="flex flex-col items-start gap-2 rounded-[10px] border border-[var(--n-200)] px-3 py-2.5">
          <p className="m-0 text-[12.5px] leading-[18px] text-[var(--n-600)]">
            This vault is not tracked. Turning on history keeps every version of every note — and
            makes the assistant's own edits reviewable, since it writes to{' '}
            <code className="[font-family:var(--font-mono)] text-[11.5px]">knowledge/</code> without
            asking.
          </p>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || provider?.native.available === false}
            onClick={guarded(enable)}
          >
            Enable history
          </Button>
        </div>
      ) : (
        <>
          <label className="flex items-center gap-3 rounded-[10px] border border-[var(--n-200)] px-3 py-2.5">
            <span className="flex-1">
              <span className="block text-[12.5px] font-medium text-[var(--n-800)]">
                Automatic checkpoints
              </span>
              <span className="block text-[11.5px] leading-[16px] text-[var(--n-500)]">
                Commit when you stop working, and after the assistant writes. Never while a note has
                unsaved edits.
              </span>
            </span>
            <Switch checked={autoCheckpoint} onChange={setAutoCheckpoint} />
          </label>

          {identity !== null && (
            <div className="rounded-[10px] border border-[var(--n-200)] px-3 py-2.5">
              <div className="text-[12.5px] font-medium text-[var(--n-800)]">Commits are by</div>
              <div className="text-[12px] text-[var(--n-600)]">
                {identity.name} &lt;{identity.email}&gt;{' '}
                <span className="text-[var(--n-400)]">({identity.source})</span>
              </div>
              {identity.warning !== null && (
                <div className="mt-1 text-[11.5px] text-[var(--warn-600)]">{identity.warning}</div>
              )}
            </div>
          )}

          <RemoteRow
            remote={remote}
            url={remoteUrl}
            onUrlChange={setRemoteUrl}
            busy={busy}
            onConnect={guarded(connect)}
            onDisconnect={guarded(disconnect)}
          />
        </>
      )}
    </section>
  );
}

function RemoteRow({
  remote,
  url,
  onUrlChange,
  busy,
  onConnect,
  onDisconnect,
}: {
  remote: GitRemoteStatus | null;
  url: string;
  onUrlChange: (v: string) => void;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (remote !== null) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-[var(--n-200)] px-3 py-2.5">
        <Icon name="cloud" size={13} color="var(--n-500)" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--n-700)]">
          {remote.upstream ?? remote.branch}
        </span>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-[10px] border border-[var(--n-200)] px-3 py-2.5">
      <div className="mb-1.5 text-[12.5px] font-medium text-[var(--n-800)]">Remote</div>
      <div className="flex items-center gap-2">
        <Input
          ariaLabel="Remote URL"
          placeholder="https://github.com/you/notes.git"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          width="100%"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || url.trim() === ''}
          onClick={onConnect}
        >
          Connect
        </Button>
      </div>
      <p className="m-0 mt-1.5 text-[11.5px] leading-[16px] text-[var(--n-500)]">
        Uses your own git credentials. Cerebro never asks for a password — if authentication fails,
        fix it in your credential helper or SSH agent.
      </p>
    </div>
  );
}
