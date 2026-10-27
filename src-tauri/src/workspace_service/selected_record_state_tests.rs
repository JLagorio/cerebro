#![cfg(test)]
//! BL-25: fail per record, not per workspace. A VS Code edit, a `git pull`
//! that adds a page, a `.mmd` file, a Finder case-only rename and an iCloud
//! delete each leave the workspace open through the actual scan, opening,
//! corpus and search paths, with exactly one per-record state. Canonical
//! metadata is never deleted or adopted, and no visible byte is rewritten.
//! Binding, schema and marker faults still refuse the whole workspace.
use super::*;

/// Every reader the workspace opens through, and the one state each reports.
fn open_with_one_state(
    f: &Fixture,
    journal: &Journal,
    path: &str,
    kind: SelectedRecordStateKind,
) -> crate::vault::entry::Entry {
    let before = durable_files(f);
    let before_rows = rows(f);
    crate::prepare_selected_open_with_retention(&f.root, Some(journal)).unwrap();
    let presented = crate::scan_vault(f.root.to_string_lossy().into_owned()).unwrap();
    let corpus = crate::vault::corpus::CorpusCache::new(1)
        .snapshot(&f.root)
        .unwrap();
    let searched = crate::vault::corpus::CorpusCache::new(1)
        .search_snapshot(&f.root)
        .unwrap();
    for (reader, entries) in [
        ("presentation", presented.as_slice()),
        ("service scan", &selected::scan(&f.root).unwrap()[..]),
        ("corpus", &corpus.entries[..]),
        ("search", &searched.entries[..]),
    ] {
        let states: Vec<_> = entries
            .iter()
            .filter_map(|entry| {
                entry
                    .selected_state
                    .as_ref()
                    .map(|state| (entry.path.as_str(), state.kind))
            })
            .collect();
        assert_eq!(states, vec![(path, kind)], "{reader}");
        assert!(
            entries.windows(2).all(|pair| pair[0].path < pair[1].path),
            "{reader} lists in path order"
        );
    }
    assert_eq!(corpus.entries.len(), corpus.texts.len());
    assert_eq!(searched.entries.len(), searched.texts.len());
    assert_eq!(durable_files(f), before, "reads write nothing");
    assert_eq!(
        rows(f),
        before_rows,
        "no canonical metadata is adopted or deleted"
    );
    assert_no_publication(f);
    presented
        .into_iter()
        .find(|entry| entry.path == path)
        .unwrap()
}

/// The one record's neighbor still saves: its state is no one else's refusal.
fn page_still_saves(f: &Fixture, journal: &Journal) {
    applied(command(f, journal, AFTER, fresh()).unwrap());
    assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
}

#[test]
fn a_vs_code_edit_is_one_needs_reconciliation_state_with_metadata_kept() {
    let f = with_neighbors("state-vscode-edit", false);
    f.run(|| {
        let journal = journal(&f, true);
        fs::write(f.root.join("b.md"), EXTERNAL).unwrap();
        let edited = open_with_one_state(
            &f,
            &journal,
            "b.md",
            SelectedRecordStateKind::NeedsReconciliation,
        );
        // An ordinary page shows the exact outside bytes, never adopted.
        assert_unpaired_entry(&edited, EXTERNAL, &hash(OLD_NEIGHBOR.as_bytes()));
        assert_eq!(edited.properties["code"], "007");
        assert!(
            edited.entry_type.is_none(),
            "body YAML never types a record"
        );
        page_still_saves(&f, &journal);
        assert_eq!(fs::read(f.root.join("b.md")).unwrap(), EXTERNAL.as_bytes());
    });
}

