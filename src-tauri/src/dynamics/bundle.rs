//! `bundle` — the three axes assembled per facet, ready to render (M27.5a).
//!
//! Every other module in [`crate::dynamics`] answers ONE question. This one
//! asks all of them about the same facet and hands back a row a surface can
//! draw without deriving anything itself.
//!
//! **The composed sentence is built here, in Rust, once.** "single-source,
//! partial coverage, stale and contested" is not decoration — it is the
//! reading of three orthogonal answers, and a UI that assembled it from three
//! serialized values would be a second implementation of the sentence, one
//! translation away from disagreeing with this one. The three `describe()`
//! halves already live beside their axes; this joins them and nothing more.
//!
//! **Review is beside the axes, never inside Support** (D8's two channels).
//! An attestation says a human looked; Support says what rests underneath.
//! A migrated concept somebody verified in 2025 is `Support: unsupported`
//! AND `review: current`, both true, neither softening the other — and
//! folding the review into Support would erase exactly the distinction the
//! migration was careful to preserve.
//!
//! **Nothing here reads the clock**, for the reason the module doc gives:
//! `as_of` is an argument, so the same ledger answers the same way whenever
//! it is asked.

use crate::ledger::reduce::{BeliefState, EpistemicState};
use crate::ledger::schema::BeliefFacetKey;
use crate::policy::authority::{self, AuthorityRoutesV1};

use super::{coverage, facet, freshness, review, support, validity};

/// The artifacts the three axes are decided by, loaded once.
///
/// Loaded per CALL rather than per facet: `coverage::load` and
/// `freshness::load` parse and digest-check shipped JSON, and a vault with
/// four hundred beliefs would otherwise pay for that four hundred times to
/// reach the same answer.
pub struct Tables {
    pub freshness: freshness::Rules,
    pub coverage: coverage::Fold,
    /// Every resolvable authority-route artifact version, because a facet's
    /// authority is matched against the version its assertion pinned.
    pub authority: Vec<AuthorityRoutesV1>,
}

impl Tables {
    pub fn load() -> Result<Tables, String> {
        Ok(Tables {
            freshness: freshness::load()?,
            coverage: coverage::load()?,
            authority: authority::resolvable()?,
        })
    }
}

/// Why freshness says what it says.
///
/// Carried because "stale" with no anchor is an accusation a reader cannot
/// check. `predicate_class` is `None` when no rule matched the predicate at
/// all, which is a different sentence from a matched rule with no anchor —
/// the two ways to reach `Freshness::Unknown`, kept apart here as they are in
/// [`freshness::Assessment`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FreshnessBasis {
    pub predicate_class: Option<String>,
    pub anchor_event_id: Option<String>,
    pub anchor_at: Option<String>,
    /// When this facet goes (or went) stale. `None` for a durable rule, an
    /// unmatched predicate, or an unknown anchor.
    pub stale_after: Option<String>,
}

/// One facet's three answers, the review channel beside them, and the line.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FacetChips {
    pub key: BeliefFacetKey,
    pub support: support::Support,
    /// WHICH families and proofs produced the Support level — a chip that
    /// says "corroborated by 2 independent" must be able to show its two.
    pub families: Vec<support::Family>,
    pub independence_edges: Vec<support::IndependenceEdge>,
    pub coverage: coverage::Coverage,
    pub validity: validity::Validity,
    pub freshness_basis: FreshnessBasis,
    /// D8 channel 1. Rendered separately, always.
    pub review: review::ReviewStatus,
    /// Each axis, already read aloud. A chip renders one of these verbatim.
    ///
    /// Carried per-axis as well as joined because a surface draws three chips
    /// and one sentence, and the alternative is a UI that maps
    /// `(kind, summary)` to "coverage unassessed" on its own — the same fold
    /// rule, spelled a second time in another language. [`Self::line`] is
    /// exactly these three joined, so there is still ONE wording.
    pub support_text: String,
    pub coverage_text: String,
    pub validity_text: String,
    /// The three axes, read aloud in axis order.
    pub line: String,
}

/// Every facet of one belief's current revision.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BeliefChips {
    pub belief_id: String,
    /// The knowledge-relative projection path, when this belief is one. The
    /// join a file-driven surface needs: the concept on screen is a file, and
    /// this is what says which belief that file is.
    pub path: Option<String>,
    pub belief_revision_event_id: String,
    /// One row per facet — a multi-facet belief renders separate scoped rows,
    /// never a merged one.
    pub facets: Vec<FacetChips>,
}

