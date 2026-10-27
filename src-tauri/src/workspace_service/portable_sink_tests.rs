use super::*;
use crate::workspace_service::backup_coordinator::{
    self as coordinator, CopyDisposition, KernelFailure, Refusal, TestCopyRequest,
};

fn source_ticket(
    f: &PortableFixture,
    context: &authority::AuthorityContext,
) -> authority::SelectedBackupOpening {
    let opening = context.request_open(&f.selected.root).unwrap();
    crate::run_open_attempt(
        context,
        &opening,
        || {
            context
                .publish_attempt_with(&opening, || Ok(()))
                .map_err(|e| e.message)
        },
        || Ok(()),
    )
    .unwrap();
    context
        .capture_selected_backup_opening(&f.selected.root)
        .unwrap()
}
fn create_work(
    f: &PortableFixture,
    context: &authority::AuthorityContext,
) -> coordinator::TestCopyWork {
    let source = source_ticket(f, context);
    let output = backup::NewDirectoryChoice::new(&f.output, "Native backup").unwrap();
    coordinator::test_copy_work(TestCopyRequest::Create { source, output })
}
fn restore_work(
    f: &PortableFixture,
    input: backup::CheckedBackupInput,
) -> coordinator::TestCopyWork {
    let output = backup::NewDirectoryChoice::new(&f.output, "Native restore").unwrap();
    coordinator::test_copy_work(TestCopyRequest::Restore { input, output })
}
fn assert_summary(summary: &backup::CheckedBackupSummary, manifest: &Value) {
    let total: u64 = manifest["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| part["bytes"].as_str().unwrap().parse::<u64>().unwrap())
        .sum();
    assert_eq!(summary.workspace_id, WORKSPACE);
    assert_eq!(summary.format, 1);
    assert_eq!(summary.schema_version, 3);
    assert_eq!(
        summary.part_count,
        manifest["parts"].as_array().unwrap().len()
    );
    assert_eq!(summary.total_bytes, total.to_string());
}

#[test]
fn admitted_export_report_retains_validated_summary_without_reopening_original_source() {
    let f = PortableFixture::new("sink-export-summary");
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let source = source_ticket(&f, &context);
        let output = backup::NewDirectoryChoice::new(&f.output, "Native backup").unwrap();
        let (lease, source) = context
            .reserve_selected_output(source, output, || Ok(()))
            .unwrap();
        let report = backup::backup_admitted(source, lease).unwrap();
        assert_summary(
            report
                .summary
                .as_ref()
                .expect("admitted export discarded validated summary"),
            &read_manifest(&f.output.join("Native backup")),
        );
    });
}

#[test]
fn admitted_restore_report_retains_same_checked_input_summary_after_both_markers() {
    let f = PortableFixture::new("sink-restore-summary");
    let bundle = f.export();
    let input = backup::check_backup_input(&bundle).unwrap();
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let output = backup::NewDirectoryChoice::new(&f.output, "Native restore").unwrap();
        let (lease, ()) = context
            .reserve_output(output, &[bundle.clone()], || Ok(()))
            .unwrap();
        let report = backup::restore_admitted(input, lease).unwrap();
        assert_summary(
            report
                .summary
                .as_ref()
                .expect("admitted restore discarded checked summary"),
            &read_manifest(&bundle),
        );
    });
}

#[test]
fn fixed_create_book_kernel_returns_typed_completion_and_bounded_summary() {
    let f = PortableFixture::new("sink-create-complete");
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let result = create_work(&f, &context).run(&context);
        assert!(
            f.output.join("Native backup/manifest.json").is_file(),
            "real fixed kernel must run"
        );
        assert!(matches!(
            result.terminal.disposition,
            CopyDisposition::Completed(_)
        ));
        assert!(result.terminal.response_available);
        assert!(result.terminal.failure.is_none());
        assert_eq!(result.terminal.workspace_id.as_deref(), Some(WORKSPACE));
        assert_summary(
            result.terminal.summary.as_ref().unwrap(),
            &read_manifest(&f.output.join("Native backup")),
        );
        assert!(!result.slot_occupied);
        assert!(!result.panicked);
    });
}

