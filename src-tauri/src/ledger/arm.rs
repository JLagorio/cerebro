//! M23.0 — arming the M22 migrator. Runs at vault activation, after ledger
//! recovery and writer open:
//!
//! 1. a matching `migration.completed` is the fast no-op;
//! 2. otherwise M22 migration resumes through its deterministic per-output
//!    `append_once` keys, whatever durable prefix a crash left behind;
//! 3. a changed source digest or key conflict REFUSES into the typed
//!    migration reconciliation signal — never a second epoch, never a
//!    duplicate output (the M23.6 circuit breaker turns the stored signal
//!    into its idempotent `ledger.divergence` event);
//! 4. after completion, the initial complete projection manifest is built
//!    only when every knowledge file byte-matches its reducer projection.
//!
//! Arming reads files and appends events; it never writes a vault file. The
//! manifest lives in `.cerebro/`, invisible to the scanner and watcher, so
//! the first post-open scan sees zero changes and queues zero distill work.

use std::path::Path;

use super::migrate::{migrate_vault, MigrateError, MigrationOutcome};
use super::reduce::reduce;
use super::schema;
use super::writer::LedgerWriter;
use super::{ledger_dir, manifest, read_ledger};

/// What arming did. `manifest_created` is false both when the manifest
/// already existed and when file/reducer bytes disagreed (the launch scan
/// owns that state); the two are distinguishable by whether the manifest
/// file exists afterwards.
#[derive(Debug, Clone, PartialEq)]
pub enum Arming {
    /// The fast path: a matching completed epoch was already committed.
    AlreadyComplete { manifest_created: bool },
    /// Migration ran (fresh or resumed) to completion this launch.
    Migrated {
        outcome: MigrationOutcome,
        manifest_created: bool,
    },
    /// A typed migration reconciliation signal — migration did not proceed
    /// and no manifest was touched.
    Refused(MigrateError),
    /// An operational failure (IO, parse) — not a reconciliation state.
    Failed(String),
}

/// Arm the migrator against an open writer. Never panics; every outcome is
/// a typed state the caller can surface.
pub fn arm(writer: &mut LedgerWriter, vault: &Path) -> Arming {
    let dir = ledger_dir(vault);
    let read = match read_ledger(&dir) {
        Ok(read) => read,
        Err(fault) => return Arming::Failed(fault.to_string()),
    };
    let store = writer.store_id().to_string();
    let completed = read.frames.iter().any(|frame| {
        frame.kind == schema::KIND_MIGRATION_COMPLETED
            && frame.body.get("store_uuid").and_then(|v| v.as_str()) == Some(store.as_str())
            && frame.body.get("migration_schema").and_then(|v| v.as_u64())
                == Some(schema::migration::MIGRATION_SCHEMA)
    });

    let (read, migrated) = if completed {
        (read, None)
    } else {
        let outcome = match migrate_vault(writer, &vault.join("knowledge")) {
            Ok(outcome) => outcome,
            Err(
                e @ (MigrateError::SourceChanged { .. } | MigrateError::IdempotencyConflict { .. }),
            ) => return Arming::Refused(e),
            Err(MigrateError::Failed(detail)) => return Arming::Failed(detail),
        };
        // Re-read: the manifest must describe the chain migration just
        // extended.
        match read_ledger(&dir) {
            Ok(read) => (read, Some(outcome)),
            Err(fault) => return Arming::Failed(fault.to_string()),
        }
    };

    // The initial manifest: create-only, and only when files agree. An
    // existing manifest belongs to the M23.2+ write protocol, not here.
    let manifest_created = match manifest::load(vault) {
        Ok(Some(_)) => false,
        Ok(None) => {
            let state = reduce(&read.frames, &store);
            match manifest::build_initial(vault, &store, &state) {
                Ok(Some(built)) => match manifest::save(vault, &built) {
                    Ok(()) => true,
                    Err(detail) => return Arming::Failed(detail),
                },
                Ok(None) => false, // files/reducer disagree — the scan owns it
                Err(detail) => return Arming::Failed(detail),
            }
        }
        Err(detail) => return Arming::Failed(detail),
    };

    match migrated {
        Some(outcome) => Arming::Migrated {
            outcome,
            manifest_created,
        },
        None => Arming::AlreadyComplete { manifest_created },
    }
}

