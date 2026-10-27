use super::*;
use crate::workspace_migration::backup::OutputPhase;
use crate::workspace_service::authority::{OutputLocation, OutputProgress, OutputReservation};

fn reserve_progress(f: &PortableFixture, leaf: &str) -> (OutputReservation, OutputProgress) {
    let context = authority::context().unwrap();
    let choice = backup::NewDirectoryChoice::new(&f.output, leaf).unwrap();
    let (lease, ()) = context.reserve_output(choice, &[], || Ok(())).unwrap();
    let observer = lease.progress();
    (lease, observer)
}
fn export_progress(f: &PortableFixture) -> (authority::AdmittedBackupRead, OutputReservation, OutputProgress) {
    let context = authority::context().unwrap();
    let opening = context.request_open(&f.selected.root).unwrap();
    crate::run_open_attempt(&context, &opening, || context.publish_attempt_with(&opening, || Ok(())).map_err(|e| e.message), || Ok(())).unwrap();
    let source = context.capture_selected_backup_opening(&f.selected.root).unwrap();
    let output = backup::NewDirectoryChoice::new(&f.output, "Progress bundle").unwrap();
    let (lease, source) = context.reserve_selected_output(source, output, || Ok(())).unwrap();
    let observer = lease.progress();
    (source, lease, observer)
}

#[test]
fn untouched_reserved_output_observer_is_no_mkdir_control() {
    let f = PortableFixture::new("progress-untouched");
    f.selected.run(|| {
        let (lease, observer) = reserve_progress(&f, "Untouched");
        assert_eq!(observer.snapshot().phase, OutputPhase::NotStarted);
        drop(lease);
        assert_eq!(observer.snapshot().phase, OutputPhase::NotStarted);
        assert!(!f.output.join("Untouched").exists());
    });
}

#[test]
fn actual_held_parent_mkdir_records_created_and_verified_original_identity_after_lease_drop() {
    let f = PortableFixture::new("progress-created");
    f.selected.run(|| {
        let (mut lease, observer) = reserve_progress(&f, "Created");
        let output = lease.create_root().unwrap();
        drop(output); drop(lease);
        let facts: authority::OutputObservation = observer.snapshot();
        assert_eq!(facts.phase, OutputPhase::Created);
        assert_eq!(facts.location, OutputLocation::Verified);
        assert_eq!(facts.display_location, fs::canonicalize(&f.output).unwrap().join("Created"));
    });
}

#[test]
fn mkdir_success_before_parent_revalidation_error_is_created_with_uncertain_location() {
    let f = PortableFixture::new("progress-mkdir-handoff-error");
    let parent = f.output.join("chosen-parent"); let moved = f.output.join("moved-parent");
    fs::create_dir(&parent).unwrap();
    f.selected.run(|| {
        let context = authority::context().unwrap();
        let choice = backup::NewDirectoryChoice::new(&parent, "Created before error").unwrap();
        let (mut lease, ()) = context.reserve_output(choice, &[], || Ok(())).unwrap();
        let observer = lease.progress(); let old_parent = parent.clone(); let new_parent = moved.clone();
        let error = backup::with_step_for_test("output_mkdir_created", move |_, _| {
            fs::rename(&old_parent, &new_parent).unwrap();
        }, || lease.create_root()).err().unwrap();
        assert_eq!(error.kind, AuthorityErrorKind::SourceChanged);
        assert!(moved.join("Created before error").is_dir(), "actual mkdir must precede the refused Root handoff");
        drop(lease);
        let facts = observer.snapshot();
        assert_eq!(facts.phase, OutputPhase::Created);
        assert_eq!(facts.location, OutputLocation::OriginalSpellingOnly);
    });
}

#[test]
fn attempted_mkdir_collision_records_uncertainty_and_preserves_foreign_bytes() {
    let f = PortableFixture::new("progress-attempt-collision");
    f.selected.run(|| {
        let (mut lease, observer) = reserve_progress(&f, "Foreign collision");
        let error = backup::with_step_for_test("output_mkdir_attempt", |target, _| {
            fs::create_dir(target).unwrap(); fs::write(target.join("foreign"), b"foreign sentinel").unwrap();
        }, || lease.create_root()).err().unwrap();
        assert_eq!(error.kind, AuthorityErrorKind::SourceChanged);
        drop(lease);
        assert_eq!(observer.snapshot().phase, OutputPhase::CreationAttempted);
        assert_eq!(observer.snapshot().location, OutputLocation::OriginalSpellingOnly);
        assert_eq!(fs::read(f.output.join("Foreign collision/foreign")).unwrap(), b"foreign sentinel");
    });
}

