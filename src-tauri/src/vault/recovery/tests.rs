#![cfg(test)]

use super::*;
use crate::vault::{receipt::WriteReceipt, testutil, write};

fn fixture() -> (PathBuf, PathBuf, Journal) {
    let vault = testutil::temp_vault("recovery-vault");
    let root = testutil::temp_vault("recovery-journal");
    let journal = Journal::open(&root).unwrap();
    (vault, root, journal)
}
#[test]
fn explicit_opt_in_is_persisted_without_enabling_another_vault() {
    let (vault, root, journal) = fixture();
    let other = testutil::temp_vault("recovery-other");
    assert!(!journal.enabled(&vault).unwrap());
    journal.set_enabled(&vault, true).unwrap();
    drop(journal);
    let reopened = Journal::open(&root).unwrap();
    assert!(reopened.enabled(&vault).unwrap());
    assert!(!reopened.enabled(&other).unwrap());
}
#[test]
fn protected_human_save_captures_exact_displaced_bytes() {
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(
        &vault,
        "page.md",
        "\u{feff}---\r\ntitle: Outside\r\n---\r\n\r\noutside \u{1f30d}\r\n",
    );
    let by = WriteReceipt::ipc(crate::knowledge::guard_human_write("page.md").unwrap());
    write::save_note_with_recovery(&vault, "page.md", "new body", None, &journal, None, &by)
        .unwrap();
    assert_eq!(
        journal.list(&vault, "page.md").unwrap().len(),
        1,
        "a successful protected human save must retain its exact preimage"
    );
}
#[test]
fn failed_startup_is_unavailable_not_disabled() {
    let root = testutil::temp_vault("recovery-bad-root");
    let file = root.join("not-a-directory");
    std::fs::write(&file, b"occupied").unwrap();
    assert!(Journal::open(&file).is_err());
}
#[test]
fn corrupt_policy_storage_is_not_explicitly_off() {
    let (vault, root, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    std::fs::write(root.join("recovery.sqlite"), b"corrupt SQLite").unwrap();
    drop(journal);
    assert!(Journal::open(&root)
        .and_then(|j| j.enabled(&vault))
        .is_err());
}

// Additional behavioral fixtures staged while shared native RED compilation runs.
fn human() -> WriteReceipt<crate::vault::receipt::Human> {
    WriteReceipt::ipc(crate::knowledge::guard_human_write("page.md").unwrap())
}
fn save(j: &Journal, v: &Path, body: &str) -> Result<RecoveryWrite, write::NoteWriteError> {
    write::save_note_with_recovery(v, "page.md", body, None, j, None, &human())
}
#[test]
fn off_saves_write_without_retaining_any_bytes() {
    let (vault, _, journal) = fixture();
    testutil::write(&vault, "page.md", "before");
    let saved = save(&journal, &vault, "after").unwrap();
    assert_eq!(saved.recovery, Outcome::Off);
    assert_eq!(
        std::fs::read_to_string(vault.join("page.md")).unwrap(),
        "after"
    );
    assert!(journal.list(&vault, "page.md").unwrap().is_empty());
}
#[test]
fn protected_mail_digest_and_symlink_alias_are_never_copied() {
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "sources/mail/thread.md", "SECRET DIGEST");
    for path in ["sources/mail/thread.md", "alias.md"] {
        if path == "alias.md" {
            #[cfg(unix)]
            std::os::unix::fs::symlink(vault.join("sources/mail/thread.md"), vault.join(path))
                .unwrap();
        }
        let saved =
            write::save_note_with_recovery(&vault, path, "updated", None, &journal, None, &human())
                .unwrap();
        assert!(
            matches!(saved.recovery, Outcome::NotRetained { ref reason } if reason == "privacy")
        );
        assert!(journal.list(&vault, path).unwrap().is_empty());
    }
    let conn = journal.connect().unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM copies", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn unavailable_capture_blocks_and_bypass_is_bound_to_exact_draft_and_current_bytes() {
    let (vault, root, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "before");
    std::fs::remove_file(root.join("recovery.sqlite")).unwrap();
    std::fs::create_dir(root.join("recovery.sqlite")).unwrap();
    let error = String::from(save(&journal, &vault, "after").unwrap_err());
    let nonce = error.strip_prefix("recovery_required:").unwrap();
    assert_eq!(
        std::fs::read_to_string(vault.join("page.md")).unwrap(),
        "before"
    );
    assert!(journal.failure(&vault, "page.md", nonce).is_ok());
    let error = write::save_note_with_recovery(
        &vault,
        "page.md",
        "different",
        None,
        &journal,
        Some(nonce),
        &human(),
    )
    .unwrap_err();
    assert!(String::from(error).contains("recovery_bypass_invalid"));
    let fresh = String::from(save(&journal, &vault, "after").unwrap_err());
    let nonce = fresh.strip_prefix("recovery_required:").unwrap();
    let saved = write::save_note_with_recovery(
        &vault,
        "page.md",
        "after",
        None,
        &journal,
        Some(nonce),
        &human(),
    )
    .unwrap();
    assert_eq!(saved.recovery, Outcome::WithoutCopy);
    assert!(write::save_note_with_recovery(
        &vault,
        "page.md",
        "after",
        None,
        &journal,
        Some(nonce),
        &human()
    )
    .is_err());
}
#[test]
fn restore_is_exact_guarded_and_conflict_checked() {
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    let before = "---\r\ntitle: outside\r\n---\r\n\r\nold \u{1f30d}\r\n";
    testutil::write(&vault, "page.md", before);
    let saved = save(&journal, &vault, "after").unwrap();
    let version = journal.list(&vault, "page.md").unwrap().remove(0);
    assert_eq!(
        journal.read(&vault, "page.md", &version.id).unwrap(),
        before.as_bytes()
    );
    testutil::write(&vault, "page.md", "outside changed again");
    assert!(matches!(
        write::restore_recovery(
            &vault,
            "page.md",
            &version.id,
            &saved.hash,
            &journal,
            None,
            &human()
        ),
        Err(write::NoteWriteError::Stale(_))
    ));
    let actual = crate::ledger::sha256_hex(b"outside changed again");
    let restored = write::restore_recovery(
        &vault,
        "page.md",
        &version.id,
        &actual,
        &journal,
        None,
        &human(),
    )
    .unwrap();
    assert_eq!(restored.hash, crate::ledger::sha256_hex(before.as_bytes()));
    assert_eq!(
        std::fs::read(vault.join("page.md")).unwrap(),
        before.as_bytes()
    );
    assert_eq!(journal.list(&vault, "page.md").unwrap().len(), 2);
    assert!(write::restore_recovery(
        &vault,
        "knowledge/guarded.md",
        &version.id,
        &actual,
        &journal,
        None,
        &human()
    )
    .is_err());
    assert!(journal.read(&vault, "other.md", &version.id).is_err());
    assert!(journal
        .read(&vault, "page.md", "../recovery.sqlite")
        .is_err());
}
#[test]
fn expiry_delete_clear_and_export_are_bounded_to_recorded_ids() {
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "one");
    save(&journal, &vault, "two").unwrap();
    save(&journal, &vault, "three").unwrap();
    let versions = journal.list(&vault, "page.md").unwrap();
    assert!(journal.delete(&vault, "page.md", &versions[0].id).unwrap());
    assert!(journal.read(&vault, "page.md", &versions[0].id).is_err());
    journal
        .connect()
        .unwrap()
        .execute("UPDATE copies SET captured_at=0", [])
        .unwrap();
    assert!(journal.list(&vault, "page.md").unwrap().is_empty());
    save(&journal, &vault, "four").unwrap();
    assert_eq!(journal.clear(&vault).unwrap(), 1);
    assert!(journal.list(&vault, "page.md").unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(vault.join("page.md")).unwrap(),
        "four"
    );
}
#[test]
fn entry_limit_excludes_without_retaining_a_partial_copy() {
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", &"a".repeat(10 * 1024 * 1024 + 1));
    let saved = save(&journal, &vault, "small").unwrap();
    assert!(matches!(saved.recovery, Outcome::NotRetained { ref reason } if reason=="entry_limit"));
    assert!(journal.list(&vault, "page.md").unwrap().is_empty());
}
#[test]
fn pending_intents_reconcile_only_when_observed_target_hash_proves_state() {
    for (observed, expected) in [
        ("before", None),
        ("after", Some("committed")),
        ("third state", Some("ambiguous")),
    ] {
        let (vault, _, journal) = fixture();
        journal.set_enabled(&vault, true).unwrap();
        testutil::write(&vault, "page.md", "before");
        {
            let lock = write::lock_paths(&vault, &["page.md"]).unwrap();
            journal
                .prepare(&lock, &vault, "page.md", "before", "after", None)
                .unwrap();
        }
        testutil::write(&vault, "page.md", observed);
        journal.sweep(&vault).unwrap();
        let versions = journal.list(&vault, "page.md").unwrap();
        if let Some(state) = expected {
            assert_eq!(versions.len(), 1);
            assert_eq!(versions[0].state, state);
            assert_eq!(versions[0].attribution, "outside, unattributed");
        } else {
            assert!(versions.is_empty());
        }
    }
}
#[test]
fn shared_global_quota_counts_two_vaults_and_reports_oldest_eviction() {
    let (vault, _, journal) = fixture();
    let other = testutil::temp_vault("recovery-quota-other");
    journal.set_enabled(&vault, true).unwrap();
    journal.set_enabled(&other, true).unwrap();
    let before = "a".repeat(10 * 1024 * 1024);
    testutil::write(&vault, "page.md", &before);
    testutil::write(&other, "page.md", &before);
    for index in 0..11 {
        let target = if index % 2 == 0 { &vault } else { &other };
        let mut next = before.clone();
        next.replace_range(0..2, &format!("{index:02}"));
        let saved = save(&journal, target, &next).unwrap();
        if index == 10 {
            assert!(matches!(
                saved.recovery,
                Outcome::Retained { evicted: 1, .. }
            ));
        }
    }
    let status = journal.status(&vault).unwrap();
    assert_eq!(status.retained_bytes, 100 * 1024 * 1024);
    assert_eq!(status.entries, 10);
}
#[test]
fn a_protected_save_reads_preimage_after_waiting_for_existing_path_lock() {
    use std::sync::{mpsc, Arc};
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "first");
    let lock = write::lock_paths(&vault, &["page.md"]).unwrap();
    let j = Arc::new(journal);
    let (started, wait) = mpsc::channel();
    let child_vault = vault.clone();
    let child_j = j.clone();
    let child = std::thread::spawn(move || {
        started.send(()).unwrap();
        save(&child_j, &child_vault, "last").unwrap()
    });
    wait.recv().unwrap();
    write::write_file(&lock, &vault.join("page.md"), "intervening winner").unwrap();
    drop(lock);
    child.join().unwrap();
    let version = j.list(&vault, "page.md").unwrap().remove(0);
    assert_eq!(
        j.read(&vault, "page.md", &version.id).unwrap(),
        b"intervening winner"
    );
}
#[test]
#[ignore = "child process fixture; requires disposable vault and journal environment"]
fn interrupted_save_child() {
    let vault = PathBuf::from(std::env::var("CEREBRO_RECOVERY_VAULT").unwrap());
    let root = PathBuf::from(std::env::var("CEREBRO_RECOVERY_JOURNAL").unwrap());
    let journal = Journal::open(&root).unwrap();
    save(&journal, &vault, "after").unwrap();
}
#[test]
fn actual_write_stop_points_leave_reconcilable_intents() {
    for (point, target, count) in [
        ("recovery-prepared", "before", 0),
        ("recovery-written", "after", 1),
    ] {
        let (vault, root, journal) = fixture();
        journal.set_enabled(&vault, true).unwrap();
        testutil::write(&vault, "page.md", "before");
        drop(journal);
        let out = testutil::run_test_child(
            "vault::recovery::tests::interrupted_save_child",
            &[
                ("CEREBRO_RECOVERY_VAULT", vault.as_os_str()),
                ("CEREBRO_RECOVERY_JOURNAL", root.as_os_str()),
                ("CEREBRO_STOP_POINT", std::ffi::OsStr::new(point)),
            ],
        );
        assert_eq!(out.status.code(), Some(86));
        assert_eq!(
            std::fs::read_to_string(vault.join("page.md")).unwrap(),
            target
        );
        let reopened = Journal::open(&root).unwrap();
        reopened.sweep(&vault).unwrap();
        let versions = reopened.list(&vault, "page.md").unwrap();
        assert_eq!(versions.len(), count);
        if count == 1 {
            assert_eq!(versions[0].state, "committed");
        }
    }
}
#[test]
fn missing_initialized_database_never_reopens_as_disabled() {
    let (vault, root, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    std::fs::remove_file(root.join("recovery.sqlite")).unwrap();
    drop(journal);
    assert!(Journal::open(&root).is_err());
}
#[test]
fn diagram_and_source_saves_use_the_same_exact_capture_door() {
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    let diagram = "---\r\ntheme: dark\r\n---\r\ngraph TD\r\n  A-->B\r\n";
    testutil::write(&vault, "map.mmd", diagram);
    write::save_note_with_recovery(
        &vault,
        "map.mmd",
        "graph TD\n B-->C",
        None,
        &journal,
        None,
        &human(),
    )
    .unwrap();
    let v = journal.list(&vault, "map.mmd").unwrap().remove(0);
    assert_eq!(
        journal.read(&vault, "map.mmd", &v.id).unwrap(),
        diagram.as_bytes()
    );
    let source = "\u{feff}---\r\ntitle: Outside\r\n---\r\n\r\nold 🌍\r\n";
    testutil::write(&vault, "page.md", source);
    write::save_source_body_with_recovery(
        &vault,
        "page.md",
        "\r\nnew 🌍\r\n",
        &journal,
        None,
        &human(),
    )
    .unwrap();
    let v = journal.list(&vault, "page.md").unwrap().remove(0);
    assert_eq!(
        journal.read(&vault, "page.md", &v.id).unwrap(),
        source.as_bytes()
    );
}
#[test]
fn entry_count_is_bounded_even_when_preimages_are_empty() {
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "");
    let key = {
        let lock = write::lock_paths(&vault, &["page.md"]).unwrap();
        lock.recovery_key(&vault.join("page.md"))
            .unwrap()
            .to_owned()
    };
    let mut conn = journal.connect().unwrap();
    let tx = conn.transaction().unwrap();
    for n in 0..limits().max_entries {
        tx.execute("INSERT INTO copies(id,vault,path,lock_key,before_hash,after_hash,captured_at,state,bytes) VALUES(?1,?2,'page.md',?5,?3,?3,?4,'committed',X'')",params![format!("{n:032x}"),journal.vault(&vault).unwrap(),hash(b""),now(),key]).unwrap();
    }
    tx.commit().unwrap();
    let saved = save(&journal, &vault, "new").unwrap();
    assert!(matches!(
        saved.recovery,
        Outcome::Retained { evicted: 1, .. }
    ));
    assert_eq!(
        journal.status(&vault).unwrap().entries,
        limits().max_entries
    );
}
#[test]
fn failed_finalize_is_pending_and_restart_can_verify_the_saved_bytes() {
    let (vault, root, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "before");
    {
        let lock = write::lock_paths(&vault, &["page.md"]).unwrap();
        let prepared = journal
            .prepare(&lock, &vault, "page.md", "before", "after", None)
            .unwrap();
        write::write_file(&lock, &vault.join("page.md"), "after").unwrap();
        std::fs::rename(root.join("recovery.sqlite"), root.join("held.sqlite")).unwrap();
        assert!(matches!(journal.finish(prepared), Outcome::Pending { .. }));
        std::fs::rename(root.join("held.sqlite"), root.join("recovery.sqlite")).unwrap();
    }
    drop(journal);
    let reopened = Journal::open(&root).unwrap();
    let versions = reopened.list(&vault, "page.md").unwrap();
    assert_eq!(versions[0].state, "committed");
    assert_eq!(
        reopened.read(&vault, "page.md", &versions[0].id).unwrap(),
        b"before"
    );
}
#[test]
fn bypass_expires_and_outside_changes_invalidate_its_exact_version() {
    let (vault, root, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "before");
    std::fs::remove_file(root.join("recovery.sqlite")).unwrap();
    let error = String::from(save(&journal, &vault, "after").unwrap_err());
    let nonce = error.strip_prefix("recovery_required:").unwrap();
    testutil::write(&vault, "page.md", "outside");
    let result = write::save_note_with_recovery(
        &vault,
        "page.md",
        "after",
        None,
        &journal,
        Some(nonce),
        &human(),
    );
    assert_eq!(String::from(result.unwrap_err()), "recovery_bypass_invalid");
    let error = String::from(save(&journal, &vault, "after").unwrap_err());
    let nonce = error.strip_prefix("recovery_required:").unwrap();
    journal
        .failures
        .lock()
        .unwrap()
        .get_mut(nonce)
        .unwrap()
        .expires_at = 0;
    assert!(journal.failure(&vault, "page.md", nonce).is_err());
    assert!(write::save_note_with_recovery(
        &vault,
        "page.md",
        "after",
        None,
        &journal,
        Some(nonce),
        &human()
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(vault.join("page.md")).unwrap(),
        "outside"
    );
}
#[test]
fn a_missing_target_is_not_recreated_by_restore() {
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "before");
    let saved = save(&journal, &vault, "after").unwrap();
    let version = journal.list(&vault, "page.md").unwrap().remove(0);
    std::fs::remove_file(vault.join("page.md")).unwrap();
    assert!(write::restore_recovery(
        &vault,
        "page.md",
        &version.id,
        &saved.hash,
        &journal,
        None,
        &human()
    )
    .is_err());
    assert!(!vault.join("page.md").exists());
}

