//! Write receipts (M58.1): every vault write carries its door's proof.
//!
//! A writer in `vault::write`, the ledger's concept writers and git's discard
//! each take a [`WriteReceipt`], and only the door's own guard can mint one.
//! The guard is no longer a call each door has to remember: a command that
//! skips it has no receipt to hand the writer, and does not compile. The
//! receipt also carries the stamp the write records in `vault_writes`
//! (`runtime::vault_writes`): who made it, in which run, and who approved it.
//!
//! Four doors, each a zero-size type:
//!
//! - [`Human`]: the IPC commands a person's UI calls. Minted from
//!   `knowledge::guard_human_write` or `guard_human_move` (their
//!   `HumanCleared`), stamped [`HUMAN_ACTOR`] with no run.
//! - [`Agent`]: the MCP tools a run calls. Minted from `mcp::RunCleared`,
//!   which only `cleared_for_note` and `cleared_for_source` build, stamped
//!   with the run's actor and id, and `human:me` as approver when a person
//!   allowed the write (M57 Q21).
//! - [`ConceptDoor`]: the knowledge bundle's writers. Minted from
//!   `knowledge::guard_verify` or `knowledge::concept_door` for a person
//!   (Verify, the capture valve, a Review decision), or from
//!   `mcp::cleared_for_concept` for a run.
//! - [`System`]: the app's own janitors, from a closed list
//!   ([`SystemWriter`]): the orphan-temp reaper, the Trash purge and the
//!   rollback of a batch a crash left unfinished (M60.6).
//!
//! Each proof holds a private `(())`, so only its guard's module can build
//! one: a receipt is never a value a caller can write down. Not `Clone`
//! either: a write that wants a receipt mints its own at its door.
//!
//! A writer called without a receipt does not compile:
//!
//! ```compile_fail,E0061
//! use std::path::Path;
//! cerebro_lib::vault::write::save_note(Path::new("/vault"), "notes/a.md", "body").unwrap();
//! ```
//!
//! and with one minted by the human guard, it does:
//!
//! ```no_run
//! use std::path::Path;
//! use cerebro_lib::vault::receipt::WriteReceipt;
//! let by = WriteReceipt::ipc(cerebro_lib::knowledge::guard_human_write("notes/a.md").unwrap());
//! cerebro_lib::vault::write::save_note(Path::new("/vault"), "notes/a.md", "body", &by).unwrap();
//! ```
//!
//! A receipt cannot be written as a literal:
//!
//! ```compile_fail,E0451
//! use cerebro_lib::vault::receipt::{Human, WriteReceipt};
//! let forged: WriteReceipt<Human> = WriteReceipt {
//!     actor: "human:me".to_string(),
//!     run_id: None,
//!     approved_by: None,
//!     door: std::marker::PhantomData,
//! };
//! ```
//!
//! only minted, through the guard:
//!
//! ```no_run
//! use cerebro_lib::vault::receipt::{Human, WriteReceipt};
//! let minted: WriteReceipt<Human> =
//!     WriteReceipt::ipc(cerebro_lib::knowledge::guard_human_write("notes/a.md").unwrap());
//! assert_eq!(minted.actor(), "human:me");
//! ```
//!
//! And a person's receipt does not open an agent's door:
//!
//! ```compile_fail,E0308
//! use std::path::Path;
//! use cerebro_lib::vault::receipt::WriteReceipt;
//! let by = WriteReceipt::ipc(cerebro_lib::knowledge::guard_human_write("sources/a.md").unwrap());
//! let fm = serde_json::Map::new();
//! cerebro_lib::vault::write::write_source(Path::new("/vault"), "sources/a.md", &fm, "b", &by)
//!     .unwrap();
//! ```
//!
//! while the same receipt opens a person's:
//!
//! ```no_run
//! use std::path::Path;
//! use cerebro_lib::vault::receipt::WriteReceipt;
//! let by = WriteReceipt::ipc(cerebro_lib::knowledge::guard_human_write("sources/a.md").unwrap());
//! cerebro_lib::vault::write::save_note(Path::new("/vault"), "sources/a.md", "b", &by).unwrap();
//! ```

use std::marker::PhantomData;

