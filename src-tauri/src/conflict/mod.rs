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
//! [`backfill`] is the one-time sweep that gives the same treatment to
//! declarations nobody ever backed with evidence — the `contradicts`
//! relations a migration inherited or a person typed before any of this
//! existed. Nothing may be gated on classification until it has run.

pub mod backfill;
pub mod detect;
pub mod emit;
pub mod resolve;
