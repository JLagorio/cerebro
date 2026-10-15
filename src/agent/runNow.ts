import { create } from 'zustand';
import { agentRef, isAgentEntry, isPaused } from '@/engine/agents';
import { runNowJob } from '@/engine/jobs';
import { pausedAgents } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';
import { deferralText, startAgentJob, type JobStart } from './startAgentJob';

/** Starts are synchronous reservations, scoped to the vault and page. A
 * slow pause read cannot let a second click race the first to Rust. */
const useStarts = create<{ keys: ReadonlySet<string> }>(() => ({ keys: new Set() }));
const keyFor = (vault: string | null, path: string) => JSON.stringify([vault, path]);
export function useRunNowStarting(vault: string | null, path: string): boolean {
  return useStarts((state) => state.keys.has(keyFor(vault, path)));
}

/** A human action: every refusal is a sentence and nothing throws. */
export async function runAgentNow(path: string): Promise<JobStart | false> {
  const state = useVaultStore.getState();
  const entry = state.entries.find((entry) => entry.path === path && isAgentEntry(entry));
  const toast = useUiStore.getState().toast;
  if (entry === undefined) {
    toast("Not started — that agent's page is gone.");
    return false;
  }
  const vault = state.vaultPath;
  if (vault === null) {
    toast('Not started — the vault is still opening.');
    return false;
  }
  if (refusedAcrossVaults(state, 'Not started — the vault is still opening.')) return false;
  if (isPaused(entry)) {
    toast(`${entry.title} is paused. Resume it to run it now.`);
    return false;
  }
  const key = keyFor(vault, path);
  const running = () =>
    useUiStore.getState().runs.some((run) => run.owner === 'job' && run.path === path);
  if (useStarts.getState().keys.has(key) || running()) {
    toast(`${entry.title} is already running. Let that run finish, or stop it first.`);
    return false;
  }
  useStarts.setState((state) => ({ keys: new Set([...state.keys, key]) }));
  try {
    // Failure is not a measured empty fleet; Rust remains the final gate.
    const paused = await pausedAgents(vault).catch(() => null);
    if (useVaultStore.getState().vaultPath !== vault) {
      toast(`Not started — the vault changed before ${entry.title} could start.`);
      return false;
    }
    if (paused?.includes(agentRef(entry).actor)) {
      toast(`${entry.title} is paused on the fleet. Resume it there to run it now.`);
      return false;
    }
    const fresh = useVaultStore.getState();
    const current = fresh.entries.find((entry) => entry.path === path && isAgentEntry(entry));
    if (current === undefined) {
      toast("Not started — that agent's page is gone.");
      return false;
    }
    if (refusedAcrossVaults(fresh, 'Not started — the vault is still opening.')) return false;
    if (isPaused(current)) {
      toast(`${current.title} is paused. Resume it to run it now.`);
      return false;
    }
    if (running()) {
      toast(`${current.title} is already running. Let that run finish, or stop it first.`);
      return false;
    }
    const job = runNowJob(current, {
      skillRuns: useUiStore.getState().skillRuns[vault] ?? {},
      now: new Date(),
    });
    const result = await startAgentJob(job, { vaultPath: vault, onSettled: () => {} });
    if (result.kind === 'deferred')
      toast(
        `${current.title} didn't start: ${deferralText(result.reasons, result.words)}.${result.gaveBack ? ' Its scheduled run is still owed.' : ''}`,
      );
    else if (result.kind === 'failed') toast(`${current.title} didn't start: ${result.error}`);
    else if (result.kind === 'moved')
      toast(`Not started — the vault changed before ${current.title} could start.`);
    return result;
  } catch (error) {
    toast(`${entry.title} didn't start: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    useStarts.setState((state) => {
      const keys = new Set(state.keys);
      keys.delete(key);
      return { keys };
    });
  }
}
