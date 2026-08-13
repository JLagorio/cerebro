//! Appending detected candidates, exactly once each (M26.7b).
//!
//! **Two guards, and neither one is redundant.** A candidate whose comparison
//! is already in reducer state is skipped before a body is even built — that
//! is the cheap one, and it is what stops a base with a long-standing
//! disagreement re-proposing it on every pass. `append_once` under
//! `conflict-candidate:<store>:<id>` is the durable one: it survives a
//! reducer state that has not caught up, and it turns the same key over
//! different bytes into a hard conflict rather than a silent second opinion.
//!
//! **The append seam is a trait for the same reason ingest's is.** The
//! ledger writer is held behind a process-global mutex that the MCP server
//! also takes; anything that holds it across a subprocess deadlocks. Nothing
//! here runs a subprocess — this pass is entirely deterministic — but the
//! seam keeps the tests off the filesystem and the production path down to
//! one call.

use std::path::{Path, PathBuf};

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    derive_comparison_id, derive_conflict_candidate_key, Actor, ConflictCandidateDetected,
    BODY_SCHEMA, KIND_CONFLICT_CANDIDATE_DETECTED,
};

use super::detect::{Candidate, DETECTOR_VERSION};

/// Who the detector signs as. A system actor: nothing here is a judgement,
/// so nothing here should look like an agent's.
pub const ACTOR: &str = "system:conflict-detector";

/// What one append did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wrote {
    Appended,
    AlreadyThere,
}

/// The seam. One method, because a candidate is one solo event.
pub trait Append {
    fn append_once(&self, key: &str, kind: &str, body: serde_json::Value) -> Result<Wrote, String>;
}

/// What one detection pass did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Emitted {
    /// Newly appended comparisons.
    pub appended: usize,
    /// Candidates the base had already recorded — the ordinary case for a
    /// disagreement nobody has classified yet.
    pub already_known: usize,
    /// Candidates that could not be appended, with the reason. A failure is
    /// reported rather than swallowed: a detector that silently drops a
    /// comparison looks exactly like a base with nothing to disagree about.
    pub failed: Vec<(String, String)>,
}

