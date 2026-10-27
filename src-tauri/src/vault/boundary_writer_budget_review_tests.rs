#![cfg(test)]
//! Actual rename lock scopes share one request budget in each acquisition phase.
use super::*;
use crate::workspace_service::boundary::{self, Limits};
use std::cell::Cell;
use std::path::PathBuf;

struct RenameScopes {
    root: PathBuf,
    keys: Vec<String>,
}
impl RenameScopes {
    fn new(label: &str) -> Self {
        let root = testutil::temp_vault(label).canonicalize().unwrap();
        testutil::write(&root, "from/a.md", "# A\n");
        testutil::write(&root, "from/b.md", "# B\n");
        testutil::write(
            &root,
            ".comments/from/a.md.json",
            r#"{"format":1,"threads":[]}"#,
        );
        testutil::write(
            &root,
            ".comments/from/b.md.json",
            r#"{"format":1,"threads":[]}"#,
        );
        Self {
            root,
            keys: rename_lock_keys("from", "to"),
        }
    }
    fn refs(&self) -> Vec<&str> {
        self.keys.iter().map(String::as_str).collect()
    }
    fn room(&self) -> Limits {
        Limits {
            entries: 1000,
            depth: 32,
            path_bytes: 1_048_576,
            marker_bytes: 8192,
            single_marker_bytes: 4096,
        }
    }
}
impl Drop for RenameScopes {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn actual_rename_lock_scope_rejects_only_the_combined_source_and_sidecar_budget() {
    let fixture = RenameScopes::new("m99-review-combined-writer-budget");
    let refs = fixture.refs();
    let mut bounds = fixture.room();
    // The declared from/to scope fits; adding the real carried sidecar scopes
    // crosses this small request budget while every individual scope still fits.
    bounds.entries = 4 * fixture.root.ancestors().count() + 7;
    boundary::guard_legacy_targets_with_limits(
        &fixture.root,
        &[("from", true), ("to", false)],
        bounds,
    )
    .unwrap();
    for rel in &refs {
        let tree = safe_join(&fixture.root, rel).unwrap().is_dir();
        boundary::guard_legacy_targets_with_limits(&fixture.root, &[(*rel, tree)], bounds).unwrap();
    }
    let acquired = Cell::new(false);
    let result = lock_paths_checked_with_limits(&fixture.root, &refs, bounds, || {
        acquired.set(true);
        lock_authorized_paths(&fixture.root, &refs)
    });
    assert!(
        !acquired.get(),
        "actual writer reset its budget at a target/sidecar boundary"
    );
    assert!(result.is_err());
}
#[test]
fn actual_rename_lock_scope_accepts_the_same_combined_targets_under_its_budget() {
    let fixture = RenameScopes::new("m99-review-combined-writer-control");
    let refs = fixture.refs();
    let acquired = Cell::new(false);
    let held = lock_paths_checked_with_limits(&fixture.root, &refs, fixture.room(), || {
        acquired.set(true);
        lock_authorized_paths(&fixture.root, &refs)
    })
    .unwrap();
    assert!(acquired.get());
    drop(held);
    assert_eq!(
        fs::read_to_string(fixture.root.join("from/a.md")).unwrap(),
        "# A\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join(".comments/from/a.md.json")).unwrap(),
        r#"{"format":1,"threads":[]}"#
    );
}
#[test]
fn post_acquisition_recheck_uses_one_combined_budget_after_sidecar_growth() {
    let fixture = RenameScopes::new("m99-review-post-lock-combined-budget");
    let refs = fixture.refs();
    let mut bounds = fixture.room();
    // Four real rename lock scopes: two existing roots with two files each,
    // and two absent destinations. Ancestor work is counted for every scope.
    bounds.entries = 8 * fixture.root.ancestors().count() + 14;
    let acquired = Cell::new(false);
    let result = lock_paths_checked_with_limits(&fixture.root, &refs, bounds, || {
        let held = lock_authorized_paths(&fixture.root, &refs)?;
        acquired.set(true);
        testutil::write(
            &fixture.root,
            ".comments/from/c.md.json",
            r#"{"format":1,"threads":[]}"#,
        );
        Ok(held)
    });
    assert!(
        acquired.get(),
        "the initial combined scope must be inside the budget"
    );
    assert!(
        result.is_err(),
        "post-acquisition checks reset the budget per target"
    );
}
