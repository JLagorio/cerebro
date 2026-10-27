#![cfg(test)]
//! Real protected captures and the actual selected editor resume consumer.
//! No reduced quota, inserted copies, fabricated receipt or crash simulation.
use super::*;
use std::collections::BTreeSet;

#[test]
fn editor_recovery_count_fresh_zero_is_known_but_resume_is_unknown() {
    let f = fixture("editor-recovery-count-zero");
    f.run(|| {
        let journal = journal(&f, true);
        let fresh_ack = serde_json::to_value(save(&f, &journal, AFTER, fresh()).unwrap()).unwrap();
        assert_eq!(fresh_ack["kind"], "selected_applied");
        assert_eq!(fresh_ack["recovery"]["kind"], "retained");
        assert_eq!(
            fresh_ack["recovery"]["evicted"], "0",
            "the fresh writer knows its actual zero"
        );
        let request = fresh();
        let path = f.root.join("page.md");
        let next = "# Original pending editor draft\n";
        let ack = selected::with_before_install_for_test(
            move || fs::write(path, "# Third-party temporary conflict\n").unwrap(),
            || save(&f, &journal, next, request.clone()),
        )
        .unwrap();
        let crate::NoteSaveResult::Selected(EditorSaveResult::Pending { operation, .. }) = ack
        else {
            panic!("the actual durable intent must remain pending");
        };
        let intent: Value =
            serde_json::from_slice(&fs::read(pending(&f).join("intent.json")).unwrap()).unwrap();
        let copy_id = intent["retained_copy"]["id"].as_str().unwrap().to_owned();
        fs::write(f.root.join("page.md"), AFTER).unwrap();
        let replay = serde_json::to_value(
            save(
                &f,
                &journal,
                next,
                EditorSaveRequest {
                    original: Some(operation),
                    ..resolve(&request)
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(replay["kind"], "selected_applied");
        assert_eq!(replay["recovery"]["kind"], "retained");
        assert_eq!(replay["recovery"]["id"], copy_id);
        assert_eq!(
            replay["recovery"]["evicted"],
            Value::Null,
            "recovery cannot infer the original capture's eviction count"
        );
        assert_eq!(receipt_count(&f), 2);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), next);
        assert!(!pending(&f).exists());
    });
}

#[test]
fn editor_recovery_count_actual_quota_eviction_is_not_reported_as_zero_on_resume() {
    let f = fixture("editor-recovery-count-evicted");
    f.run(|| {
        let journal = journal(&f, true);
        let limits = crate::vault::recovery::limits();
        let bytes = usize::try_from(limits.entry_bytes).unwrap();
        let captures = usize::try_from(limits.global_bytes / limits.entry_bytes).unwrap();
        assert_eq!(limits.global_bytes % limits.entry_bytes, 0);
        assert_eq!(
            captures, 10,
            "exercise the actual compiled quota, never a test-reduced budget"
        );
        let large = |number: usize| {
            let heading = format!("# Actual protected preimage {number:02}\n");
            let padding = bytes.checked_sub(heading.len()).unwrap();
            heading + &"x".repeat(padding)
        };
        let mut before = large(0);
        fs::write(f.root.join("page.md"), &before).unwrap();
        let mut original_copy_ids = BTreeSet::new();
        for number in 1..=captures {
            let after = large(number);
            let wire = serde_json::to_value(save(&f, &journal, &after, fresh()).unwrap()).unwrap();
            assert_eq!(wire["kind"], "selected_applied");
            assert_eq!(wire["recovery"]["kind"], "retained");
            assert_eq!(wire["recovery"]["evicted"], "0");
            original_copy_ids.insert(wire["recovery"]["id"].as_str().unwrap().to_owned());
            before = after;
        }
        let full = journal.status(&f.root).unwrap();
        assert_eq!(full.retained_bytes, limits.global_bytes);
        assert_eq!(full.entries, i64::try_from(captures).unwrap());
        let request = fresh();
        let path = f.root.join("page.md");
        let ack = selected::with_before_install_for_test(
            move || fs::write(path, "# Third-party temporary conflict\n").unwrap(),
            || save(&f, &journal, AFTER, request.clone()),
        )
        .unwrap();
        let crate::NoteSaveResult::Selected(EditorSaveResult::Pending { operation, .. }) = ack
        else {
            panic!("the real post-capture intent must remain pending");
        };
        let intent: Value =
            serde_json::from_slice(&fs::read(pending(&f).join("intent.json")).unwrap()).unwrap();
        let copy_id = intent["retained_copy"]["id"].as_str().unwrap().to_owned();
        let current = journal.list(&f.root, "page.md").unwrap();
        let current_ids: BTreeSet<_> = current.iter().map(|row| row.id.clone()).collect();
        assert_eq!(
            original_copy_ids.difference(&current_ids).count(),
            1,
            "one actual previously captured copy was evicted before interruption"
        );
        assert_eq!(current.len(), captures);
        assert_eq!(
            current.iter().filter(|row| row.state == "pending").count(),
            1
        );
        assert!(current
            .iter()
            .any(|row| row.id == copy_id && row.state == "pending"));
        fs::write(f.root.join("page.md"), &before).unwrap();
        let replay = serde_json::to_value(
            save(
                &f,
                &journal,
                AFTER,
                EditorSaveRequest {
                    original: Some(operation),
                    ..resolve(&request)
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(replay["kind"], "selected_applied");
        assert_eq!(replay["recovery"]["kind"], "retained");
        assert_eq!(replay["recovery"]["id"], copy_id);
        assert_eq!(
            replay["recovery"]["evicted"],
            Value::Null,
            "a lost original eviction count must never be replaced by a measured zero"
        );
        assert_eq!(receipt_count(&f), i64::try_from(captures + 1).unwrap());
        assert_eq!(
            count_copies(&f, "committed"),
            i64::try_from(captures).unwrap()
        );
        assert_eq!(count_copies(&f, "pending"), 0);
        assert_eq!(selected::read_body(&f.root, "page.md").unwrap(), AFTER);
        assert!(!pending(&f).exists());
    });
}