/// Build one candidate's body.
fn body(candidate: &Candidate) -> Result<(String, serde_json::Value), String> {
    let comparison_id = derive_comparison_id(&candidate.left, &candidate.right)?;
    let event = ConflictCandidateDetected {
        schema: BODY_SCHEMA,
        batch_id: None,
        // Stamped by `append_once` from the key below. Set here it would be
        // part of the canonical bytes twice over.
        idempotency_key: None,
        actor: Actor {
            id: ACTOR.to_string(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        comparison_id: comparison_id.clone(),
        left: candidate.left.clone(),
        right: candidate.right.clone(),
        detector_version: DETECTOR_VERSION.to_string(),
        reason_codes: candidate.reason_codes.clone(),
    };
    event.validate()?;
    let value = serde_json::to_value(&event).map_err(|e| e.to_string())?;
    Ok((comparison_id, value))
}

/// Append every candidate the base has not already recorded.
pub fn emit<A: Append>(
    state: &EpistemicState,
    store_uuid: &str,
    candidates: &[Candidate],
    appender: &A,
) -> Emitted {
    let mut out = Emitted::default();
    for candidate in candidates {
        let (comparison_id, value) = match body(candidate) {
            Ok(built) => built,
            Err(detail) => {
                // No comparison id exists yet — that is what failed. Name
                // the pair by its assertions instead, so the report points
                // at something a person can look up.
                out.failed.push((
                    format!(
                        "{}+{}",
                        candidate.left.assertion_event_id, candidate.right.assertion_event_id
                    ),
                    detail,
                ));
                continue;
            }
        };
        if state.comparisons.contains_key(&comparison_id) {
            out.already_known += 1;
            continue;
        }
        let key = derive_conflict_candidate_key(store_uuid, &comparison_id);
        match appender.append_once(&key, KIND_CONFLICT_CANDIDATE_DETECTED, value) {
            Ok(Wrote::Appended) => out.appended += 1,
            Ok(Wrote::AlreadyThere) => out.already_known += 1,
            Err(detail) => out.failed.push((comparison_id, detail)),
        }
    }
    out
}

/// The production seam: append through whatever writer is armed for a vault.
pub struct ShadowAppend {
    pub vault: PathBuf,
}

impl ShadowAppend {
    pub fn new(vault: &Path) -> ShadowAppend {
        ShadowAppend {
            vault: vault.to_path_buf(),
        }
    }
}

impl Append for ShadowAppend {
    fn append_once(&self, key: &str, kind: &str, body: serde_json::Value) -> Result<Wrote, String> {
        crate::ledger::shadow::with_writer(&self.vault, |writer| {
            writer.append_once(key, kind, body).map(|result| {
                if result.was_existing() {
                    Wrote::AlreadyThere
                } else {
                    Wrote::Appended
                }
            })
        })
        // `None` means no writer is armed for this vault — a real answer, not
        // a missing one: nothing is recorded, and the next pass finds the
        // same candidates because the detector is deterministic.
        .ok_or_else(|| {
            format!(
                "no ledger writer is armed for {} — nothing can be appended against it",
                self.vault.display()
            )
        })?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conflict::detect;
    use crate::ledger::reduce::{ComparisonOrigin, ComparisonRow};
    use crate::ledger::schema::ConflictEndpoint;
    use std::cell::RefCell;

    const STORE: &str = "cafebabecafebabecafebabecafebabe";

    #[derive(Default)]
    struct Spy {
        seen: RefCell<Vec<(String, String)>>,
        answer: Option<Wrote>,
        fail: bool,
    }

    impl Append for Spy {
        fn append_once(
            &self,
            key: &str,
            kind: &str,
            body: serde_json::Value,
        ) -> Result<Wrote, String> {
            // Whatever the emitter hands the writer has to be a body the
            // writer would accept, and its key has to name its own id.
            let decoded = crate::ledger::schema::decode_body(kind, &body)
                .expect("a decodable body")
                .expect("a schema-v1 body");
            decoded.validate(STORE).expect("a valid body");
            assert!(
                key.ends_with(body["comparison_id"].as_str().expect("an id")),
                "the key names a different comparison than the body"
            );
            self.seen
                .borrow_mut()
                .push((key.to_string(), kind.to_string()));
            if self.fail {
                return Err("the writer said no".into());
            }
            Ok(self.answer.unwrap_or(Wrote::Appended))
        }
    }

    fn candidates() -> Vec<Candidate> {
        let found = detect::find(&detect::fixture::base());
        assert!(!found.is_empty(), "the fixture disagrees with itself");
        found
    }

    #[test]
    fn every_candidate_is_appended_once_under_a_store_scoped_key() {
        let spy = Spy::default();
        let out = emit(&EpistemicState::default(), STORE, &candidates(), &spy);
        assert_eq!(out.appended, 1);
        assert_eq!(out.already_known, 0);
        assert!(out.failed.is_empty());
        let seen = spy.seen.borrow();
        assert_eq!(seen.len(), 1);
        assert!(seen[0]
            .0
            .starts_with(&format!("conflict-candidate:{STORE}:")));
        assert_eq!(seen[0].1, KIND_CONFLICT_CANDIDATE_DETECTED);
    }

    #[test]
    fn a_comparison_the_base_already_holds_never_reaches_the_writer() {
        // The cheap guard, and the one that matters: a long-standing
        // disagreement nobody has classified must not re-propose itself on
        // every pass.
        let candidates = candidates();
        let comparison_id =
            derive_comparison_id(&candidates[0].left, &candidates[0].right).unwrap();
        let mut state = EpistemicState::default();
        state.comparisons.insert(
            comparison_id.clone(),
            ComparisonRow {
                comparison_id,
                event_id: "90000000000000000000000000000001".into(),
                left: ConflictEndpoint::Asserted {
                    endpoint: candidates[0].left.clone(),
                },
                right: ConflictEndpoint::Asserted {
                    endpoint: candidates[0].right.clone(),
                },
                origin: ComparisonOrigin::Detected {
                    detector_version: DETECTOR_VERSION.into(),
                    reason_codes: candidates[0].reason_codes.clone(),
                },
            },
        );
        let spy = Spy::default();
        let out = emit(&state, STORE, &candidates, &spy);
        assert_eq!(out.already_known, 1);
        assert_eq!(out.appended, 0);
        assert!(spy.seen.borrow().is_empty(), "the writer was called anyway");
    }

    #[test]
    fn the_durable_guard_still_answers_when_state_has_not_caught_up() {
        let spy = Spy {
            answer: Some(Wrote::AlreadyThere),
            ..Spy::default()
        };
        let out = emit(&EpistemicState::default(), STORE, &candidates(), &spy);
        assert_eq!(out.already_known, 1);
        assert_eq!(out.appended, 0);
    }

    #[test]
    fn a_failed_append_is_reported_rather_than_swallowed() {
        // A detector that silently drops a comparison looks exactly like a
        // base with nothing to disagree about.
        let spy = Spy {
            fail: true,
            ..Spy::default()
        };
        let out = emit(&EpistemicState::default(), STORE, &candidates(), &spy);
        assert_eq!(out.appended, 0);
        assert_eq!(out.failed.len(), 1);
        assert!(out.failed[0].1.contains("the writer said no"));
        assert!(!out.failed[0].0.is_empty(), "a failure names what failed");
    }
}
