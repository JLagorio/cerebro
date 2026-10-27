use super::*;
use crate::agent::child_jobs::types::{JobBudget, RequestedReadGrant};
use crate::mcp::WriteAsks;
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        Self(crate::vault::testutil::temp_vault("m95-freeze"))
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Fixture {
    temp: TempDir,
    root: PathBuf,
    parent: RunGrant,
    spec: ChildJobSpec,
}
impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new();
        let root = temp.path().canonicalize().unwrap();
        for folder in [
            "projects/atlas",
            "knowledge/topic",
            "private",
            "public",
            "sources/mail",
        ] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        std::fs::write(
            root.join("projects/atlas/a.md"),
            b"# Bounded local evidence\n",
        )
        .unwrap();
        std::fs::write(root.join("knowledge/topic/b.md"), b"# Second evidence\n").unwrap();
        let evidence = ["projects/atlas/a.md", "knowledge/topic/b.md"]
            .into_iter()
            .map(|path| EvidenceRef {
                path: path.into(),
                sha256: crate::ledger::sha256_hex(&std::fs::read(root.join(path)).unwrap()),
            })
            .collect();
        let parent = RunGrant {
            actor: "claude-code".into(),
            run_id: "parent".into(),
            scope: Some(vec![]),
            read_scope: Some(vec!["projects/atlas".into(), "knowledge".into()]),
            tools: Some(
                [
                    "get_note",
                    "search_notes",
                    "edit_note",
                    "hand_to",
                    "navigate",
                    "comment_on_note",
                    "WebSearch",
                    "Bash",
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            chain: vec!["claude-code".into()],
            vault: Some(root.clone()),
            asks: WriteAsks {
                kind: crate::policy::tool_approval::RunKind::Attended,
                ask_first: true,
            },
        };
        let source = crate::agent::cli_agents::preset_prompt("cerebro-researcher").unwrap();
        let spec = ChildJobSpec {
            parent_run_id: "parent".into(),
            parent_attempt_id: "attempt".into(),
            objective: "Transient objective only".into(),
            instruction_source_version: crate::ledger::sha256_hex(source.as_bytes()),
            input_evidence_refs: evidence,
            result_schema_id: "read_evidence_summary.v1".into(),
            requested_grant: RequestedReadGrant {
                read_scope: vec!["projects".into(), "knowledge/topic".into()],
            },
            budget: JobBudget {
                elapsed_seconds: 600,
                result_bytes: 262144,
            },
            deadline_at: now().unwrap() + 600,
        };
        Self {
            temp,
            root,
            parent,
            spec,
        }
    }
    fn prepare(&self) -> Result<PreparedFreeze, FreezeRefusal> {
        PreparedFreeze::prepare(&self.root, &self.parent, &self.spec)
    }
    fn one(&mut self, path: &str, body: &[u8], scope: &str) {
        std::fs::write(self.root.join(path), body).unwrap();
        self.parent.read_scope = Some(vec![scope.into()]);
        self.spec.requested_grant.read_scope = vec![scope.into()];
        self.spec.input_evidence_refs = vec![EvidenceRef {
            path: path.into(),
            sha256: crate::ledger::sha256_hex(body),
        }];
    }
}
#[test]
fn m95_freeze_contract_uses_actual_compiled_source_and_local_read_policy() {
    let fixture = Fixture::new();
    let prepared = fixture.prepare().unwrap();
    assert_eq!(prepared.read_scope, ["knowledge/topic", "projects/atlas"]);
    assert_eq!(prepared.tools, ["get_note", "search_notes"]);
    assert_eq!(
        prepared.instructions,
        crate::agent::cli_agents::preset_prompt("cerebro-researcher").unwrap()
    );
    assert_eq!(prepared.evidence.len(), 2);
    assert!(prepared
        .recheck(&fixture.root, fixture.spec.deadline_at)
        .is_ok());
    assert!(fixture.temp.path().is_dir());
    let limits = limits::load().unwrap();
    let policy: serde_json::Value = serde_json::from_str(limits::POLICY_JSON).unwrap();
    assert_eq!(
        limits.max_evidence_file_bytes,
        policy["input_bounds"]["max_evidence_file_bytes"]
            .as_u64()
            .unwrap()
    );
    assert_eq!(
        limits.max_evidence_total_bytes,
        policy["input_bounds"]["max_evidence_total_bytes"]
            .as_u64()
            .unwrap()
    );
    assert_eq!(limits.max_evidence_file_bytes, 16 * 1024 * 1024);
    assert_eq!(limits.max_evidence_total_bytes, 64 * 1024 * 1024);
}
#[test]
fn m95_freeze_none_is_unrestricted_but_empty_and_invalid_parent_axes_refuse() {
    let mut fixture = Fixture::new();
    fixture.parent.read_scope = None;
    assert_eq!(
        fixture.prepare().unwrap().read_scope,
        ["knowledge/topic", "projects"]
    );
    fixture.parent.read_scope = Some(vec![]);
    assert_eq!(fixture.prepare().err(), Some(FreezeRefusal::EmptyScope));
    fixture.parent.read_scope = Some(vec!["../private".into()]);
    assert_eq!(fixture.prepare().err(), Some(FreezeRefusal::Unavailable));
    fixture.parent.read_scope = None;
    fixture.parent.tools = Some(vec![]);
    assert_eq!(fixture.prepare().err(), Some(FreezeRefusal::EmptyTools));
    fixture.parent.tools = Some(vec!["edit_note".into(), "WebSearch".into(), "Bash".into()]);
    assert_eq!(fixture.prepare().err(), Some(FreezeRefusal::EmptyTools));
    fixture.parent.vault = None;
    assert_eq!(fixture.prepare().err(), Some(FreezeRefusal::Unavailable));
}
#[test]
fn m95_freeze_scope_intersection_is_separator_aware_and_rejects_source_changes() {
    let mut fixture = Fixture::new();
    fixture.parent.read_scope = Some(vec!["work".into()]);
    fixture.spec.requested_grant.read_scope = vec!["workspace".into()];
    assert_eq!(fixture.prepare().err(), Some(FreezeRefusal::EmptyScope));
    let mut fixture = Fixture::new();
    fixture.spec.instruction_source_version = "c".repeat(64);
    assert_eq!(fixture.prepare().err(), Some(FreezeRefusal::InvalidSource));
    let fixture = Fixture::new();
    let mut prepared = fixture.prepare().unwrap();
    prepared.instructions = "a different retained source";
    assert_eq!(
        prepared.recheck(&fixture.root, fixture.spec.deadline_at),
        Err(FreezeRefusal::InvalidSource)
    );
}
#[test]
fn m95_freeze_evidence_never_inherits_attended_mail_or_hidden_files() {
    let mut fixture = Fixture::new();
    fixture.one("sources/mail/a.md", b"mail must remain private", "sources");
    assert!(crate::mail::attended(&fixture.parent));
    assert_eq!(
        fixture.prepare().err(),
        Some(FreezeRefusal::EvidenceUnavailable)
    );
    std::fs::create_dir(fixture.root.join(".private")).unwrap();
    fixture.one(".private/a.md", b"hidden", ".private");
    assert_eq!(
        fixture.prepare().err(),
        Some(FreezeRefusal::EvidenceUnavailable)
    );
}
#[cfg(unix)]
#[test]
fn m95_freeze_evidence_checks_both_symlink_spelling_and_contained_landing() {
    let mut fixture = Fixture::new();
    fixture.one("private/a.md", b"private", "public");
    std::os::unix::fs::symlink("../private/a.md", fixture.root.join("public/alias.md")).unwrap();
    fixture.spec.input_evidence_refs[0].path = "public/alias.md".into();
    assert_eq!(
        fixture.prepare().err(),
        Some(FreezeRefusal::EvidenceUnavailable)
    );
    let outside = TempDir::new();
    std::fs::write(outside.path().join("a.md"), b"private").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("a.md"),
        fixture.root.join("public/out.md"),
    )
    .unwrap();
    fixture.spec.input_evidence_refs[0].path = "public/out.md".into();
    assert_eq!(
        fixture.prepare().err(),
        Some(FreezeRefusal::EvidenceUnavailable)
    );
    std::fs::write(fixture.root.join("public/inside.md"), b"private").unwrap();
    std::os::unix::fs::symlink("inside.md", fixture.root.join("public/in.md")).unwrap();
    fixture.spec.input_evidence_refs[0].path = "public/in.md".into();
    assert!(fixture.prepare().is_ok());
}
#[test]
fn m95_freeze_replay_refuses_content_and_same_bytes_identity_replacement() {
    let fixture = Fixture::new();
    let prepared = fixture.prepare().unwrap();
    let target = fixture.root.join(&fixture.spec.input_evidence_refs[0].path);
    let original = std::fs::read(&target).unwrap();
    std::fs::write(&target, b"changed body").unwrap();
    assert_eq!(
        prepared.recheck(&fixture.root, fixture.spec.deadline_at),
        Err(FreezeRefusal::EvidenceUnavailable)
    );
    let fixture = Fixture::new();
    let prepared = fixture.prepare().unwrap();
    let target = fixture.root.join(&fixture.spec.input_evidence_refs[0].path);
    std::fs::write(fixture.root.join("replacement.md"), original).unwrap();
    std::fs::rename(fixture.root.join("replacement.md"), target).unwrap();
    assert_eq!(
        prepared.recheck(&fixture.root, fixture.spec.deadline_at),
        Err(FreezeRefusal::EvidenceUnavailable)
    );
    assert_eq!(
        prepared.recheck(&fixture.root, now().unwrap()),
        Err(FreezeRefusal::Deadline)
    );
}
#[test]
fn m95_freeze_evidence_sparse_oversize_is_refused_before_hashing() {
    let fixture = Fixture::new();
    let target = fixture.root.join(&fixture.spec.input_evidence_refs[0].path);
    std::fs::File::create(target)
        .unwrap()
        .set_len(limits::load().unwrap().max_evidence_file_bytes + 1)
        .unwrap();
    assert_eq!(
        fixture.prepare().err(),
        Some(FreezeRefusal::EvidenceUnavailable)
    );
}
#[test]
fn m95_freeze_streaming_rechecks_growth_replacement_and_total_budget() {
    let fixture = Fixture::new();
    let scope = vec!["projects".into()];
    let reference = &fixture.spec.input_evidence_refs[0];
    let policy = limits::load().unwrap();
    let mut total = policy.max_evidence_total_bytes;
    assert_eq!(
        hash_evidence(
            &fixture.root,
            &scope,
            reference,
            fixture.spec.deadline_at,
            &policy,
            &mut total,
            || {}
        )
        .err(),
        Some(FreezeRefusal::EvidenceUnavailable)
    );
    let target = fixture.root.join(&reference.path);
    let mut once = false;
    let mut total = 0;
    let result = hash_evidence(
        &fixture.root,
        &scope,
        reference,
        fixture.spec.deadline_at,
        &policy,
        &mut total,
        || {
            if !once {
                once = true;
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&target)
                    .unwrap();
                file.write_all(b"growth").unwrap();
            }
        },
    );
    assert_eq!(result.err(), Some(FreezeRefusal::EvidenceUnavailable));
    let fixture = Fixture::new();
    let reference = &fixture.spec.input_evidence_refs[0];
    let target = fixture.root.join(&reference.path);
    let replacement = fixture.root.join("next.md");
    std::fs::write(&replacement, std::fs::read(&target).unwrap()).unwrap();
    let mut once = false;
    let mut total = 0;
    let result = hash_evidence(
        &fixture.root,
        &scope,
        reference,
        fixture.spec.deadline_at,
        &policy,
        &mut total,
        || {
            if !once {
                once = true;
                std::fs::rename(&replacement, &target).unwrap();
            }
        },
    );
    assert_eq!(result.err(), Some(FreezeRefusal::EvidenceUnavailable));
}
#[test]
fn m95_freeze_contract_digest_binds_original_allocation_source_policy_scope_and_tools() {
    let fixture = Fixture::new();
    let mut prepared = fixture.prepare().unwrap();
    let mut allocation = crate::runtime::child_jobs::Allocation {
        job_id: "a".repeat(32),
        run_id: "b".repeat(32),
        session_id: "00000000-0000-4000-8000-000000000001".into(),
        request_digest: "c".repeat(64),
        deadline_at: fixture.spec.deadline_at,
    };
    let original = prepared.digest_with_parent(&allocation, &"e".repeat(64));
    allocation.deadline_at += 1;
    assert_ne!(
        original,
        prepared.digest_with_parent(&allocation, &"e".repeat(64))
    );
    allocation.deadline_at -= 1;
    prepared.tools.push("other".into());
    assert_ne!(
        original,
        prepared.digest_with_parent(&allocation, &"e".repeat(64))
    );
    prepared.tools.pop();
    prepared.read_scope = vec!["ab".into(), "c".into()];
    let first = prepared.digest_with_parent(&allocation, &"e".repeat(64));
    prepared.read_scope = vec!["a".into(), "bc".into()];
    assert_ne!(
        first,
        prepared.digest_with_parent(&allocation, &"e".repeat(64))
    );
    let first = prepared.digest_with_parent(&allocation, &"e".repeat(64));
    prepared.policy_digest = "d".repeat(64);
    assert_ne!(
        first,
        prepared.digest_with_parent(&allocation, &"e".repeat(64))
    );
    let first = prepared.digest_with_parent(&allocation, &"e".repeat(64));
    prepared.evidence[0].sha256 = "f".repeat(64);
    assert_ne!(
        first,
        prepared.digest_with_parent(&allocation, &"e".repeat(64))
    );
}

