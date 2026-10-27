//! Native ownership is active; action/account services remain test-gated.
mod catalog;
pub(crate) mod ids;
pub(crate) mod schema;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod types;

#[cfg(test)]
mod approval;
mod effect_kernel;
#[cfg(test)]
mod recovery;
#[cfg(test)]
mod service;

#[cfg(test)]
mod admission;
#[cfg(test)]
mod native_admission_tests;
mod native_authority;

pub(crate) mod native_owner;

#[cfg(test)]
#[path = "../../../conformance/outcomes/native.rs"]
mod outcome_conformance;

// Shared kernel consumed by retained native provenance registration.
mod native_db;
mod native_lineage;
mod native_rules;

mod compiled_catalog;
mod github_issues;
pub(crate) mod read_types;

mod effect_reads;
mod effect_record;
mod effect_types;
pub(crate) mod recovery_read_types;

mod workflow_linkage;

pub(crate) mod output_handoff;

pub(crate) mod workflow_requests;

mod workflow_bridge;

// Exact transport counter shared by Rust-owned generated workflow DTOs.
pub(crate) use effect_types::{ActionEffectDetails, SafeCounter};

pub(crate) mod chat_retention;
