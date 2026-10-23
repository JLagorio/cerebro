// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewCard } from '@/lib/ipc';
import { failNext, resetFaults } from '@/lib/mockFaults';
import { __seedReview, queueAgentWrite, resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { NeedsYouSection } from './NeedsYouSection';

/**
 * Waiting on you holds one queue from two stores (M57.4c): the ledger's
 * proposals and runtime.db's queued page writes, each read on its own, each
 * failing on its own, and "Nothing is waiting" only when every read came
 * back empty.
 */

const VAULT = '/vault';

const proposal = (id: string): ReviewCard => ({
  proposal_id: id,
  commit_set_id: `c-${id}`,
  run_id: 'run',
  actor: 'process:release-scout',
  op: 'update_belief',
  effective_risk: 'HIGH',
  review: null,
  queued_for: [],
  intended_use_kind: 'ReversibleWork',
  intended_use_stakes: 'HIGH',
  transition_cause: 'new_evidence',
  evidence_refs: [],
  coverage_refs: [],
  authority_refs: [],
  targets: [],
  reason: 'it moved',
  set_members: [id],
  set_ready: true,
});

const queueWrite = () =>
  queueAgentWrite(VAULT, {
    actor: 'process:release-scout',
    runId: 'run-1',
    tool: 'create_note',
    input: { folder: 'records/risks', slug: 'vendor-delay', body: '# Vendor delay\n' },
  });

beforeEach(() => {
  resetMockFs();
  __seedReview({ cards: [], applications: [] });
  useVaultStore.setState({ vaultPath: VAULT, entries: [] });
});
afterEach(() => {
  cleanup();
  resetFaults();
  resetMockFs();
});

describe('NeedsYouSection (M57.4c)', () => {
  it('shows a queued page write on its own', async () => {
    await queueWrite();
    render(<NeedsYouSection vaultPath={VAULT} />);
    expect(await screen.findByTestId('pending-write-card')).not.toBeNull();
    expect(screen.queryByTestId('review-card')).toBeNull();
    expect(screen.queryByTestId('section-empty')).toBeNull();
  });

  it('shows the page writes after the proposals, in one grid', async () => {
    __seedReview({ cards: [proposal('p1')] });
    await queueWrite();
    render(<NeedsYouSection vaultPath={VAULT} />);
    const grid = await screen.findByTestId('review-cards');
    await screen.findByTestId('pending-write-card');
    const kinds = [...grid.children].map((child) => child.getAttribute('data-testid'));
    expect(kinds).toEqual(['review-card', 'pending-write-card']);
    // M91.14 — both are Confirmations, each a cell the grid lays out
    // (review.css), so a row's answers line up.
    expect(grid.classList.contains('cb-review-cards')).toBe(true);
    expect([...grid.children].map((child) => child.getAttribute('data-slot'))).toEqual([
      'confirmation',
      'confirmation',
    ]);
  });

  it('says a failed writes read beside the proposals, and never that nothing waits', async () => {
    __seedReview({ cards: [proposal('p1')] });
    failNext('pending_writes');
    render(<NeedsYouSection vaultPath={VAULT} />);
    expect((await screen.findByTestId('pending-writes-unavailable')).textContent).toBe(
      'Queued page writes could not be read, so this list may be missing some.',
    );
    expect(screen.getByTestId('review-cards')).not.toBeNull();
    expect(screen.queryByTestId('section-empty')).toBeNull();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('says nothing waits only when every read came back empty', async () => {
    render(<NeedsYouSection vaultPath={VAULT} />);
    expect((await screen.findByTestId('section-empty')).textContent).toBe(
      'Nothing is waiting on a decision.',
    );
    cleanup();
    failNext('pending_writes');
    render(<NeedsYouSection vaultPath={VAULT} />);
    expect(await screen.findByTestId('pending-writes-unavailable')).not.toBeNull();
    expect(screen.queryByTestId('section-empty')).toBeNull();
  });
});