/// Assemble one facet's row.
pub fn chips_for_facet(
    state: &EpistemicState,
    tables: &Tables,
    belief: &BeliefState,
    facet: &facet::Facet,
    as_of: chrono::DateTime<chrono::Utc>,
) -> FacetChips {
    let derived = support::support_of(state, &tables.authority, facet);
    // The facet's predicate class, resolved HERE because this is the one place
    // holding both artifacts. Coverage needs the class name to tell a
    // class-scoped assessment about this facet from one about something else
    // (M27.10); it has no business knowing what a freshness rule is.
    let class = tables
        .freshness
        .rule_for(facet.key.predicate.value())
        .map(|rule| rule.predicate_class.as_str());
    let coverage = coverage::coverage_of(state, &tables.coverage, facet, class);
    let assessment = freshness::assess(state, &tables.freshness, facet, as_of);
    let validity = validity::validity_of(state, belief, assessment.freshness);
    let support_text = derived.support.describe();
    let coverage_text = coverage.describe().to_string();
    let validity_text = validity.describe();
    let line = format!("{support_text}, {coverage_text}, {validity_text}");
    FacetChips {
        key: facet.key.clone(),
        support: derived.support,
        families: derived.families,
        independence_edges: derived.independence_edges,
        coverage,
        validity,
        freshness_basis: FreshnessBasis {
            predicate_class: assessment.predicate_class,
            anchor_event_id: assessment.anchor.as_ref().map(|a| a.event_id.clone()),
            anchor_at: assessment.anchor.as_ref().map(|a| a.at.to_rfc3339()),
            stale_after: assessment.effective_at.map(|at| at.to_rfc3339()),
        },
        review: review::status_for(belief, facet.key.belief_revision_event_id.as_str()),
        support_text,
        coverage_text,
        validity_text,
        line,
    }
}

/// Every facet of one belief, in facet-key order.
///
/// Total: a belief resting on nothing gets its one `unknown/unknown` row
/// saying so, because [`facet::facets_of`] is total and this adds no filter
/// of its own.
pub fn chips_for(
    state: &EpistemicState,
    tables: &Tables,
    belief: &BeliefState,
    as_of: chrono::DateTime<chrono::Utc>,
) -> BeliefChips {
    BeliefChips {
        belief_id: belief.belief_id.clone(),
        path: belief.path.clone(),
        belief_revision_event_id: belief.current().event_id.clone(),
        facets: facet::facets_of(state, belief)
            .iter()
            .map(|f| chips_for_facet(state, tables, belief, f, as_of))
            .collect(),
    }
}

/// Every live belief's chips, belief-id order.
///
/// Tombstoned beliefs are absent, matching [`facet::all_facets`]: tombstoning
/// is terminal, and a row of axes about a belief that has been withdrawn
/// would be an answer to a question nobody can still ask. Asking
/// [`chips_for`] directly about one still works — the filter is this
/// function's, not a rule about the belief.
pub fn all_chips(
    state: &EpistemicState,
    tables: &Tables,
    as_of: chrono::DateTime<chrono::Utc>,
) -> Vec<BeliefChips> {
    state
        .beliefs
        .values()
        .filter(|belief| belief.tombstoned_by.is_none())
        .map(|belief| chips_for(state, tables, belief, as_of))
        .collect()
}

