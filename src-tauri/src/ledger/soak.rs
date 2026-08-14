//! The M22.7 migration acceptance soak — everything the milestone promises,
//! automated against a TEMP COPY of demo-vault (the repository corpus is
//! never migrated in place).
//!
//! The batch kill matrix and acknowledgement-loss idempotency live with the
//! writer (`writer::tests::killed_*`); the distiller-queue-stays-cold check
//! lives with the engine that owns the queue
//! (`src/lib/epistemic/soak.test.ts`), fed by the mtime invariant proven
//! here.

use super::index::Index;
use super::migrate::migrate_vault;
use super::migrate::tests::{corpus_copy, WRITER};
use super::reduce::reduce;
use super::schema;
use super::writer::LedgerWriter;
use super::{ledger_dir, read_ledger};
use crate::vault::testutil;

/// Snapshot every knowledge file's (path, mtime, bytes).
fn corpus_fingerprint(dir: &std::path::Path) -> Vec<(String, std::time::SystemTime, Vec<u8>)> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(dir).sort_by_file_name() {
        let entry = entry.unwrap();
        if !entry.file_type().is_file() {
            continue;
        }
        let meta = entry.metadata().unwrap();
        out.push((
            entry.path().display().to_string(),
            meta.modified().unwrap(),
            std::fs::read(entry.path()).unwrap(),
        ));
    }
    out
}

#[test]
fn the_migration_soak_holds_end_to_end() {
    let vault = corpus_copy("soak-e2e");
    let knowledge = vault.join("knowledge");
    let config = testutil::temp_vault("soak-e2e-config");
    let before = corpus_fingerprint(&knowledge);

    let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
    let store = writer.store_id().to_string();
    let outcome = migrate_vault(&mut writer, &knowledge).unwrap();
    assert_eq!(outcome.replayed, 0);

    // Byte-identical re-projection AND untouched mtimes: migration reads
    // files and writes only events.
    assert_eq!(
        corpus_fingerprint(&knowledge),
        before,
        "no file was touched"
    );
    let read = read_ledger(&ledger_dir(&vault)).unwrap();
    let state = reduce(&read.frames, &store);
    assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
    for (path, _, bytes) in &before {
        if !path.ends_with(".md") {
            continue;
        }
        let rel = path
            .split_once("/knowledge/")
            .map(|(_, rel)| rel.to_string())
            .unwrap();
        let belief = state
            .beliefs
            .get(&schema::migrate_id(&store, "belief", &rel))
            .unwrap_or_else(|| panic!("{rel} migrated"));
        let projected =
            super::project::project(&belief.current().content, &belief.current().fields);
        assert_eq!(projected.as_bytes(), bytes.as_slice(), "{rel}");
    }

    // Verified chain (read_ledger already chain-verified) and a
    // byte-identical index rebuild, epistemic tables included.
    let mut index = Index::open(&config, &read.store.store_id).unwrap();
    index.replay(&read, WRITER).unwrap();
    let index = index.rebuild(&read, WRITER).unwrap();
    let path = index.path().to_path_buf();
    let dump = index.dump_epistemic().unwrap();
    assert!(dump.contains("== beliefs"));
    drop(index);
    let first = std::fs::read(&path).unwrap();
    let index = Index::open(&config, &read.store.store_id).unwrap();
    let index = index.rebuild(&read, WRITER).unwrap();
    drop(index);
    assert_eq!(
        first,
        std::fs::read(&path).unwrap(),
        "rebuild-from-zero determinism"
    );

    // Completed-marker fast no-op: the rerun replays everything, appends
    // nothing, and the record count is frozen.
    let records = read.records;
    let rerun = migrate_vault(&mut writer, &knowledge).unwrap();
    assert_eq!(rerun.replayed, rerun.output_keys.len());
    drop(writer);
    assert_eq!(read_ledger(&ledger_dir(&vault)).unwrap().records, records);

    let _ = std::fs::remove_dir_all(&vault);
    let _ = std::fs::remove_dir_all(&config);
}

/// Child: arm the migrator (the M23.0 production path) against
/// CEREBRO_CRASH_VAULT; the parent walks the kill point one output
/// boundary per iteration.
#[test]
#[ignore = "crash-scenario child body, spawned by the soak kill matrix"]
fn crash_scenario_migrate_vault() {
    let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
        return;
    };
    let vault = std::path::PathBuf::from(vault);
    let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
    let _ = super::arm::arm(&mut writer, &vault);
}

#[test]
fn kill_and_restart_after_every_output_never_duplicates() {
    let vault = corpus_copy("soak-kill");
    let knowledge = vault.join("knowledge");

    // Walk the kill point forward one output per iteration: each child
    // replays the committed prefix, appends exactly one more output, and
    // dies post-commit. When the point is past the last output the child
    // completes the whole migration and exits cleanly.
    let mut boundary = 1usize;
    loop {
        let status = testutil::run_crash_scenario(
            "ledger::soak::crash_scenario_migrate_vault",
            &format!("migrate-output-{boundary}"),
            &vault,
        );
        // The committed prefix stays readable and chain-valid either way.
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert!(
            read.records >= boundary as u64,
            "prefix committed through {boundary}"
        );
        if status.success() {
            break;
        }
        boundary += 1;
        assert!(boundary < 200, "runaway kill matrix");
    }

    // The full run converged: the armed child also built the initial
    // manifest over agreeing bytes.
    assert!(
        super::manifest::load(&vault).unwrap().is_some(),
        "the completing run created the projection manifest"
    );
    // Rerun in-process, prove zero duplicates.
    let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
    let store = writer.store_id().to_string();
    let outcome = migrate_vault(&mut writer, &knowledge).unwrap();
    assert_eq!(
        outcome.replayed,
        outcome.output_keys.len(),
        "everything replays"
    );
    drop(writer);

    let read = read_ledger(&ledger_dir(&vault)).unwrap();
    assert_eq!(
        read.records,
        outcome.output_keys.len() as u64 + 2,
        "outputs + brackets, no duplicate from any kill"
    );
    // Every idempotency key appears exactly once across all frames.
    let mut seen = std::collections::BTreeSet::new();
    for frame in &read.frames {
        if let Some(key) = frame.body.get("idempotency_key").and_then(|v| v.as_str()) {
            assert!(seen.insert(key.to_string()), "duplicate key {key}");
        }
    }
    assert_eq!(seen.len(), outcome.output_keys.len() + 2);
    // And the reduced state is clean.
    let state = reduce(&read.frames, &store);
    assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
    assert_eq!(state.beliefs.len(), 10);
    let _ = std::fs::remove_dir_all(&vault);
}
