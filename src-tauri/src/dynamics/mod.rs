//! Belief dynamics (M27): the three orthogonal axes, per facet.
//!
//! **"Confidence" does not survive here** (D9). A belief does not get a
//! number; it gets three answers to three different questions —
//! [`support::Support`] (what rests under it), [`coverage::Coverage`] (how
//! much anybody has looked), and [`validity::Validity`] (whether it still
//! holds). They are orthogonal on purpose: a corroborated belief can be
//! stale, a blind one can be uncontested, and a scalar that multiplied them
//! together would destroy exactly the distinctions a person needs.
//!
//! **Everything is keyed by [`facet::BeliefFacetKey`], never by belief.** One
//! revision can be supported by assertions about two different predicates at
//! two different stages; collapsing them would force a choice of canonical
//! scope that nothing in the base authorizes. Each `(predicate, stage)` pair
//! among the revision's admissible supports is its own facet with its own
//! answers, and an unsupported revision is one honest `unknown/unknown` facet
//! rather than an absence.
//!
//! **Nothing in this module reads the clock.** Freshness needs a time, so the
//! time is an argument (`as_of`) — the same discipline
//! [`crate::attention::signals`] and [`crate::convergence`] already carry. A
//! derivation that read `Utc::now()` would answer differently depending on
//! when it was asked, about a ledger whose contents had not moved, and the
//! byte-identical-replay requirement would be unmeetable by construction.

pub mod facet;
pub mod freshness;
pub mod review;
pub mod validity;
