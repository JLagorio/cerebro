//! The trigger registry (M28.0) — deferral governance as data.
//!
//! **This module authorizes nothing.** M28+ defers fourteen capabilities, each
//! behind a named gate; what ships here is only the substrate that can
//! EVALUATE and RECORD those gates: the closed registry artifact and its
//! loader. A `fired` result permits exactly one thing — a dated plan document
//! plus a matrix-row update in one commit — and never the deferred
//! capability's code, a feature flag, an agent launch, or a proposal
//! registration.
//!
//! **The registry is closed, and closed as data.** Which gate key requires
//! which evaluation variant, which parents a subcapability may name, and which
//! unit a metric carries all live in
//! `shared/policy/trigger-registry.v1.json`, read by this module and by
//! `src/lib/trigger/registry.ts` from the same bytes. Any combination the
//! artifact does not name refuses — there is no default variant and no
//! benefit of the doubt, because a gate that can be evaluated under the wrong
//! rules is a gate somebody can satisfy by accident.

pub mod evaluation;
pub mod registry;
