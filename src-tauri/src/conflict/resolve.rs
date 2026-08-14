//! The deterministic D12 gauntlet (M27.3c) — why most candidates are not
//! contradictions.
//!
//! **Resolution comes BEFORE contradiction.** M26 hands over pairs worth
//! classifying; this runs them through the design's gates in order — subject,
//! revision qualifier, environment and geography, valid time, state stage,
//! and finally value — and the overwhelmingly common answer is that the pair
//! separates on one of them. "Rev A uses NVIDIA" against "Rev C uses AMD" is
//! temporal succession. Intended-against-shipping is stage lag. Without this
//! step the preservation gate screams at normal evolution, the owner learns
//! to ignore it, and the entire surface dies.
//!
//! **It reads no clock, no prose, and no model** — the same tripwire the
//! detector carries, enforced by the same kind of test. Every gate is a typed
//! comparison over recorded qualifiers, which is exactly why the matrix lets
//! this layer claim temporal, scope, and stage results and forbids a model
//! from claiming them: something confident about arithmetic could resolve a
//! real conflict away.
//!
//! **What it will not answer.** When every gate leaves the pair overlapping
//! there are two possibilities — the claims really are incompatible, or they
//! mean the same thing in different words — and telling those apart is
//! semantics. The one exception is values whose incompatibility is structural
//! rather than interpretive: two booleans, or two numbers, under one
//! predicate, one scope, one stage, and one valid time cannot both hold. That
//! is the design's typed-value incompatibility rule, and it is the only road
//! to a deterministic `genuine_direct`. Everything else waits for the
//! M24-mapped `classify_conflict` review, which is where `same_meaning` and
//! any granularity judgement have to come from.
//!
//! **The unresolved half is one batch.** A classification and the edge it
//! requires commit together, so a crash can expose neither an unresolved
//! verdict without its protected edge nor an edge nobody can explain. A
//! resolved verdict batches no edge at all.

use crate::ledger::reduce::{ComparisonRow, EpistemicState};
use crate::ledger::schema::{
    derive_edge_id, Actor, Classification, ConflictClassified, ConflictOutcome, ConflictReasonCode,
    ContradictionOpened, EdgeKind, TypedValue, BODY_SCHEMA, KIND_CONFLICT_CLASSIFIED,
    KIND_CONTRADICTION_OPENED,
};

use super::detect::{qualifiers_overlap, stages_overlap, valid_times_overlap};

/// Which gauntlet build produced a verdict, so it can be read against the
/// rules that produced it.
pub const GAUNTLET_VERSION: &str = "conflict-gauntlet-v1";

/// Who the gauntlet signs as. A system actor: everything it concludes is a
/// typed comparison, and none of it is a judgement.
pub const ACTOR: &str = "system:conflict-classifier";

/// What the gauntlet concluded about one comparison.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// A typed comparison settled it. The reason names the gate that did.
    Settled {
        outcome: ConflictOutcome,
        reason: ConflictReasonCode,
    },
    /// Every gate left the pair overlapping and the values are not
    /// structurally incompatible. This is a question about MEANING, and the
    /// gauntlet does not answer those — `same_meaning`, `conditional`, and
    /// any granularity judgement arrive through review or not at all.
    NeedsSemantics { why: &'static str },
}

