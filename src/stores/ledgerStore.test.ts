import { describe, expect, it } from 'vitest';
import type { LedgerStatus } from '@/lib/ipc';
import { ledgerReviewOf, quarantineOf } from './ledgerStore';
import { supersessionKey } from '@/engine/okf';

const VAULT = '/vault';

function read(extra: Partial<LedgerStatus>) {
  const status: LedgerStatus = {
    verdict: 'valid',
    detail: 'valid',
    head: null,
    seq: 1,
    segments: 1,
    anomalies: 0,
    reconciliation_open: false,
    divergences: [],
    quarantined: [],
    stopped: false,
    history_unreadable: false,
    approved_supersessions: [],
    recorded_human: [],
    writer: { state: 'held', detail: null },
    ...extra,
  };
  return { vault: VAULT, read: { kind: 'read' as const, status } };
}

describe('ledgerStore readers (M49.8)', () => {
  it('a ledger that exists and cannot be read trusts no stamp — never "none quarantined"', () => {
    expect(quarantineOf(VAULT, read({ history_unreadable: true }))).toBe('unknown');
    expect(quarantineOf(VAULT, read({}))).toEqual(new Set());
    expect(quarantineOf(VAULT, { vault: VAULT, read: { kind: 'unavailable', error: 'x' } })).toBe(
      'unknown',
    );
  });

  it('keys the supersessions a person approved, and reads who reviewed from the ledger', () => {
    const view = ledgerReviewOf(
      VAULT,
      read({
        approved_supersessions: [['knowledge/b.md', 'knowledge/a.md']],
        recorded_human: ['knowledge/a.md'],
      }),
    );
    expect(view.approved.has(supersessionKey('knowledge/b.md', 'knowledge/a.md'))).toBe(true);
    expect(view.approved.has(supersessionKey('knowledge/a.md', 'knowledge/b.md'))).toBe(false);
    expect(view.recordedHuman).toEqual(new Set(['knowledge/a.md']));
  });

  it('with no ledger to answer, the file stamp is read instead (recordedHuman null)', () => {
    expect(ledgerReviewOf(VAULT, read({ verdict: 'no-ledger' })).recordedHuman).toBeNull();
    expect(ledgerReviewOf(VAULT, read({ history_unreadable: true })).recordedHuman).toBeNull();
  });
});
