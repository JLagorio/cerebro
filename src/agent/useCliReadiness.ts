import { useEffect, useSyncExternalStore } from 'react';
import { readCliReadiness } from './agentIpc';
import { createCliReadinessOwner } from './readiness';

let shared = createCliReadinessOwner(readCliReadiness);

export function useCliReadiness() {
  const owner = shared;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useEffect(() => {
    void owner.ensure();
  }, [owner]);
  return state;
}

export function refreshCliReadiness() {
  return shared.refresh();
}

/** Independent test surfaces start with no previous machine observation. */
export function __resetCliReadiness() {
  shared = createCliReadinessOwner(readCliReadiness);
}
