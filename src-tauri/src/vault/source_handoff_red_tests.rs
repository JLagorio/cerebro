#![cfg(test)]
//! Source-reader handoff RED: two scoped-pipeline tests and five actual command controls.
//! No Wry window, process admission, global hook, sleep or authority-bearing callback.
use super::*;
use crate::vault::testutil;
use crate::workspace_service::{authority, types::LegacyRecordSnapshot};
use std::{cell::Cell, fs};

const SOURCE_A: &str = "\u{feff}---\r\ntype: Doc\r\n---\r\n\r\n# Retained A\r\n";
const SOURCE_A_SHA: &str = "556ba90053a0a168820cf531e611ac05c38c576760f4d4bc7d3ad3ed21fcdfc7";
const SOURCE_B: &str = "---\r\ntype: Doc\r\n---\r\n\r\n# Protected B\r\n";
const PREPARING: &str =
    r#"{"format":1,"authority":"sqlite_metadata","state":"preparing","manifest_hash":null}"#;

struct Fixture {
    root: PathBuf,
    origin: PathBuf,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let root = testutil::temp_vault(label).canonicalize().unwrap();
        let origin = testutil::temp_vault(&format!("{label}-origin"))
            .canonicalize()
            .unwrap();
        testutil::write(&root, "notes/a.md", SOURCE_A);
        testutil::write(&root, "protected/retained.md", SOURCE_B);
        testutil::write(&root, "protected/.cerebro/workspace-format.json", PREPARING);
        Self { root, origin }
    }
    fn run<T>(&self, action: impl FnOnce() -> T) -> T {
        authority::with_fixture_context(
            authority::AuthorityContext::new(self.origin.clone()),
            action,
        )
    }
    fn command(&self, relative: &str) -> Result<LegacyRecordSnapshot, String> {
        self.run(|| {
            crate::read_note_source(self.root.to_str().unwrap().to_owned(), relative.to_owned())
        })
    }
    fn protected_bytes_unchanged(&self) {
        assert_eq!(
            fs::read(self.root.join("protected/retained.md")).unwrap(),
            SOURCE_B.as_bytes()
        );
        assert_eq!(
            fs::read(self.root.join("protected/.cerebro/workspace-format.json")).unwrap(),
            PREPARING.as_bytes()
        );
    }
    fn deeper_route(&self) {
        testutil::write(&self.root, "ordinary/page.md", SOURCE_A);
        fs::create_dir_all(self.root.join("protected/deep")).unwrap();
        std::os::unix::fs::symlink("../../ordinary", self.root.join("protected/deep/link"))
            .unwrap();
        std::os::unix::fs::symlink("protected/deep", self.root.join("route")).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        let _ = fs::remove_dir_all(&self.origin);
    }
}

#[test]
fn source_descriptor_survives_leaf_replacement_before_content_read() {
    let f = Fixture::new("m99-source-handoff-replaced");
    let calls = Cell::new(0);
    let source = f
        .run(|| {
            read_note_source_before_content_read(&f.root, "notes/a.md", || {
                calls.set(calls.get() + 1);
                fs::rename(f.root.join("notes/a.md"), f.root.join("notes/kept.md")).unwrap();
                std::os::unix::fs::symlink("../protected/retained.md", f.root.join("notes/a.md"))
                    .unwrap();
            })
        })
        .expect("the source reader must return the retained ordinary descriptor's exact source");
    assert_eq!(
        calls.get(),
        1,
        "the deterministic replacement callback must have run exactly once"
    );
    assert_eq!(
        fs::read(f.root.join("notes/kept.md")).unwrap(),
        SOURCE_A.as_bytes()
    );
    assert_eq!(
        fs::read_link(f.root.join("notes/a.md")).unwrap(),
        PathBuf::from("../protected/retained.md")
    );
    assert_eq!(
        fs::read(f.root.join("notes/a.md")).unwrap(),
        SOURCE_B.as_bytes(),
        "the replacement really resolves to protected B"
    );
    f.protected_bytes_unchanged();
    assert_eq!(source.content, SOURCE_A, "the source reader reopened the replaced path and consumed protected B instead of retained A");
    assert_eq!(source.hash, SOURCE_A_SHA);
}

#[test]
fn source_descriptor_no_mutation_control() {
    let f = Fixture::new("m99-source-handoff-no-mutation");
    let calls = Cell::new(0);
    let source = f
        .run(|| {
            read_note_source_before_content_read(&f.root, "notes/a.md", || {
                calls.set(calls.get() + 1);
            })
        })
        .unwrap();
    assert_eq!(calls.get(), 1);
    assert_eq!(source.content, SOURCE_A);
    assert_eq!(source.hash, SOURCE_A_SHA);
    assert_eq!(
        fs::read(f.root.join("notes/a.md")).unwrap(),
        SOURCE_A.as_bytes()
    );
    f.protected_bytes_unchanged();
}

#[test]
fn actual_source_command_preserves_bom_frontmatter_crlf_and_exact_hash() {
    let f = Fixture::new("m99-source-command-exact");
    let source = f.command("notes/a.md").unwrap();
    assert_eq!(source.content, SOURCE_A);
    assert_eq!(source.hash, SOURCE_A_SHA);
    assert_eq!(
        fs::read(f.root.join("notes/a.md")).unwrap(),
        SOURCE_A.as_bytes()
    );
    f.protected_bytes_unchanged();
}

#[test]
fn actual_source_command_refuses_preexisting_deep_alias_out_boundary() {
    let f = Fixture::new("m99-source-command-deep-refusal");
    f.deeper_route();
    assert_eq!(
        f.command("route/link/page.md").unwrap_err(),
        "Selected workspace preparation is incomplete."
    );
    assert_eq!(
        fs::read(f.root.join("ordinary/page.md")).unwrap(),
        SOURCE_A.as_bytes()
    );
    f.protected_bytes_unchanged();
}

#[test]
fn actual_source_command_preserves_unrelated_ordinary_sibling() {
    let f = Fixture::new("m99-source-command-sibling");
    f.deeper_route();
    let source = f.command("ordinary/page.md").unwrap();
    assert_eq!(source.content, SOURCE_A);
    assert_eq!(source.hash, SOURCE_A_SHA);
    f.protected_bytes_unchanged();
}

#[test]
fn source_descriptor_stable_leaf_alias_control() {
    let f = Fixture::new("m99-source-command-leaf-alias");
    std::os::unix::fs::symlink("notes/a.md", f.root.join("alias.md")).unwrap();
    let source = f.command("alias.md").unwrap();
    assert_eq!(source.content, SOURCE_A);
    assert_eq!(source.hash, SOURCE_A_SHA);
    f.protected_bytes_unchanged();
}

#[test]
fn source_descriptor_invalid_utf8_control() {
    let f = Fixture::new("m99-source-command-invalid-utf8");
    fs::write(f.root.join("notes/invalid.md"), [0xff, 0xfe]).unwrap();
    assert!(
        f.command("notes/invalid.md").is_err(),
        "invalid UTF-8 must not produce an empty or partial source snapshot"
    );
    assert_eq!(
        fs::read(f.root.join("notes/invalid.md")).unwrap(),
        [0xff, 0xfe]
    );
    f.protected_bytes_unchanged();
}
