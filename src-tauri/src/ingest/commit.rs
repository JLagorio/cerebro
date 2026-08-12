//! The production [`Commit`](super::pass::Commit) — appending a window's
//! terminal batch to the live vault (M26.4i).
//!
//! It is three lines and it exists for one reason: to be called at a moment
//! when no subprocess is running.
//!
//! `ledger::shadow::with_writer` holds a process-global mutex for the whole
//! of its closure, and the MCP server's `propose_*` and `commit_proposals`
//! tools open with the same call on a different thread. Anything that holds
//! the writer across a CLI run deadlocks: the driver waits for the run, the
//! run waits for MCP, MCP waits for the writer. `ingest::pass` therefore
//! takes this seam rather than a `&mut LedgerWriter`, and takes it only after
//! the runner has returned.

use std::path::{Path, PathBuf};

use super::pass::Commit;

/// Append through whatever writer is armed for this vault.
pub struct ShadowCommit {
    pub vault: PathBuf,
}

impl ShadowCommit {
    pub fn new(vault: &Path) -> ShadowCommit {
        ShadowCommit {
            vault: vault.to_path_buf(),
        }
    }
}

impl Commit for ShadowCommit {
    fn append_batch(
        &self,
        events: Vec<(String, serde_json::Value)>,
        operation_key: &str,
    ) -> Result<(), String> {
        crate::ledger::shadow::with_writer(&self.vault, |writer| {
            writer.append_batch(events, Some(operation_key)).map(|_| ())
        })
        // `None` means no writer is armed for this vault — a real answer, not
        // a missing one: the window stays closed-in-memory and its items are
        // held rather than consumed.
        .ok_or_else(|| {
            format!(
                "no ledger writer is armed for {} — nothing can be committed against it",
                self.vault.display()
            )
        })?
    }
}
