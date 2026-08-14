//! `entity.merged` (M24.3) — the CRITICAL identity merge.
//!
//! Merging two Entities is the hardest error in the system to notice later:
//! afterwards there is one identity where there were two, and every Belief,
//! alias, and Relation that pointed at the loser now points at the survivor.
//! So the event carries a COMPLETE enumerated plan and performs every one of
//! those reassignments as ONE event effect. There is no hidden alias or
//! relation side event; the reducer refuses an omitted, extra, or repeated
//! target rather than reindexing whatever it happens to find.
//!
//! The plan is digest-sealed. `plan_digest` covers the canonical plan with
//! the digest field itself omitted, so a plan cannot be edited between
//! policy acceptance and append without the seal breaking.

use serde::{Deserialize, Serialize};

use super::{canonical_json, is_id128, is_sha256, schema_body, sha256_first128};

/// One live alias the merge reassigns, pinned to the M22 event that
/// registered it and carrying that event's canonical normalized key.
/// Display spelling is never hashed as identity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveAlias {
    pub normalized_alias: String,
    pub alias_event_id: String,
    pub from_entity_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntityReassignmentPlan {
    pub survivor_id: String,
    pub merged_ids: Vec<String>,
    pub affected_belief_ids: Vec<String>,
    pub live_aliases: Vec<LiveAlias>,
    pub affected_relation_ids: Vec<String>,
    pub plan_digest: String,
}

fn sorted_unique_ids(label: &str, ids: &[String]) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for id in ids {
        if !is_id128(id) {
            return Err(format!(
                "{label} entry {id:?} is not a stable 128-bit hex id"
            ));
        }
        if !seen.insert(id.as_str()) {
            return Err(format!("{label} repeats {id}"));
        }
    }
    let sorted: Vec<&str> = seen.into_iter().collect();
    let given: Vec<&str> = ids.iter().map(String::as_str).collect();
    if sorted != given {
        return Err(format!("{label} is not sorted"));
    }
    Ok(())
}

impl EntityReassignmentPlan {
    /// The seal over everything except the seal itself.
    pub fn digest_of(&self) -> Result<String, String> {
        let sealed = EntityReassignmentPlan {
            plan_digest: String::new(),
            ..self.clone()
        };
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"cerebro-entity-merge-plan-v1\0");
        bytes.extend_from_slice(canonical_json(&sealed)?.as_bytes());
        Ok(crate::ledger::sha256_hex(&bytes))
    }

    pub fn validate(&self) -> Result<(), String> {
        if !is_id128(&self.survivor_id) {
            return Err("survivor_id is not a stable 128-bit hex id".into());
        }
        if self.merged_ids.is_empty() {
            return Err("a merge with nothing to merge is not a merge".into());
        }
        sorted_unique_ids("merged_ids", &self.merged_ids)?;
        if self.merged_ids.contains(&self.survivor_id) {
            return Err(
                "survivor_id appears in merged_ids — an entity cannot absorb itself".into(),
            );
        }
        sorted_unique_ids("affected_belief_ids", &self.affected_belief_ids)?;
        sorted_unique_ids("affected_relation_ids", &self.affected_relation_ids)?;

        let mut seen_alias = std::collections::BTreeSet::new();
        for alias in &self.live_aliases {
            if alias.normalized_alias.is_empty() {
                return Err("a live alias with an empty normalized key".into());
            }
            if !is_id128(&alias.alias_event_id) {
                return Err("live alias alias_event_id is not an event id".into());
            }
            if !is_id128(&alias.from_entity_id) {
                return Err("live alias from_entity_id is not an entity id".into());
            }
            // An alias can only be reassigned from an entity this merge is
            // actually absorbing (or from the survivor, where it stays put).
            if alias.from_entity_id != self.survivor_id
                && !self.merged_ids.contains(&alias.from_entity_id)
            {
                return Err(format!(
                    "live alias {:?} comes from {} — an entity this merge does not touch",
                    alias.normalized_alias, alias.from_entity_id
                ));
            }
            if !seen_alias.insert(alias.normalized_alias.as_str()) {
                return Err(format!(
                    "two live aliases share the normalized key {:?} — the merge would have to \
                     choose one, and choosing is not a reindex",
                    alias.normalized_alias
                ));
            }
        }
        let sorted: Vec<&str> = seen_alias.into_iter().collect();
        let given: Vec<&str> = self
            .live_aliases
            .iter()
            .map(|a| a.normalized_alias.as_str())
            .collect();
        if sorted != given {
            return Err("live_aliases is not sorted by normalized alias".into());
        }

        if !is_sha256(&self.plan_digest) {
            return Err("plan_digest is not a sha256".into());
        }
        if self.digest_of()? != self.plan_digest {
            return Err(
                "plan_digest does not seal this plan — it was edited after it was minted".into(),
            );
        }
        Ok(())
    }
}

schema_body! {
    /// One event, every reassignment. `reassignment_digest` repeats the
    /// plan's seal at the event level so a frame is self-checking without
    /// re-deriving the plan.
    pub struct EntityMerged {
        pub survivor_id: String,
        pub merged_ids: Vec<String>,
        pub reassignment_plan: EntityReassignmentPlan,
        pub reassignment_digest: String,
    }
}