/// Run the gates, in the design's order.
///
/// Revision and environment/geography are separate steps in the design and
/// one call here, because they produce the same outcome from the same reason
/// code: a pair whose recorded qualifiers do not meet is not a disagreement,
/// and `scope_disjoint` is the one word this vocabulary has for it.
pub fn classify(state: &EpistemicState, comparison: &ComparisonRow) -> Verdict {
    let (Some(left), Some(right)) = (comparison.left.asserted(), comparison.right.asserted())
    else {
        // A declared-relation comparison has no assertions to compare, which
        // is the whole reason it exists as a second endpoint kind. M27.3d's
        // backfill classifies those from what the relation DID record, and
        // says out loud what was missing.
        return Verdict::NeedsSemantics {
            why: "a declared-relation comparison carries no assertions to compare",
        };
    };

    // 1. Subject and predicate. Two claims about different things, or about
    //    different properties of one thing, are not in disagreement. Subject
    //    is the outermost scope and `scope_disjoint` is its reason code —
    //    this vocabulary has no separate word for "not even about the same
    //    thing", and inventing one would put a code in the ledger that the
    //    shared matrix does not know.
    if left.subject_id != right.subject_id || left.predicate != right.predicate {
        return settled(
            ConflictOutcome::ResolvedByScope,
            ConflictReasonCode::ScopeDisjoint,
        );
    }
    // 2/3. Revision qualifier, then environment and geography. An unset
    //      qualifier applies everywhere and therefore overlaps anything; two
    //      set ones meet only when they match.
    if !qualifiers_overlap(&left.scope, &right.scope) {
        return settled(
            ConflictOutcome::ResolvedByScope,
            ConflictReasonCode::ScopeDisjoint,
        );
    }
    // 4. Valid time. Claims about intervals that do not touch are
    //    succession, and succession is how a base stays honest over time.
    if !valid_times_overlap(&left.valid_time, &right.valid_time) {
        return settled(
            ConflictOutcome::ResolvedTemporally,
            ConflictReasonCode::TemporalDisjoint,
        );
    }
    // 5. State stage. The canonical case: intended against shipping is lag,
    //    not conflict, and calling it one is what teaches an owner to stop
    //    reading the word.
    if !stages_overlap(&left.scope, &right.scope) {
        return settled(
            ConflictOutcome::ResolvedByStage,
            ConflictReasonCode::StageDisjoint,
        );
    }
    // 6. Value — structural incompatibility only, never interpretation.
    match structurally_incompatible(
        &pinned_value(state, &left.assertion_event_id),
        &pinned_value(state, &right.assertion_event_id),
    ) {
        Incompatibility::Structural => settled(
            ConflictOutcome::GenuineDirect,
            ConflictReasonCode::IncompatibleValues,
        ),
        Incompatibility::NeedsMeaning(why) => Verdict::NeedsSemantics { why },
    }
}

fn settled(outcome: ConflictOutcome, reason: ConflictReasonCode) -> Verdict {
    Verdict::Settled { outcome, reason }
}

/// One endpoint's typed value, read by the assertion the endpoint pins.
///
/// `Missing` when the index has no entry — which reads as "nothing structural
/// to compare" and sends the pair to review rather than inventing an answer.
fn pinned_value(state: &EpistemicState, assertion_event_id: &str) -> TypedValue {
    state
        .assertion_facets
        .get(assertion_event_id)
        .map(|facet| facet.value.clone())
        .unwrap_or(TypedValue::Missing)
}

enum Incompatibility {
    Structural,
    NeedsMeaning(&'static str),
}

/// The design's typed-value incompatibility rule, and nothing wider.
///
/// Booleans and numbers are the two shapes whose inequality needs no
/// interpretation: under one predicate, one scope, one stage, and one valid
/// time, `true` against `false` — or 4 against 7 — cannot both hold.
///
/// A string pair is the entire semantic question, and the bytes cannot tell
/// the cases apart: "AMD" against "AMD Corporation" is `same_meaning`, "AMD"
/// against "NVIDIA" is `genuine_direct`, and NOTHING structural separates
/// them. A deterministic rule that guessed would be doing a model's job
/// without a model, and without any of the review that goes with one.
fn structurally_incompatible(left: &TypedValue, right: &TypedValue) -> Incompatibility {
    match (left, right) {
        (TypedValue::Boolean { value: a }, TypedValue::Boolean { value: b }) if a != b => {
            Incompatibility::Structural
        }
        (TypedValue::Number { value: a }, TypedValue::Number { value: b }) if a != b => {
            Incompatibility::Structural
        }
        (TypedValue::Boolean { .. }, TypedValue::Boolean { .. })
        | (TypedValue::Number { .. }, TypedValue::Number { .. }) => Incompatibility::NeedsMeaning(
            "the two values are identical, so whatever this pair disagrees about is not the value",
        ),
        _ => Incompatibility::NeedsMeaning(
            "the values are not two booleans or two numbers, so telling incompatibility from a \
             difference in wording is a question about meaning",
        ),
    }
}

/// One comparison's whole plan: the classification, and the edge if the
/// verdict leaves one. Built together because they commit together.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub comparison_id: String,
    pub outcome: ConflictOutcome,
    /// The members, in fold order, ready for `append_batch`. One event for a
    /// resolved verdict; two for an unresolved one.
    pub members: Vec<(String, serde_json::Value)>,
    /// `conflict-classify:<store>:<comparison>` — one comparison is one
    /// classification, so a retry replays instead of deciding twice.
    pub operation_key: String,
}