#[test]
fn admitted_export_final_durable_helper_records_published_after_all_resources_close() {
    let f = PortableFixture::new("progress-export-published");
    f.selected.run(|| {
        let (source, lease, observer) = export_progress(&f);
        assert_eq!(backup::backup_admitted(source, lease).unwrap().workspace_id, WORKSPACE);
        assert_eq!(observer.snapshot().phase, OutputPhase::Published);
        assert_eq!(observer.snapshot().location, OutputLocation::Verified);
        let context = authority::context().unwrap();
        let choice = backup::NewDirectoryChoice::new(&f.output, "After export").unwrap();
        drop(context.reserve_output(choice, &[], || Ok(())).unwrap());
    });
}

#[test]
fn admitted_restore_both_final_markers_record_published_after_resource_cleanup() {
    let f = PortableFixture::new("progress-restore-published"); let bundle = f.export();
    let input = backup::check_backup_input(&bundle).unwrap();
    f.selected.run(|| {
        let (lease, observer) = reserve_progress(&f, "Progress restore");
        assert_eq!(backup::restore_admitted(input, lease).unwrap().workspace_id, WORKSPACE);
        assert_eq!(observer.snapshot().phase, OutputPhase::Published);
        assert_eq!(observer.snapshot().location, OutputLocation::Verified);
    });
}

#[test]
fn failed_copy_keeps_created_fact_without_claiming_publication() {
    let f = PortableFixture::new("progress-copy-error");
    f.selected.run(|| {
        let (source, lease, observer) = export_progress(&f);
        let error = backup::with_step_for_test("export_publish", |_, output| {
            fs::write(output.join("bodies/page.md"), b"changed installed bytes").unwrap();
        }, || backup::backup_admitted(source, lease)).unwrap_err();
        assert_eq!(error.kind, BackupErrorKind::PartMismatch);
        assert_eq!(observer.snapshot().phase, OutputPhase::Created);
        assert_eq!(observer.snapshot().location, OutputLocation::Verified);
        assert!(!f.output.join("Progress bundle/manifest.json").exists());
    });
}

#[test]
fn refused_final_manifest_write_stays_publication_attempted_and_does_not_overwrite() {
    let f = PortableFixture::new("progress-manifest-write-error");
    f.selected.run(|| {
        let (source, lease, observer) = export_progress(&f);
        let error = backup::with_step_for_test("export_publication_attempt", |_, output| {
            fs::write(output.join("manifest.json"), b"foreign manifest sentinel").unwrap();
        }, || backup::backup_admitted(source, lease)).unwrap_err();
        assert_eq!(error.kind, BackupErrorKind::DestinationUnavailable);
        assert_eq!(observer.snapshot().phase, OutputPhase::PublicationAttempted);
        assert_eq!(fs::read(f.output.join("Progress bundle/manifest.json")).unwrap(), b"foreign manifest sentinel");
    });
}

#[test]
fn export_panic_after_successful_publication_preserves_published_fact() {
    let f = PortableFixture::new("progress-export-published-panic");
    f.selected.run(|| {
        let (source, lease, observer) = export_progress(&f);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            backup::with_step_for_test("export_published", |_, _| panic!("synthetic presentation panic after real publication"), || backup::backup_admitted(source, lease))
        }));
        assert!(result.is_err());
        assert_eq!(observer.snapshot().phase, OutputPhase::Published);
        assert_eq!(observer.snapshot().location, OutputLocation::Verified);
        let context = authority::context().unwrap(); let next = backup::NewDirectoryChoice::new(&f.output, "After unwind").unwrap();
        drop(context.reserve_output(next, &[], || Ok(())).unwrap());
    });
}

