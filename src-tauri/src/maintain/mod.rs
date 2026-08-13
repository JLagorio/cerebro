//! The maintenance pass (M26.6).
//!
//! One scheduled run that looks at the base rather than at what changed. The
//! ingest pass reads new bytes; this reads what the base has become — the
//! duplicates, the retired links nothing points at, the beliefs standing on
//! one source or on none.
//!
//! **It proposes; it never applies.** Everything it finds ends as an M24
//! proposal with the risk the policy table gives it, so a CRITICAL
//! `merge_entities` reaches a person and a LOW `merge_beliefs_exact` does not
//! need to. There are no maintenance opcodes (§16) and there is no maintenance
//! bypass.
//!
//! **Reconciler and Temporal, not yet Curiosity or Skeptic.** D6 names four
//! roles for this construct; the other two join at M28+ through the trigger
//! registry, and pretending they were here would mean a pass that speculates.

pub mod candidates;
pub mod live;
pub mod pass;
pub mod prompt;
pub mod schedule;
