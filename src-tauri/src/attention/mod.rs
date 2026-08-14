//! Attention: the deterministic signals, the lanes over them, and the bypass.
//!
//! [`signals`] (M26.7c) computes the facts a ranking would need, with no
//! ranking in it. [`lanes`] (M27.6) is the ranking, and it is declared in an
//! artifact rather than written here. [`critical`] (M27.7) is §8's bypass —
//! the few things that must not wait in a lane at all. [`store`] persists one
//! signals row per live belief in app-data, schema-disjoint from anything
//! epistemic.
//!
//! The split was the point and still is: M26 shipped the services and M27
//! shipped the surfaces, so the ordering could not be decided by whoever
//! wrote the query first.
//!
//! **The preference firewall is two things, and both are tested** (§33):
//! these tables never touch belief tables, AND no preference may suppress a
//! protected class. See [`preferences`].

pub mod critical;
pub mod lanes;
pub mod preferences;
pub mod signals;
pub mod store;
