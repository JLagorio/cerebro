//! Human recovery controls. The journal is outside the vault; restoring still
//! goes through its ordinary guarded writer and current-version check.
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use tauri::Manager;

use crate::vault::recovery::{Failure, Journal, Status, Version};

#[derive(Default)]
pub(crate) struct RecoveryState {
    journal: Mutex<Option<Arc<Journal>>>,
}

impl RecoveryState {
    pub(crate) fn for_config(&self, config: &Path) -> Result<Arc<Journal>, String> {
        let mut cached = self
            .journal
            .lock()
            .map_err(|_| "recovery_unavailable: initialization lock failed".to_string())?;
        if let Some(journal) = cached.as_ref() {
            return Ok(Arc::clone(journal));
        }
        // Cache successes only. A repaired initial storage failure can retry;
        // an existing service must keep its one-use failure choice book.
        let journal = Arc::new(Journal::open(&config.join("recovery"))?);
        *cached = Some(Arc::clone(&journal));
        Ok(journal)
    }
    pub(crate) fn get(&self, app: &tauri::AppHandle) -> Result<Arc<Journal>, String> {
        let config =
            crate::config_dir(app).map_err(|error| format!("recovery_unavailable: {error}"))?;
        self.for_config(&config)
    }
}

/// One loop belongs to app setup, not a webview or an active vault. Cleanup
/// also runs when opening the service and on access. While the process is
/// stopped there is no daemon: expired copies are refused on the next read
/// and cleaned at startup or the next cleanup after resume. Storage failures remain visible to callers.
pub(crate) fn start_cleanup(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        if journal(&app)
            .and_then(|journal| journal.sweep_all())
            .is_err()
        {
            log::warn!("recovery journal cleanup unavailable");
        }
        std::thread::sleep(std::time::Duration::from_secs(60));
    });
}

/// Only a registered code reaches operational history. The original IPC
/// error still carries its one-use choice; neither that token nor storage
/// paths/content are copied into runtime history or diagnostic messages.
pub(crate) fn record_refusal(surface: &str, message: String) -> String {
    let code = message.split(':').next().unwrap_or_default();
    if code.starts_with("recovery_") {
        let typed = crate::policy::table::PolicyTable::load().and_then(|table| {
            crate::policy::rejection::OperationalRefusal::new(&table, code, surface, code)
        });
        match typed {
            Ok(typed) => {
                crate::runtime::sink::record(&typed, &crate::runtime::operational::LogEntry::bare())
            }
            Err(_) => log::warn!("recovery operational recorder could not type a refusal"),
        }
    }
    message
}

fn journal(app: &tauri::AppHandle) -> Result<Arc<Journal>, String> {
    app.state::<RecoveryState>().get(app)
}

fn with_journal<T>(
    app: &tauri::AppHandle,
    surface: &str,
    operation: impl FnOnce(&Journal) -> Result<T, String>,
) -> Result<T, String> {
    journal(app)
        .and_then(|journal| operation(&journal))
        .map_err(|message| record_refusal(surface, message))
}

