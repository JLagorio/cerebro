import { describe, expect, it } from 'vitest';
import type { CardTarget, ReviewCard } from '@/lib/ipc';
import { POLICY } from '@/lib/policy/table';
import {
  OP_VERB,
  basisText,
  heldForText,
  humanize,
  movedText,
  opVerb,
  purposeText,
  reasonSentence,
  riskLabel,
  riskTitle,
  targetName,
  waitingLine,
} from './proposalText';

/**
 * The card's words (M52.2). UI copy keyed by the table's own names — so what
 * is held here is that the copy COVERS the table and never replaces a code
 * it has no words for.
 */

const TARGET: CardTarget = {
  target_class: 'belief',
  target_id: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
  expected_version: 3,
  current_version: 4,
  stale: true,
  path: 'knowledge/systems/offline-guarantee.md',
};

const CARD: ReviewCard = {
  proposal_id: 'p1',
  commit_set_id: 'c1',
  run_id: 'r1',
  actor: 'process:release-scout',
  op: 'update_belief',
  effective_risk: 'HIGH',
  review: null,
  queued_for: [],
  intended_use_kind: 'ReversibleWork',
  intended_use_stakes: 'HIGH',
  transition_cause: 'new_evidence',
  evidence_refs: ['e1', 'e2', 'e3'],
  coverage_refs: ['c1'],
  authority_refs: [],
  targets: [TARGET],
  reason: 'the error rate held for six days',
  set_members: ['p1'],
  set_ready: true,
};

describe('proposal copy (M52.2)', () => {
  it('has a verb for every op the policy table declares', () => {
    // A new op in the table fails HERE, rather than reading as its code on
    // a card nobody tested it on.
    expect(Object.keys(POLICY.ops).filter((op) => !(op in OP_VERB))).toEqual([]);
    expect(Object.keys(OP_VERB).filter((op) => !(op in POLICY.ops))).toEqual([]);
  });

  it('reads an op it has no verb for aloud, and says so', () => {
    expect(opVerb('update_belief')).toEqual({ verb: 'Revise', known: true });
    expect(opVerb('tombstone_belief')).toEqual({ verb: 'Retire', known: true });
    expect(opVerb('add_relation')).toEqual({ verb: 'Add relation', known: false });
  });

  it('says why a card waits in words, keyed by the table slot, and shows an unknown code as itself', () => {
    const code = POLICY.high_stakes.queue_rejection;
    expect(code).toBe('high_stakes_verification_required');
    // What the card lacks, read off its own refs (M52.5): this one cites a
    // coverage check and no sign-off, so it says the sign-off is missing —
    // never that "nothing has confirmed it" above a line citing the check.
    expect(heldForText(code, CARD)).toBe(
      'Needs a person: it backs a high-stakes decision and nobody has signed off on it yet.',
    );
    expect(heldForText(code, { ...CARD, coverage_refs: [], authority_refs: ['a1'] })).toBe(
      'Needs a person: it backs a high-stakes decision and nothing has checked what it covers yet.',
    );
    expect(heldForText(code, { ...CARD, coverage_refs: [] })).toBe(
      'Needs a person: it backs a high-stakes decision, nobody has signed off on it, and nothing has checked what it covers yet.',
    );
    expect(heldForText(code, { ...CARD, authority_refs: ['a1'] })).toBe(
      'Needs a person: it backs a high-stakes decision.',
    );
    expect(heldForText(code, CARD)).not.toContain('_');
    expect(heldForText('some_future_code', CARD)).toBe('Held for some_future_code.');
  });

  it("leads with the proposer's reason as a sentence", () => {
    expect(reasonSentence('the error rate held for six days')).toBe(
      'The error rate held for six days',
    );
  });

  it('reads codes aloud, and an absent field as not recorded — never as nothing', () => {
    expect(humanize('new_evidence')).toBe('new evidence');
    expect(humanize('ReversibleWork')).toBe('reversible work');
    expect(humanize('HIGH')).toBe('high');
    expect(humanize(undefined)).toBe('not recorded');
    expect(humanize('')).toBe('not recorded');
  });

  it('says what a proposal rests on, with measured counts, in one line', () => {
    expect(basisText(CARD)).toBe('Based on 3 sources and 1 coverage check');
    expect(basisText({ ...CARD, coverage_refs: [], authority_refs: ['a1'] })).toBe(
      'Based on 3 sources and 1 sign-off',
    );
    expect(basisText({ ...CARD, evidence_refs: ['e1'], coverage_refs: [] })).toBe(
      'Based on 1 source',
    );
    // An empty list is measured-at-zero, and said.
    expect(basisText({ ...CARD, evidence_refs: [], coverage_refs: [] })).toBe('Cites no evidence');
    // A list the wire did not carry is not claimed either way.
    const unrecorded = {
      ...CARD,
      evidence_refs: undefined,
      coverage_refs: undefined,
      authority_refs: undefined,
    } as unknown as ReviewCard;
    expect(basisText(unrecorded)).toBeNull();
  });

  // M52.5 — stakes and reversibility read as policy on the face of the card;
  // they are Details' words now.
  it('says why now and what for in words, for the Details', () => {
    expect(purposeText(CARD)).toBe(
      'Proposed because of new evidence, for reversible work at high stakes.',
    );
  });

  it('names a target by its concept, as "this concept" on its own page, or by its class', () => {
    const titleOf = () => 'The offline guarantee';
    expect(targetName(TARGET, titleOf)).toBe('The offline guarantee');
    expect(targetName(TARGET, titleOf, TARGET.path as string)).toBe('this concept');
    expect(targetName({ ...TARGET, target_class: 'relation', path: null }, titleOf)).toBe('a link');
  });

  it('says what moved underneath before anyone approves', () => {
    // What happened, and no more: Approve is already disabled beside it.
    expect(movedText(TARGET, 'this concept')).toBe('This concept changed after this was proposed.');
    expect(movedText({ ...TARGET, current_version: null }, 'a link')).toBe(
      'A link no longer exists.',
    );
  });

  it('gives a queue row one line', () => {
    expect(waitingLine([CARD])).toBe('A proposal to revise it is waiting on you');
    expect(waitingLine([{ ...CARD, op: 'add_relation' }])).toBe(
      'A proposal (add relation) is waiting on you',
    );
    expect(waitingLine([CARD, CARD])).toBe('2 proposals are waiting on you');
  });

  // M52.5 — "MEDIUM" beside "a high-stakes decision" read as a contradiction;
  // the chip says whose risk it is.
  it('names the risk in sentence case', () => {
    expect(riskLabel('MEDIUM')).toBe('Medium risk');
    expect(riskLabel('CRITICAL')).toBe('Critical risk');
  });

  it("takes the risk chip's tooltip from the table's own ladder", () => {
    expect(riskTitle('HIGH')).toBe('High risk — changes at this risk wait for a person');
    expect(riskTitle('LOW')).toBe('Low risk');
  });
});