#[test]
fn restore_marker_identity_error_keeps_unconfirmed_publication_not_success() {
    let f = PortableFixture::new("progress-restore-marker-error"); let bundle = f.export(); let input = backup::check_backup_input(&bundle).unwrap();
    let old_marker = f.output.join("original-body-marker");
    f.selected.run(|| {
        let (lease, observer) = reserve_progress(&f, "Progress restore");
        let error = backup::with_step_for_test("restore_publication_attempt", move |bodies, _| {
            let marker = bodies.join(".cerebro/workspace-format.json");
            fs::rename(&marker, &old_marker).unwrap(); fs::write(&marker, b"foreign marker sentinel").unwrap();
        }, || backup::restore_admitted(input, lease)).unwrap_err();
        assert_eq!(error.kind, BackupErrorKind::SourceChanged);
        assert_eq!(observer.snapshot().phase, OutputPhase::PublicationAttempted);
        assert_eq!(fs::read(f.output.join("Progress restore/Pages/.cerebro/workspace-format.json")).unwrap(), b"foreign marker sentinel");
    });
}

#[test]
fn restore_panic_after_both_durable_markers_preserves_published_fact() {
    let f = PortableFixture::new("progress-restore-published-panic"); let bundle = f.export(); let input = backup::check_backup_input(&bundle).unwrap();
    f.selected.run(|| {
        let (lease, observer) = reserve_progress(&f, "Progress restore");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            backup::with_step_for_test("restore_published", |_, _| panic!("synthetic presentation panic after both real markers"), || backup::restore_admitted(input, lease))
        }));
        assert!(result.is_err());
        assert_eq!(observer.snapshot().phase, OutputPhase::Published);
        assert_eq!(observer.snapshot().location, OutputLocation::Verified);
    });
}

#[test]
fn published_fact_never_adopts_same_path_replacement_location() {
    let f = PortableFixture::new("progress-published-root-replaced");
    f.selected.run(|| {
        let (source, lease, observer) = export_progress(&f); backup::backup_admitted(source, lease).unwrap();
        let original = f.output.join("Progress bundle"); let moved = f.output.join("Moved completed bundle");
        fs::rename(&original, &moved).unwrap(); fs::create_dir(&original).unwrap(); fs::write(original.join("foreign"), b"replacement sentinel").unwrap();
        let facts = observer.snapshot(); assert_eq!(facts.phase, OutputPhase::Published);
        assert_eq!(facts.location, OutputLocation::OriginalSpellingOnly);
        assert_eq!(facts.display_location, fs::canonicalize(&f.output).unwrap().join("Progress bundle"));
        assert_eq!(fs::read(original.join("foreign")).unwrap(), b"replacement sentinel");
    });
}

#[test]
fn passive_observer_does_not_retain_output_denial_or_opening_authority() {
    let f = PortableFixture::new("progress-observer-no-lease");
    f.selected.run(|| {
        let (mut lease, observer) = reserve_progress(&f, "Settled empty output");
        drop(lease.create_root().unwrap()); drop(lease);
        let context = authority::context().unwrap();
        let opening = context.request_open(&f.output.join("Settled empty output")).unwrap();
        context.abandon_open(&opening).unwrap();
        assert_eq!(observer.snapshot().phase, OutputPhase::Created);
    });
}

#[test]
fn held_output_root_replacement_before_footprint_binding_is_not_adopted() {
    let f = PortableFixture::new("progress-created-identity-bind");
    f.selected.run(|| {
        let (mut lease, _observer) = reserve_progress(&f, "Original output");
        let moved = f.output.join("Moved original output");
        let error = backup::with_step_for_test("output_root_handoff", move |original, _| {
            fs::rename(original, &moved).unwrap(); fs::create_dir(original).unwrap();
            fs::write(original.join("foreign"), b"replacement footprint sentinel").unwrap();
        }, || lease.create_root()).err().expect("footprint adopted replacement inode after held Root creation");
        assert_eq!(error.kind, AuthorityErrorKind::SourceChanged);
        assert_eq!(fs::read(f.output.join("Original output/foreign")).unwrap(), b"replacement footprint sentinel");
        assert!(f.output.join("Moved original output").is_dir());
    });
}
