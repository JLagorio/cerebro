import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { useLedgerStore } from '@/stores/ledgerStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { WriterStatus } from '@/lib/ipc';

/** What each non-recording writer state means, in the user's words. */
const WHY: Record<Exclude<WriterStatus['state'], 'held' | 'none'>, string> = {
  'lost-lock': 'Another Cerebro window or build has this vault open and is recording it.',
  refused: 'The recorded history failed its startup check, so nothing can be added to it.',
  'fail-stopped': 'The recorder stopped after a disk error. Reopen the vault to restart it.',
  'other-vault': 'This window is recording a different vault.',
  inactive: 'Recording has not started for this vault.',
};

/**
 * The M49.2 "Not recording" banner, and the one place the shared ledger
 * status is refreshed.
 *
 * Before M49.2 a vault could stop recording silently — a lost lock, a
 * reload that dropped the writer — and every knowledge write fell through
 * to a file-first path the ledger later called forgery. M49.1 made those
 * writes refuse; this makes the state they refuse in visible.
 *
 * Refreshed once the vault is ready (the launch scan has run by then) and
 * again after every rescan, so a state that changes mid-session — including
 * a divergence the watcher finds — shows without a relaunch (K14).
 */
export function RecordingBanner({ vault }: { vault: string }) {
  const ready = useVaultStore((s) => s.status === 'ready');
  const entries = useVaultStore((s) => s.entries);
  const refresh = useLedgerStore((s) => s.refresh);
  const readVault = useLedgerStore((s) => s.vault);
  const read = useLedgerStore((s) => s.read);

  useEffect(() => {
    if (ready) void refresh(vault);
  }, [ready, entries, refresh, vault]);

  if (readVault !== vault || read.kind === 'unread') return null;
  if (read.kind === 'unavailable') {
    return (
      <div data-testid="recording-banner" data-state="unavailable" role="alert" className={BANNER}>
        <span className="font-semibold">Couldn't tell whether knowledge is being recorded.</span>
        <span>Background learning is paused until it can.</span>
        <Button size="sm" className="ml-auto" onClick={() => void refresh(vault)}>
          Check again
        </Button>
        <span className="w-full">{read.error}</span>
      </div>
    );
  }
  const writer = read.status.writer;
  if (writer.state === 'held' || writer.state === 'none') return null;
  return (
    <div data-testid="recording-banner" data-state={writer.state} role="alert" className={BANNER}>
      <span className="font-semibold">Not recording knowledge.</span>
      <span>
        {WHY[writer.state]} Knowledge writes are refused and background learning is paused.
      </span>
      {/* Opening the vault again is what starts recording it: every state
          but a refused history can clear that way (a lost lock once the
          other window lets go). */}
      {writer.state !== 'refused' && (
        <Button
          size="sm"
          className="ml-auto"
          testId="recording-reopen"
          onClick={() => void useVaultStore.getState().openVault(vault)}
        >
          Reopen vault
        </Button>
      )}
      {writer.detail !== null && <span className="w-full">{writer.detail}</span>}
    </div>
  );
}

/** The DS warn pairing; the stock palette is reset in index.css. */
const BANNER =
  'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn-300 bg-warn-50 px-4 py-2 text-xs text-warn-700';