impl EntityMerged {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        self.reassignment_plan.validate()?;
        // The body's own summary must not be able to disagree with the plan
        // it carries; a reader that trusted the wrong one would reassign a
        // different set than the one policy approved.
        if self.survivor_id != self.reassignment_plan.survivor_id {
            return Err("entity.merged survivor_id disagrees with its plan".into());
        }
        if self.merged_ids != self.reassignment_plan.merged_ids {
            return Err("entity.merged merged_ids disagree with its plan".into());
        }
        if self.reassignment_digest != self.reassignment_plan.plan_digest {
            return Err("reassignment_digest disagrees with the plan's own seal".into());
        }
        Ok(())
    }

    /// Every target this event writes, as `(class, id)` — the exact set the
    /// reducer increments and the exact set top-level CAS must name.
    pub fn write_targets(&self) -> Vec<(&'static str, &str)> {
        let plan = &self.reassignment_plan;
        std::iter::once(("entity", plan.survivor_id.as_str()))
            .chain(plan.merged_ids.iter().map(|id| ("entity", id.as_str())))
            .chain(
                plan.affected_belief_ids
                    .iter()
                    .map(|id| ("belief", id.as_str())),
            )
            .chain(
                plan.affected_relation_ids
                    .iter()
                    .map(|id| ("relation", id.as_str())),
            )
            .collect()
    }
}

/// Domain-separated id for a merge plan, when one needs naming outside the
/// event. Same first-128-bits shape as every other derived id here.
pub fn derive_plan_id(plan_digest: &str) -> String {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"cerebro-entity-merge-plan-id-v1\0");
    bytes.extend_from_slice(plan_digest.as_bytes());
    sha256_first128(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::Actor;

    const SURVIVOR: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const MERGED: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
    const BELIEF: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
    const RELATION: &str = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
    const ALIAS_EVENT: &str = "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5";

    fn plan() -> EntityReassignmentPlan {
        let mut plan = EntityReassignmentPlan {
            survivor_id: SURVIVOR.into(),
            merged_ids: vec![MERGED.into()],
            affected_belief_ids: vec![BELIEF.into()],
            live_aliases: vec![LiveAlias {
                normalized_alias: "atlas".into(),
                alias_event_id: ALIAS_EVENT.into(),
                from_entity_id: MERGED.into(),
            }],
            affected_relation_ids: vec![RELATION.into()],
            plan_digest: String::new(),
        };
        plan.plan_digest = plan.digest_of().unwrap();
        plan
    }

    fn merged(plan: EntityReassignmentPlan) -> EntityMerged {
        EntityMerged {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor { id: "test".into() },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            survivor_id: plan.survivor_id.clone(),
            merged_ids: plan.merged_ids.clone(),
            reassignment_digest: plan.plan_digest.clone(),
            reassignment_plan: plan,
        }
    }

    #[test]
    fn a_sealed_plan_validates_and_an_edited_one_does_not() {
        let plan = plan();
        assert!(plan.validate().is_ok());
        let mut tampered = plan.clone();
        tampered.affected_belief_ids.clear();
        assert!(tampered
            .validate()
            .unwrap_err()
            .contains("edited after it was minted"));
    }

    #[test]
    fn an_entity_cannot_absorb_itself() {
        let mut plan = plan();
        plan.merged_ids = vec![SURVIVOR.into()];
        plan.plan_digest = plan.digest_of().unwrap();
        assert!(plan.validate().unwrap_err().contains("absorb itself"));
    }

    #[test]
    fn an_alias_from_an_untouched_entity_is_refused() {
        // Otherwise a merge could quietly reassign identity the proposal
        // never named, which is the one thing a CRITICAL op must not do.
        let mut plan = plan();
        plan.live_aliases[0].from_entity_id = BELIEF.into();
        plan.plan_digest = plan.digest_of().unwrap();
        assert!(plan
            .validate()
            .unwrap_err()
            .contains("an entity this merge does not touch"));
    }

    #[test]
    fn two_aliases_with_one_normalized_key_are_refused() {
        let mut plan = plan();
        plan.live_aliases.push(LiveAlias {
            normalized_alias: "atlas".into(),
            alias_event_id: ALIAS_EVENT.into(),
            from_entity_id: SURVIVOR.into(),
        });
        plan.plan_digest = plan.digest_of().unwrap();
        assert!(plan
            .validate()
            .unwrap_err()
            .contains("choosing is not a reindex"));
    }

    #[test]
    fn the_body_summary_cannot_disagree_with_the_plan() {
        let mut event = merged(plan());
        event.survivor_id = MERGED.into();
        assert!(event
            .validate()
            .unwrap_err()
            .contains("disagrees with its plan"));

        let mut event = merged(plan());
        event.reassignment_digest = "0".repeat(64);
        assert!(event
            .validate()
            .unwrap_err()
            .contains("disagrees with the plan's own seal"));
    }

    #[test]
    fn the_write_target_set_is_exactly_the_enumerated_plan() {
        // Aliases are read-only provenance: reindexing them is part of the
        // one event effect, not a repeated survivor increment.
        let event = merged(plan());
        assert_eq!(
            event.write_targets(),
            vec![
                ("entity", SURVIVOR),
                ("entity", MERGED),
                ("belief", BELIEF),
                ("relation", RELATION),
            ]
        );
    }

    #[test]
    fn a_valid_merge_validates() {
        assert!(merged(plan()).validate().is_ok());
    }
}
