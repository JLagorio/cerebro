//! Real restore publication ordering; existing 38 assertions stay in their parent module.
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[test]
fn both_restored_roots_are_sealed_before_the_first_carrier_is_installed() {
    let fixture = PortableFixture::new("nested-early-seals");
    let bundle = fixture.export();
    let container = fixture.output.join("early-seal-copy");
    fs::create_dir(&container).unwrap();
    let bodies = container.join("content");
    let metadata = container.join("state");
    let seen = Arc::new(AtomicBool::new(false));
    let observed = seen.clone();
    fixture
        .selected
        .run(|| {
            crate::workspace_migration::backup::with_step_for_test(
                "restore_roots_sealed",
                move |body, data| {
                    for root in [body, data] {
                        let marker: Value =
                            serde_json::from_slice(&fs::read(root.join(MARKER)).unwrap()).unwrap();
                        assert_eq!(marker["state"], "preparing");
                    }
                    assert!(!body.join("page.md").exists());
                    assert!(!data.join("workspace.db").exists());
                    assert!(!data.join("originals/page.md").exists());
                    observed.store(true, Ordering::SeqCst);
                },
                || {
                    crate::workspace_migration::restore::restore_workspace(
                        &bundle, &bodies, &metadata,
                    )
                },
            )
        })
        .unwrap();
    assert!(seen.load(Ordering::SeqCst));
}
#[test]
fn metadata_final_seal_survives_fresh_context_and_preserves_database_and_original_bytes() {
    let fixture = PortableFixture::new("nested-final-seals");
    let bundle = fixture.export();
    let expected_database = fs::read(bundle.join("metadata/workspace.db")).unwrap();
    let expected_original = fs::read(bundle.join("metadata/originals/page.md")).unwrap();
    let container = fixture.output.join("final-seal-copy");
    fs::create_dir(&container).unwrap();
    let bodies = container.join("content");
    let metadata = container.join("state");
    fixture
        .selected
        .run(|| crate::workspace_migration::restore::restore_workspace(&bundle, &bodies, &metadata))
        .unwrap();
    for root in [&bodies, &metadata] {
        let marker: Value = serde_json::from_slice(&fs::read(root.join(MARKER)).unwrap()).unwrap();
        assert_eq!(marker["state"], "restored_inactive");
        let fresh = authority::AuthorityContext::new(fixture.selected.origin.clone());
        assert_eq!(
            crate::workspace_service::boundary::guard(&fresh, &root.join("page.md"), false)
                .unwrap_err()
                .kind,
            AuthorityErrorKind::InvalidFormat
        );
    }
    assert_eq!(
        fs::read(metadata.join("workspace.db")).unwrap(),
        expected_database
    );
    assert_eq!(
        fs::read(metadata.join("originals/page.md")).unwrap(),
        expected_original
    );
}
