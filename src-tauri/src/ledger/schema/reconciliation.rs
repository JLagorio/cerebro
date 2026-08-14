//! `ledger.divergence` and `ledger.reconciliation_resolved` (M23.1) — the
//! circuit breaker's vocabulary.
//!
//! A divergence names a detected condition under a stable detection key
//! (also its append idempotency key, so one unresolved condition emits one
//! event across launches). A resolution closes the mode ONLY when it
//! references an active divergence and its digests prove the declared
//! result — a prose-only event can never bless unexplained bytes.

use serde::{Deserialize, Serialize};

use super::projection::validate_projection_path;
use super::{is_id128, is_sha256, schema_body};

/// The actor that detects divergence and records resolutions — the core,
/// never a caller.
pub const ACTOR_RECONCILIATION: &str = "system:reconciliation";

/// The CLOSED divergence signal list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DivergenceSignal {
    GitAnchorRegression,
    RememberedHeadRegression,
    ManifestReducerDisagreement,
    MassProjectionMismatch,
    MigrationSourceChanged,
    MigrationIdempotencyConflict,
}

impl DivergenceSignal {
    pub fn as_str(&self) -> &'static str {
        match self {
            DivergenceSignal::GitAnchorRegression => "git_anchor_regression",
            DivergenceSignal::RememberedHeadRegression => "remembered_head_regression",
            DivergenceSignal::ManifestReducerDisagreement => "manifest_reducer_disagreement",
            DivergenceSignal::MassProjectionMismatch => "mass_projection_mismatch",
            DivergenceSignal::MigrationSourceChanged => "migration_source_changed",
            DivergenceSignal::MigrationIdempotencyConflict => "migration_idempotency_conflict",
        }
    }
}

/// Bounded sample list length — the complete path set stays derived from
/// the manifest/reducer/file scan, never from this event.
pub const MAX_SAMPLE_PATHS: usize = 32;

/// A chain head hash: a frame hash (64 hex) or, for an empty ledger, the
/// store id anchor (32 hex).
fn is_head_hash(s: &str) -> bool {
    is_sha256(s) || is_id128(s)
}

schema_body! {
    /// The divergence circuit breaker's record: what was detected, under
    /// which stable key, with every corroborating head/digest available at
    /// detection time.
    pub struct LedgerDivergence {
        pub detection_key: String,
        pub signals: Vec<DivergenceSignal>,
        pub ledger_head: String,
        pub git_anchored_head: Option<String>,
        pub remembered_head: Option<String>,
        pub manifest_digest: String,
        pub reducer_projection_digest: String,
        pub mismatch_count: u64,
        pub projection_count: u64,
        pub sample_paths: Vec<String>,
    }
}

