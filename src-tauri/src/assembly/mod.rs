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
