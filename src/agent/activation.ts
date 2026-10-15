import { lastSetFireKey, parseScheduleSet } from '@/engine/skills';
import { jobLedgerClaim } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';

export const RESUME_STAMP_FAILED =
  "Resumed. Cerebro couldn't record when, so a run its schedule missed may start now.";
export const SCHEDULE_STAMP_FAILED =
  "Saved. Cerebro couldn't record when the new schedule starts, so a run it missed may start now.";

/** Answer the newest passed fire without starting it. A false claim means
 * that same key was already answered, which is also a successful boundary. */
export async function stampActivation(
  vault: string,
  identity: string,
  schedule: unknown,
  now: Date,
): Promise<boolean> {
  const parsed = parseScheduleSet(schedule);
  const key = parsed === null ? null : lastSetFireKey(parsed, now);
  if (key === null) return true;
  try {
    await jobLedgerClaim(vault, 'skillRuns', identity, key);
    useUiStore.getState().recordSkillRun(vault, identity, key);
    return true;
  } catch {
    return false;
  }
}
