import { useCallback } from 'react';
import { useAutoCheckpoint, useGit } from '@/git/useGit';
import { useUiStore } from '@/stores/uiStore';

/**
 * Runs the automatic-checkpoint loop (M9.4).
 *
 * Mounted at the app root for the same reason `useLearnRunner` is: the panel
 * or page that happened to trigger the work may already be unmounted by the
 * time the vault settles, and a history that only accrues while a particular
 * screen is open is not one.
 */
export function CheckpointHost() {
  const enabled = useUiStore((s) => s.autoCheckpoint);
  const { isRepo, refresh } = useGit();
  const onCommitted = useCallback(() => {
    void refresh();
  }, [refresh]);

  // Intent (`enabled`) and fact (`isRepo`) are separate gates: the setting can
  // be on for a vault that has no repository to commit into.
  useAutoCheckpoint(enabled && isRepo, onCommitted);
  return null;
}
