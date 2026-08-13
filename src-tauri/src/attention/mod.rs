//! Attention primitives (M26.7c): the deterministic signals M27's lanes will
//! rank, computed and stored — with no lanes, no ranking, and no UI.
//!
//! The split is the point. [`signals`] is a pure function of reducer state
//! and an `as_of` argument; [`store`] persists one row per live belief in
//! app-data, schema-disjoint from anything epistemic. Nothing consumes either
//! yet, deliberately: M26 ships the services, M27 ships the surfaces, and
//! shipping them together would mean the ranking was decided by whoever wrote
//! the query first.

pub mod signals;
pub mod store;
