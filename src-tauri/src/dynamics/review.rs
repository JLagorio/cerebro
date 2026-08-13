//! [`ReviewStatus`] — D8's first channel, kept out of Support (M27.1).
//!
//! **A human saying "I checked this" is not evidence for it.** M22 refuses an
//! attestation as a basis link structurally: [`BeliefBasis`] has nowhere to
//! put one. This module is where that refusal becomes a visible answer instead
//! of a silence — the review state renders BESIDE the three axes, never inside
//! Support, so a migrated `verified: true` concept keeps `Support: unsupported`
//! and its review stamp at the same time, and neither one is a lie.
//!
//! **Latest by ledger position, never by supplied time.** `occurred_at` is a
//! label a caller wrote (D3); the fold order is the store's own. The reducer
//! keeps `attested` pointing at the newest applied attestation, and that
//! pointer is what this reads.
//!
//! [`BeliefBasis`]: crate::ledger::schema::BeliefBasis

use crate::ledger::reduce::BeliefState;

/// Whether the human review channel has anything to say about one facet's
/// pinned revision.
///
/// Tagged rather than a boolean pair, because `predates_current` is a real
/// third answer: it says a person DID check this belief, and checked a
/// different version of it. Collapsing that into `unreviewed` throws away the
/// fact that review happened; collapsing it into `current` claims a check that
/// never covered these bytes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ReviewStatus {
    Unreviewed,
    Current {
        attestation_event_id: String,
        attested_belief_revision_event_id: String,
    },
    PredatesCurrent {
        attestation_event_id: String,
        attested_belief_revision_event_id: String,
    },
}

impl ReviewStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReviewStatus::Unreviewed => "unreviewed",
            ReviewStatus::Current { .. } => "current",
            ReviewStatus::PredatesCurrent { .. } => "predates_current",
        }
    }

    /// The attesting event, when one exists.
    pub fn attestation_event_id(&self) -> Option<&str> {
        match self {
            ReviewStatus::Unreviewed => None,
            ReviewStatus::Current {
                attestation_event_id,
                ..
            }
            | ReviewStatus::PredatesCurrent {
                attestation_event_id,
                ..
            } => Some(attestation_event_id.as_str()),
        }
    }
}

/// The review status of one belief relative to a PINNED revision.
///
/// Relative to the facet's revision rather than to "the current one", because
/// a facet is about a pinned revision: asking whether the review covers the
/// belief's newest bytes would answer a question the facet never asked.
pub fn status_for(belief: &BeliefState, revision_event_id: &str) -> ReviewStatus {
    match &belief.attested {
        None => ReviewStatus::Unreviewed,
        Some((attestation_event_id, attested_revision))
            if attested_revision == revision_event_id =>
        {
            ReviewStatus::Current {
                attestation_event_id: attestation_event_id.clone(),
                attested_belief_revision_event_id: attested_revision.clone(),
            }
        }
        Some((attestation_event_id, attested_revision)) => ReviewStatus::PredatesCurrent {
            attestation_event_id: attestation_event_id.clone(),
            attested_belief_revision_event_id: attested_revision.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{B_ONE, REV_ONE, REV_TWO};
    use crate::dynamics::facet::tests::base;

    const ATTESTATION: &str = "70000000000000000000000000000001";

    #[test]
    fn no_attestation_is_unreviewed() {
        let state = base();
        assert_eq!(
            status_for(state.beliefs.get(B_ONE).unwrap(), REV_ONE),
            ReviewStatus::Unreviewed
        );
    }

    #[test]
    fn an_attestation_pinned_to_this_revision_is_current() {
        let mut state = base();
        state
            .beliefs
            .get_mut(B_ONE)
            .unwrap()
            .attested
            .replace((ATTESTATION.into(), REV_ONE.into()));
        assert_eq!(
            status_for(state.beliefs.get(B_ONE).unwrap(), REV_ONE),
            ReviewStatus::Current {
                attestation_event_id: ATTESTATION.into(),
                attested_belief_revision_event_id: REV_ONE.into(),
            }
        );
    }

    #[test]
    fn an_attestation_pinned_elsewhere_predates_and_is_not_forgotten() {
        // The third answer earning its keep: review HAPPENED, and it covered
        // other bytes. Neither `unreviewed` nor `current` says that.
        let mut state = base();
        state
            .beliefs
            .get_mut(B_ONE)
            .unwrap()
            .attested
            .replace((ATTESTATION.into(), REV_TWO.into()));
        let status = status_for(state.beliefs.get(B_ONE).unwrap(), REV_ONE);
        assert_eq!(status.as_str(), "predates_current");
        assert_eq!(status.attestation_event_id(), Some(ATTESTATION));
    }
}