/// Every committed comparison the gauntlet can settle and nobody has
/// classified yet.
///
/// Deterministic in what it returns and in what order: `comparisons` is a
/// `BTreeMap`, so plans come out in comparison-id order regardless of when
/// the events arrived.
///
/// `classified_at` is passed IN — it is supplied display content, never
/// ordering (D3), and the gauntlet is a pure function of state and that
/// stamp. Reading a clock here is the supervisor's job.
pub fn plan(state: &EpistemicState, store_uuid: &str, classified_at: &str) -> Vec<Plan> {
    let mut out = Vec::new();
    for comparison in state.comparisons.values() {
        if state
            .conflict_classifications
            .contains_key(&comparison.comparison_id)
        {
            continue;
        }
        let Verdict::Settled { outcome, reason } = classify(state, comparison) else {
            continue;
        };
        match build(comparison, outcome, reason, store_uuid, classified_at) {
            Ok(plan) => out.push(plan),
            // A body that will not build is a bug in this module, not a
            // reason to stop classifying the rest of the base.
            Err(detail) => eprintln!(
                "conflict gauntlet: comparison {} could not be planned — {detail}",
                comparison.comparison_id
            ),
        }
    }
    out
}

fn build(
    comparison: &ComparisonRow,
    outcome: ConflictOutcome,
    reason: ConflictReasonCode,
    store_uuid: &str,
    classified_at: &str,
) -> Result<Plan, String> {
    let actor = Actor {
        id: ACTOR.to_string(),
    };
    let classified = ConflictClassified {
        schema: BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: actor.clone(),
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        comparison_id: comparison.comparison_id.clone(),
        left: comparison.left.clone(),
        right: comparison.right.clone(),
        outcome,
        classification: Classification::Deterministic {
            rule_version: GAUNTLET_VERSION.to_string(),
        },
        evidence_event_ids: vec![],
        reason_codes: vec![reason],
        classified_at: classified_at.to_string(),
    };
    classified.validate()?;
    let mut members = vec![(
        KIND_CONFLICT_CLASSIFIED.to_string(),
        serde_json::to_value(&classified).map_err(|e| e.to_string())?,
    )];

    if let Some(kind) = EdgeKind::of(outcome) {
        let opened = ContradictionOpened {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            edge_id: derive_edge_id(&comparison.comparison_id, kind),
            comparison_id: comparison.comparison_id.clone(),
            left: comparison.left.clone(),
            right: comparison.right.clone(),
            kind,
            // The classification is member 0 of this batch and its id does
            // not exist yet; the writer substitutes the allocated one.
            classified_event_id: crate::ledger::writer::member_ref(0),
        };
        // Deliberately NOT validated here: `member_ref(0)` is a symbolic
        // reference rather than an event id, so the body only becomes
        // well-formed after substitution. The reducer validates what lands.
        members.push((
            KIND_CONTRADICTION_OPENED.to_string(),
            serde_json::to_value(&opened).map_err(|e| e.to_string())?,
        ));
    }

    Ok(Plan {
        comparison_id: comparison.comparison_id.clone(),
        outcome,
        members,
        operation_key: format!(
            "conflict-classify:{store_uuid}:{}",
            comparison.comparison_id
        ),
    })
}

/// What one gauntlet pass did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Emitted {
    /// Comparisons resolved apart — the ordinary outcome, and the one worth
    /// reporting even though it is quiet.
    pub resolved: usize,
    /// Comparisons that became contradiction edges.
    pub opened: usize,
    /// Comparisons the gauntlet declined to settle, which wait for review.
    pub needs_semantics: usize,
    /// Failures, with the reason. Reported rather than swallowed: a gauntlet
    /// that silently drops a verdict looks exactly like a base with nothing
    /// left to classify.
    pub failed: Vec<(String, String)>,
}

