import type { Followup } from '@/engine/followups';

/**
 * What is waiting to run, as queues (M91.14): the wakes waiting on an agent
 * (M63.1b) and the follow-ups agents booked for themselves (M63.8). Each row
 * is a Queue item whose state a screen reader hears before its title, in a
 * word, and which its icon draws; the sentence under it stays the record's
 * own (`wakes::words`, `followupWords`). Pure.
 */

/** A queue item's state: its word, read before its title, and its icon. */
export interface QueueState {
  statusText: string;
  icon: string;
}

/** A state this build does not name: its own word, made readable. */
function unnamed(state: string): QueueState {
  const words = state.replace(/[_-]+/g, ' ').trim();
  return {
    statusText: words === '' ? 'Unknown' : words[0].toUpperCase() + words.slice(1),
    icon: 'circle-dashed',
  };
}

const WAKE_STATES: Readonly<Record<string, QueueState>> = {
  pending: { statusText: 'Waiting', icon: 'clock' },
  skipped: { statusText: 'Skipped', icon: 'skip-forward' },
  expired: { statusText: 'Expired', icon: 'timer-off' },
};

/** A wake's state (`fleet_wakes`): waiting, or skipped or expired this week. */
export function wakeState(state: string): QueueState {
  return WAKE_STATES[state] ?? unnamed(state);
}

/**
 * The wakes in the list's two sections, each in the order the read gave
 * them: what still waits, and what ended without a run — skipped, or expired
 * — which the read keeps for a week.
 */
export function wakeSections<W extends { state: string }>(
  wakes: readonly W[],
): { waiting: W[]; ended: W[] } {
  return {
    waiting: wakes.filter((wake) => wake.state === 'pending'),
    ended: wakes.filter((wake) => wake.state !== 'pending'),
  };
}

const FOLLOWUP_STATES: Readonly<Record<string, QueueState>> = {
  pending: { statusText: 'Waiting', icon: 'clock' },
  claimed: { statusText: 'Starting', icon: 'circle-play' },
  fired: { statusText: 'Started', icon: 'circle-check' },
  cancelled: { statusText: 'Cancelled', icon: 'circle-x' },
};

/** A follow-up's state (M63.8): waiting for its time, starting, started, or
 *  cancelled — by the person, or by Cerebro when its agent was gone or
 *  paused. */
export function followupState(state: Followup['state']): QueueState {
  return FOLLOWUP_STATES[state] ?? unnamed(state);
}