#[tauri::command(async)]
pub(crate) fn recovery_status(app: tauri::AppHandle, vault: String) -> Result<Status, String> {
    with_journal(&app, "recovery_status", |journal| {
        journal.status(Path::new(&vault))
    })
}
#[tauri::command(async)]
pub(crate) fn set_recovery_enabled(
    app: tauri::AppHandle,
    vault: String,
    enabled: bool,
) -> Result<Status, String> {
    with_journal(&app, "set_recovery_enabled", |journal| {
        journal.set_enabled(Path::new(&vault), enabled)?;
        journal.status(Path::new(&vault))
    })
}
#[tauri::command(async)]
pub(crate) fn list_recovery(
    app: tauri::AppHandle,
    vault: String,
    path: String,
) -> Result<Vec<Version>, String> {
    with_journal(&app, "list_recovery", |journal| {
        journal.list(Path::new(&vault), &path)
    })
}
#[tauri::command(async)]
pub(crate) fn read_recovery(
    app: tauri::AppHandle,
    vault: String,
    path: String,
    recovery_id: String,
) -> Result<String, String> {
    with_journal(&app, "read_recovery", |journal| {
        String::from_utf8(journal.read(Path::new(&vault), &path, &recovery_id)?)
            .map_err(|_| "recovery_copy_invalid_utf8".into())
    })
}
#[tauri::command(async)]
pub(crate) fn delete_recovery(
    app: tauri::AppHandle,
    vault: String,
    path: String,
    recovery_id: String,
) -> Result<bool, String> {
    with_journal(&app, "delete_recovery", |journal| {
        journal.delete(Path::new(&vault), &path, &recovery_id)
    })
}
#[tauri::command(async)]
pub(crate) fn clear_recovery(app: tauri::AppHandle, vault: String) -> Result<usize, String> {
    with_journal(&app, "clear_recovery", |journal| {
        journal.clear(Path::new(&vault))
    })
}
#[tauri::command(async)]
pub(crate) fn recovery_failure(
    app: tauri::AppHandle,
    vault: String,
    path: String,
    nonce: String,
) -> Result<Failure, String> {
    with_journal(&app, "recovery_failure", |journal| {
        journal.failure(Path::new(&vault), &path, &nonce)
    })
}
#[tauri::command(async)]
pub(crate) fn restore_recovery(
    app: tauri::AppHandle,
    vault: String,
    path: String,
    recovery_id: String,
    expect_hash: String,
    recovery_bypass: Option<String>,
) -> Result<crate::NoteWriteAck, String> {
    with_journal(&app, "restore_recovery", |journal| {
        let by =
            crate::vault::receipt::WriteReceipt::ipc(crate::knowledge::guard_human_write(&path)?);
        crate::vault::write::restore_recovery(
            Path::new(&vault),
            &path,
            &recovery_id,
            &expect_hash,
            journal,
            recovery_bypass.as_deref(),
            &by,
        )
        .map(crate::NoteWriteAck::from)
        .map_err(crate::save_note_refusal)
    })
}
#[tauri::command(async)]
pub(crate) fn export_recovery(
    app: tauri::AppHandle,
    vault: String,
    path: String,
    recovery_id: String,
) -> Result<Option<String>, String> {
    with_journal(&app, "export_recovery", |journal| {
        let bytes = journal.read(Path::new(&vault), &path, &recovery_id)?;
        let name = Path::new(&path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        crate::shell::file_actions::save_recovery_copy(
            &app,
            &crate::config_dir(&app)?,
            Path::new(&vault),
            &name,
            &bytes,
        )
        .map_err(|error| error.message)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil::{temp_vault, write};

    #[test]
    fn successful_service_keeps_one_nonce_book_and_failed_initialization_can_retry() {
        let config = temp_vault("recovery-service-init");
        write(&config, "recovery", "temporary obstruction");
        let service = RecoveryState::default();
        assert!(service.for_config(&config).is_err());
        std::fs::remove_file(config.join("recovery")).unwrap();
        let first = service.for_config(&config).unwrap();
        let second = service.for_config(&config).unwrap();
        assert!(
            Arc::ptr_eq(&first, &second),
            "every command must share the same nonce book"
        );
        std::fs::remove_dir_all(config).unwrap();
    }
    #[test]
    fn recovery_consumer_captures_actual_rich_and_source_preimages() {
        let vault = temp_vault("recovery-consumer-vault");
        let config = temp_vault("recovery-consumer-config");
        let journal = RecoveryState::default().for_config(&config).unwrap();
        journal.set_enabled(&vault, true).unwrap();
        let before = "\u{feff}---\r\ntitle: Exact\r\n---\r\n# Before\r\n";
        write(&vault, "a.md", before);
        let ack = crate::save_note_with_journal(
            Ok(&journal),
            vault.to_string_lossy().into_owned(),
            "a.md".into(),
            "# After\r\n".into(),
            None,
            Some("source".into()),
            None,
        )
        .unwrap();
        let copies = journal.list(&vault, "a.md").unwrap();
        assert_eq!(
            copies.len(),
            1,
            "ordinary command must use the opted-in journal"
        );
        assert_eq!(
            journal.read(&vault, "a.md", &copies[0].id).unwrap(),
            before.as_bytes()
        );
        let after = std::fs::read(vault.join("a.md")).unwrap();
        assert_eq!(
            after,
            b"\xef\xbb\xbf---\r\ntitle: Exact\r\n---\r\n# After\r\n"
        );
        let ack = serde_json::to_value(ack).unwrap();
        assert_eq!(ack["recovery"]["kind"], "retained");
        assert_eq!(ack["contentHash"], crate::ledger::sha256_hex(&after));
        let ack = crate::save_note_with_journal(
            Ok(&journal),
            vault.to_string_lossy().into_owned(),
            "a.md".into(),
            "# Rich".into(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(ack).unwrap()["recovery"]["kind"],
            "retained"
        );
        assert!(journal
            .list(&vault, "a.md")
            .unwrap()
            .iter()
            .any(|copy| journal.read(&vault, "a.md", &copy.id).unwrap() == after));
        for dir in [vault, config] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn recovery_consumer_unavailable_service_never_becomes_off_or_writes() {
        let vault = temp_vault("recovery-consumer-unavailable");
        write(&vault, "a.md", "before");
        for format in [None, Some("source".to_string())] {
            let result = crate::save_note_with_journal(
                Err("recovery_unavailable: initialization failed".into()),
                vault.to_string_lossy().into_owned(),
                "a.md".into(),
                "after".into(),
                None,
                format,
                None,
            );
            assert!(
                result.is_err(),
                "unavailable protection must refuse the write"
            );
            assert_eq!(std::fs::read(vault.join("a.md")).unwrap(), b"before");
        }
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn recovery_consumer_default_is_off_and_deleted_target_stays_deleted() {
        let vault = temp_vault("recovery-consumer-default");
        let config = temp_vault("recovery-consumer-default-config");
        let journal = RecoveryState::default().for_config(&config).unwrap();
        write(&vault, "a.md", "before");
        assert!(!journal.enabled(&vault).unwrap());
        let ack = crate::save_note_with_journal(
            Ok(&journal),
            vault.to_string_lossy().into_owned(),
            "a.md".into(),
            "after".into(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(ack).unwrap()["recovery"]["kind"],
            "off"
        );
        assert!(journal.list(&vault, "a.md").unwrap().is_empty());
        std::fs::remove_file(vault.join("a.md")).unwrap();
        assert!(crate::save_note_with_journal(
            Ok(&journal),
            vault.to_string_lossy().into_owned(),
            "a.md".into(),
            "must not recreate".into(),
            None,
            None,
            None
        )
        .is_err());
        assert!(!vault.join("a.md").exists());
        for dir in [vault, config] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
    #[test]
    fn recovery_refusal_destinies_are_registered_operational_transport_failures() {
        let table = crate::policy::table::PolicyTable::load().unwrap();
        for code in [
            "recovery_required",
            "recovery_unavailable",
            "recovery_bypass_invalid",
            "recovery_privacy_excluded",
            "recovery_copy_unavailable",
            "recovery_copy_corrupt",
            "recovery_copy_invalid_utf8",
            "recovery_invalid_path",
            "recovery_pending",
        ] {
            assert_eq!(
                table.destiny(code),
                Some(crate::policy::table::Destiny::Operational),
                "{code}"
            );
            assert!(
                table.transport_rejections.iter().any(|item| item == code),
                "{code}"
            );
        }
    }

    #[test]
    fn recovery_failure_choice_and_storage_details_never_enter_operational_history() {
        let _lock = crate::runtime::sink::test_lock();
        let config = temp_vault("recovery-consumer-operational");
        crate::runtime::sink::arm(&config).unwrap();
        let nonce = "recovery_required:0123456789abcdef0123456789abcdef";
        assert_eq!(record_refusal("save_note", nonce.to_string()), nonce);
        let failure = "recovery_unavailable: /private/a-persons-content recovery.sqlite";
        assert_eq!(
            record_refusal("read_recovery", failure.to_string()),
            failure
        );
        let conn = crate::runtime::open(&config).unwrap();
        let rows: Vec<(String, String, String)> = conn
            .prepare("SELECT code,surface,detail FROM operational_log ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        crate::runtime::sink::disarm();
        assert_eq!(
            rows,
            vec![
                (
                    "recovery_required".into(),
                    "save_note".into(),
                    "recovery_required".into()
                ),
                (
                    "recovery_unavailable".into(),
                    "read_recovery".into(),
                    "recovery_unavailable".into()
                )
            ]
        );
        std::fs::remove_dir_all(config).unwrap();
    }
}
