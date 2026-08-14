//! Query-time assembly (M26.5) — the attended half of the platform.
//!
//! The ingest pass reads what changed. This answers what somebody ASKED, and
//! the two are different contracts on purpose:
//!
//! - **Attended is bounded, never budgeted.** An assembly is capped by
//!   sources, bytes and evidence items so one request cannot run away, and it
//!   is metered. It is NEVER refused by M25's daily-run or token ceilings, or
//!   by what ambient work spent this morning. A person waiting for an answer
//!   is not competing with the background for a quota; there is deliberately
//!   no `max_daily_runs` anywhere in this module.
//! - **Ambient is budgeted.** Ingest, maintenance, the Source Monitor's
//!   triggered work and scheduled convergence all go through M25's gates.
//!
//! A per-run model limit may still end an attended request. That is a runtime
//! failure and is reported as one — never as a budget refusal, because the
//! two mean opposite things to the person who asked.

pub mod answer;
pub mod ask;
pub mod assemble;
pub mod corpus;
pub(crate) mod fixture;
pub mod live;
pub mod manifest;
pub mod prompt;
pub mod store;

/// One question's answer, as a surface sees it (M26.5e).
///
/// **A typed result, never a thrown error.** A refusal is not a failure to
/// report and move on from: `cap_conflict` means accessible counterevidence
/// would not fit and the app declined to synthesize, and that is a card the
/// person who asked has to see. AGENTS.md's never-throw rule is for human UI
/// actions; this is the same exemption the proposal channels have, for the
/// same reason — the caller is expected to READ this and act on it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Asked {
    Answered {
        manifest: Box<manifest::WorkingMemoryManifest>,
        answer: Box<answer::SynthesisAnswer>,
    },
    /// The run happened and submitted nothing. The receipt says what it saw.
    Unanswered {
        manifest: Box<manifest::WorkingMemoryManifest>,
        detail: String,
    },
    /// There is no manifest and nothing ran.
    Refused { code: &'static str, detail: String },
}

impl From<ask::Outcome> for Asked {
    fn from(outcome: ask::Outcome) -> Asked {
        match outcome {
            ask::Outcome::Answered { manifest, answer } => Asked::Answered { manifest, answer },
            ask::Outcome::Unanswered { manifest, detail } => Asked::Unanswered { manifest, detail },
        }
    }
}

impl From<assemble::Refusal> for Asked {
    fn from(refusal: assemble::Refusal) -> Asked {
        let detail = refusal.to_string();
        Asked::Refused {
            // Named, not stringly-derived: a surface routes on these, and a
            // code that changed when someone reworded a message would be a
            // silent break.
            code: match refusal {
                assemble::Refusal::CapConflict { .. } => "cap_conflict",
                assemble::Refusal::RetrievalUnavailable { .. } => "retrieval_unavailable",
                assemble::Refusal::Incoherent { .. } => "base_incoherent",
                assemble::Refusal::Invalid { .. } => "assembly_invalid",
            },
            detail,
        }
    }
}
