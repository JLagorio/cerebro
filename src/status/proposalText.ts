import type { CardLink, CardTarget, ReviewCard } from '@/lib/ipc';
import { POLICY } from '@/lib/policy/table';

/**
 * A proposal card in the app's own words (M52.2).
 *
 * The card led with the ledger's vocabulary — `update_belief`,
 * `high_stakes_verification_required`, "Intended use ReversibleWork · HIGH",
 * "Because new_evidence", "belief The offline guarantee @3 → 4" — and the
 * owner could not decide from it. Every one of those is right, and every one
 * stays on the card, under Details and on the element as `data-`: they are
 * what the ledger recorded. What changed is what a person reads first.
 *
 * **This is UI copy, not policy.** The table carries codes and no sentences
 * (`shared/policy/policy.v3.json` has no label field), so the words are
 * written here, keyed BY the table's own names: nothing is decided, no rule
 * is restated, and a code this build has no words for is shown as itself
 * rather than guessed at. The verbs are held to the table's `ops` by a test,
 * so a new op fails there instead of quietly reading as a code.
 */

/** What each op does to its target, as the start of a sentence. */
export const OP_VERB: Record<string, string> = {
  add_entity_alias: 'Add an alias to',
  append_observation: 'Add an observation to',
  archive_belief: 'Archive',
  cache_source: 'Keep a copy of',
  classify_conflict: 'Classify a conflict in',
  confirm_observation_independence: 'Confirm independent evidence for',
  contest_belief: 'Contest',
  correct_observation_subject: 'Correct what is observed about',
  create_belief: 'Add',
  deprecate: 'Deprecate',
  edit_relation: 'Change',
  mass_supersede: 'Replace',
  merge_beliefs_exact: 'Merge duplicates of',
  merge_entities: 'Merge',
  promote_draft: 'Promote the draft of',
  revert_proposal: 'Undo a change to',
  split_belief: 'Split',
  supersede_belief: 'Replace',
  tombstone_belief: 'Retire',
  update_belief: 'Revise',
};

/** What a target is called when no concept file names it. Keyed by the
 * table's `target_classes`. */
const CLASS_NOUN: Record<string, string> = {
  belief: 'a concept',
  comparison: 'a comparison',
  entity: 'a subject',
  observation: 'an observation',
  proposal: 'an earlier proposal',
  relation: 'a link',
  source: 'a source',
};

/**
 * Why a card waits beyond its risk, keyed by the table slot the code comes
 * from rather than by a second spelling of the code. The sentence is the
 * stopping rule's shape (`policy/coverage.rs::high_stakes`) said once for a
 * reader: HIGH or CRITICAL stakes, with coverage or an authority route the
 * interpreter could not confirm — in the words a reader decides by, not the
 * rule's (M52.5: "nothing has confirmed its coverage and authority yet" was
 * the policy talking). The code itself is on the card's Details.
 *
 * What is missing is read off the card's own refs (M52.5), so the sentence
 * never contradicts the line under it: "nothing has confirmed it yet" sat
 * above "Based on 2 sources and 2 coverage checks" when what the card lacked
 * was a sign-off. A list the wire did not carry counts as missing — the rule
 * held the card, so something it needed was not there.
 */
const HELD_FOR: Record<string, (card: ReviewCard) => string> = {
  [POLICY.high_stakes.queue_rejection]: (card) => {
    const missing = [
      (countOf(card.authority_refs) ?? 0) === 0 ? 'nobody has signed off on it' : null,
      (countOf(card.coverage_refs) ?? 0) === 0 ? 'nothing has checked what it covers' : null,
    ].filter((part) => part !== null);
    const lead = 'Needs a person: it backs a high-stakes decision';
    if (missing.length === 0) return `${lead}.`;
    if (missing.length === 1) return `${lead} and ${missing[0]} yet.`;
    return `${lead}, ${missing[0]}, and ${missing[1]} yet.`;
  },
};

/**
 * A code read aloud: `new_evidence` → "new evidence", `ReversibleWork` →
 * "reversible work". Absent is never zero: a field the wire did not carry
 * reads "not recorded", not as an empty string.
 */
