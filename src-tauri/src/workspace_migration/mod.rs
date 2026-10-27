//! Selected-store staging and the private paired-change protocol. No activation
//! producer or IPC door lives here.
//! Checked inventory and identity planning serve the inactive semantic producer.
//! Disposable comparison adapters remain test-only.
#[cfg(test)]
pub(crate) mod comparison;
pub mod identity;
pub mod inventory;
#[cfg(test)]
mod sidecar;
#[cfg(test)]
mod sqlite;
mod syntax;

pub mod format_gate;
mod selected_sqlite;
pub mod semantic;
pub mod stage;

pub(crate) mod cutover;
pub(crate) mod journal;
pub(crate) mod recovery;

// Portable inactive directory-bundle boundary; initially closed under RED.
pub mod backup;
pub mod restore;