impl LedgerDivergence {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if self.actor.id != ACTOR_RECONCILIATION {
            return Err(format!(
                "ledger.divergence is recorded only by {ACTOR_RECONCILIATION}, got {:?}",
                self.actor.id
            ));
        }
        if !is_sha256(&self.detection_key) {
            return Err("detection_key must be a SHA-256 condition hash".into());
        }
        if self.signals.is_empty() {
            return Err("a divergence names at least one closed signal".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut prev: Option<DivergenceSignal> = None;
        for signal in &self.signals {
            if !seen.insert(*signal) {
                return Err(format!("duplicate signal {}", signal.as_str()));
            }
            if prev.is_some_and(|p| p > *signal) {
                return Err("signals must be in canonical (declaration) order".into());
            }
            prev = Some(*signal);
        }
        if !is_head_hash(&self.ledger_head) {
            return Err("ledger_head is not a chain head hash".into());
        }
        for (name, head) in [
            ("git_anchored_head", &self.git_anchored_head),
            ("remembered_head", &self.remembered_head),
        ] {
            if let Some(head) = head {
                if !is_head_hash(head) {
                    return Err(format!("{name} is not a chain head hash"));
                }
            }
        }
        if !is_sha256(&self.manifest_digest) || !is_sha256(&self.reducer_projection_digest) {
            return Err("manifest/reducer digests must be SHA-256 hex".into());
        }
        if self.mismatch_count > self.projection_count {
            return Err("mismatch_count cannot exceed projection_count".into());
        }
        if self.sample_paths.len() > MAX_SAMPLE_PATHS {
            return Err(format!("sample_paths is bounded at {MAX_SAMPLE_PATHS}"));
        }
        let mut prev: Option<&str> = None;
        for path in &self.sample_paths {
            validate_projection_path(path)?;
            if prev.is_some_and(|p| p >= path.as_str()) {
                return Err("sample_paths must be sorted and duplicate-free".into());
            }
            prev = Some(path);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationAction {
    AcceptCurrentFiles,
    RestoreLedgerAuthority,
}

impl ReconciliationAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReconciliationAction::AcceptCurrentFiles => "accept_current_files",
            ReconciliationAction::RestoreLedgerAuthority => "restore_ledger_authority",
        }
    }
}

schema_body! {
    /// The explicit reconciliation exit. The action-specific contract is
    /// CLOSED: accept commits inside the same logical batch as every
    /// adoption event and pins matching accepted/resulting digests; restore
    /// is unbatched with an empty capture list and a null accepted digest.
    pub struct ReconciliationResolved {
        pub divergence_event_id: String,
        pub action: ReconciliationAction,
        pub affected_paths: Vec<String>,
        pub capture_batch_ids: Vec<String>,
        pub accepted_files_digest: Option<String>,
        pub resulting_projection_digest: String,
    }
}

impl ReconciliationResolved {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if self.actor.id != ACTOR_RECONCILIATION {
            return Err(format!(
                "ledger.reconciliation_resolved is recorded only by {ACTOR_RECONCILIATION}, \
                 got {:?}",
                self.actor.id
            ));
        }
        if !is_id128(&self.divergence_event_id) {
            return Err("divergence_event_id is not an event id".into());
        }
        if self.affected_paths.is_empty() {
            return Err("a resolution names the paths it affected".into());
        }
        let mut prev: Option<&str> = None;
        for path in &self.affected_paths {
            validate_projection_path(path)?;
            if prev.is_some_and(|p| p >= path.as_str()) {
                return Err("affected_paths must be sorted and duplicate-free".into());
            }
            prev = Some(path);
        }
        if !is_sha256(&self.resulting_projection_digest) {
            return Err("resulting_projection_digest must be SHA-256 hex".into());
        }
        match self.action {
            ReconciliationAction::AcceptCurrentFiles => {
                let batch_id = self
                    .batch_id
                    .as_deref()
                    .ok_or("accept_current_files commits inside its adoption batch")?;
                if self.capture_batch_ids != [batch_id.to_string()] {
                    return Err(
                        "accept_current_files capture_batch_ids is exactly its own singleton \
                         batch id"
                            .into(),
                    );
                }
                let accepted = self
                    .accepted_files_digest
                    .as_deref()
                    .ok_or("accept_current_files requires the accepted-files digest")?;
                if !is_sha256(accepted) {
                    return Err("accepted_files_digest must be SHA-256 hex".into());
                }
                if accepted != self.resulting_projection_digest {
                    return Err(
                        "accepted and resulting digests must match — adopted bytes must equal \
                         the staged reducer projections"
                            .into(),
                    );
                }
            }
            ReconciliationAction::RestoreLedgerAuthority => {
                if self.batch_id.is_some() {
                    return Err("restore_ledger_authority is appended unbatched".into());
                }
                if !self.capture_batch_ids.is_empty() {
                    return Err("restore_ledger_authority captures nothing".into());
                }
                if self.accepted_files_digest.is_some() {
                    return Err("restore_ledger_authority accepted_files_digest is null".into());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::tests::{common, ID_A};
    use super::*;

    pub(crate) fn divergence_body() -> LedgerDivergence {
        let (schema, actor) = common(ACTOR_RECONCILIATION);
        LedgerDivergence {
            schema,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            detection_key: crate::ledger::sha256_hex(b"condition"),
            signals: vec![DivergenceSignal::ManifestReducerDisagreement],
            ledger_head: crate::ledger::sha256_hex(b"head"),
            git_anchored_head: None,
            remembered_head: Some(crate::ledger::sha256_hex(b"remembered")),
            manifest_digest: crate::ledger::sha256_hex(b"manifest"),
            reducer_projection_digest: crate::ledger::sha256_hex(b"reducer"),
            mismatch_count: 1,
            projection_count: 10,
            sample_paths: vec!["concepts/acme.md".into()],
        }
    }

    pub(crate) fn resolution_body(action: ReconciliationAction) -> ReconciliationResolved {
        let (schema, actor) = common(ACTOR_RECONCILIATION);
        let digest = crate::ledger::sha256_hex(b"resulting");
        let batched = matches!(action, ReconciliationAction::AcceptCurrentFiles);
        ReconciliationResolved {
            schema,
            batch_id: batched.then(|| "beefbeefbeefbeefbeefbeefbeefbeef".to_string()),
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            divergence_event_id: ID_A.into(),
            action,
            affected_paths: vec!["concepts/acme.md".into()],
            capture_batch_ids: if batched {
                vec!["beefbeefbeefbeefbeefbeefbeefbeef".to_string()]
            } else {
                vec![]
            },
            accepted_files_digest: batched.then(|| digest.clone()),
            resulting_projection_digest: digest,
        }
    }

    #[test]
    fn divergence_pins_actor_key_signals_and_sorted_samples() {
        let event = divergence_body();
        event.validate().unwrap();

        let mut forged = event.clone();
        forged.actor.id = "human:josef".into();
        assert!(forged.validate().is_err());

        let mut unsorted = event.clone();
        unsorted.signals = vec![
            DivergenceSignal::MassProjectionMismatch,
            DivergenceSignal::GitAnchorRegression,
        ];
        assert!(unsorted.validate().is_err());

        let mut dup = event.clone();
        dup.sample_paths = vec!["b.md".into(), "a.md".into()];
        assert!(dup.validate().is_err());

        let mut overcount = event;
        overcount.mismatch_count = 11;
        assert!(overcount.validate().is_err());
    }

    #[test]
    fn the_action_specific_resolution_contract_is_closed() {
        resolution_body(ReconciliationAction::AcceptCurrentFiles)
            .validate()
            .unwrap();
        resolution_body(ReconciliationAction::RestoreLedgerAuthority)
            .validate()
            .unwrap();

        // accept: digests must match; the batch relationship is exact.
        let mut mismatched = resolution_body(ReconciliationAction::AcceptCurrentFiles);
        mismatched.accepted_files_digest = Some(crate::ledger::sha256_hex(b"other"));
        assert!(mismatched.validate().unwrap_err().contains("match"));
        let mut unbatched = resolution_body(ReconciliationAction::AcceptCurrentFiles);
        unbatched.batch_id = None;
        assert!(unbatched.validate().is_err());
        let mut foreign = resolution_body(ReconciliationAction::AcceptCurrentFiles);
        foreign.capture_batch_ids = vec!["feedfacefeedfacefeedfacefeedface".into()];
        assert!(foreign.validate().is_err());

        // restore: unbatched, empty captures, null accepted digest.
        let mut batched = resolution_body(ReconciliationAction::RestoreLedgerAuthority);
        batched.batch_id = Some("beefbeefbeefbeefbeefbeefbeefbeef".into());
        assert!(batched.validate().is_err());
        let mut with_digest = resolution_body(ReconciliationAction::RestoreLedgerAuthority);
        with_digest.accepted_files_digest = Some(crate::ledger::sha256_hex(b"x"));
        assert!(with_digest.validate().is_err());
        let mut with_capture = resolution_body(ReconciliationAction::RestoreLedgerAuthority);
        with_capture.capture_batch_ids = vec!["beefbeefbeefbeefbeefbeefbeefbeef".into()];
        assert!(with_capture.validate().is_err());

        let mut empty = resolution_body(ReconciliationAction::RestoreLedgerAuthority);
        empty.affected_paths = vec![];
        assert!(empty.validate().is_err());
    }
}