/// Read one vault's chips through the active writer (M27.5b).
///
/// Rebuilt from the ledger on every call, like the review surface: the axes
/// are a fold of what is on disk, and a cache of them is a second answer that
/// can be wrong while the first one is right.
///
/// A vault with no writer is an ERROR rather than an empty list. "This vault
/// has no ledger" and "this vault's beliefs rest on nothing" are opposite
/// sentences, and a caller that got `[]` for the first would render the
/// second.
pub fn for_vault(
    vault: &std::path::Path,
    as_of: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<BeliefChips>, String> {
    let tables = Tables::load()?;
    crate::ledger::shadow::with_writer(vault, |writer| {
        let read = crate::ledger::read_ledger(&crate::ledger::ledger_dir(vault))
            .map_err(|e| e.to_string())?;
        let state = crate::ledger::reduce::reduce(&read.frames, writer.store_id());
        Ok(all_chips(&state, &tables, as_of))
    })
    .unwrap_or_else(|| Err("no active ledger writer for this vault".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{relate, B_ONE, B_TWO, OBS_AUTHORITY, OBS_INFERRED, REV_ONE};
    use crate::dynamics::facet::tests::{assertion_facet, base};
    use crate::ledger::reduce::AssertionFacet;
    use crate::ledger::schema::{RelationKind, Stage, StateStage};

    fn at(stamp: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    /// An assertion carrying the time its own rule measures from — the
    /// `ci_status` rule anchors on `occurred_at`, the shipping-BOM rule on
    /// `valid_from`, and an assertion with neither is honestly unknown.
    fn anchored(predicate: &str, stage: Stage, observed: &str) -> AssertionFacet {
        let mut assertion = assertion_facet(predicate, Some(stage), observed);
        assertion.observed_at = Some(observed.into());
        assertion.valid_time.from = Some(observed.into());
        assertion
    }

    fn tables() -> Tables {
        Tables::load().expect("the shipped artifacts")
    }

    fn one(state: &EpistemicState, belief_id: &str) -> BeliefChips {
        let belief = state.beliefs.get(belief_id).unwrap();
        chips_for(state, &tables(), belief, at("2026-08-12T00:00:00Z"))
    }

    #[test]
    fn a_belief_resting_on_nothing_says_so_in_three_ways() {
        // The empty case out loud: one row, keyed on nothing, and every axis
        // answering rather than going quiet.
        let chips = one(&base(), B_TWO);
        assert_eq!(chips.facets.len(), 1);
        let facet = &chips.facets[0];
        assert_eq!(facet.key.predicate.value(), None);
        assert_eq!(facet.key.state_stage, StateStage::Unknown);
        assert_eq!(facet.support.level(), "unsupported");
        assert_eq!(
            facet.line, "unsupported, coverage unassessed, freshness unknown",
            "no rule matched an unknown predicate, and nothing has been assessed"
        );
        assert_eq!(facet.freshness_basis.predicate_class, None);
        assert_eq!(facet.freshness_basis.anchor_event_id, None);
    }

    #[test]
    fn two_predicates_are_two_rows_and_the_rows_can_disagree() {
        // The reason the unit is a facet: one belief, two claims, and the
        // shipping one has gone stale while the implemented one has not. A
        // single line about "the belief" would have to pick one and be wrong
        // about the other.
        let mut state = base();
        state.assertion_facets.insert(
            OBS_AUTHORITY.into(),
            anchored("ci_status", Stage::Implemented, "2026-08-11T22:00:00Z"),
        );
        state.assertion_facets.insert(
            OBS_INFERRED.into(),
            anchored("bill_of_materials", Stage::Shipping, "2020-01-01T00:00:00Z"),
        );
        let chips = one(&state, B_ONE);
        assert_eq!(chips.facets.len(), 2, "two predicates, two rows");
        let bom = &chips.facets[0];
        let ci = &chips.facets[1];
        assert_eq!(bom.key.predicate.value(), Some("bill_of_materials"));
        assert_eq!(ci.key.predicate.value(), Some("ci_status"));
        assert!(
            bom.line.ends_with("stale"),
            "a 2020 anchor is stale in 2026: {}",
            bom.line
        );
        assert!(
            ci.line.ends_with("fresh"),
            "yesterday's CI status is not: {}",
            ci.line
        );
    }

    #[test]
    fn the_line_reads_in_axis_order_and_never_mentions_the_review() {
        // The spec's own sentence shape, and the D8 rule that keeps the two
        // channels apart: a human attestation must not appear in a line that
        // is about what rests underneath.
        let mut state = base();
        state.assertion_facets.insert(
            OBS_AUTHORITY.into(),
            anchored("ci_status", Stage::Implemented, "2020-01-01T00:00:00Z"),
        );
        relate(
            &mut state,
            &"r".repeat(32),
            B_ONE,
            B_TWO,
            RelationKind::Contradicts,
            true,
        );
        let belief = state.beliefs.get_mut(B_ONE).unwrap();
        belief.attested = Some(("a".repeat(32), REV_ONE.to_string()));

        let chips = one(&state, B_ONE);
        let facet = chips
            .facets
            .iter()
            .find(|f| f.key.predicate.value() == Some("ci_status"))
            .expect("the ci_status facet");
        assert_eq!(
            facet.line, "single-source, coverage unassessed, stale and contested",
            "support, then coverage, then validity"
        );
        assert_eq!(facet.review.as_str(), "current");
        assert!(
            !facet.line.contains("review") && !facet.line.contains("verified"),
            "the review channel renders beside the line, never inside it: {}",
            facet.line
        );
        assert_eq!(
            facet.support.level(),
            "single_source",
            "and an attestation does not lift Support"
        );
    }

    #[test]
    fn a_migrated_verified_concept_reads_unsupported_with_its_review_beside_it() {
        // The migration case the spec calls out by name (§ error handling).
        // A concept a human verified in 2025 and a migration lifted into the
        // ledger has NO recorded evidence — the verification was of the text,
        // not of a source. Both facts render, and neither softens the other:
        // an `unsupported` that quietly became `single-source` because
        // somebody once ticked a box is the failure this separation exists
        // to prevent.
        let mut state = base();
        let migrated = state.beliefs.get_mut(B_TWO).unwrap();
        migrated.attested = Some(("a".repeat(32), crate::assembly::fixture::REV_TWO.into()));

        let chips = one(&state, B_TWO);
        let facet = &chips.facets[0];
        assert_eq!(facet.support.level(), "unsupported");
        assert!(facet.line.starts_with("unsupported"), "{}", facet.line);
        assert_eq!(facet.review.as_str(), "current");
        assert_eq!(
            facet.support.independent_family_count(),
            0,
            "an attestation is not a family"
        );
    }

    #[test]
    fn the_wire_shape_is_pinned_because_typescript_declares_it_a_second_time() {
        // `src/lib/mockIpc.ts` re-declares these shapes as interfaces, and a
        // field added here that nobody adds there is invisible until a
        // surface silently renders `undefined`. That exact class of drift got
        // through once already in M27.3b.
        //
        // This pins the KEYS only. It cannot prove the TypeScript is right —
        // nothing in this suite reads that file — so it fails loudly enough
        // to send whoever changed the struct to the other declaration.
        let chips = one(&base(), B_TWO);
        let json = serde_json::to_value(&chips).unwrap();
        let keys = |value: &serde_json::Value| -> Vec<String> {
            value
                .as_object()
                .expect("an object")
                .keys()
                .cloned()
                .collect()
        };
        assert_eq!(
            keys(&json),
            ["belief_id", "path", "belief_revision_event_id", "facets"],
            "BeliefChips changed shape — update the interface in src/lib/mockIpc.ts"
        );
        assert_eq!(
            keys(&json["facets"][0]),
            [
                "key",
                "support",
                "families",
                "independence_edges",
                "coverage",
                "validity",
                "freshness_basis",
                "review",
                "support_text",
                "coverage_text",
                "validity_text",
                "line"
            ],
            "FacetChips changed shape — update the interface in src/lib/mockIpc.ts"
        );
        assert_eq!(
            json["support"]["level"],
            serde_json::Value::Null,
            "Support is tagged INSIDE its own object, not flattened onto the facet"
        );
        assert_eq!(json["facets"][0]["support"]["level"], "unsupported");
        assert_eq!(json["facets"][0]["coverage"]["kind"], "no_assessments");
        assert_eq!(json["facets"][0]["review"]["status"], "unreviewed");
    }

    #[test]
    fn a_tombstoned_belief_is_absent_from_the_sweep_and_answerable_on_request() {
        let mut state = base();
        state.beliefs.get_mut(B_TWO).unwrap().tombstoned_by = Some("t".repeat(32));
        let swept = all_chips(&state, &tables(), at("2026-08-12T00:00:00Z"));
        assert_eq!(
            swept
                .iter()
                .map(|c| c.belief_id.as_str())
                .collect::<Vec<_>>(),
            vec![B_ONE],
            "the sweep skips it"
        );
        assert_eq!(
            one(&state, B_TWO).facets.len(),
            1,
            "asking directly still answers"
        );
    }

    #[test]
    fn the_projection_path_is_carried_so_a_file_surface_can_find_its_belief() {
        // The join the knowledge UI needs. Without it a concept on screen has
        // no way to say which belief these axes are about.
        let mut state = base();
        state.beliefs.get_mut(B_ONE).unwrap().path = Some("concepts/falcon.md".into());
        let chips = one(&state, B_ONE);
        assert_eq!(chips.path.as_deref(), Some("concepts/falcon.md"));
        assert_eq!(
            one(&state, B_TWO).path,
            None,
            "and a belief with no file says so"
        );
    }
}
