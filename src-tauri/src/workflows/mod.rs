//! Rust-owned workflow definitions. Publishing never grants execution authority.
// The definition boundary lands before the native workflow service.
#![expect(
    dead_code,
    reason = "M98 definition boundary precedes native service wiring"
)]

mod definition;
#[cfg(test)]
mod tests;

mod files;
mod mapping;

mod read;
mod runner;

pub(crate) mod native_definition;

pub(crate) mod transport;

pub(crate) mod document_service;

/// Shared data-only schedule decisions for preview and native admission.
pub(crate) mod schedule;

/// Retained descriptor publication metadata; no native execution authority.
pub(crate) mod publication;
