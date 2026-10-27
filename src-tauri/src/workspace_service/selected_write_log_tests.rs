#![cfg(test)]
//! BL-24 (CV-33): each selected writer records its receipt's stamp in
//! runtime.db's `vault_writes` after its commit, as the legacy doors do, and
//! a row only ever says what landed: the visible body's bytes, by the person
//! whose receipt the write carried. The readers stay refused for selected
//! workspaces; read anyway, the row names exactly what is on disk.
use super::*;

fn by() -> crate::vault::receipt::WriteReceipt<crate::vault::receipt::Human> {
    crate::vault::receipt::WriteReceipt::ipc(
        crate::knowledge::guard_human_write("page.md").unwrap(),
    )
}

#[test]
fn an_editor_save_records_the_person_and_the_bytes_it_landed() {
    let armed = Armed::new("editor-save");
    let f = fixture("write-log-editor");
    f.run(|| {
        let journal = journal(&f, true);
        applied(save(&f, &journal, AFTER, fresh()).unwrap());
        assert_eq!(
            written(&f.root),
            vec![person_wrote("page.md", AFTER.as_bytes())]
        );
        // An autosave burst by the same hand is one row whose hash moves on.
        let later = "# Later\n";
        applied(save(&f, &journal, later, fresh()).unwrap());
        assert_eq!(
            written(&f.root),
            vec![person_wrote("page.md", later.as_bytes())]
        );
        // An unchanged save lands nothing, so records nothing.
        assert!(matches!(
            save(&f, &journal, later, fresh()).unwrap(),
            crate::NoteSaveResult::Selected(EditorSaveResult::Unchanged { .. })
        ));
        assert_eq!(written(&f.root).len(), 1);
    });
    drop(armed);
}

#[test]
fn a_checklist_tick_or_title_edit_through_the_paired_writer_records_its_row() {
    let armed = Armed::new("checklist");
    let f = fixture("write-log-checklist");
    f.run(|| {
        let journal = journal(&f, true);
        let mut request = fresh();
        request.expected_version = Some(f.version());
        applied(save(&f, &journal, AFTER, request).unwrap());
        assert_eq!(
            written(&f.root),
            vec![person_wrote("page.md", AFTER.as_bytes())]
        );
        // A stale expectation is refused and records nothing.
        let mut stale = fresh();
        stale.expected_version = Some(SelectedRecordVersion {
            body_hash: crate::ledger::sha256_hex(b"elsewhere"),
            ..f.version()
        });
        assert!(save(&f, &journal, "# Refused\n", stale).is_err());
        assert_eq!(written(&f.root).len(), 1);
    });
    drop(armed);
}

#[test]
fn full_width_records_the_unchanged_body_it_checked() {
    let armed = Armed::new("full-width");
    let f = fixture("write-log-full-width");
    f.run(|| {
        let ack = selected::set_full_width(
            &f.root,
            "page.md",
            &f.version(),
            SelectedMode::Default,
            &by(),
        )
        .unwrap();
        assert!(matches!(ack, SelectedMetadataAck::Applied { .. }));
        assert_eq!(
            written(&f.root),
            vec![person_wrote("page.md", BEFORE.as_bytes())]
        );
        // Unchanged lands nothing.
        selected::set_full_width(
            &f.root,
            "page.md",
            &f.version(),
            SelectedMode::Default,
            &by(),
        )
        .unwrap();
        assert_eq!(written(&f.root).len(), 1);
    });
    drop(armed);
}

#[test]
fn the_explicit_cutover_writer_records_through_the_shared_paired_writer() {
    let armed = Armed::new("cutover");
    let f = fixture("write-log-cutover");
    f.run(|| {
        replace(&f, &f.version(), AFTER.as_bytes()).unwrap();
        assert_eq!(
            written(&f.root),
            vec![person_wrote("page.md", AFTER.as_bytes())]
        );
        // A stale version is refused before any write and records nothing.
        let stale = SelectedRecordVersion {
            metadata_hash: crate::ledger::sha256_hex(b"stale"),
            ..f.version()
        };
        assert!(replace(&f, &stale, BEFORE.as_bytes()).is_err());
        assert_eq!(written(&f.root).len(), 1);
    });
    drop(armed);
}

#[test]
fn recovery_records_a_completed_original_save_under_its_original_stamp_once() {
    let f = fixture("write-log-redo");
    // The original save published its intent and stopped before its commit.
    stopped_editor(&f, "selected-journal-durable");
    let armed = Armed::new("redo");
    f.run(|| {
        let journal = journal(&f, true);
        assert!(matches!(
            recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
            RecoveryReport::Completed { .. }
        ));
        assert_eq!(
            written(&f.root),
            vec![person_wrote("page.md", AFTER.as_bytes())]
        );
        assert_eq!(
            recovery::recover_workspace_with_retention(&f.root, &journal).unwrap(),
            RecoveryReport::Clean
        );
        assert_eq!(written(&f.root).len(), 1, "a clean reopen records nothing");
    });
    drop(armed);
}

#[test]
fn readers_stay_refused_for_selected_and_a_read_row_names_exactly_what_is_on_disk() {
    let armed = Armed::new("readers");
    let f = fixture("write-log-readers");
    f.run(|| {
        // The native admission table keeps every vault_writes reader closed
        // to a selected root, so no new row can surface through them.
        let table: Value =
            serde_json::from_str(include_str!("../../../shared/workspace/authority.v2.json"))
                .unwrap();
        for command in [
            "page_attribution",
            "vault_activity",
            "page_activity",
            "admit_wakes",
        ] {
            let row = table["nativeCommands"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["command"] == command)
                .unwrap();
            assert_eq!(
                row["selectedDisposition"], "unsupported_selected",
                "{command}"
            );
            let payload = tauri::ipc::InvokeBody::Json(json!({
                "vault": f.root.to_str().unwrap(),
                "path": "page.md",
            }));
            let request =
                crate::workspace_service::native_admission::request(command, &payload).unwrap();
            let context = authority::context().unwrap();
            let refused = crate::workspace_service::native_admission::dispatch_checked(
                &context,
                request,
                || (),
            )
            .unwrap_err();
            assert_eq!(
                refused.kind,
                AuthorityErrorKind::UnsupportedOperation,
                "{command}"
            );
        }
        let journal = journal(&f, true);
        applied(save(&f, &journal, AFTER, fresh()).unwrap());
        // Read anyway, the row's hash is the visible file's: the person's.
        let attribution = crate::page_attribution_in(&armed.config, &f.root, "page.md").unwrap();
        let crate::runtime::write_log::Attribution::Recorded(last) = attribution else {
            panic!("a recorded selected save reads as recorded: {attribution:?}");
        };
        assert_eq!(last.actor.as_deref(), Some("human:me"));
        assert_eq!(last.kind, "vault.write");
        // An outside edit afterwards reads as changed outside, never as the person's.
        fs::write(f.root.join("page.md"), "# Outside\n").unwrap();
        assert!(matches!(
            crate::page_attribution_in(&armed.config, &f.root, "page.md").unwrap(),
            crate::runtime::write_log::Attribution::Unattributed(_)
        ));
    });
    drop(armed);
}
