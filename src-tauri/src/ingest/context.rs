//! What the prefilter is told about an item, and what nothing can tell it yet
//! (M26.4i).
//!
//! `prefilter::Context` has five fields. One has a producer. The other four
//! are `false`, and each `false` is a claim — so each one is written out at
//! its own line with the milestone that owns it, rather than arriving through
//! a `..Default::default()` that would let a sixth field default silently.
//! The risk this module is shaped against is a quiet `false`, so there is a
//! test per field named for the reason it is false.
//!
//! **M26.4i ingests STRUCTURED change only, and that is a declared limit.**
//! `normalize::snapshot` records title, type, properties, relationships and
//! links, and by documented choice excludes the note BODY. So a prose-only
//! edit produces zero changed fields with the bytes moved, which the
//! prefilter closes as `non_material_change`. `residual_ambiguity` is the
//! field that exists to catch exactly that, and it has no producer anywhere.
//!
//! Setting it true instead would escalate every reformat, every git checkout
//! and every regenerated projection to a paid run — inverting the "a checkout
//! costs nothing" property the prefilter was built to give. Adding the body
//! to the normalizer is the real answer and belongs to a later milestone,
//! because bumping `NORMALIZER_VERSION` forces `Verdict::Changed` for every
//! item in every vault on the next launch, by design.
//!
//! So: editing a note's prose teaches the base nothing in this milestone.
//! Written here, in the milestone, rather than discovered later.

use crate::runtime::catchup::Scanned;
use crate::runtime::scheduler::Row;

use super::prefilter::Context;

/// Build the prefilter's context for one scanned item.
///
/// `artifact_changed` comes from catch-up, which already compared the stored
/// hash against the bytes on disk. Recomputing it here would read every file
/// a second time and duplicate a comparison that module makes.
pub fn context_for(prior: Option<&Row>, _item: &Scanned, artifact_changed: bool) -> Context {
    Context {
        // A file the scheduler has never seen has, trivially, changed.
        artifact_changed: artifact_changed || prior.is_none(),

        // No producer: `EpistemicState.independence` is unreachable in
        // production. The only emitter of `independence.recorded` builds an
        // `IndependenceProof::HumanConfirmed`, which the reducer refuses
        // outright, and `ingest::independence::proof_for` has no caller.
        // Until one exists, claiming corroboration would be claiming a fact
        // nobody recorded — and the schema already refuses evidence-state
        // materiality on an unknown independence.
        corroborates_existing_value: false,

        // No producer: both lineage walks (`independence::shares_ancestry`,
        // `reduce::ancestors`) are private to their modules.
        same_lineage: false,

        // Not a gap — the code already made this call. `route_for` sends
        // every material candidate to `M26Queued` when no deterministic
        // mapper is available, with the comment "a candidate with no
        // deterministic mapper does not vanish because its consumer lands
        // one milestone later". Nothing in this tree maps a snapshot diff to
        // a `ProposalV1`, so the three deterministic-proposal routes are
        // dead in this milestone and every material change costs a run.
        deterministic_proposal_available: false,

        // The declared limit. See the module note: prose-only edits close as
        // non-material, and that is a decision rather than an oversight.
        residual_ambiguity: false,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::runtime::normalize::{Snapshot, NORMALIZER_VERSION};
    use crate::runtime::scheduler::SchedulerState;

    fn snapshot(fields: &[(&str, &str)]) -> Snapshot {
        Snapshot {
            normalizer_version: NORMALIZER_VERSION.to_string(),
            fields: fields
                .iter()
                .map(|(k, v)| ((*k).to_string(), serde_json::json!(v)))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    fn scanned(fields: &[(&str, &str)]) -> Scanned {
        Scanned {
            item_key: "records/a.md".into(),
            artifact_hash: "a".repeat(64),
            snapshot: snapshot(fields),
        }
    }

    fn row(fields: &[(&str, &str)]) -> Row {
        Row {
            item_key: "records/a.md".into(),
            source_id: None,
            content_hash: "b".repeat(64),
            snapshot: snapshot(fields),
            event_cursor: None,
            route: None,
            state: SchedulerState::Pending,
        }
    }

    #[test]
    fn an_item_the_scheduler_has_never_seen_has_changed() {
        let ctx = context_for(None, &scanned(&[("title", "Alpha")]), false);
        assert!(ctx.artifact_changed);
    }

    #[test]
    fn catchups_answer_is_taken_rather_than_recomputed() {
        let prior = row(&[("title", "Alpha")]);
        assert!(
            !context_for(Some(&prior), &scanned(&[("title", "Alpha")]), false).artifact_changed
        );
        assert!(context_for(Some(&prior), &scanned(&[("title", "Beta")]), true).artifact_changed);
    }

    #[test]
    fn corroboration_is_false_because_nothing_records_independence() {
        // A test named for the reason, so the milestone that lands a producer
        // BREAKS this instead of quietly changing what the app spends.
        let ctx = context_for(None, &scanned(&[]), true);
        assert!(!ctx.corroborates_existing_value);
    }

    #[test]
    fn same_lineage_is_false_because_both_walks_are_private() {
        assert!(!context_for(None, &scanned(&[]), true).same_lineage);
    }

    #[test]
    fn no_deterministic_mapper_exists_so_every_material_change_costs_a_run() {
        // Not an oversight: `route_for` anticipates it, and the route matrix
        // would refuse a deterministic-proposal receipt carrying no proposal
        // anyway.
        let ctx = context_for(None, &scanned(&[("title", "Alpha")]), true);
        assert!(!ctx.deterministic_proposal_available);
    }

    #[test]
    fn a_prose_only_edit_closes_as_non_material_and_that_is_declared() {
        // THE DECLARED LIMIT OF M26.4i, as a test rather than a sentence in a
        // doc nobody reads. Bytes moved, no normalized field did — because
        // the normalizer excludes the body on purpose — so the prefilter
        // closes it and no model ever looks.
        //
        // If a later milestone adds body materiality or a `residual_ambiguity`
        // producer, this test fails, and failing is the correct behaviour:
        // the limit stopped being true and the milestone that changed it
        // should say so.
        let unchanged_fields = &[("title", "Alpha")][..];
        let ctx = context_for(
            Some(&row(unchanged_fields)),
            &scanned(unchanged_fields),
            true,
        );
        assert!(!ctx.residual_ambiguity);

        let verdict = super::super::prefilter::assess(
            &snapshot(unchanged_fields),
            &snapshot(unchanged_fields),
            &ctx,
        );
        assert_eq!(
            verdict.verdict,
            crate::ledger::schema::PrefilterVerdict::NonMaterialChange
        );
        assert_eq!(
            super::super::prefilter::route_for(&verdict, &ctx, None),
            crate::ledger::schema::Route::ClosedNonMaterial
        );
    }

    #[test]
    fn a_structured_edit_still_reaches_a_model() {
        // The other side of the declared limit: what M26.4i DOES ingest.
        let before = &[("title", "Alpha")][..];
        let after = &[("title", "Beta")][..];
        let ctx = context_for(Some(&row(before)), &scanned(after), true);
        let verdict = super::super::prefilter::assess(&snapshot(before), &snapshot(after), &ctx);
        assert_eq!(
            verdict.verdict,
            crate::ledger::schema::PrefilterVerdict::MaterialCandidate
        );
        assert_eq!(
            super::super::prefilter::route_for(&verdict, &ctx, None),
            crate::ledger::schema::Route::M26Queued,
            "and it queues, because no deterministic mapper exists"
        );
    }
}
