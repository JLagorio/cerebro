import { useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import * as ipc from '@/lib/ipc';
import type { ReviewCard, RevertableApplication } from '@/lib/ipc';
import { refusalText } from '@/lib/refusal';
import { useUiStore } from '@/stores/uiStore';

/**
 * The proposals agents queued, read where a concept is (M52.2).
 *
 * The cards lived only in Review's "Waiting on you", so a person reading the
 * concept an agent wanted to retire saw nothing of it — the page and the
 * decision about it were two places that never named each other. A concept
 * page now reads the same queue and shows the cards that target it.
 *
 * **Two reads, one version.** Each surface reads for itself (the house rule:
 * a section owns its read and its failure), and a decision made on either
 * one bumps the version, so both re-read. Nothing is cached — a card is
 * never shown from memory, only from the ledger's latest answer.
 */

/** Bumped by every decision, anywhere; every reader of the queue re-reads. */
const usePendingVersionStore = create<{ version: number; bump: () => void }>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));

export function usePendingVersion(): number {
  return usePendingVersionStore((s) => s.version);
}

export function bumpPendingCards(): void {
  usePendingVersionStore.getState().bump();
}

/** The `Feed<T>` contract (`knowledge/BaseItself.tsx`): a failed read is
 * `unavailable`, never an empty list. */
export type PendingCards =
  { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; data: ReviewCard[] };

export function usePendingCards(vaultPath: string | null): PendingCards {
  const version = usePendingVersion();
  // Keyed by the vault it answered for, so a vault switch reads as loading
  // rather than showing the last vault's cards for a frame.
  const [read, setRead] = useState<{ vault: string | null; feed: PendingCards }>({
    vault: vaultPath,
    feed: { kind: 'loading' },
  });
  useEffect(() => {
    if (vaultPath === null) {
      setRead({ vault: null, feed: { kind: 'unavailable' } });
      return;
    }
    let live = true;
    void (async () => {
      try {
        const cards = await ipc.reviewQueue(vaultPath);
        if (live) setRead({ vault: vaultPath, feed: { kind: 'ready', data: cards } });
      } catch {
        // A read behind a surface goes quiet (AGENTS.md's store-layer rule);
        // each caller decides what "could not tell" looks like.
        if (live) setRead({ vault: vaultPath, feed: { kind: 'unavailable' } });
      }
    })();
    return () => {
      live = false;
    };
  }, [vaultPath, version]);
  return read.vault === vaultPath ? read.feed : { kind: 'loading' };
}

/** Every concept path a card targets, to the cards targeting it. */
export function proposalsByPath(cards: readonly ReviewCard[]): Map<string, ReviewCard[]> {
  const byPath = new Map<string, ReviewCard[]>();
  for (const card of cards) {
    const paths = new Set(card.targets.flatMap((t) => (t.path == null ? [] : [t.path])));
    for (const path of paths) byPath.set(path, [...(byPath.get(path) ?? []), card]);
  }
  return byPath;
}

/** Who a decision is recorded as. The ledger keeps the reviewer, so this is
 * a name in the permanent record and not a UI label. */
export const REVIEWER = 'human:me';

/**
 * Approve, reject and revert — one implementation for every surface that
 * shows a card, so the Review tab and a concept page cannot drift in what
 * they send (M52.2; the handlers are `ReviewPage`'s, moved twice).
 *
 * Proposal channels are the AGENTS.md carve-out: the result is READ, not
 * toasted away. A queued set that did not resolve, and a rejection the
 * server refused, are different answers and the reviewer sees both.
 *
 * Rejection needs a reason before it will send. That is not politeness —
 * the server refuses a reasonless rejection, and a refusal nobody can learn
 * from later is the shape M24 exists to avoid.
 *
 * **A decided card stays decided until the re-read lands (M52.4).** `busy`
 * clears the moment the decision resolves, but the queue is re-read after
 * it, so for that gap the card is still on screen with its buttons live — a
 * second click sends a decision about a proposal that no longer waits.
 * `isSettled` names the cards this hook has already decided (a resolved set:
 * all of its members) and `isReverted` the applications it has undone, and
 * the surfaces hold those buttons. Two lists, because approving a card is
 * what makes it an undoable application under the same proposal id — one
 * list would hold the Revert of the change just applied.
 */
export function useDecisions(vaultPath: string | null) {
  const toast = useUiStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [isSettled, settle] = useSettledIds(vaultPath);
  const [isReverted, reverted] = useSettledIds(vaultPath);

  const decide = useCallback(
    async (card: ReviewCard, approve: boolean, reason: string | null) => {
      if (vaultPath === null) return;
      setBusy(true);
      try {
        const transition = await ipc.decideProposal(
          vaultPath,
          card.proposal_id,
          approve,
          REVIEWER,
          reason,
        );
        if (transition === null) {
          toast('Recorded — the rest of this set is still waiting');
        } else if (transition === 'apply') {
          toast('Applied');
        } else if (transition === 'stale_reject') {
          toast('Refused: it changed after it was proposed');
        } else {
          toast('Rejected');
        }
        // A transition resolved the whole set; null recorded only this vote.
        settle(transition === null ? [card.proposal_id] : card.set_members);
        bumpPendingCards();
      } catch (e) {
        toast(`Couldn't decide: ${refusalText(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [vaultPath, toast, settle],
  );

  const undo = useCallback(
    async (application: RevertableApplication) => {
      if (vaultPath === null) return;
      setBusy(true);
      try {
        await ipc.revertApplication(
          vaultPath,
          application.proposal_id,
          [application.applied_event_id],
          REVIEWER,
        );
        toast('Reverted — the original change is still in the record');
        reverted([application.proposal_id]);
        bumpPendingCards();
      } catch (e) {
        toast(`Couldn't revert: ${refusalText(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [vaultPath, toast, reverted],
  );

  return { busy, decide, undo, isSettled, isReverted };
}

/** Ids a surface has acted on, forgotten when the vault changes — keyed by the
 * vault they were recorded in, as `usePendingCards` keys its read. */
function useSettledIds(
  vaultPath: string | null,
): [(id: string) => boolean, (ids: readonly string[]) => void] {
  const [settled, setSettled] = useState<{ vault: string | null; ids: ReadonlySet<string> }>({
    vault: vaultPath,
    ids: new Set(),
  });
  const add = useCallback(
    (ids: readonly string[]) =>
      setSettled((s) => ({
        vault: vaultPath,
        ids: new Set([...(s.vault === vaultPath ? s.ids : []), ...ids]),
      })),
    [vaultPath],
  );
  return [(id) => settled.vault === vaultPath && settled.ids.has(id), add];
}
