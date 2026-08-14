//! The Source Monitor (M26.7d).
//!
//! Deterministic Rust, never an LLM role, and never a fetcher. [`sources`]
//! decides what a cached copy IS and whether it moved; [`store`] remembers
//! what was last seen and reports what is due. The fetch itself belongs to
//! the assistant, through the owner's own connectors — there is no HTTP
//! client in this crate, and there should not be one.

pub mod pass;
pub mod sources;
pub mod store;