#[test]
fn fixed_restore_works_with_detached_original_source_and_legacy_current_context() {
    let f = PortableFixture::new("sink-restore-detached");
    let bundle = f.export();
    let input = backup::check_backup_input(&bundle).unwrap();
    let detached = f.output.join("Unavailable original source");
    fs::rename(&f.selected.root, &detached).unwrap();
    let origin = f.output.join("Fresh app configuration");
    fs::create_dir(&origin).unwrap();
    let legacy = f.output.join("Legacy current");
    fs::create_dir(&legacy).unwrap();
    let context = authority::AuthorityContext::new(origin);
    let opening = context.request_open(&legacy).unwrap();
    crate::run_open_attempt(
        &context,
        &opening,
        || {
            context
                .publish_attempt_with(&opening, || Ok(()))
                .map_err(|e| e.message)
        },
        || Ok(()),
    )
    .unwrap();
    let result = restore_work(&f, input).run(&context);
    for name in ["Pages", "Workspace data"] {
        let marker: Value = serde_json::from_slice(
            &fs::read(
                f.output
                    .join("Native restore")
                    .join(name)
                    .join(".cerebro/workspace-format.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(marker["state"], "restored_inactive");
    }
    assert!(matches!(
        result.terminal.disposition,
        CopyDisposition::Completed(_)
    ));
    assert!(result.terminal.response_available);
    assert!(!result.slot_occupied);
    assert_summary(
        result.terminal.summary.as_ref().unwrap(),
        &read_manifest(&bundle),
    );
}

#[test]
fn fixed_copy_failure_preserves_backup_error_and_known_incomplete_output() {
    let f = PortableFixture::new("sink-incomplete");
    f.selected.run(|| {
        let context = authority::context().unwrap(); let work = create_work(&f, &context);
        let result = backup::with_step_for_test("export_publish", |_, output| { fs::write(output.join("bodies/page.md"), b"changed installed bytes").unwrap(); }, || work.run(&context));
        assert!(matches!(&result.terminal.failure, Some(KernelFailure::Backup(error)) if error.kind == BackupErrorKind::PartMismatch));
        assert!(matches!(result.terminal.disposition, CopyDisposition::Incomplete(_)));
        assert!(!f.output.join("Native backup/manifest.json").exists()); assert!(!result.slot_occupied);
    });
}

#[test]
fn same_path_reopen_refuses_original_source_ticket_with_typed_authority_and_no_output() {
    let f = PortableFixture::new("sink-stale-opening");
    f.selected.run(|| {
        let context = authority::context().unwrap(); let work = create_work(&f, &context);
        let opening = context.request_open(&f.selected.root).unwrap();
        crate::run_open_attempt(&context, &opening, || context.publish_attempt_with(&opening, || Ok(())).map_err(|e| e.message), || Ok(())).unwrap();
        let result = work.run(&context);
        assert!(matches!(&result.terminal.failure, Some(KernelFailure::Authority(error)) if error.kind == AuthorityErrorKind::SourceChanged));
        assert!(!f.output.join("Native backup").exists());
        assert_eq!(result.terminal.disposition, CopyDisposition::NoneCreated); assert!(!result.slot_occupied);
    });
}

#[test]
fn database_replacement_after_admission_refuses_before_mkdir_with_original_backup_error() {
    let f = PortableFixture::new("sink-source-replaced-after-gate");
    f.selected.run(|| {
        let context = authority::context().unwrap(); let work = create_work(&f, &context);
        let database = f.selected.db.clone();
        let result = backup::with_step_for_test("backup_after_output_admission", move |_, _| {
            let old = database.with_extension("original"); fs::rename(&database, &old).unwrap(); fs::copy(&old, &database).unwrap(); private_file(&database);
        }, || work.run(&context));
        assert!(matches!(&result.terminal.failure, Some(KernelFailure::Backup(error)) if error.kind == BackupErrorKind::SourceChanged));
        assert!(!f.output.join("Native backup").exists());
        assert_eq!(result.terminal.disposition, CopyDisposition::NoneCreated); assert!(!result.slot_occupied);
    });
}

#[test]
fn held_input_root_replacement_after_admission_refuses_before_any_restore_output() {
    let f = PortableFixture::new("sink-input-replaced-after-gate");
    let bundle = f.export();
    let input = backup::check_backup_input(&bundle).unwrap();
    f.selected.run(|| {
        let context = authority::context().unwrap(); let work = restore_work(&f, input); let original = bundle.clone(); let moved = f.output.join("Original checked bundle");
        let result = backup::with_step_for_test("backup_after_output_admission", move |_, _| { fs::rename(&original, &moved).unwrap(); copy_valid_portable_tree(&moved, &original); }, || work.run(&context));
        assert!(matches!(&result.terminal.failure, Some(KernelFailure::Backup(error)) if error.kind == BackupErrorKind::SourceChanged));
        assert!(!f.output.join("Native restore").exists());
        assert_eq!(result.terminal.disposition, CopyDisposition::NoneCreated); assert!(!result.slot_occupied);
    });
}

#[test]
fn actual_gate_rechecks_original_window_after_book_and_before_first_write() {
    let f = PortableFixture::new("sink-window-retired-before-gate");
    f.selected.run(|| {
        let context = authority::context().unwrap(); let work = create_work(&f, &context); let retirement = work.retirement();
        let result = backup::with_step_for_test("backup_before_output_admission", move |_, _| { retirement.retire(); assert_eq!(retirement.recreated_check_refusal(), Some(Refusal::Busy)); }, || work.run(&context));
        assert!(matches!(&result.terminal.failure, Some(KernelFailure::Authority(error)) if error.kind == AuthorityErrorKind::ContextUnavailable));
        assert!(!f.output.join("Native backup").exists());
        assert_eq!(result.terminal.disposition, CopyDisposition::NoneCreated); assert!(!result.slot_occupied);
    });
}

#[test]
fn retirement_after_admission_keeps_real_kernel_and_global_slot_until_completion() {
    let f = PortableFixture::new("sink-window-retired-after-gate");
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let work = create_work(&f, &context);
        let retirement = work.retirement();
        let result = backup::with_step_for_test(
            "backup_after_output_admission",
            move |_, _| {
                retirement.retire();
                assert!(retirement.slot_occupied());
                assert_eq!(retirement.recreated_check_refusal(), Some(Refusal::Busy));
            },
            || work.run(&context),
        );
        assert!(f.output.join("Native backup/manifest.json").is_file());
        assert!(matches!(
            result.terminal.disposition,
            CopyDisposition::Completed(_)
        ));
        assert!(result.terminal.failure.is_none());
        assert!(!result.slot_occupied);
    });
}

#[test]
fn admitted_source_stays_original_when_unrelated_opening_publishes_before_reader() {
    let f = PortableFixture::new("sink-source-after-switch");
    let other = f.output.join("Other current");
    fs::create_dir(&other).unwrap();
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let work = create_work(&f, &context);
        let changed = context.clone();
        let result = backup::with_step_for_test(
            "backup_after_output_admission",
            move |_, _| {
                let opening = changed.request_open(&other).unwrap();
                crate::run_open_attempt(
                    &changed,
                    &opening,
                    || {
                        changed
                            .publish_attempt_with(&opening, || Ok(()))
                            .map_err(|e| e.message)
                    },
                    || Ok(()),
                )
                .unwrap();
            },
            || work.run(&context),
        );
        assert_eq!(
            fs::read(f.output.join("Native backup/bodies/page.md")).unwrap(),
            fs::read(f.selected.root.join("page.md")).unwrap()
        );
        assert!(matches!(
            result.terminal.disposition,
            CopyDisposition::Completed(_)
        ));
        assert!(!result.slot_occupied);
    });
}

