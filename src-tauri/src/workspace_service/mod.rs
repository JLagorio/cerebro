//! Rust-owned workspace service boundary. The first consumer is the existing
//! human whole-source read; this is not a storage or authorization migration.

pub(crate) mod legacy;
pub(crate) mod types;

#[cfg(test)]
mod tests;

// Queries remain disposable. Canonical values serve inactive staging and the
// explicit selected-authority read/one-key metadata adapter.
#[cfg(test)]
pub(crate) mod query;
pub(crate) mod value;

// Selected-authority vertical; no registration or activation producer.
pub(crate) mod authority;
pub(crate) mod boundary;
pub(crate) mod native_admission;
#[cfg(test)]
mod native_admission_tests;
pub(crate) mod selected;
#[cfg(test)]
mod selected_tests;

// Shared data only; native workflow remains disabled until coordinator acceptance.
#[cfg(unix)]
pub(crate) mod backup_policy;

// One original-owner workflow; macOS commands register the actual main window.
#[cfg(unix)]
#[cfg_attr(all(not(test), not(target_os = "macos")), expect(dead_code, reason = "Native backup workflow is unsupported outside macOS."))]
pub(crate) mod backup_coordinator;

// Generated backup wire views contain no authority-bearing values.
pub(crate) mod backup_types;

// Actual native backup handlers, authenticated by the registered main window.
pub(crate) mod backup_commands;