#[cfg(test)]
mod tests {
    use super::super::migrate::tests::{corpus_copy, WRITER};
    use super::super::LedgerHead;
    use super::*;
    use crate::vault::testutil;

    /// Snapshot every knowledge file's (path, mtime, bytes) — the distiller
    /// trap: arming must move NOTHING the scanner can see.
    fn fingerprint(vault: &Path) -> Vec<(String, std::time::SystemTime, Vec<u8>)> {
        let dir = vault.join("knowledge");
        let mut out = Vec::new();
        if !dir.exists() {
            return out;
        }
        for entry in walkdir::WalkDir::new(&dir).sort_by_file_name() {
            let entry = entry.unwrap();
            if !entry.file_type().is_file() {
                continue;
            }
            out.push((
                entry.path().display().to_string(),
                entry.metadata().unwrap().modified().unwrap(),
                std::fs::read(entry.path()).unwrap(),
            ));
        }
        out
    }

    #[test]
    fn arming_migrates_builds_the_manifest_and_touches_no_file() {
        let vault = corpus_copy("arm-corpus");
        let before = fingerprint(&vault);
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();

        let first = arm(&mut writer, &vault);
        let Arming::Migrated {
            outcome,
            manifest_created,
        } = &first
        else {
            panic!("first arm migrates, got {first:?}");
        };
        assert!(manifest_created);
        assert_eq!(outcome.replayed, 0);
        assert_eq!(fingerprint(&vault), before, "no file was touched");

        // The manifest describes exactly the corpus, complete entries only.
        let manifest = manifest::load(&vault).unwrap().unwrap();
        assert_eq!(manifest.entries.len(), 10, "the whole golden corpus");
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);
        for (path, entry) in &manifest.entries {
            assert!(path.starts_with("knowledge/"), "{path}");
            let bytes = std::fs::read(vault.join(path)).unwrap();
            assert_eq!(entry.content_hash, crate::ledger::sha256_hex(&bytes));
            assert_eq!(entry.projected_revision, 1);
            assert_eq!(entry.write_state, manifest::WriteState::Complete);
            assert_eq!(entry.previous_content_hash, None);
            let projection =
                super::super::reduce::project_belief(&state, &entry.belief_id).unwrap();
            assert_eq!(
                entry.belief_revision_event,
                projection.belief_revision_event
            );
            assert_eq!(entry.generating_event, projection.generating_event);
            assert_eq!(
                entry.projection_state_digest,
                projection.projection_state_digest
            );
        }

