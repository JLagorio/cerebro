//! The risk vocabulary (M24.3).
//!
//! It lives in the LEDGER schema rather than in `policy::table` because it
//! is a persisted value: a Proposal declares one, `proposal.queued` and
//! `proposal.applied` record the effective one, and a review card renders
//! it years later. The policy table maps ops ONTO these four names; it does
//! not own them, and `policy::table` re-exports this type rather than
//! defining a second copy that could drift.
//!
//! The ordering is the whole point of the type: `Ord` here is "more
//! dangerous", which is what "agent-declared risk may only RAISE" compares.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Risk {
    #[serde(rename = "LOW")]
    Low,
    #[serde(rename = "MEDIUM")]
    Medium,
    #[serde(rename = "HIGH")]
    High,
    #[serde(rename = "CRITICAL")]
    Critical,
}

impl Risk {
    pub const ALL: [Risk; 4] = [Risk::Low, Risk::Medium, Risk::High, Risk::Critical];

    pub fn as_str(&self) -> &'static str {
        match self {
            Risk::Low => "LOW",
            Risk::Medium => "MEDIUM",
            Risk::High => "HIGH",
            Risk::Critical => "CRITICAL",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordering_is_danger_not_alphabet() {
        // "CRITICAL" < "LOW" as strings; deriving Ord from the spelling
        // would silently invert every "may only RAISE" comparison.
        assert!(Risk::Low < Risk::Medium);
        assert!(Risk::Medium < Risk::High);
        assert!(Risk::High < Risk::Critical);
    }

    #[test]
    fn the_wire_spelling_is_upper_case_and_round_trips() {
        for risk in Risk::ALL {
            let raw = serde_json::to_string(&risk).unwrap();
            assert_eq!(raw, format!("\"{}\"", risk.as_str()));
            assert_eq!(serde_json::from_str::<Risk>(&raw).unwrap(), risk);
        }
    }
}
