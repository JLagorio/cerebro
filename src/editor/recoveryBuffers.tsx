import { createContext, useContext, useId } from 'react';
import type { DocumentOwner } from './documentOwner';

/** Data-only capture. Each presentation binds once to an actual owner instance;
 * delayed child cleanup cannot acquire a replacement owner at the same path. */
export interface RecoveryCapture {
  bind: (owner: DocumentOwner) => void;
  set: (group: string, text: string | null) => void;
  commit: (group: string, apply: () => void) => void;
  detach: () => void;
  owner: () => DocumentOwner | null;
}
export function createRecoveryCapture(scope?: {
  vaultId: string | null;
  path: string;
  ownerId: string;
  generation?: number;
}): RecoveryCapture {
  let target: DocumentOwner | null = null;
  let active = true;
  const pending = new Map<string, string | null>();
  return {
    bind(owner) {
      if (!active || target !== null) return;
      if (
        scope &&
        (scope.vaultId !== owner.key.vaultId ||
          scope.path !== owner.key.path ||
          scope.ownerId !== owner.key.ownerId)
      )
        return;
      target = owner;
      for (const [group, text] of pending) target.setChildDrafts(group, text);
      pending.clear();
    },
    set(group, text) {
      if (!active) return;
      if (target) target.setChildDrafts(group, text);
      else pending.set(group, text);
    },
    commit(group, apply) {
      if (!active || target?.recoveryRetired()) return;
      const before = target?.snapshot().latestDraft;
      apply();
      // A synchronous owner change proves preparation reached its body. A
      // detached/no-op callback keeps the child for explicit recovery.
      if (target && target.snapshot().latestDraft !== before) target.setChildDrafts(group, null);
    },
    detach() {
      active = false;
      pending.clear();
    },
    owner() {
      return active && !target?.recoveryRetired() ? target : null;
    },
  };
}
export const RecoveryBufferContext = createContext<RecoveryCapture | null>(null);
export function useRecoveryBuffer(kind: string) {
  const capture = useContext(RecoveryBufferContext);
  const instance = useId();
  const group = `${kind}:${instance}`;
  return {
    set(text: string, source: string) {
      capture?.set(group, JSON.stringify({ kind, source, text }));
    },
    clear() {
      capture?.set(group, null);
    },
    commit(apply: () => void) {
      if (capture) capture.commit(group, apply);
      else apply();
    },
  };
}