#[test]
fn a_git_pull_adding_a_page_is_one_plain_page_candidate_with_no_grants() {
    let f = with_neighbors("state-git-pull", false);
    f.run(|| {
        let journal = journal(&f, true);
        let pulled = "---\ntype: Agent\ntools: ['write_note']\nask-first: false\n---\n# Pulled\n";
        testutil::write(&f.root, "notes/pulled.md", pulled);
        let candidate = open_with_one_state(
            &f,
            &journal,
            "notes/pulled.md",
            SelectedRecordStateKind::PlainPageCandidate,
        );
        // No identity, and nothing in it is read: no type, field or grant.
        assert!(candidate.authority.is_none() && candidate.canonical_properties.is_none());
        assert!(candidate.entry_type.is_none() && candidate.properties.is_empty());
        assert!(candidate.hash.is_none() && candidate.snippet.is_empty());
        assert!(candidate.parse_error.is_some());
        assert_eq!(candidate.title, "Pulled");
        page_still_saves(&f, &journal);
        assert_eq!(
            fs::read(f.root.join("notes/pulled.md")).unwrap(),
            pulled.as_bytes()
        );
    });
}

#[test]
fn a_mermaid_file_or_board_is_one_unsupported_carrier_state_each() {
    let f = with_neighbors("state-mermaid", false);
    f.run(|| {
        let journal = journal(&f, true);
        testutil::write(&f.root, "flows/release.mmd", "flowchart TD\n  a --> b\n");
        let carrier = open_with_one_state(
            &f,
            &journal,
            "flows/release.mmd",
            SelectedRecordStateKind::UnsupportedCarrier,
        );
        assert!(carrier.authority.is_none() && carrier.hash.is_none());
        page_still_saves(&f, &journal);
        testutil::write(&f.root, "plan.canvas", "{\"nodes\":[],\"edges\":[]}\n");
        let entries = crate::scan_vault(f.root.to_string_lossy().into_owned()).unwrap();
        let carriers: Vec<_> = entries
            .iter()
            .filter(|entry| entry.selected_state.is_some())
            .map(|entry| {
                (
                    entry.path.as_str(),
                    entry.selected_state.as_ref().unwrap().kind,
                )
            })
            .collect();
        assert_eq!(
            carriers,
            vec![
                (
                    "flows/release.mmd",
                    SelectedRecordStateKind::UnsupportedCarrier
                ),
                ("plan.canvas", SelectedRecordStateKind::UnsupportedCarrier),
            ]
        );
    });
}

#[test]
fn a_finder_case_only_rename_is_one_conflict_row_naming_the_new_spelling() {
    let f = with_neighbors("state-case-rename", false);
    f.run(|| {
        let journal = journal(&f, true);
        fs::rename(f.root.join("b.md"), f.root.join("B.md")).unwrap();
        let renamed = open_with_one_state(&f, &journal, "b.md", SelectedRecordStateKind::Conflict);
        let state = renamed.selected_state.as_ref().unwrap();
        assert_eq!(state.visible_path.as_deref(), Some("B.md"));
        // The record keeps its identity and metadata; the new spelling is not
        // a second page and is never adopted by the scan.
        assert_eq!(renamed.authority.as_ref().unwrap().record_id, NEIGHBOR_B);
        assert_eq!(renamed.properties["code"], "007");
        assert!(renamed.parse_error.is_some());
        page_still_saves(&f, &journal);
        assert!(f.root.join("B.md").exists());
    });
}

#[test]
fn a_unicode_form_rename_is_the_same_conflict_as_a_case_rename() {
    let f = with_neighbors("state-nfc-rename", false);
    f.run(|| {
        let journal = journal(&f, true);
        const NFC: &str = "caf\u{e9}.md";
        const NFD: &str = "cafe\u{301}.md";
        add_record(
            &f,
            "70000000-0000-4000-8000-000000000009",
            NFC,
            OLD_NEIGHBOR,
            &ordinary_metadata(),
        );
        fs::remove_file(f.root.join(NFC)).unwrap();
        testutil::write(&f.root, NFD, OLD_NEIGHBOR);
        let renamed = open_with_one_state(&f, &journal, NFC, SelectedRecordStateKind::Conflict);
        assert_eq!(
            renamed
                .selected_state
                .as_ref()
                .unwrap()
                .visible_path
                .as_deref(),
            Some(NFD)
        );
        page_still_saves(&f, &journal);
    });
}