/// Commit every plan. One batch each, keyed so a retry replays rather than
/// classifying twice.
pub fn emit<C: crate::ingest::pass::Commit>(
    state: &EpistemicState,
    store_uuid: &str,
    classified_at: &str,
    committer: &C,
) -> Emitted {
    let mut out = Emitted::default();
    for comparison in state.comparisons.values() {
        if state
            .conflict_classifications
            .contains_key(&comparison.comparison_id)
        {
            continue;
        }
        if matches!(classify(state, comparison), Verdict::NeedsSemantics { .. }) {
            out.needs_semantics += 1;
        }
    }
    for plan in plan(state, store_uuid, classified_at) {
        match committer.append_batch(plan.members.clone(), &plan.operation_key) {
            Ok(()) => {
                if plan.outcome.is_unresolved() {
                    out.opened += 1;
                } else {
                    out.resolved += 1;
                }
            }
            Err(detail) => out.failed.push((plan.comparison_id, detail)),
        }
    }
    out
}

/// The same tripwire the detector carries. A gauntlet that could read the
/// time could resolve a pair because one side got old, and "old" is not a
/// resolution; one that could read prose would be answering the semantic
/// question it exists to refuse.
#[cfg(test)]
mod discipline {
    #[test]
    fn nothing_in_the_gauntlet_reads_a_clock_or_a_claim() {
        let source = include_str!("resolve.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in [
            "Utc::now",
            "SystemTime",
            "Local::now",
            "extracted_text",
            "rendered_text",
            ".content",
        ] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the gauntlet — it compares recorded qualifiers, not \
                 claims, and never asks what time it is"
            );
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::assembly::fixture::{
        belief, linked, observation, revision, OBS_AUTHORITY, OBS_PLANNED,
    };
    use crate::conflict::detect::fixture::{base, facet, interval, scope};
    use crate::conflict::detect::{self, DETECTOR_VERSION};
    use crate::ledger::reduce::{AssertionFacet, ComparisonOrigin, ComparisonRow};
    use crate::ledger::schema::{
        derive_comparison_id, derive_value_hash, AuthorityProvenance, ConflictEndpoint, Scope,
        Stage,
    };

    const STORE: &str = "feedfacefeedfacefeedfacefeedface";
    const AS_OF: &str = "2026-08-12T09:00:00.000Z";

    /// Run the detector and commit everything it finds, which is the state
    /// the gauntlet actually reads.
    fn detect_into(state: &mut EpistemicState) {
        for (index, candidate) in detect::find(state).into_iter().enumerate() {
            let comparison_id = derive_comparison_id(&candidate.left, &candidate.right).unwrap();
            state.comparisons.insert(
                comparison_id.clone(),
                ComparisonRow {
                    comparison_id,
                    event_id: format!("910000000000000000000000000000{index:02}"),
                    left: ConflictEndpoint::Asserted {
                        endpoint: candidate.left,
                    },
                    right: ConflictEndpoint::Asserted {
                        endpoint: candidate.right,
                    },
                    origin: ComparisonOrigin::Detected {
                        detector_version: DETECTOR_VERSION.into(),
                        reason_codes: candidate.reason_codes,
                    },
                },
            );
        }
    }

    fn only_verdict(state: &EpistemicState) -> Verdict {
        let mut verdicts: Vec<Verdict> = state
            .comparisons
            .values()
            .map(|c| classify(state, c))
            .collect();
        assert_eq!(verdicts.len(), 1, "expected exactly one comparison");
        verdicts.pop().unwrap()
    }

    /// A facet whose typed value and digest agree — the detector compares the
    /// digest and the gauntlet compares the value, so a fixture that let them
    /// drift would be testing two different claims.
    fn typed(predicate: &str, value: TypedValue, scope: Scope) -> AssertionFacet {
        let mut f = facet(predicate, "placeholder", scope);
        f.value_hash = derive_value_hash(&value).unwrap();
        f.value = value;
        f
    }

    fn string_facet(predicate: &str, value: &str, scope: Scope) -> AssertionFacet {
        typed(predicate, TypedValue::string(value), scope)
    }

    #[test]
    fn two_strings_that_overlap_everywhere_are_a_question_about_meaning() {
        // The load-bearing refusal. "on track" against "slipped" LOOKS like a
        // contradiction to a person, and in the bytes it is indistinguishable
        // from "on track" against "on schedule". A deterministic rule that
        // called this `genuine_direct` would be doing a model's job with none
        // of the review.
        let mut state = base();
        detect_into(&mut state);
        assert!(matches!(
            only_verdict(&state),
            Verdict::NeedsSemantics { .. }
        ));
        assert!(
            plan(&state, STORE, AS_OF).is_empty(),
            "a pair the gauntlet cannot settle must not be classified anyway"
        );
    }