        // The second arm is the fast no-op: zero appends, manifest kept.
        let records = read.records;
        let again = arm(&mut writer, &vault);
        assert_eq!(
            again,
            Arming::AlreadyComplete {
                manifest_created: false
            }
        );
        drop(writer);
        assert_eq!(read_ledger(&ledger_dir(&vault)).unwrap().records, records);
        assert_eq!(fingerprint(&vault), before);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_vault_without_knowledge_closes_an_empty_epoch_once() {
        let vault = testutil::temp_vault("arm-empty");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let first = arm(&mut writer, &vault);
        let Arming::Migrated {
            outcome,
            manifest_created,
        } = &first
        else {
            panic!("{first:?}");
        };
        assert!(outcome.output_keys.is_empty(), "nothing to migrate");
        assert!(manifest_created);
        let manifest = manifest::load(&vault).unwrap().unwrap();
        assert!(manifest.entries.is_empty());
        assert_eq!(
            arm(&mut writer, &vault),
            Arming::AlreadyComplete {
                manifest_created: false
            }
        );
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, 2, "the two brackets, once");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_changed_corpus_under_an_open_epoch_refuses_with_the_typed_signal() {
        let vault = corpus_copy("arm-source-changed");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        // Open the epoch by hand over a DIFFERENT corpus digest — the state
        // a crash leaves when files changed before the resume.
        let started = schema::MigrationStarted {
            schema: schema::BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: schema::Actor {
                id: schema::ACTOR_MIGRATOR.to_string(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            store_uuid: store.clone(),
            migration_schema: schema::migration::MIGRATION_SCHEMA,
            source_digest: crate::ledger::sha256_hex(b"a corpus that no longer exists"),
            planned_output_count: 1,
        };
        writer
            .append_once(
                &format!("migrate-v1:{store}:started"),
                schema::KIND_MIGRATION_STARTED,
                serde_json::to_value(&started).unwrap(),
            )
            .unwrap();

        let refused = arm(&mut writer, &vault);
        let Arming::Refused(err) = &refused else {
            panic!("typed refusal, got {refused:?}");
        };
        assert_eq!(err.signal(), Some("migration_source_changed"));
        assert_eq!(manifest::load(&vault).unwrap(), None, "no manifest");
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, 1, "the hand-opened epoch and nothing else");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn completion_without_a_manifest_builds_only_when_bytes_agree() {
        let vault = corpus_copy("arm-late-manifest");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        assert!(matches!(
            arm(&mut writer, &vault),
            Arming::Migrated {
                manifest_created: true,
                ..
            }
        ));

        // The killed-before-manifest shape: completed exists, manifest gone.
        std::fs::remove_file(manifest::manifest_path(&vault)).unwrap();
        let target = vault.join("knowledge/systems/status-model.md");
        let original = std::fs::read_to_string(&target).unwrap();
        std::fs::write(&target, format!("{original}\nEdited offline.\n")).unwrap();
        assert_eq!(
            arm(&mut writer, &vault),
            Arming::AlreadyComplete {
                manifest_created: false
            },
            "disagreeing bytes must not be blessed into a manifest"
        );
        assert_eq!(manifest::load(&vault).unwrap(), None);

        // Restore the original bytes: now the manifest may exist.
        std::fs::write(&target, original).unwrap();
        assert_eq!(
            arm(&mut writer, &vault),
            Arming::AlreadyComplete {
                manifest_created: true
            }
        );
        assert!(manifest::load(&vault).unwrap().is_some());
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// Child: open the writer and arm. The parent kills at the
    /// migrate-completed boundary — after the epoch closer fsynced, before
    /// any manifest work.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the crash tests"]
    fn crash_scenario_arm_vault() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let vault = std::path::PathBuf::from(vault);
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let _ = arm(&mut writer, &vault);
    }

    #[test]
    fn killed_after_the_completed_marker_the_reopen_builds_the_manifest() {
        let vault = corpus_copy("arm-kill-completed");
        let status = testutil::run_crash_scenario(
            "ledger::arm::tests::crash_scenario_arm_vault",
            "migrate-completed",
            &vault,
        );
        assert!(!status.success(), "the child dies at the boundary");
        // Completed is durable; the manifest never got built.
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert!(read
            .frames
            .iter()
            .any(|f| f.kind == schema::KIND_MIGRATION_COMPLETED));
        assert_eq!(manifest::load(&vault).unwrap(), None);
        let head_before = LedgerHead {
            seq: read.head_seq,
            hash: read.head_hash.clone(),
        };

        // Reopen: fast completed path, missing outputs are zero, and the
        // manifest is built from files that agree.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        assert_eq!(
            arm(&mut writer, &vault),
            Arming::AlreadyComplete {
                manifest_created: true
            }
        );
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(
            LedgerHead {
                seq: read.head_seq,
                hash: read.head_hash.clone()
            },
            head_before,
            "the reopen appended nothing"
        );
        assert_eq!(manifest::load(&vault).unwrap().unwrap().entries.len(), 10);
        let _ = std::fs::remove_dir_all(&vault);
    }
}
