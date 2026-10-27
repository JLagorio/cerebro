import { isKeptOutOfGit } from '@/engine/mailPolicy';
import { isKnowledgePath } from '@/engine/okf';
import { sha256Hex } from './sha256';
import { recoveryLimits } from './policy/recovery';
import type { RecoveryOutcome, RecoveryStatus, RecoveryVersion } from '@/engine/recovery';

export { recoveryLimits } from './policy/recovery';
export type RecoveryRow = RecoveryVersion & { vault: string; raw: string };
/** Browser demonstration only. This journal never claims disk persistence. */
export class MockRecovery {
  private enabled = new Map<string, boolean>();
  private permits = new Map<
    string,
    {
      vault: string;
      path: string;
      before: string;
      after: string;
      expiresAt: number;
      reason: string;
    }
  >();
  private sequence = 0;
  constructor(private rows = new Map<string, RecoveryRow>()) {}
  reset() {
    this.rows.clear();
    this.enabled.clear();
    this.permits.clear();
  }
  /** State-lab fixtures only; no native journal or disk is touched. */
  seed(rows: RecoveryRow[], enabledVaults: string[] = []) {
    this.reset();
    for (const row of rows) this.rows.set(row.id, { ...row });
    for (const vault of enabledVaults) this.enabled.set(vault, true);
  }
  status(vault: string): RecoveryStatus {
    this.expire();
    const rows = [...this.rows.values()];
    return {
      enabled: this.enabled.get(vault) ?? false,
      entries: rows.length,
      retainedBytes: rows.reduce((n, row) => n + row.bytes, 0),
      pending: rows.filter((r) => r.state === 'pending').length,
      ambiguous: rows.filter((r) => r.state === 'ambiguous').length,
      limits: recoveryLimits,
    };
  }
  setEnabled(vault: string, enabled: boolean) {
    if (!this.enabled.has(vault) && this.enabled.size >= recoveryLimits.maxVaults)
      throw new Error('recovery_vault_limit');
    this.enabled.set(vault, enabled);
    return this.status(vault);
  }
  list(vault: string, path: string): RecoveryVersion[] {
    this.expire();
    return [...this.rows.values()]
      .filter((r) => r.vault === vault && r.path === path)
      .sort((a, b) => b.capturedAt - a.capturedAt || b.id.localeCompare(a.id))
      .map(({ vault: _vault, raw: _raw, ...version }) => version);
  }
  private expire() {
    const now = Date.now() / 1000;
    for (const [id, row] of this.rows)
      if (row.state !== 'pending' && row.capturedAt <= now - recoveryLimits.retentionSeconds)
        this.rows.delete(id);
    for (const [id, permit] of this.permits) if (permit.expiresAt <= now) this.permits.delete(id);
  }
  read(vault: string, path: string, id: string): string {
    this.expire();
    const row = this.rows.get(id);
    if (isKeptOutOfGit(path) || isKnowledgePath(path)) throw new Error('recovery_privacy_excluded');
    if (
      !row ||
      row.vault !== vault ||
      row.path !== path ||
      row.state === 'pending' ||
      row.bytes > recoveryLimits.entryBytes
    )
      throw new Error('recovery_copy_unavailable');
    if (sha256Hex(row.raw) !== row.beforeHash) throw new Error('recovery_copy_corrupt');
    return row.raw;
  }
  delete(vault: string, path: string, id: string): boolean {
    this.expire();
    const row = this.rows.get(id);
    return row?.vault === vault && row.path === path && row.state !== 'pending'
      ? this.rows.delete(id)
      : false;
  }
  clear(vault: string): number {
    this.expire();
    if ([...this.rows.values()].some((row) => row.vault === vault && row.state === 'pending'))
      throw new Error('recovery_pending');
    let n = 0;
    for (const [id, row] of this.rows)
      if (row.vault === vault) {
        this.rows.delete(id);
        n++;
      }
    return n;
  }
  failure(vault: string, path: string, nonce: string) {
    this.expire();
    const permit = this.permits.get(nonce);
    if (!permit || permit.vault !== vault || permit.path !== path)
      throw new Error('recovery_bypass_invalid');
    return { reason: permit.reason, expiresAt: permit.expiresAt };
  }
  capture(
    vault: string,
    path: string,
    before: string,
    after: string,
    bypass?: string,
  ): RecoveryOutcome {
    this.expire();
    const beforeHash = sha256Hex(before),
      afterHash = sha256Hex(after);
    if (bypass !== undefined) {
      const permit = this.permits.get(bypass);
      this.permits.delete(bypass);
      if (
        !permit ||
        permit.vault !== vault ||
        permit.path !== path ||
        permit.before !== beforeHash ||
        permit.after !== afterHash
      )
        throw new Error('recovery_bypass_invalid');
      return { kind: 'without_copy' };
    }
    if (isKeptOutOfGit(path) || isKnowledgePath(path))
      return { kind: 'not_retained', reason: 'privacy' };
    if (!this.enabled.get(vault)) return { kind: 'off' };
    if (before === after) return { kind: 'not_retained', reason: 'unchanged' };
    const bytes = new TextEncoder().encode(before).length;
    if (bytes > recoveryLimits.entryBytes) return { kind: 'not_retained', reason: 'entry_limit' };
    try {
      if (new TextEncoder().encode(path).length > recoveryLimits.maxPathBytes)
        throw new Error('path limit');
      const evict: RecoveryRow[] = [];
      let retainedBytes = this.status(vault).retainedBytes;
      const oldest = [...this.rows.values()]
        .filter((r) => r.state !== 'pending')
        .sort((a, b) => a.capturedAt - b.capturedAt);
      while (
        retainedBytes + bytes > recoveryLimits.globalBytes ||
        this.rows.size - evict.length >= recoveryLimits.maxEntries
      ) {
        const row = oldest.shift();
        if (!row) throw new Error('quota pending');
        evict.push(row);
        retainedBytes -= row.bytes;
      }
      const id = `mock-recovery-${++this.sequence}`;
      this.rows.set(id, {
        id,
        vault,
        path,
        raw: before,
        beforeHash,
        afterHash,
        capturedAt: Math.floor(Date.now() / 1000),
        bytes,
        state: 'committed',
        attribution: 'outside, unattributed',
      });
      for (const row of evict) this.rows.delete(row.id);
      return { kind: 'retained', id, evicted: evict.length };
    } catch (error) {
      while (this.permits.size >= recoveryLimits.maxBypasses)
        this.permits.delete(this.permits.keys().next().value!);
      const nonce = `mock-permit-${++this.sequence}`;
      this.permits.set(nonce, {
        vault,
        path,
        before: beforeHash,
        after: afterHash,
        reason:
          error instanceof Error && error.message === 'quota pending'
            ? 'pending_capacity'
            : 'journal_storage_failed',
        expiresAt: Math.floor(Date.now() / 1000) + recoveryLimits.bypassSeconds,
      });
      throw new Error(`recovery_required:${nonce}`, { cause: error });
    }
  }
}
export const mockRecovery = new MockRecovery();
