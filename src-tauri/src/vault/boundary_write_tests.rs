//! Tests the actual guard/acquire/recheck handoff; no global hooks or sleeps.
use super::*;
use crate::vault::testutil;
use std::fs;

#[test]
fn marker_added_during_acquisition_is_checked_before_writer_receives_lock() {
    let root = testutil::temp_vault("m99-boundary-lock-handoff");
    testutil::write(&root, "child/page.md", "# Original\n");
    let held = lock_authorized_paths(&root, &["child/page.md"]).unwrap();
    let result = lock_paths_checked(&root, &["child/page.md"], || {
        testutil::write(
            &root,
            "child/.cerebro/workspace-format.json",
            r#"{"format":2,"authority":"sqlite_metadata","state":"preparing","manifest_hash":null}"#,
        );
        drop(held);
        lock_authorized_paths(&root, &["child/page.md"])
    });
    assert!(
        result.is_err(),
        "writer received a lock after its target became inactive"
    );
    assert_eq!(
        fs::read_to_string(root.join("child/page.md")).unwrap(),
        "# Original\n"
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn handoff_recheck_keeps_an_exact_unrelated_sibling_scope_usable() {
    let root = testutil::temp_vault("m99-boundary-lock-sibling");
    testutil::write(&root, "ordinary.md", "# Original\n");
    let held = lock_authorized_paths(&root, &["ordinary.md"]).unwrap();
    let result = lock_paths_checked(&root, &["ordinary.md"], || {
        testutil::write(
            &root,
            "other/.cerebro/workspace-format.json",
            r#"{"format":2,"authority":"sqlite_metadata","state":"preparing","manifest_hash":null}"#,
        );
        drop(held);
        lock_authorized_paths(&root, &["ordinary.md"])
    });
    let next = result.expect("nonintersecting exact sibling must keep its own scope");
    drop(next);
    assert_eq!(
        fs::read_to_string(root.join("ordinary.md")).unwrap(),
        "# Original\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn raw_batch_rejects_marked_ancestor_scope_before_journal_availability_or_body_planning() {
    let root = testutil::temp_vault("m99-boundary-batch-entry");
    testutil::write(&root, "child/page.md", "# Original\n");
    testutil::write(
        &root,
        "child/.cerebro/workspace-format.json",
        r#"{"format":999}"#,
    );
    let by = WriteReceipt::ipc(crate::knowledge::guard_human_write("child/page.md").unwrap());
    let ops = [serde_json::json!({"op":"body","path":"child/page.md","body":"# Forbidden\n"})];
    let error = crate::vault::batch::apply_batch(&root, &ops, &by).unwrap_err();
    match error {
        crate::vault::batch::BatchError::Refused(words) => assert!(
            words.contains("unsupported"),
            "batch reached a later planning/journal phase: {words}"
        ),
        other => panic!("batch returned a later-phase result: {other:?}"),
    }
    assert_eq!(
        fs::read_to_string(root.join("child/page.md")).unwrap(),
        "# Original\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[path = "boundary_writer_budget_review_tests.rs"]
mod review_budget;