/// Who a person's writes are stamped as (D1: single user).
pub const HUMAN_ACTOR: &str = "human:me";

/// Who the orphan-temp janitor's writes are stamped as.
pub const ORPHAN_TEMPS_ACTOR: &str = "system:orphan-temps";

/// Who the launch purge of the vault's Trash is stamped as (M60.8).
pub const TRASH_PURGE_ACTOR: &str = "system:trash-purge";

/// Who the launch rollback of an unfinished batch is stamped as (M60.6).
pub const BATCH_RECOVERY_ACTOR: &str = "system:batch-recovery";

mod sealed {
    /// Only this module's doors and proofs are doors and proofs.
    pub trait Sealed {}
}

/// One of the four doors a write comes through. Sealed: no other door exists.
pub trait Door: sealed::Sealed {
    /// The door's name, for a message.
    const NAME: &'static str;
}

/// A door that may create notes: a person's and a run's.
pub trait CreatesNotes: Door {}

/// A door a run's grant mints for: a run's page writes and its concept
/// writes.
pub trait RunDoor: Door {}

/// A person's IPC commands.
#[derive(Debug)]
pub struct Human;
/// A run's MCP tools.
#[derive(Debug)]
pub struct Agent;
/// The knowledge bundle's writers.
#[derive(Debug)]
pub struct ConceptDoor;
/// The app's own janitors.
#[derive(Debug)]
pub struct System;

impl sealed::Sealed for Human {}
impl sealed::Sealed for Agent {}
impl sealed::Sealed for ConceptDoor {}
impl sealed::Sealed for System {}

impl Door for Human {
    const NAME: &'static str = "human";
}
impl Door for Agent {
    const NAME: &'static str = "agent";
}
impl Door for ConceptDoor {
    const NAME: &'static str = "concept";
}
impl Door for System {
    const NAME: &'static str = "system";
}

impl CreatesNotes for Human {}
impl CreatesNotes for Agent {}

impl RunDoor for Agent {}
impl RunDoor for ConceptDoor {}

/// A person's guard proof, and the door it opens. Sealed: the two proofs are
/// `knowledge::HumanCleared` and `knowledge::ConceptCleared`.
pub trait IpcProof: sealed::Sealed {
    type Door: Door;
}

impl sealed::Sealed for crate::knowledge::HumanCleared {}
impl sealed::Sealed for crate::knowledge::ConceptCleared {}

impl IpcProof for crate::knowledge::HumanCleared {
    type Door = Human;
}
impl IpcProof for crate::knowledge::ConceptCleared {
    type Door = ConceptDoor;
}

/// The app's own writers, a closed list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemWriter {
    /// `scan_vault`'s reaping of crashed writes' temps.
    OrphanTemps,
    /// `start_watcher`'s purge of Trash items past their days (M60.8).
    TrashPurge,
    /// `start_watcher`'s rollback of a batch an earlier process left
    /// unfinished (M60.6).
    BatchRecovery,
}

/// Proof that `D`'s guard cleared a write, and the stamp it records under.
/// See the module doc.
#[derive(Debug)]
#[must_use = "a receipt is minted for the write it is handed to"]
pub struct WriteReceipt<D: Door> {
    actor: String,
    run_id: Option<String>,
    approved_by: Option<&'static str>,
    door: PhantomData<D>,
}

impl<D: Door> WriteReceipt<D> {
    /// Who made the write: `human:me`, the run's actor, or a system writer.
    pub fn actor(&self) -> &str {
        &self.actor
    }

    /// The run the write belongs to, or `None` for a person's or the app's.
    pub fn run_id(&self) -> Option<&str> {
        self.run_id.as_deref()
    }

    /// Who allowed the run's write (`human:me`), or `None` when nobody had to.
    pub fn approved_by(&self) -> Option<&str> {
        self.approved_by
    }

    /// A person's receipt, from their guard's proof: `human:me`, no run.
    pub fn ipc<P: IpcProof<Door = D>>(_cleared: P) -> Self {
        Self::stamped(HUMAN_ACTOR.to_string(), None, None)
    }

    /// A test's receipt, minted past every guard. Production mints at a door.
    #[cfg(test)]
    pub(crate) fn for_test(actor: &str, run_id: Option<&str>) -> Self {
        Self::stamped(actor.to_string(), run_id.map(str::to_string), None)
    }

