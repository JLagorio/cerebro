import { readChatRecovery } from './agentIpc';
import { getVaultOpening, useVaultStore } from '@/stores/vaultStore';
import type { ChatRecoveryInspection } from '@/lib/generated/actions';
import type { NativeRecoveryRoot } from './types';

export type RecoveryInspectionState =
  | { kind: 'loading' | 'retired' | 'unavailable' }
  | { kind: 'loaded'; value: ChatRecoveryInspection };

/** A read-only disclosure lifetime. The native command alone admits the read. */
export class RecoveryInspection {
  private readonly root: NativeRecoveryRoot;
  private state: RecoveryInspectionState = { kind: 'loading' };
  private live = false;
  private retired = false;
  private serial = 0;
  private listeners = new Set<() => void>();

  constructor(root: NativeRecoveryRoot) {
    this.root = { ...root };
  }

  snapshot = (): RecoveryInspectionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(state: RecoveryInspectionState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  private current(): boolean {
    return (
      this.live &&
      !this.retired &&
      useVaultStore.getState().vaultPath === this.root.vaultPath &&
      getVaultOpening() === this.root.opening
    );
  }

  private retire(): void {
    this.retired = true;
    this.serial += 1;
    this.publish({ kind: 'retired' });
  }

  start = (): (() => void) => {
    this.live = true;
    const unsubscribe = useVaultStore.subscribe(() => {
      if (!this.current()) this.retire();
    });
    void this.refresh();
    return () => {
      this.live = false;
      this.serial += 1;
      unsubscribe();
    };
  };

  refresh = async (): Promise<void> => {
    if (!this.current()) {
      this.retire();
      return;
    }
    const request = ++this.serial;
    this.publish({ kind: 'loading' });
    try {
      const value = await readChatRecovery(this.root.runId);
      if (!this.current() || request !== this.serial) return;
      if (value.origin.runId !== this.root.runId) {
        this.publish({ kind: 'unavailable' });
        return;
      }
      this.publish({ kind: 'loaded', value: structuredClone(value) });
    } catch {
      if (this.current() && request === this.serial) this.publish({ kind: 'unavailable' });
    }
  };
}