export function humanize(code: string | null | undefined): string {
  if (typeof code !== 'string' || code === '') return 'not recorded';
  return code
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The proposer's reason as the card leads with it (M52.5): a sentence, so
 * capitalised — the ledger keeps it as the agent wrote it, usually the end
 * of one ("the sync error rate has been…"). */
export function reasonSentence(reason: string | null | undefined): string {
  return typeof reason === 'string' ? capitalize(reason.trim()) : '';
}

/** The op as the start of a sentence, and whether it is ours or its code
 * read aloud (an op this build has no verb for). */
export function opVerb(op: string): { verb: string; known: boolean } {
  const verb = OP_VERB[op];
  return verb === undefined
    ? { verb: capitalize(humanize(op)), known: false }
    : { verb, known: true };
}

/** The targets a card names by file (M50.3), deduplicated, in card order. */
export function conceptTargets(card: ReviewCard): CardTarget[] {
  const seen = new Set<string>();
  return card.targets.filter((t) => {
    if (t.path == null || seen.has(t.path)) return false;
    seen.add(t.path);
    return true;
  });
}

/** What a target is called: its concept's title, "this concept" on its own
 * page, or the noun for its class. */
export function targetName(
  target: CardTarget,
  titleOf: (path: string) => string,
  here?: string,
): string {
  if (target.path != null) return target.path === here ? 'this concept' : titleOf(target.path);
  return CLASS_NOUN[target.target_class] ?? humanize(target.target_class);
}

/** The link an `edit_relation` card would add or remove (M52.5), from its
 * relation target — or null, and the card names its targets as any other. */
export function linkOf(card: ReviewCard): CardLink | null {
  return card.targets.find((t) => t.link != null)?.link ?? null;
}

/** What a link card leads with, by the op's own action. */
export function linkVerb(link: CardLink): string {
  return link.action === 'remove' ? 'Remove the link' : 'Add a link';
}

/**
 * A link card's headline as one line of text — "Add a link: this concept
 * refines Warehouse cutover" — for where the card itself is not on screen: the
 * mark a table row wears for it (M52.5). The end the reader is on is "this
 * concept", so the line names the other one.
 */
export function linkLine(link: CardLink, titleOf: (path: string) => string, here?: string): string {
  const name = (path: string | null) =>
    path === null ? 'a concept' : path === here ? 'this concept' : titleOf(path);
  return `${linkVerb(link)}: ${name(link.from_path)} ${relationVerb(link)} ${name(link.to_path)}`;
}

/** A link's kind as the verb between its two ends: "A refines B". */
const RELATION_VERB: Record<string, string> = {
  supersedes: 'replaces',
  refines: 'refines',
  contradicts: 'contradicts',
};

export function relationVerb(link: CardLink): string {
  return RELATION_VERB[link.relation] ?? humanize(link.relation);
}

/** The card's one line when it is not on screen: "A proposal to revise it
 * is waiting on you" — the queue row's marker (M52.2). */
export function waitingLine(cards: readonly ReviewCard[]): string {
  if (cards.length !== 1) return `${cards.length} proposals are waiting on you`;
  const { verb, known } = opVerb(cards[0].op);
  return known
    ? `A proposal to ${verb.charAt(0).toLowerCase()}${verb.slice(1)} it is waiting on you`
    : `A proposal (${verb.toLowerCase()}) is waiting on you`;
}

/** Why the card waits beyond its risk, one sentence per code. */
export function heldForText(code: string, card: ReviewCard): string {
  return HELD_FOR[code]?.(card) ?? `Held for ${code}.`;
}

/**
 * What moved underneath the card, said before anyone clicks Approve. Only
 * what happened (M52.5): the card already offers "Ask for a fresh proposal"
 * in Approve's place, and "approving it will be refused" beside a disabled
 * Approve told the reader about a button they could not press.
 */
export function movedText(target: CardTarget, name: string): string {
  const who = capitalize(name);
  if (target.current_version === null) return `${who} no longer exists.`;
  if (target.expected_version === null) {
    return `${who} was created by something else while this waited.`;
  }
  return `${who} changed after this was proposed.`;
}

/** A measured count, or null when the wire did not carry the list — so a
 * missing list is left out of the sentence rather than read as zero. */
function countOf(refs: readonly string[] | undefined): number | null {
  return Array.isArray(refs) ? refs.length : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What the proposal rests on, in one line a reader decides by (M52.5):
 * "Based on 3 sources and 1 coverage check". The counts are measured — an
 * empty list is "Cites no evidence", said — and a list the wire did not carry
 * is left out rather than read as zero. Why now, and what the change is meant
 * for, are `purposeText`'s, under Details: "for reversible work at high stakes"
 * read as policy on the face of the card.
 */
export function basisText(card: ReviewCard): string | null {
  const cited: string[] = [];
  const evidence = countOf(card.evidence_refs);
  const coverage = countOf(card.coverage_refs);
  const authority = countOf(card.authority_refs);
  if (evidence !== null && evidence > 0) cited.push(plural(evidence, 'source', 'sources'));
  if (coverage !== null && coverage > 0) {
    cited.push(plural(coverage, 'coverage check', 'coverage checks'));
  }
  if (authority !== null && authority > 0) cited.push(plural(authority, 'sign-off', 'sign-offs'));
  if (cited.length > 0) {
    const last = cited[cited.length - 1];
    return `Based on ${cited.length === 1 ? last : `${cited.slice(0, -1).join(', ')} and ${last}`}`;
  }
  const measured = evidence !== null || coverage !== null || authority !== null;
  return measured ? 'Cites no evidence' : null;
}

/** Why now and what for, in words — the card's Details, beside the codes
 * they read aloud: "Proposed because of new evidence, for reversible work at
 * high stakes." */
export function purposeText(card: ReviewCard): string {
  return `Proposed because of ${humanize(card.transition_cause)}, for ${humanize(
    card.intended_use_kind,
  )} at ${humanize(card.intended_use_stakes)} stakes.`;
}

/** The risk chip's words (M52.5): "Medium risk", in sentence case and named
 * — a bare "MEDIUM" beside "a high-stakes decision" read as the card
 * contradicting itself, when one is the change's risk and the other the
 * decision's stakes. The rung itself is the chip's `data-risk`. */
export function riskLabel(risk: string): string {
  return `${capitalize(risk.toLowerCase())} risk`;
}

/** The risk chip's tooltip: the rung's own apply mode, read from the table. */
export function riskTitle(risk: string): string {
  const rung = (POLICY.risk_ladder as Record<string, { apply: string } | undefined>)[risk];
  if (rung === undefined) return `${risk} risk`;
  return rung.apply === 'queued-human-card'
    ? `${capitalize(risk.toLowerCase())} risk — changes at this risk wait for a person`
    : `${capitalize(risk.toLowerCase())} risk`;
}
