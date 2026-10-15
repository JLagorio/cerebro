import { useCallback, useEffect, useRef } from 'react';
import type { HomeRow } from '@/engine/homeLanes';
import { markId, type DoneMarkResult } from '@/engine/reminderState';
import { useDoneMarksStore } from '@/stores/doneMarksStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const pending = new Set<string>();
/** Done covers each rendered revision. doneMany keeps one toast and one exact
 * Undo for the group, even if another window has since written a newer mark. */
export function useHomeDone() {
  const vault = useVaultStore((s) => s.vaultPath);
  const lifetime = useRef(0);
  useEffect(
    () =>
      useVaultStore.subscribe((next, previous) => {
        if (next.vaultPath !== previous.vaultPath) lifetime.current++;
      }),
    [],
  );
  const stateVault = useDoneMarksStore((s) => s.vault);
  const status = useDoneMarksStore((s) => s.status);
  const marks = useDoneMarksStore((s) => s.marks);
  useEffect(() => {
    if (vault !== null) void useDoneMarksStore.getState().hydrate(vault);
  }, [vault]);
  const perform = useCallback(
    async (rows: readonly HomeRow[], many: boolean): Promise<boolean> => {
      const epoch = lifetime.current;
      const sameVault = () =>
        vault !== null &&
        useVaultStore.getState().vaultPath === vault &&
        useDoneMarksStore.getState().vault === vault;
      const current = () => sameVault() && epoch === lifetime.current;
      if (!current() || useDoneMarksStore.getState().status !== 'ready') return false;
      const results: DoneMarkResult[] = [];
      const inputs = new Map(
        rows.flatMap((row) => (row.done ? [[markId(row.done), row.done] as const] : [])),
      );
      let failed = 0;
      for (const [id, input] of inputs) {
        if (!current()) return false;
        const key = `${vault}:${id}`;
        if (pending.has(key)) continue;
        pending.add(key);
        try {
          const result = await useDoneMarksStore.getState().markDoneResult(input, { quiet: many });
          if (result === false) failed++;
          else results.push(result);
        } catch {
          failed++;
          if (!many) useUiStore.getState().toast('Done could not be saved. Please try again.');
        } finally {
          pending.delete(key);
        }
      }
      if (!current() || results.length + failed === 0) return false;
      if (many || results.length)
        useUiStore.getState().toast(
          many
            ? `Marked ${results.length} done${failed ? ` · ${failed} couldn't be marked` : ''}`
            : 'Marked done',
          results.length
            ? {
                action: {
                  label: 'Undo',
                  run: () => {
                    if (!sameVault()) {
                      useUiStore.getState().toast('Reopen this vault to undo Done.');
                      return;
                    }
                    const undoEpoch = lifetime.current;
                    const undoCurrent = () => sameVault() && lifetime.current === undoEpoch;
                    void (async () => {
                      let refused = 0;
                      for (const result of results) {
                        if (!undoCurrent()) return;
                        try {
                          if (
                            !(await useDoneMarksStore
                              .getState()
                              .undoDone(result.set, result.replaced, { quiet: many }))
                          )
                            refused++;
                        } catch {
                          refused++;
                        }
                      }
                      if (many && refused && undoCurrent())
                        useUiStore
                          .getState()
                          .toast(
                            `${refused} Done ${refused === 1 ? 'mark' : 'marks'} could not be undone.`,
                          );
                    })();
                  },
                },
              }
            : undefined,
        );
      return results.length > 0;
    },
    [vault],
  );
  const ready = vault !== null && stateVault === vault && status === 'ready';
  return {
    marks: ready ? marks : null,
    loading: stateVault !== vault || status === 'idle' || status === 'loading',
    ready,
    done: useCallback((row: HomeRow) => perform([row], false), [perform]),
    doneMany: useCallback((rows: readonly HomeRow[]) => perform(rows, true), [perform]),
  };
}
