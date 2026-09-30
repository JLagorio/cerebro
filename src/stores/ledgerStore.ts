import { create } from 'zustand';
import { ledgerStatus, type LedgerStatus } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import {
  NO_LEDGER_REVIEW,
  supersessionKey,
  type LedgerReviewView,
  type Quarantine,
} from '@/engine/okf';

/**
 * The open vault's live ledger status (M49.2), shared by the two ledger
 * banners and the job runner.
 *
 * A read that FAILED is `unavailable`, never `null`. Before M49.2 the banner
 * mapped a failed read to "render nothing", which is the sentence "all is
 * well" — the opposite of "we could not tell" (AGENTS.md: unavailable is
 * never empty).
 */
export type LedgerRead =
  | { kind: 'unread' }
  | { kind: 'read'; status: LedgerStatus }
  | { kind: 'unavailable'; error: string };

interface LedgerState {
  vault: string | null;
  read: LedgerRead;
  /** Never throws (store-layer invariant); a failure lands as `unavailable`. */
  refresh(vault: string): Promise<void>;
}

/** Bumped per refresh, so a slow read for the previous vault cannot land
 * over a newer one. */
let generation = 0;

export const useLedgerStore = create<LedgerState>()((set) => ({
  vault: null,
  read: { kind: 'unread' },
  async refresh(vault) {
    const mine = ++generation;
    try {
      const status = await ledgerStatus(vault);
      if (mine === generation) set({ vault, read: { kind: 'read', status } });
    } catch (err) {
      if (mine !== generation) return;
      set({
        vault,
        read: { kind: 'unavailable', error: err instanceof Error ? err.message : String(err) },
      });
    }
  },
}));

/**
 * May knowledge work run against `vault`? Only a read that SAYS so counts:
 * unread, unavailable, another vault's status, and every writer state but
 * `held` (and the mock's ledgerless `none`) fail closed. Knowledge writes
 * would refuse anyway (M49.1); this stops a paid run before it starts.
 */
export function isRecording(vault: string | null, state: Pick<LedgerState, 'vault' | 'read'>) {
  if (vault === null || state.vault !== vault || state.read.kind !== 'read') return false;
  const writer = state.read.status.writer.state;
  return writer === 'held' || writer === 'none';
}

/**
 * The open vault's quarantined knowledge paths (M49.8), as a set stable
 * across renders that did not change it — `listConcepts` reads it so a
 * review claimed by a file that is not the recorded one reads `disputed`.
 * Empty until a status is read, and in the browser mock.
 */
let lastQuarantine: { read: LedgerRead | null; set: Quarantine } = {
  read: null,
  set: new Set(),
};

export function quarantineOf(
  vault: string | null,
  state: Pick<LedgerState, 'vault' | 'read'>,
): Quarantine {
  if (vault === null || state.vault !== vault || state.read.kind === 'unread') {
    return EMPTY_QUARANTINE;
  }
  // A status that could not be read, or a bundle that could not be
  // compared, is NOT "nothing quarantined" (review fix): no file's own
  // review claim is trusted until it can be checked.
  if (state.read.kind === 'unavailable') return 'unknown';
  if (lastQuarantine.read !== state.read) {
    const { quarantined: rows, history_unreadable } = state.read.status;
    lastQuarantine = {
      read: state.read,
      // A ledger that exists and could not be read is not "no ledger":
      // Rust's `trust_label` trusts no stamp then, and neither does this.
      set:
        history_unreadable || rows.some((q) => q.path === 'knowledge/')
          ? 'unknown'
          : new Set(rows.map((q) => q.path)),
    };
  }
  return lastQuarantine.set;
}

/**
 * What the ledger says about review, for `listConcepts` (M49.8, K22): the
 * supersessions a person approved, keyed `replacement\u0000replaced`, and
 * the concepts whose current review it records as a person's. Stable across
 * renders that did not change them. No readable ledger — unread, failed,
 * unreadable history, or none at all — answers `recordedHuman: null`, and
 * the file's stamp is read instead, as Rust's `review_label` does.
 */
let lastReview: { read: LedgerRead | null; view: LedgerReviewView } = {
  read: null,
  view: NO_LEDGER_REVIEW,
};

export function ledgerReviewOf(
  vault: string | null,
  state: Pick<LedgerState, 'vault' | 'read'>,
): LedgerReviewView {
  if (vault === null || state.vault !== vault || state.read.kind !== 'read') {
    return NO_LEDGER_REVIEW;
  }
  if (lastReview.read !== state.read) {
    const status = state.read.status;
    const answers = status.verdict !== 'no-ledger' && !status.history_unreadable;
    lastReview = {
      read: state.read,
      view: {
        approved: new Set(
          status.approved_supersessions.map(([by, replaced]) => supersessionKey(by, replaced)),
        ),
        recordedHuman: answers ? new Set(status.recorded_human) : null,
      },
    };
  }
  return lastReview.view;
}

/** `ledgerReviewOf` for the open vault, as a hook. */
export function useLedgerReview(): LedgerReviewView {
  const vault = useVaultStore((s) => s.vaultPath);
  return useLedgerStore((s) => ledgerReviewOf(vault, s));
}

const EMPTY_QUARANTINE: ReadonlySet<string> = new Set();

/** `quarantineOf` for the open vault, as a hook. */
export function useQuarantine(): Quarantine {
  const vault = useVaultStore((s) => s.vaultPath);
  return useLedgerStore((s) => quarantineOf(vault, s));
}