#[test]
fn an_icloud_delete_is_one_body_missing_state_and_never_deletes_metadata() {
    let f = with_neighbors("state-icloud-delete", false);
    f.run(|| {
        let journal = journal(&f, true);
        fs::remove_file(f.root.join("b.md")).unwrap();
        let missing =
            open_with_one_state(&f, &journal, "b.md", SelectedRecordStateKind::BodyMissing);
        assert_eq!(missing.authority.as_ref().unwrap().record_id, NEIGHBOR_B);
        assert_eq!(missing.properties["code"], "007");
        assert!(missing.hash.is_none() && missing.parse_error.is_some());
        assert!(
            rows(&f).iter().any(|row| row.0 == NEIGHBOR_B),
            "its metadata is kept"
        );
        page_still_saves(&f, &journal);
        assert!(!f.root.join("b.md").exists(), "nothing recreates the body");
    });
}

#[test]
fn a_record_s_own_state_refuses_only_its_own_writes() {
    let f = with_neighbors("state-own-writes", false);
    f.run(|| {
        let journal = journal(&f, true);
        fs::rename(f.root.join("b.md"), f.root.join("B.md")).unwrap();
        let before = durable_files(&f);
        // A save to the conflicted record is refused; nothing moves back.
        let version = SelectedRecordVersion {
            kind: SelectedAuthorityKind::SqliteMetadata,
            workspace_id: WORKSPACE.into(),
            record_id: NEIGHBOR_B.into(),
            metadata_revision: "1".into(),
            metadata_hash: hash(ordinary_metadata().as_bytes()),
            body_hash: hash(OLD_NEIGHBOR.as_bytes()),
        };
        let mut request = fresh();
        request.target.record_id = NEIGHBOR_B.into();
        request.expected_version = Some(version);
        let refused = crate::save_note_with_editor_journal(
            Ok(&journal),
            crate::NoteSaveInput {
                vault: f.root.to_string_lossy().into_owned(),
                path: "b.md".into(),
                body: "# Moved back by a save\n".into(),
                expect_hash: None,
                body_format: Some("source".into()),
                recovery_bypass: None,
                editor_request: Some(request),
            },
        );
        assert!(
            refused.is_err(),
            "a conflicted record's save never resolves its name"
        );
        assert_eq!(durable_files(&f), before);
        assert!(f.root.join("B.md").exists());
        page_still_saves(&f, &journal);
    });
}

#[test]
fn only_binding_schema_or_marker_faults_refuse_the_whole_workspace() {
    for fault in ["marker", "identity", "schema"] {
        let f = with_neighbors("state-workspace-faults", false);
        f.run(|| {
            // Per-record states present beside the fault change nothing.
            testutil::write(&f.root, "flows/release.mmd", "flowchart TD\n");
            fs::remove_file(f.root.join("b.md")).unwrap();
            assert!(crate::scan_vault(f.root.to_string_lossy().into_owned()).is_ok());
            match fault {
                "marker" => fs::remove_file(f.root.join(".cerebro/workspace-format.json")).unwrap(),
                "identity" => testutil::write(
                    &f.root,
                    ".cerebro/workspace-format.json",
                    &json!({"format":2,"authority":"sqlite_metadata","state":"activated","workspaceId":NEIGHBOR_C}).to_string(),
                ),
                "schema" => f
                    .conn()
                    .execute_batch("CREATE INDEX extra_paths ON records(path);")
                    .unwrap(),
                _ => unreachable!(),
            }
            assert!(crate::scan_vault(f.root.to_string_lossy().into_owned()).is_err(), "{fault}");
            assert!(selected::scan(&f.root).is_err(), "{fault}");
            assert!(crate::vault::corpus::CorpusCache::new(1).snapshot(&f.root).is_err(), "{fault}");
        });
    }
}