    fn stamped(actor: String, run_id: Option<String>, approved_by: Option<&'static str>) -> Self {
        Self {
            actor,
            run_id,
            approved_by,
            door: PhantomData,
        }
    }
}

impl<D: RunDoor> WriteReceipt<D> {
    /// A run's receipt, from the grant its MCP door cleared
    /// (`mcp::cleared_for_note`, `cleared_for_source`, `cleared_for_concept`).
    pub(crate) fn run(cleared: crate::mcp::RunCleared<D>) -> Self {
        let (actor, run_id, approved_by) = cleared.into_stamp();
        Self::stamped(actor, Some(run_id), approved_by)
    }
}

impl WriteReceipt<System> {
    /// The app's own writer's receipt, from the closed list.
    pub fn system(writer: SystemWriter) -> Self {
        let actor = match writer {
            SystemWriter::OrphanTemps => ORPHAN_TEMPS_ACTOR,
            SystemWriter::TrashPurge => TRASH_PURGE_ACTOR,
            SystemWriter::BatchRecovery => BATCH_RECOVERY_ACTOR,
        };
        Self::stamped(actor.to_string(), None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_receipt_from_the_human_guard_writes_human_me() {
        let _sink = crate::runtime::sink::test_lock();
        let config = crate::vault::testutil::temp_vault("receipt-human-config");
        let vault = crate::vault::testutil::temp_vault("receipt-human");
        crate::runtime::sink::arm(&config).unwrap();
        crate::vault::testutil::write(&vault, "notes/a.md", "# A\n");
        let by = WriteReceipt::ipc(crate::knowledge::guard_human_write("notes/a.md").unwrap());
        assert_eq!(
            (by.actor(), by.run_id(), by.approved_by()),
            (HUMAN_ACTOR, None, None)
        );
        crate::vault::write::save_note(&vault, "notes/a.md", "\n# A\n\nSaved.\n", &by).unwrap();
        let vault_id = crate::runtime::scope::derive_vault_id(&vault);
        let rows: Vec<(String, Option<String>, Option<String>)> =
            crate::runtime::sink::with_sink(|conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT kind, actor, run_id FROM vault_writes WHERE vault_id = ?1 \
                         ORDER BY rowid",
                    )
                    .unwrap();
                stmt.query_map([&vault_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
            })
            .unwrap();
        assert_eq!(
            rows,
            vec![("vault.write".into(), Some(HUMAN_ACTOR.into()), None)]
        );
        crate::runtime::sink::disarm();
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_system_receipt_names_its_writer() {
        let by = WriteReceipt::system(SystemWriter::OrphanTemps);
        assert_eq!((by.actor(), by.run_id()), (ORPHAN_TEMPS_ACTOR, None));
        let by = WriteReceipt::system(SystemWriter::TrashPurge);
        assert_eq!((by.actor(), by.run_id()), (TRASH_PURGE_ACTOR, None));
        let by = WriteReceipt::system(SystemWriter::BatchRecovery);
        assert_eq!((by.actor(), by.run_id()), (BATCH_RECOVERY_ACTOR, None));
    }

    /// The name of the last `fn` declared before byte `at` of `source`: the
    /// function whose body holds it, which is all a scan needs.
    fn enclosing_fn(source: &str, at: usize) -> Option<String> {
        let before = &source[..at];
        let start = before.rfind("fn ")?;
        let name: String = before[start + 3..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        Some(name)
    }

    /// Every production line of `source`: the `#[cfg(test)] mod tests` tail
    /// cut off, so a test's own call never counts as a door.
    fn production(source: &str) -> &str {
        source
            .find("#[cfg(test)]\nmod tests")
            .map_or(source, |cut| &source[..cut])
    }

    /// Where `needle` occurs in `source`, outside `//` comments.
    fn occurrences(source: &str, needle: &str) -> Vec<usize> {
        let mut found = Vec::new();
        let mut offset = 0;
        for line in source.split_inclusive('\n') {
            let code = line.split("//").next().unwrap_or_default();
            let mut from = 0;
            while let Some(i) = code[from..].find(needle) {
                found.push(offset + from + i);
                from += i + needle.len();
            }
            offset += line.len();
        }
        found
    }

    #[test]
    fn receipts_are_minted_only_at_their_doors() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut sources = Vec::new();
        for entry in walkdir::WalkDir::new(&src)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.path().extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&src)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let text = std::fs::read_to_string(entry.path()).unwrap();
            sources.push((rel, text));
        }
        let mut problems = Vec::new();
        for (rel, text) in &sources {
            let code = production(text);
            // A person's receipt: only the IPC commands mint one.
            for at in occurrences(code, "WriteReceipt::ipc(") {
                if !matches!(rel.as_str(), "lib.rs" | "git_commands.rs") {
                    problems.push(format!("{rel}: WriteReceipt::ipc at byte {at}"));
                }
            }
            // The app's own receipt: only scan_vault's janitor, and
            // start_watcher's purge of the vault's Trash (M60.8) and its
            // rollback of an unfinished batch (M60.6).
            for at in occurrences(code, "WriteReceipt::system(") {
                let writer = code[at..].split(')').next().unwrap_or_default();
                let doors: &[&str] = match enclosing_fn(code, at).as_deref() {
                    Some("scan_vault") => &["SystemWriter::OrphanTemps"],
                    Some("start_watcher") => {
                        &["SystemWriter::TrashPurge", "SystemWriter::BatchRecovery"]
                    }
                    _ => &[],
                };
                if rel != "lib.rs" || !doors.iter().any(|door| writer.contains(door)) {
                    problems.push(format!("{rel}: WriteReceipt::system outside its door"));
                }
            }
            // A run's proof: built only by mcp.rs's three cleared_for_*.
            for at in occurrences(code, "RunCleared {") {
                let fn_name = enclosing_fn(code, at).unwrap_or_default();
                let declared = code[..at].ends_with("struct ");
                let allowed = rel == "mcp.rs"
                    && matches!(
                        fn_name.as_str(),
                        "cleared_for_note" | "cleared_for_source" | "cleared_for_concept"
                    );
                if !declared && !allowed {
                    problems.push(format!("{rel}: RunCleared built in {fn_name}"));
                }
            }
            // A person's approval: only a consumed ask-first approval and
            // Review's decision of a queued write name one.
            for at in occurrences(code, "Approval::Person") {
                let fn_name = enclosing_fn(code, at).unwrap_or_default();
                if rel != "mcp.rs"
                    || !matches!(fn_name.as_str(), "ask_first_step" | "decide_pending")
                {
                    problems.push(format!("{rel}: Approval::Person in {fn_name}"));
                }
            }
            // The agent's doors never reach a person's guard, or a person's
            // concept door: those mint human:me.
            if rel == "mcp.rs" {
                for needle in [
                    "guard_human_write(",
                    "guard_human_move(",
                    "guard_verify(",
                    "concept_door(",
                ] {
                    if !occurrences(code, needle).is_empty() {
                        problems.push(format!("mcp.rs calls {needle}"));
                    }
                }
            }
        }
        // Each ledger concept writer takes its receipt itself, so no door
        // reaches one without it.
        for (rel, signature) in [
            ("ledger/concepts.rs", "pub fn write_concept("),
            ("ledger/concepts.rs", "pub fn append_log("),
            ("ledger/concepts.rs", "pub fn verify_concept("),
            ("ledger/concepts.rs", "pub fn recheck_concept("),
            ("ledger/capture.rs", "pub fn capture_body_edit("),
            ("ledger/capture.rs", "pub fn capture_frontmatter_patch("),
            ("ledger/capture.rs", "pub fn capture_from_json("),
        ] {
            let text = &sources.iter().find(|(r, _)| r == rel).unwrap().1;
            let at = text
                .find(signature)
                .unwrap_or_else(|| panic!("{rel} has no {signature}"));
            let head = &text[at..at + text[at..].find('{').unwrap()];
            if !head.contains("&WriteReceipt<ConceptDoor>") {
                problems.push(format!("{rel}: {signature} takes no ConceptDoor receipt"));
            }
        }
        assert!(problems.is_empty(), "{problems:#?}");
    }
}
