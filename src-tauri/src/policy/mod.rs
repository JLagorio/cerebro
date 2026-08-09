//! The M24 policy layer: mutation governance as DATA.
//!
//! `shared/policy/policy.v1.json` is the one table; `authority-routes.v1.json`
//! and its content-addressed snapshots are the one authority artifact. Rust
//! compiles them in with `include_str!`; the TS mock imports the identical
//! files through vite. Neither language holds a rule the other has to be
//! trusted to have copied correctly — parity is the shared artifact plus the
//! shared goldens in `shared/policy/goldens/`, and a rule written twice as
//! Rust and TS code is a review-blocking defect.
//!
//! M24 builds the whole skeleton with **agents off**: nothing here is
//! registered as an MCP tool. Synthetic proposals exercise it through the
//! internal typed boundary until M26 turns the surface on.

pub mod authority;
pub mod goldens;
pub mod rejection;
pub mod risk;
pub mod submit;
pub mod table;
pub mod verdict;

/// **The tripwire list** (the `write_target` pattern, mcp.rs:1362).
///
/// Every proposal op the codebase can construct, named once. The table must
/// map exactly these — no more, no fewer. An op that ships unmapped would
/// route around risk, transitions, and rejection destinies entirely while
/// looking deliberate, which is the failure this list exists to make
/// impossible.
///
/// M24.3's `ProposalOp` tagged union is checked against this same list, so
/// adding a variant without adding a table row fails the suite rather than
/// shipping ungoverned.
pub const OP_INVENTORY: &[&str] = &[
    "add_entity_alias",
    "append_observation",
    "archive_belief",
    "cache_source",
    "classify_conflict",
    "confirm_observation_independence",
    "contest_belief",
    "correct_observation_subject",
    "create_belief",
    "deprecate",
    "edit_relation",
    "mass_supersede",
    "merge_beliefs_exact",
    "merge_entities",
    "promote_draft",
    "revert_proposal",
    "split_belief",
    "supersede_belief",
    "tombstone_belief",
    "update_belief",
];

#[cfg(test)]
mod tests {
    use super::table::PolicyTable;
    use super::OP_INVENTORY;
    use std::collections::BTreeSet;

    #[test]
    fn no_constructible_op_escapes_the_table() {
        // THE TRIPWIRE. An op in the code with no table row has no risk, no
        // legal transitions, and no declared rejection destinies — it would
        // be a mutation path outside policy.
        let table = PolicyTable::load().unwrap();
        let mapped: BTreeSet<&str> = table.ops.keys().map(String::as_str).collect();
        let constructible: BTreeSet<&str> = OP_INVENTORY.iter().copied().collect();
        assert_eq!(
            constructible.difference(&mapped).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "op(s) the code can construct are unmapped in policy.v1.json"
        );
        assert_eq!(
            mapped.difference(&constructible).collect::<Vec<_>>(),
            Vec::<&&str>::new(),
            "table row(s) for op(s) nothing can construct — dead policy"
        );
    }

    #[test]
    fn the_op_union_names_exactly_the_inventory() {
        // The other half of the tripwire (M24.3). `OP_INVENTORY` is the
        // list, `ProposalOp` is what the code can actually construct, and
        // the table is what governs. All three must be the same set: a
        // variant added without a row would be an ungoverned mutation path,
        // and a row with no variant is dead policy.
        use crate::ledger::schema::ProposalOp;
        let constructible: BTreeSet<&str> = ProposalOp::ALL_KINDS.iter().copied().collect();
        let inventory: BTreeSet<&str> = OP_INVENTORY.iter().copied().collect();
        assert_eq!(constructible, inventory);
    }

    #[test]
    fn the_target_classes_agree_between_the_schema_and_the_table() {
        // `TargetClass` is a serde enum (the wire needs a type) and the
        // table carries the same seven as data. One assertion binds them,
        // the same way the op tripwire binds the op union.
        use crate::ledger::schema::TargetClass;
        let table = PolicyTable::load().unwrap();
        let declared: Vec<&str> = TargetClass::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(declared, table.target_classes);
    }

    #[test]
    fn every_silence_cause_is_a_transition_cause_the_schema_can_spell() {
        // A cause in the table that no proposal could ever carry would be a
        // rule that never fires while looking like protection.
        use crate::ledger::schema::TransitionCause;
        let table = PolicyTable::load().unwrap();
        let spellable: BTreeSet<&str> = [
            TransitionCause::NewEvidence,
            TransitionCause::HumanCorrection,
            TransitionCause::QualificationMet,
            TransitionCause::ConflictResolution,
            TransitionCause::Maintenance,
            TransitionCause::Revert,
            TransitionCause::ElapsedTime,
            TransitionCause::AbsenceOfObservations,
        ]
        .iter()
        .map(|c| c.as_str())
        .collect();
        for cause in &table.silence.causes {
            assert!(
                spellable.contains(cause.as_str()),
                "silence cause {cause} is not a TransitionCause"
            );
        }
    }

    #[test]
    fn the_inventory_is_sorted_and_unique() {
        let mut sorted = OP_INVENTORY.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.as_slice(), OP_INVENTORY);
    }

    #[test]
    fn the_op_inventory_covers_the_d5_ladder() {
        // Each rung of the D5 ladder must actually exist in the table, so a
        // future edit cannot quietly empty one — CRITICAL in particular.
        use super::table::Risk;
        let table = PolicyTable::load().unwrap();
        for risk in [Risk::Low, Risk::Medium, Risk::High, Risk::Critical] {
            assert!(
                table.ops.values().any(|op| op.base_risk == risk),
                "no op sits at {}",
                risk.as_str()
            );
        }
    }
}