#[test]
fn expired_pending_in_an_inactive_vault_is_cleaned_globally() {
    let (inactive, _, journal) = fixture();
    let active = testutil::temp_vault("recovery-active");
    journal.set_enabled(&inactive, true).unwrap();
    testutil::write(&inactive, "page.md", "before");
    {
        let lock = write::lock_paths(&inactive, &["page.md"]).unwrap();
        journal
            .prepare(&lock, &inactive, "page.md", "before", "after", None)
            .unwrap();
    }
    journal
        .connect()
        .unwrap()
        .execute("UPDATE copies SET captured_at=0", [])
        .unwrap();
    journal.sweep(&active).unwrap();
    let count: i64 = journal
        .connect()
        .unwrap()
        .query_row("SELECT count(*) FROM copies", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        count, 0,
        "an inactive vault cannot retain expired pending bytes"
    );
}

#[test]
fn expired_pending_in_a_missing_vault_is_cleaned_globally() {
    let (missing, _, journal) = fixture();
    let active = testutil::temp_vault("recovery-active-missing");
    journal.set_enabled(&missing, true).unwrap();
    testutil::write(&missing, "page.md", "before");
    {
        let lock = write::lock_paths(&missing, &["page.md"]).unwrap();
        journal
            .prepare(&lock, &missing, "page.md", "before", "after", None)
            .unwrap();
    }
    journal
        .connect()
        .unwrap()
        .execute("UPDATE copies SET captured_at=0", [])
        .unwrap();
    std::fs::remove_dir_all(&missing).unwrap();
    journal.sweep(&active).unwrap();
    let count: i64 = journal
        .connect()
        .unwrap()
        .query_row("SELECT count(*) FROM copies", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "missing vaults cannot defeat expiry");
}