#[test]
fn final_manifest_failure_is_unknown_completion_with_typed_cause_not_incomplete_or_no_output() {
    let f = PortableFixture::new("sink-publication-unknown");
    f.selected.run(|| {
        let context = authority::context().unwrap(); let work = create_work(&f, &context);
        let result = backup::with_step_for_test("export_publication_attempt", |_, output| { fs::write(output.join("manifest.json"), b"foreign final manifest").unwrap(); }, || work.run(&context));
        assert!(matches!(&result.terminal.failure, Some(KernelFailure::Backup(error)) if error.kind == BackupErrorKind::DestinationUnavailable));
        assert!(matches!(&result.terminal.disposition, CopyDisposition::CompletionUnknown(Some(facts)) if facts.phase == backup::OutputPhase::PublicationAttempted));
        assert!(!result.terminal.response_available); assert!(!result.slot_occupied);
    });
}

#[test]
fn published_then_panic_is_completed_with_response_unavailable_and_released_slot() {
    let f = PortableFixture::new("sink-published-panic");
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let work = create_work(&f, &context);
        let result = backup::with_step_for_test(
            "export_published",
            |_, _| panic!("synthetic response failure after actual publication"),
            || work.run(&context),
        );
        assert!(result.panicked);
        assert!(f.output.join("Native backup/manifest.json").is_file());
        assert!(matches!(
            result.terminal.disposition,
            CopyDisposition::Completed(_)
        ));
        assert!(!result.terminal.response_available);
        assert!(result.terminal.summary.is_none());
        assert!(matches!(
            result.terminal.failure,
            Some(KernelFailure::Control(Refusal::UnknownOutcome))
        ));
        assert!(!result.slot_occupied);
    });
}

