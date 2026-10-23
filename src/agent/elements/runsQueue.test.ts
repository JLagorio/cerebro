import { describe, expect, it } from 'vitest';
import type { Followup } from '@/engine/followups';
import { followupState, wakeSections, wakeState } from './runsQueue';

/**
 * What waits to run, as queues (M91.14): each wake and follow-up says its
 * state in a word before its title, and the wakes keep the read's order in
 * their two sections.
 */

describe('wakeState', () => {
  it('names each state the read gives a wake', () => {
    expect(['pending', 'skipped', 'expired'].map(wakeState)).toEqual([
      { statusText: 'Waiting', icon: 'clock' },
      { statusText: 'Skipped', icon: 'skip-forward' },
      { statusText: 'Expired', icon: 'timer-off' },
    ]);
  });

  it('says a state this build does not name in its own word', () => {
    expect(wakeState('held_by_gate')).toEqual({
      statusText: 'Held by gate',
      icon: 'circle-dashed',
    });
    expect(wakeState('')).toEqual({ statusText: 'Unknown', icon: 'circle-dashed' });
  });
});

describe('wakeSections', () => {
  it('splits what waits from what ended, each in the order the read gave', () => {
    const wakes = [
      { id: 'p1', state: 'pending' },
      { id: 's1', state: 'skipped' },
      { id: 'p2', state: 'pending' },
      { id: 'e1', state: 'expired' },
    ];
    const { waiting, ended } = wakeSections(wakes);
    expect(waiting.map((wake) => wake.id)).toEqual(['p1', 'p2']);
    expect(ended.map((wake) => wake.id)).toEqual(['s1', 'e1']);
  });
});

describe('followupState', () => {
  it('names each state a follow-up passes through', () => {
    const states: Followup['state'][] = ['pending', 'claimed', 'fired', 'cancelled'];
    expect(states.map((state) => followupState(state).statusText)).toEqual([
      'Waiting',
      'Starting',
      'Started',
      'Cancelled',
    ]);
    expect(followupState('archived' as Followup['state']).statusText).toBe('Archived');
  });
});