#[test]
fn pending_capacity_blocks_the_file_until_exact_explicit_bypass() {
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "before");
    let key = {
        let lock = write::lock_paths(&vault, &["page.md"]).unwrap();
        lock.recovery_key(&vault.join("page.md"))
            .unwrap()
            .to_owned()
    };
    let mut conn = journal.connect().unwrap();
    let tx = conn.transaction().unwrap();
    for n in 0..limits().max_entries {
        tx.execute("INSERT INTO copies(id,vault,path,lock_key,before_hash,after_hash,captured_at,state,bytes) VALUES(?1,?2,'page.md',?5,?3,?3,?4,'pending',X'')",params![format!("{n:032x}"),journal.vault(&vault).unwrap(),hash(b""),now(),key]).unwrap();
    }
    tx.commit().unwrap();
    let failure = save(&journal, &vault, "after");
    assert!(
        failure.is_err(),
        "pending capacity must never silently allow a protected replacement"
    );
    assert_eq!(std::fs::read(vault.join("page.md")).unwrap(), b"before");
    let error = String::from(failure.unwrap_err());
    let nonce = error.strip_prefix("recovery_required:").unwrap();
    let saved = write::save_note_with_recovery(
        &vault,
        "page.md",
        "after",
        None,
        &journal,
        Some(nonce),
        &human(),
    )
    .unwrap();
    assert_eq!(saved.recovery, Outcome::WithoutCopy);
    assert_eq!(
        journal
            .connect()
            .unwrap()
            .query_row("SELECT count(*) FROM copies", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        limits().max_entries
    );
}

