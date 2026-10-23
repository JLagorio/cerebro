import { describe, expect, it, vi } from 'vitest';
import {
  changedSinceQueued,
  editSent,
  editWaits,
  FILING_COPY,
  filingAnswers,
  filingState,
  PENDING_COPY,
  pendingWriteAnswers,
  pendingWriteState,
  proposalAnswers,
  proposalState,
} from '@/agent/elements/decisions';
import { FRESH_PROPOSAL_LABEL } from '@/lib/prompts';

/**
 * The decisions' view models (M91.14): the state each card's Confirmation is
 * told, the answers it offers, and what each answer hands its door.
 */

describe('a queued page write', () => {
  const idle = { busy: false, refused: null, outcome: null };

  it('waits, answers, refuses an edit and settles, in that order of precedence', () => {
    expect(pendingWriteState(idle)).toBe('pending');
    expect(pendingWriteState({ ...idle, busy: true })).toBe('answering');
    // A refused edit still waits for the person.
    expect(pendingWriteState({ ...idle, refused: 'Not in scope.' })).toBe('refused');
    expect(pendingWriteState({ ...idle, refused: 'Not in scope.', busy: true })).toBe('answering');
    // A decision that landed is the outcome until the queue reads again.
    expect(pendingWriteState({ busy: true, refused: null, outcome: 'Rejected' })).toBe('answered');
  });

  it('says the page changed only when both hashes are known and differ', () => {
    expect(changedSinceQueued('a', 'b')).toBe(true);
    expect(changedSinceQueued('a', 'a')).toBe(false);
    expect(changedSinceQueued(null, 'b')).toBe(false);
    expect(changedSinceQueued('a', null)).toBe(false);
    expect(changedSinceQueued('a', undefined)).toBe(false);
  });

  it('sends the edit only when there is one, and waits while it cannot be sent', () => {
    const input = { body: '# B\n' };
    expect(editSent(null)).toBeNull();
    expect(editSent({ input, valid: true, edited: false })).toBeNull();
    expect(editSent({ input, valid: true, edited: true })).toBe(input);
    expect(editWaits(null)).toBe(false);
    expect(editWaits({ input, valid: false, edited: true })).toBe(true);
    expect(editWaits({ input, valid: true, edited: true })).toBe(false);
    // An untouched form waits on nothing.
    expect(editWaits({ input, valid: false, edited: false })).toBe(false);
  });

  it('offers Allow and a Reject that asks for words once pressed', () => {
    const onAllow = vi.fn();
    const onReject = vi.fn();
    const { approve, deny } = pendingWriteAnswers({ allowWaits: true, onAllow, onReject });
    expect(approve).toEqual([
      { label: 'Allow', testId: 'pending-write-allow', disabled: true, onClick: onAllow },
    ]);
    expect(deny.label).toBe(PENDING_COPY.reject);
    expect(deny.testId).toBe('pending-write-reject');
    expect(deny.reason).toEqual({
      label: PENDING_COPY.reason,
      required: true,
      when: 'on_deny',
      testId: 'pending-write-reason',
      sendLabel: 'Send',
      sendTestId: 'pending-write-send',
    });
    deny.onDeny('not yet');
    expect(onReject).toHaveBeenCalledWith('not yet');
    // The reason is required: a wordless Deny never reaches the door.
    deny.onDeny(null);
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});

describe('a queued proposal', () => {
  const handlers = () => ({ onApprove: vi.fn(), onAskFresh: vi.fn(), onReject: vi.fn() });

  it('offers nothing while a decision is on its way or waits for the re-read', () => {
    expect(proposalState(false)).toBe('pending');
    expect(proposalState(true)).toBe('answering');
  });

  it('approves as its primary answer, and rejects only with a reason asked beside it', () => {
    const h = handlers();
    const { approve, deny } = proposalAnswers({ stale: false, ...h });
    expect(approve.map((c) => [c.label, c.testId, c.variant, c.disabled])).toEqual([
      ['Approve', 'approve', 'primary', false],
    ]);
    approve[0].onClick();
    expect(h.onApprove).toHaveBeenCalledTimes(1);
    expect(deny.testId).toBe('reject');
    expect(deny.reason).toEqual({
      label: 'Why not?',
      required: true,
      when: 'always',
      testId: 'reject-reason',
    });
    deny.onDeny('the rewrite kept it');
    expect(h.onReject).toHaveBeenCalledWith('the rewrite kept it');
    deny.onDeny(null);
    expect(h.onReject).toHaveBeenCalledTimes(1);
  });

  it('offers a fresh proposal in place of an Approve the ledger would refuse', () => {
    const h = handlers();
    const { approve } = proposalAnswers({ stale: true, ...h });
    expect(approve.map((c) => [c.label, c.testId, c.variant, c.disabled ?? false])).toEqual([
      [FRESH_PROPOSAL_LABEL, 'ask-fresh', 'primary', false],
      ['Approve', 'approve', 'secondary', true],
    ]);
    expect(approve[0].icon).toBe('sparkles');
    approve[0].onClick();
    expect(h.onAskFresh).toHaveBeenCalledTimes(1);
    expect(h.onApprove).not.toHaveBeenCalled();
  });
});

describe('a suggested filing', () => {
  it('offers nothing more while Apply writes', () => {
    expect(filingState(false)).toBe('pending');
    expect(filingState(true)).toBe('answering');
  });

  it('applies, or dismisses without asking why', () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const { approve, deny } = filingAnswers({ onApply, onDismiss });
    expect(approve.map((c) => [c.label, c.icon])).toEqual([[FILING_COPY.apply, 'check']]);
    approve[0].onClick();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(deny.label).toBe(FILING_COPY.dismiss);
    expect(deny.reason).toBeUndefined();
    deny.onDeny(null);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
