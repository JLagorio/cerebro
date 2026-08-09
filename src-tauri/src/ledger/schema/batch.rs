//! `batch.committed` (M22.1/M22.2): the logical-batch commit marker.
//!
//! Atomicity is MARKER-BASED: member frames are physical history the moment
//! they are durable, but they have zero entity-state effect until a valid,
//! fsynced marker names the exact contiguous ordered member set.

use super::{is_id128, is_sha256, schema_body, ACTOR_LEDGER};

schema_body! {
    /// `members_digest` covers the canonical member FRAMES in order (torn or
    /// substituted members cannot hide); `operation_digest` covers the
    /// symbolic pre-allocation member plan, so a retried operation whose
    /// physical ids differ still hashes identically.
    pub struct BatchCommitted {
        pub member_event_ids: Vec<String>,
        pub member_count: u64,
        pub members_digest: String,
        pub operation_digest: String,
    }
}

impl BatchCommitted {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if self.actor.id != ACTOR_LEDGER {
            return Err(format!(
                "batch.committed is stamped only by {ACTOR_LEDGER}, got {:?}",
                self.actor.id
            ));
        }
        if self.batch_id.is_none() {
            return Err("batch.committed must carry its batch_id".into());
        }
        if self.member_event_ids.is_empty() {
            return Err("a batch with no members is not a batch".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        for id in &self.member_event_ids {
            if !is_id128(id) {
                return Err(format!("member event id {id:?} is not a 128-bit hex id"));
            }
            if !seen.insert(id.as_str()) {
                return Err(format!("duplicate member event id {id}"));
            }
        }
        if self.member_count != self.member_event_ids.len() as u64 {
            return Err(format!(
                "member_count {} disagrees with {} member ids",
                self.member_count,
                self.member_event_ids.len()
            ));
        }
        if !is_sha256(&self.members_digest) || !is_sha256(&self.operation_digest) {
            return Err("batch digests must be SHA-256 hex".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{common, ID_A, ID_B};
    use super::*;

    fn marker() -> BatchCommitted {
        let (schema, actor) = common(ACTOR_LEDGER);
        BatchCommitted {
            schema,
            batch_id: Some("beefbeefbeefbeefbeefbeefbeefbeef".into()),
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            member_event_ids: vec![ID_A.into(), ID_B.into()],
            member_count: 2,
            members_digest: crate::ledger::sha256_hex(b"members"),
            operation_digest: crate::ledger::sha256_hex(b"plan"),
        }
    }

    #[test]
    fn a_valid_marker_validates() {
        marker().validate().unwrap();
    }

    #[test]
    fn count_batch_id_actor_and_duplicates_are_pinned() {
        let mut wrong_count = marker();
        wrong_count.member_count = 3;
        assert!(wrong_count.validate().unwrap_err().contains("disagrees"));

        let mut no_batch = marker();
        no_batch.batch_id = None;
        assert!(no_batch.validate().is_err());

        let mut dup = marker();
        dup.member_event_ids = vec![ID_A.into(), ID_A.into()];
        assert!(dup.validate().unwrap_err().contains("duplicate"));

        let mut empty = marker();
        empty.member_event_ids.clear();
        empty.member_count = 0;
        assert!(empty.validate().is_err());

        let mut foreign = marker();
        foreign.actor.id = "agent:run-1".into();
        assert!(foreign.validate().is_err());
    }
}
