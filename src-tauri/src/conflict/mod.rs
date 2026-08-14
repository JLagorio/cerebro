//! Conflict, in three deterministic halves (M26.7, M27.3).
//!
//! [`detect`] is a pure function of reducer state that finds pairs worth
//! classifying; [`emit`] appends each one exactly once. Neither decides that
//! anything disagrees — they exist so the gauntlet has committed, rebuildable
//! input instead of a scan it has to redo.
//!
//! [`resolve`] is the gauntlet: it runs the committed pairs through D12's
//! typed gates and, overwhelmingly, resolves them APART. What survives every
//! gate is either a structural value incompatibility — the only deterministic
//! contradiction there is — or a question about meaning, which it refuses to
//! answer and leaves for review.
//!
//! [`declared`] is the other gauntlet, for the claims nobody ever backed with
//! evidence — someone simply wrote that two beliefs contradict. It is the
//! RULE, shared by both callers: [`backfill`] is the one-time sweep that
//! applies it to the `contradicts` relations a migration inherited or a
//! person typed before any of this existed, and the `edit_relation`
//! expansion applies it to one being authored now. Nothing may be gated on
//! classification until the backfill has run.

pub mod backfill;
pub mod declared;
pub mod detect;
pub mod emit;
pub mod resolve;