    #[test]
    fn two_booleans_that_differ_are_a_contradiction_without_interpretation() {
        let mut state = base();
        for (event, value) in [(OBS_AUTHORITY, true), (OBS_PLANNED, false)] {
            state.assertion_facets.insert(
                event.into(),
                typed(
                    "cutover_done",
                    TypedValue::Boolean { value },
                    scope(None, None),
                ),
            );
        }
        detect_into(&mut state);
        assert_eq!(
            only_verdict(&state),
            Verdict::Settled {
                outcome: ConflictOutcome::GenuineDirect,
                reason: ConflictReasonCode::IncompatibleValues,
            }
        );

        // Both events, one batch, in fold order — the crash-safety rule.
        let plans = plan(&state, STORE, AS_OF);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].members.len(), 2);
        assert_eq!(plans[0].members[0].0, KIND_CONFLICT_CLASSIFIED);
        assert_eq!(plans[0].members[1].0, KIND_CONTRADICTION_OPENED);
        assert!(plans[0].operation_key.starts_with("conflict-classify:"));
    }

    #[test]
    fn stage_lag_resolves_and_batches_no_edge() {
        let mut state = base();
        state.assertion_facets.insert(
            OBS_AUTHORITY.into(),
            string_facet(
                "cutover_status",
                "on track",
                scope(Some(Stage::Planned), None),
            ),
        );
        state.assertion_facets.insert(
            OBS_PLANNED.into(),
            string_facet(
                "cutover_status",
                "slipped",
                scope(Some(Stage::Shipping), None),
            ),
        );
        detect_into(&mut state);

        assert_eq!(
            only_verdict(&state),
            Verdict::Settled {
                outcome: ConflictOutcome::ResolvedByStage,
                reason: ConflictReasonCode::StageDisjoint,
            }
        );
        let plans = plan(&state, STORE, AS_OF);
        assert_eq!(plans.len(), 1);
        assert_eq!(
            plans[0].members.len(),
            1,
            "a resolved verdict opens nothing"
        );
    }

    #[test]
    fn disjoint_valid_times_are_succession_not_disagreement() {
        let mut state = base();
        let mut early = string_facet("cutover_status", "on track", scope(None, None));
        early.valid_time = interval(
            Some("2026-01-01T00:00:00.000Z"),
            Some("2026-03-01T00:00:00.000Z"),
        );
        let mut late = string_facet("cutover_status", "slipped", scope(None, None));
        late.valid_time = interval(Some("2026-06-01T00:00:00.000Z"), None);
        state.assertion_facets.insert(OBS_AUTHORITY.into(), early);
        state.assertion_facets.insert(OBS_PLANNED.into(), late);
        detect_into(&mut state);

        assert_eq!(
            only_verdict(&state),
            Verdict::Settled {
                outcome: ConflictOutcome::ResolvedTemporally,
                reason: ConflictReasonCode::TemporalDisjoint,
            }
        );
    }

    #[test]
    fn different_revisions_of_one_thing_are_not_two_opinions_about_it() {
        let mut state = base();
        for (event, value, revision) in [
            (OBS_AUTHORITY, "on track", "Rev A"),
            (OBS_PLANNED, "slipped", "Rev C"),
        ] {
            state.assertion_facets.insert(
                event.into(),
                string_facet(
                    "cutover_status",
                    value,
                    Scope {
                        stage: None,
                        revision: Some(revision.into()),
                        environment: None,
                        geography: None,
                    },
                ),
            );
        }
        detect_into(&mut state);
        assert_eq!(
            only_verdict(&state),
            Verdict::Settled {
                outcome: ConflictOutcome::ResolvedByScope,
                reason: ConflictReasonCode::ScopeDisjoint,
            }
        );
    }

    #[test]
    fn a_comparison_already_classified_is_not_planned_again() {
        let mut state = base();
        for (event, value) in [(OBS_AUTHORITY, true), (OBS_PLANNED, false)] {
            state.assertion_facets.insert(
                event.into(),
                typed(
                    "cutover_done",
                    TypedValue::Boolean { value },
                    scope(None, None),
                ),
            );
        }
        detect_into(&mut state);
        assert_eq!(plan(&state, STORE, AS_OF).len(), 1);

        let comparison_id = state.comparisons.keys().next().unwrap().clone();
        state.conflict_classifications.insert(
            comparison_id.clone(),
            crate::ledger::reduce::ClassificationRow {
                comparison_id,
                event_id: "90000000000000000000000000000009".into(),
                outcome: ConflictOutcome::GenuineDirect,
                classification: Classification::Deterministic {
                    rule_version: GAUNTLET_VERSION.into(),
                },
                reason_codes: vec![ConflictReasonCode::IncompatibleValues],
                evidence_event_ids: vec![],
            },
        );
        assert!(
            plan(&state, STORE, AS_OF).is_empty(),
            "a settled comparison is not re-litigated on the next pass"
        );
    }

    // --- the canonical fixture ---------------------------------------------

    const GPU: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
    const B_LEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2";
    const B_MAIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3";
    const B_BOM: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4";
    const OBS_LEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa8";
    const OBS_MAIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9";
    const OBS_BOM: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab1";
    const SOURCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab2";

    fn gpu_facet(value: &str, stage: Stage, revision: &str) -> AssertionFacet {
        string_facet(
            "gpu_supplier",
            value,
            Scope {
                stage: Some(stage),
                revision: Some(revision.to_string()),
                environment: None,
                geography: None,
            },
        )
    }

    /// The lead says Rev C is AMD; main has the AMD config committed; the
    /// manufacturing BOM says NVIDIA. Three live beliefs about one entity and
    /// one predicate, disagreeing on the face of it.
    pub(crate) fn lead_main_bom() -> EpistemicState {
        let mut state = EpistemicState::default();
        for (belief_id, revision_event, content, observation_event) in [
            (
                B_LEAD,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5",
                "AMD per the lead",
                OBS_LEAD,
            ),
            (
                B_MAIN,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6",
                "AMD committed",
                OBS_MAIN,
            ),
            (
                B_BOM,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7",
                "NVIDIA on the BOM",
                OBS_BOM,
            ),
        ] {
            state.beliefs.insert(
                belief_id.into(),
                belief(
                    belief_id,
                    GPU,
                    vec![revision(
                        1,
                        revision_event,
                        content,
                        linked(&[observation_event]),
                    )],
                ),
            );
            state.observations.insert(
                observation_event.into(),
                observation(
                    observation_event,
                    GPU,
                    SOURCE,
                    AuthorityProvenance::RegisteredDirectArtifact,
                ),
            );
        }
        // Intended, implemented, and shipping — and the BOM is about the
        // PREVIOUS revision, which really does carry NVIDIA.
        state
            .assertion_facets
            .insert(OBS_LEAD.into(), gpu_facet("amd", Stage::Planned, "Rev C"));
        state.assertion_facets.insert(
            OBS_MAIN.into(),
            gpu_facet("amd", Stage::Implemented, "Rev C"),
        );
        state.assertion_facets.insert(
            OBS_BOM.into(),
            gpu_facet("nvidia", Stage::Shipping, "Rev B"),
        );
        state
    }

    #[test]
    fn the_lead_main_and_bom_coexist_without_a_single_edge() {
        // The milestone's acceptance case. Everything here looks like a
        // contradiction and none of it is one.
        let mut state = lead_main_bom();
        detect_into(&mut state);
        // TWO pairs, not three: the lead and main AGREE, and agreement is
        // never a candidate — it is the exact-merge finder's question. What
        // is left is the BOM against each of them.
        assert_eq!(
            state.comparisons.len(),
            2,
            "the detector raised {} pair(s)",
            state.comparisons.len()
        );

        for comparison in state.comparisons.values() {
            match classify(&state, comparison) {
                Verdict::Settled { outcome, .. } => assert!(
                    !outcome.is_unresolved(),
                    "comparison {} opened a {} edge",
                    comparison.comparison_id,
                    outcome.as_str()
                ),
                Verdict::NeedsSemantics { why } => {
                    panic!("the canonical fixture separates structurally, and this did not: {why}")
                }
            }
        }
        for plan in plan(&state, STORE, AS_OF) {
            assert_eq!(
                plan.members.len(),
                1,
                "comparison {} planned an edge",
                plan.comparison_id
            );
        }
        // Three beliefs, still standing, with nothing to alarm anyone.
        assert_eq!(state.beliefs.len(), 3);
    }
}
