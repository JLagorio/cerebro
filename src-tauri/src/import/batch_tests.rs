// Included inside vault::batch::tests to exercise the real journal and receipt.
fn import_request(path: &str, record_id: &str, body: &str) -> Value {
    json!({"op":"import", "system":"linear", "recordId":record_id,
        "path":path, "content":format!("---\ntype: Work item\n---\n{body}\n")})
}
const IMPORT_ID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

#[test]
fn two_batches_importing_one_new_id_make_one_page() {
    let _recording = Recording::new("parallel-import-config");
    let vault = testutil::temp_vault("parallel-import");
    let start = std::sync::Arc::new(std::sync::Barrier::new(3));
    let threads: Vec<_> = ["records/a.md", "records/b.md"]
        .into_iter()
        .map(|path| {
            let vault = vault.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                apply(
                    &vault,
                    json!([import_request(path, IMPORT_ID, "Same record")]),
                )
                .unwrap()
            })
        })
        .collect();
    start.wait();
    let mut outcomes: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap().imports.unwrap()[0].outcome)
        .collect();
    outcomes.sort();
    assert_eq!(outcomes, vec!["created", "unchanged"]);
    assert_eq!(tree(&vault).len(), 1);
    assert_eq!(rows(&vault).len(), 1);
    assert_eq!(rows(&vault)[0].2, HUMAN_ACTOR);
    assert_eq!(journal_rows(), 0);
    let _ = std::fs::remove_dir_all(vault);
}

#[test]
fn reverting_an_import_batch_puts_every_page_back() {
    let _recording = Recording::new("undo-import-config");
    let vault = testutil::temp_vault("undo-import");
    apply(
        &vault,
        json!([import_request("records/old.md", IMPORT_ID, "Old record")]),
    )
    .unwrap();
    let old = read(&vault, "records/old.md").unwrap();
    let applied = apply(
        &vault,
        json!([
            import_request("records/proposed.md", IMPORT_ID, "Updated record"),
            import_request(
                "records/new.md",
                "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
                "New record"
            )
        ]),
    )
    .unwrap();
    assert_eq!(applied.files.len(), 2);
    assert_eq!(applied.imports.as_ref().unwrap()[0].path, "records/old.md");
    let undone = apply(&vault, revert_ops(&applied)).unwrap();
    assert_eq!(read(&vault, "records/old.md"), Some(old));
    assert!(read(&vault, "records/new.md").is_none());
    assert_eq!(undone.files.len(), 2);
    apply(&vault, revert_ops(&undone)).unwrap();
    assert!(read(&vault, "records/old.md")
        .unwrap()
        .contains("Updated record"));
    assert!(read(&vault, "records/new.md")
        .unwrap()
        .contains("New record"));
    assert_eq!(journal_rows(), 0);
    let _ = std::fs::remove_dir_all(vault);
}

#[test]
fn a_replace_whose_page_changed_after_planning_refuses_as_stale_content() {
    for move_away in [false, true] {
        let _recording = Recording::new("stale-import-config");
        let vault = testutil::temp_vault("stale-import");
        apply(
            &vault,
            json!([import_request("records/a.md", IMPORT_ID, "Old record")]),
        )
        .unwrap();
        let (parked_tx, parked_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        *seams::IMPORT_PARK.lock().unwrap() = Some((parked_tx, release_rx));
        let release = Release(Some(release_tx));
        let cloned = vault.clone();
        let thread = std::thread::spawn(move || {
            apply(
                &cloned,
                json!([import_request("records/a.md", IMPORT_ID, "Updated record")]),
            )
        });
        parked_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the import parks before its path lock");
        if move_away {
            std::fs::rename(vault.join("records/a.md"), vault.join("records/moved.md")).unwrap();
        } else {
            write::save_note(&vault, "records/a.md", "The person's edit", None, &human()).unwrap();
        }
        let before = tree(&vault);
        let writes_before = rows(&vault).len();
        drop(release);
        let Err(BatchError::Stale(stale)) = thread.join().unwrap() else {
            panic!("must be stale")
        };
        assert_eq!(stale.path, "records/a.md");
        assert_eq!(tree(&vault), before);
        assert_eq!(rows(&vault).len(), writes_before);
        assert_eq!(journal_rows(), 0);
        let _ = std::fs::remove_dir_all(vault);
    }
}