#[test]
fn completed_copy_is_not_downgraded_when_terminal_book_becomes_unavailable_after_kernel_return() {
    let f = PortableFixture::new("sink-published-book-poison");
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let work = create_work(&f, &context);
        let retirement = work.retirement();
        let result = backup::with_step_for_test(
            "backup_after_kernel_return",
            move |_, _| {
                assert!(retirement.slot_occupied());
                retirement.poison_book();
            },
            || work.run(&context),
        );
        assert!(!result.panicked);
        assert!(f.output.join("Native backup/manifest.json").is_file());
        assert!(matches!(
            result.terminal.disposition,
            CopyDisposition::Completed(_)
        ));
        assert!(!result.terminal.response_available);
        assert!(matches!(
            result.terminal.failure,
            Some(KernelFailure::Control(Refusal::Unavailable))
        ));
        assert!(!result.slot_occupied);
    });
}

#[test]
fn actual_mkdir_collision_is_creation_uncertain_and_does_not_claim_foreign_output() {
    let f = PortableFixture::new("sink-creation-uncertain");
    f.selected.run(|| {
        let context = authority::context().unwrap(); let work = create_work(&f, &context);
        let result = backup::with_step_for_test("output_mkdir_attempt", |target, _| {
            fs::create_dir(target).unwrap(); fs::write(target.join("foreign"), b"foreign output sentinel").unwrap();
        }, || work.run(&context));
        assert!(matches!(&result.terminal.failure, Some(KernelFailure::Backup(error)) if error.kind == BackupErrorKind::SourceChanged));
        assert!(matches!(&result.terminal.disposition, CopyDisposition::CreationUncertain(facts) if facts.phase == backup::OutputPhase::CreationAttempted));
        assert_eq!(fs::read(f.output.join("Native backup/foreign")).unwrap(), b"foreign output sentinel");
        assert!(!result.slot_occupied);
    });
}
