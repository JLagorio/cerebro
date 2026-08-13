//! Potential conflicts as a deterministic signal (M26.7).
//!
//! Two halves and a hard line between them. [`detect`] is a pure function of
//! reducer state that finds pairs worth classifying; [`emit`] appends each
//! one exactly once. Neither half decides that anything disagrees — M27 owns
//! classification, and this module exists so that M27 has committed,
//! rebuildable input instead of a scan it has to redo.

pub mod detect;
pub mod emit;