#[test]
fn global_expiry_waits_for_the_original_capture_lock_even_after_vault_removal() {
    use std::sync::{mpsc, Arc};
    let (vault, _, journal) = fixture();
    let active = testutil::temp_vault("recovery-active-held");
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "before");
    let lock = write::lock_paths(&vault, &["page.md"]).unwrap();
    journal
        .prepare(&lock, &vault, "page.md", "before", "after", None)
        .unwrap();
    journal
        .connect()
        .unwrap()
        .execute("UPDATE copies SET captured_at=0", [])
        .unwrap();
    std::fs::remove_dir_all(&vault).unwrap();
    let journal = Arc::new(journal);
    let child_j = journal.clone();
    let (done, wait) = mpsc::channel();
    let child = std::thread::spawn(move || {
        done.send(child_j.sweep(&active)).unwrap();
    });
    assert!(
        wait.recv_timeout(std::time::Duration::from_millis(100))
            .is_err(),
        "expiry cannot remove bytes held by an active capture"
    );
    drop(lock);
    wait.recv_timeout(std::time::Duration::from_secs(5))
        .unwrap()
        .unwrap();
    child.join().unwrap();
    assert_eq!(
        journal
            .connect()
            .unwrap()
            .query_row("SELECT count(*) FROM copies", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn startup_never_confirms_an_after_hash_from_only_a_large_target_prefix() {
    let (vault, _, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "before");
    let intended = "a".repeat(limits().entry_bytes as usize + 1);
    {
        let lock = write::lock_paths(&vault, &["page.md"]).unwrap();
        journal
            .prepare(&lock, &vault, "page.md", "before", &intended, None)
            .unwrap();
    }
    testutil::write(&vault, "page.md", &(intended + "outside suffix"));
    let versions = journal.list(&vault, "page.md").unwrap();
    assert_eq!(
        versions[0].state, "ambiguous",
        "a bounded prefix is not the observed whole-file hash"
    );
}

#[test]
#[ignore = "child process fixture; requires disposable journal environment"]
fn second_process_open_child() {
    let root = PathBuf::from(std::env::var("CEREBRO_RECOVERY_JOURNAL").unwrap());
    assert!(
        Journal::open(&root).is_err(),
        "a second process must not reconcile the live owner's intent"
    );
}
#[test]
fn second_process_cannot_discard_a_live_pending_capture() {
    let (vault, root, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "before");
    let lock = write::lock_paths(&vault, &["page.md"]).unwrap();
    journal
        .prepare(&lock, &vault, "page.md", "before", "after", None)
        .unwrap();
    let child = testutil::run_test_child(
        "vault::recovery::tests::second_process_open_child",
        &[("CEREBRO_RECOVERY_JOURNAL", root.as_os_str())],
    );
    assert!(
        child.status.success(),
        "{}",
        String::from_utf8_lossy(&child.stdout)
    );
    let count: i64 = journal
        .connect()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM copies WHERE state='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "durable intent survives the competing startup");
    drop(lock);
    drop(journal);
    let reopened = Journal::open(&root).unwrap();
    assert!(
        reopened.list(&vault, "page.md").unwrap().is_empty(),
        "released ownership permits legitimate abandoned-intent reconciliation"
    );
}
#[test]
fn the_loaded_bytes_match_the_committed_digest() {
    assert_eq!(
        hash(include_bytes!("../../../../shared/policy/recovery.v1.json")),
        include_str!("../../../../shared/policy/recovery.v1.sha256").trim()
    );
}
#[test]
#[ignore = "deliberately regenerate after changing the shared recovery policy"]
fn write_recovery_digest() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/policy/recovery.v1.sha256");
    std::fs::write(
        path,
        format!(
            "{}\n",
            hash(include_bytes!("../../../../shared/policy/recovery.v1.json"))
        ),
    )
    .unwrap();
}

#[test]
fn interrupted_first_install_retries_after_storage_is_repaired() {
    let root = testutil::temp_vault("recovery-first-install-retry");
    let vault = testutil::temp_vault("recovery-first-install-vault");
    testutil::write(&vault, "page.md", "before");
    // The published and private installation names are both obstructed so
    // the failure occurs during schema commit in either implementation.
    for name in ["recovery.sqlite-journal", "recovery.install.sqlite-journal"] {
        std::fs::create_dir(root.join(name)).unwrap();
    }
    assert!(Journal::open(&root).is_err());
    assert!(!root.join(MARKER).exists());
    assert!(
        root.join(DATABASE).is_file() || root.join("recovery.install.sqlite").is_file(),
        "failure occurs after creating the SQLite file"
    );
    for name in ["recovery.sqlite-journal", "recovery.install.sqlite-journal"] {
        std::fs::remove_dir(root.join(name)).unwrap();
    }
    let journal = Journal::open(&root).expect(
        "Retry must recover an interrupted first installation after the storage cause is repaired",
    );
    assert!(!journal.enabled(&vault).unwrap());
    let saved = save(&journal, &vault, "after").unwrap();
    assert_eq!(saved.recovery, Outcome::Off);
    assert_eq!(std::fs::read(vault.join("page.md")).unwrap(), b"after");
}
#[test]
fn existing_schema_mismatch_is_never_reset_even_without_initialization_marker() {
    for remove_marker in [false, true] {
        let (vault, root, journal) = fixture();
        journal.set_enabled(&vault, true).unwrap();
        journal
            .connect()
            .unwrap()
            .pragma_update(None, "user_version", 999)
            .unwrap();
        drop(journal);
        if remove_marker {
            std::fs::remove_file(root.join(MARKER)).unwrap();
        }
        let before = std::fs::read(root.join(DATABASE)).unwrap();
        assert!(Journal::open(&root).is_err());
        assert_eq!(std::fs::read(root.join(DATABASE)).unwrap(), before);
    }
}

#[test]
fn first_install_process_exits_are_retryable_at_each_publication_boundary() {
    for point in [
        "recovery-install-created",
        "recovery-install-validated",
        "recovery-install-published",
    ] {
        let vault = testutil::temp_vault("recovery-install-stop-vault");
        let root = testutil::temp_vault("recovery-install-stop-journal");
        testutil::write(&vault, "page.md", "before");
        let out = testutil::run_test_child(
            "vault::recovery::tests::interrupted_save_child",
            &[
                ("CEREBRO_RECOVERY_VAULT", vault.as_os_str()),
                ("CEREBRO_RECOVERY_JOURNAL", root.as_os_str()),
                ("CEREBRO_STOP_POINT", std::ffi::OsStr::new(point)),
            ],
        );
        assert_eq!(
            out.status.code(),
            Some(86),
            "{point}: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(!root.join(MARKER).exists());
        assert_eq!(
            root.join(DATABASE).exists(),
            point == "recovery-install-published"
        );
        let journal = Journal::open(&root).unwrap_or_else(|error| panic!("{point}: {error}"));
        assert!(!journal.enabled(&vault).unwrap());
        assert!(root.join(MARKER).is_file());
        assert!(!root.join("recovery.install.sqlite").exists());
        assert_eq!(std::fs::read(vault.join("page.md")).unwrap(), b"before");
    }
}

#[test]
fn retention_unknown_missing_root_stays_pending_until_recorded_key_expiry() {
    let (vault, root, journal) = fixture();
    let active = testutil::temp_vault("recovery-unrelated-active");
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "before");
    let id = {
        let held = write::lock_paths(&vault, &["page.md"]).unwrap();
        match journal
            .prepare(&held, &vault, "page.md", "before", "after", None)
            .unwrap()
            .outcome
        {
            Outcome::Retained { id, .. } => id,
            _ => panic!("real capture did not retain a pending copy"),
        }
    };
    drop(journal);
    fs::remove_dir_all(&vault).unwrap();
    let journal = Journal::open(&root).unwrap();
    let observed = || {
        journal
            .connect()
            .unwrap()
            .query_row("SELECT state,bytes FROM copies WHERE id=?1", [&id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .unwrap()
    };
    assert_eq!(observed(), ("pending".into(), b"before".to_vec()));
    journal.status(&active).unwrap();
    assert_eq!(observed(), ("pending".into(), b"before".to_vec()));
    journal
        .connect()
        .unwrap()
        .execute("UPDATE copies SET captured_at=0 WHERE id=?1", [&id])
        .unwrap();
    journal.sweep_all().unwrap();
    assert_eq!(
        journal
            .connect()
            .unwrap()
            .query_row("SELECT count(*) FROM copies WHERE id=?1", [&id], |r| r
                .get::<_, i64>(0),)
            .unwrap(),
        0
    );
    assert!(
        !vault.exists(),
        "cleanup must not recreate the unavailable root"
    );
    drop(journal);
    fs::remove_dir_all(&active).unwrap();
    fs::remove_dir_all(&root).unwrap();
}

#[path = "selected_join_tests.rs"]
mod selected_join;