// Removing the fail-closed parent-name validation must make these fail even
// though get_note alone would produce a nonempty effective child grant.
#[test]
fn m95_freeze_mixed_valid_and_malformed_parent_authority_refuses() {
    for invalid in [
        "",
        " ",
        "unknown_local_tool",
        "get_note,edit_note",
        "get_note(*)",
    ] {
        let mut fixture = Fixture::new();
        fixture.parent.tools = Some(vec!["get_note".into(), invalid.into()]);
        assert_eq!(
            fixture.prepare().err(),
            Some(FreezeRefusal::Unavailable),
            "{invalid:?}"
        );
    }
    for invalid in [
        "",
        "/",
        "projects//atlas",
        "projects/../private",
        " projects",
    ] {
        let mut fixture = Fixture::new();
        fixture
            .parent
            .read_scope
            .as_mut()
            .unwrap()
            .push(invalid.into());
        assert_eq!(
            fixture.prepare().err(),
            Some(FreezeRefusal::Unavailable),
            "{invalid:?}"
        );
    }
}
#[test]
fn m95_freeze_policy_identity_binds_the_actual_composed_subagent_brief() {
    let brief = crate::agent::cli_agents::subagent_brief();
    let expected = [
        include_str!("../../../../shared/prompt/product-brief.md"),
        include_str!("../../../../shared/prompt/server-instructions.md"),
        include_str!("../../../../shared/prompt/subagent-line.md"),
    ]
    .map(str::trim)
    .join("\n\n");
    assert_eq!(brief, expected);
    assert_eq!(policy_digest(), policy_digest_for_brief(&brief));
    assert_ne!(
        policy_digest(),
        policy_digest_for_brief(&(brief + " changed"))
    );
    let fixture = Fixture::new();
    let mut prepared = fixture.prepare().unwrap();
    prepared.policy_digest = policy_digest_for_brief("a stale composed brief");
    assert_eq!(
        prepared.recheck(&fixture.root, fixture.spec.deadline_at),
        Err(FreezeRefusal::InvalidSource)
    );
}
