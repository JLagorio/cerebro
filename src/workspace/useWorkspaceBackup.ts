import { useEffect } from 'react';
import {
  workspaceBackupAvailability,
  chooseWorkspaceBackup,
  checkWorkspaceBackup,
  chooseWorkspaceRestore,
  commitWorkspaceBackup,
  commitWorkspaceRestore,
  cancelWorkspaceBackupChoice,
  workspaceBackupOperation,
  onWorkspaceBackupChanged,
} from '@/lib/ipc';
import { flushOpenPages, unresolvedOpenPages } from '@/editor/openPages';
import { getVaultOpening, useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { createBackupWorkflow } from './backupWorkflow';

// One presentation owner survives Settings unmounts. Native owns every chooser,
// token, output reservation and worker; this module stores no backup bytes.
export const workspaceBackupWorkflow = createBackupWorkflow({
  api: {
    availability: workspaceBackupAvailability,
    choose: chooseWorkspaceBackup,
    check: checkWorkspaceBackup,
    restore: chooseWorkspaceRestore,
    commit: commitWorkspaceBackup,
    commitRestore: commitWorkspaceRestore,
    cancel: cancelWorkspaceBackupChoice,
    operation: workspaceBackupOperation,
  },
  presentation: () => ({
    vaultPath: useVaultStore.getState().vaultPath,
    opening: getVaultOpening(),
  }),
  flush: () => flushOpenPages(),
  unresolved: unresolvedOpenPages,
  toast: (message) => useUiStore.getState().toast(message),
});

export function useWorkspaceBackupHost() {
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let unlisten: (() => void) | null = null;
    const schedule = () => {
      if (!alive) return;
      if (workspaceBackupWorkflow.getSnapshot().operation?.kind !== 'running') {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        return;
      }
      if (timer !== null || polling) return;
      // Read-only progress recovery also covers a terminal event that arrived
      // before the original commit acknowledgement. No poll starts a copy.
      timer = setTimeout(() => {
        timer = null;
        polling = true;
        void workspaceBackupWorkflow.refresh().finally(() => {
          polling = false;
          schedule();
        });
      }, 1000);
    };
    const stop = workspaceBackupWorkflow.subscribe(schedule);
    const stopVault = useVaultStore.subscribe(() => {
      void workspaceBackupWorkflow.presentationChanged();
    });
    void onWorkspaceBackupChanged(() => {
      if (alive) void workspaceBackupWorkflow.refresh().finally(schedule);
    }).then(
      (release) => {
        if (alive) unlisten = release;
        else release();
      },
      () => {
        if (alive)
          useUiStore.getState().toast('Live backup updates are unavailable. Use Check status.');
      },
    );
    void workspaceBackupWorkflow.refresh().finally(schedule);
    void workspaceBackupWorkflow.refreshAvailability();
    return () => {
      alive = false;
      stop();
      stopVault();
      unlisten?.();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
