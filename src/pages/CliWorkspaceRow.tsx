import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { agentWorkspace, purgeAgentWorkspace } from '@/agent/agentIpc';
import type { CliWorkspace } from '@/agent/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * What the CLI keeps about this vault, outside this vault (M17.14).
 *
 * Cerebro spawns Claude Code with cwd = the vault, and the CLI files its own
 * session transcripts — with each session's subagent transcripts, tool output
 * and copies of the files it edited — and its auto-memory under a key derived
 * from that path, in its config folder (`~/.claude` unless `CLAUDE_CONFIG_DIR`
 * moves it). On this machine that was already 18 transcripts and ~2.2 MB of
 * verbatim note content before anyone looked.
 *
 * It cannot be turned off. `--bare` is the only flag that skips auto-memory,
 * and it also stops the CLI reading the keychain — verified against the real
 * binary, which answers "Not logged in". Cerebro's whole premise is that the
 * assistant is the user's own signed-in CLI and no API key enters the app, so
 * `--bare` would trade a privacy leak for a product that cannot authenticate.
 * `--no-session-persistence` costs `--resume`, which is how a conversation
 * survives a reload.
 *
 * So this row exists instead: name the directory, count what is in it, and
 * give the user a button. Not a fix — a disclosure, which is the honest thing
 * a settings screen can do about a dependency's behaviour it does not control.
 * A count that could not read everything says it is a floor (CV-05), and a
 * folder every project shares is counted but offers no button (M56.11).
 */
export function CliWorkspaceRow() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);
  const [workspace, setWorkspace] = useState<CliWorkspace | null>(null);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(() => {
    if (vaultPath === null) return;
    void agentWorkspace(vaultPath)
      .then(setWorkspace)
      .catch(() => setWorkspace(null));
  }, [vaultPath]);

  useEffect(refresh, [refresh]);

  // Browser mode spawns no CLI, so there is no directory to report on. An
  // empty row would read as "nothing is stored", which is a claim.
  if (workspace === null || !workspace.exists) return null;

  const mb = workspace.bytes / 1_000_000;
  const size = mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.round(workspace.bytes / 1_000)} KB`;
  const counts =
    `${workspace.sessions} ${plural(workspace.sessions, 'session')} in ` +
    `${workspace.sessionFiles} ${plural(workspace.sessionFiles, 'file')}, ${size}`;

  const purge = () => {
    if (vaultPath === null) return;
    setConfirming(false);
    void purgeAgentWorkspace(vaultPath)
      .then((removed) => {
        toast(removed === 0 ? 'Nothing to clear' : `Cleared ${removed} file(s)`);
        refresh();
      })
      .catch(() => {
        toast("Couldn't clear the assistant's stored history");
        // A clear stops at its first error, so some of it may be gone: show
        // what is left rather than the count from before.
        refresh();
      });
  };

  return (
    <div className="flex items-start gap-3 py-2" data-testid="cli-workspace">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-n-800">Stored outside this vault</div>
        <div className="mt-0.5 text-xs leading-[16px] text-n-500">
          Claude Code keeps its own copy of every conversation so a thread can be resumed —{' '}
          <span className="font-medium text-n-700" data-testid="cli-workspace-counts">
            {counts}
          </span>
          {workspace.memoryFiles > 0 && (
            <span className="font-medium text-warn-700">
              , plus {workspace.memoryFiles} memory {plural(workspace.memoryFiles, 'file')}
            </span>
          )}{' '}
          — in its own folder, not in the vault. With each session it also keeps its subagents&apos;
          transcripts, the output of the tools it ran and copies of the files it edited. All of it
          holds whatever the assistant read, verbatim, outside the vault&apos;s git history and its
          backups. Turning it off is not possible without also signing the assistant out, so cerebro
          says where it is instead.
          {workspace.unreadable > 0 && (
            <div className="mt-1 text-warn-700" data-testid="cli-workspace-floor">
              {workspace.unreadable} {plural(workspace.unreadable, 'item')} could not be read, so
              these counts are a floor.
            </div>
          )}
          {workspace.shared && (
            <div className="mt-1" data-testid="cli-workspace-shared">
              Claude Code keeps every project&apos;s sessions in this one folder
              (CLAUDE_CODE_PROJECT_DIR_NAME), so Cerebro won&apos;t clear it.
            </div>
          )}
          <div
            className="mt-1 truncate [font-family:var(--font-mono)]"
            data-testid="cli-workspace-path"
            title={workspace.path}
          >
            {workspace.path}
          </div>
        </div>
      </div>
      {workspace.shared ? null : confirming ? (
        <span className="flex flex-none items-center gap-1.5">
          <Button variant="danger" size="sm" onClick={purge}>
            Clear it
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
          Clear history
        </Button>
      )}
    </div>
  );
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
