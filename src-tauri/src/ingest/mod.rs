//! The deterministic ingest pipeline (M25.5).
//!
//! Between the scheduler (what changed) and the ledger (what it means) sits
//! one Rust decision: is an LLM run WARRANTED. That is all the prefilter
//! decides. It never decides whether an observation is recorded — recording
//! is epistemic and unconditional; spending is operational and bounded.
//!
//! **Materiality has four dimensions (§17)**, and only two of them come from
//! comparing values:
//!
//! - `world_state` and `belief_state` come from the per-field diff;
//! - `evidence_state` comes from hashes and lineage — a SECOND independent
//!   lineage for a value that did not move is material, which is why "no
//!   field changed → discard" is forbidden;
//! - `attention` is the residual, and residual ambiguity is escalated to
//!   M26 rather than resolved by a guess.
//!
//! **Every verdict has a consumer.** The route matrix in
//! `ledger/schema/ingest.rs` is total, and [`route_for`] is the function that
//! lands on it. A verdict that fell out of a `match` with nowhere to go is
//! exactly what a closed matrix exists to make impossible.

pub mod independence;
pub mod outcome;
pub mod prefilter;
pub mod prompt;
pub mod resolver;
pub mod taint;
pub mod window;
