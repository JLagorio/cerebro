#![cfg(test)]
//! Kernel/lifecycle probes through actual runtime/ReadOnly owners. These plain
//! metadata fixtures confer no authority; actual publication is tested separately.
use super::*;
use crate::runtime::{self, VaultScope};

struct Fixture {
    data: PathBuf,
    root: PathBuf,
    other: PathBuf,
    scope: VaultScope,
    writer: Connection,
    context: AuthorityContext,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let data = crate::vault::testutil::temp_vault(&format!("m97-config-{label}-data"));
        let root = crate::vault::testutil::temp_vault(&format!("m97-config-{label}-vault"));
        let other = crate::vault::testutil::temp_vault(&format!("m97-config-{label}-other"));
        let writer = runtime::open(&data).unwrap();
        let vault_id = runtime::scope::register(&writer, &root).unwrap();
        let scope = VaultScope {
            vault_id,
            store_uuid: Some("actual-fixture-store".into()),
        };
        runtime::catchup::open_session(
            &writer,
            runtime::sessions::session_id(),
            &scope.vault_id,
            scope.store_uuid.as_deref().unwrap(),
            Utc::now(),
        )
        .unwrap();
        let context = AuthorityContext::new(data.clone());
        let opening = context.begin_open().unwrap();
        context.publish_open(opening, &root).unwrap();
        let fixture = Self {
            data,
            root,
            other,
            scope,
            writer,
            context,
        };
        fixture.run("m97-config-run");
        fixture
    }
    fn run(&self, id: &str) {
        runtime::dispatch::begin_attended(
            &self.writer,
            id,
            Some(&self.scope.vault_id),
            self.scope.store_uuid.as_deref(),
            None,
            None,
            None,
            Utc::now(),
        )
        .unwrap();
    }
    fn manifest(&self, id: &str) -> RunConfigurationManifestV1 {
        let actor = SelectorIdentity {
            sha256: crate::ledger::sha256_hex(crate::mcp::DEFAULT_ACTOR.as_bytes()),
            metadata_label: None,
        };
        RunConfigurationManifestV1 {
            format: 1,
            run_id: id.into(),
            vault_id: self.scope.vault_id.clone(),
            store_uuid: self.scope.store_uuid.clone(),
            dispatched_at: runtime::now_utc(),
            effective_grant: EffectiveGrant {
                actor_id: actor.clone(),
                write_scope: ScopeAxis::Unrestricted,
                read_scope: ScopeAxis::Unrestricted,
                tools: ToolAxis::Unrestricted,
                chain: vec![actor],
                run_kind: "attended".into(),
                ask_first: false,
            },
            permission_mode: "default".into(),
            cli_tools: vec![],
            allowed_tools: vec![],
            denied_tools: vec![],
            asked_tools: vec![],
            requested_model: None,
            requested_effort: None,
            observed_model_at_dispatch: Known::Unknown {
                reason: UnknownReason::NotObservedBeforeDispatch,
            },
            observed_cli_version: Known::Unknown {
                reason: UnknownReason::NotReportedByNativeProbe,
            },
            artifacts: vec![ArtifactIdentity {
                artifact: "shared/policy/tools.v1.json".into(),
                sha256: crate::ledger::sha256_hex(include_bytes!(
                    "../../../shared/policy/tools.v1.json"
                )),
            }],
            standing_agent: Known::Unknown {
                reason: UnknownReason::NoNativeIdentityReceipt,
            },
            skills: Known::Unknown {
                reason: UnknownReason::NoNativeIdentityReceipt,
            },
            defined_subagents: vec![],
            effective_system_prompt_sha256: None,
            connectors: vec![],
            inherits_user_mcp: false,
            user_settings: Known::Unknown {
                reason: UnknownReason::InheritedUserConfiguration,
            },
            settings_hardening: false,
            seated: false,
            message_transport: "argv".into(),
            coverage: vec![
                "hash_only_instructions".into(),
                "model_not_observed_before_dispatch".into(),
            ],
        }
    }
    fn finish(self) {
        drop(self.writer);
        for path in [self.root, self.other, self.data] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
}

#[test]
fn run_configuration_immutable_record_is_read_through_actual_scoped_readonly() {
    let f = Fixture::new("immutable");
    let original = f.manifest("m97-config-run");
    let first = record_configuration(&f.writer, &original, Utc::now());
    let repeated = record_configuration(&f.writer, &original, Utc::now());
    let mut changed = original.clone();
    changed.permission_mode = "acceptEdits".into();
    let replaced = record_configuration(&f.writer, &changed, Utc::now());
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    let read = read_configuration(&ro, &ticket, "m97-config-run");
    drop(ro);
    f.finish();
    assert_eq!(
        first,
        Ok(Recorded::Stored),
        "new immutable writer is closed"
    );
    assert_eq!(repeated, Ok(Recorded::AlreadyStored));
    assert_eq!(
        replaced,
        Err(ManifestWriteError::Conflict),
        "same run accepted changed original facts"
    );
    assert_eq!(read, Ok(ConfigurationRead::Recorded { manifest: original }));
}

#[test]
fn run_configuration_read_retains_opening_epoch_across_a_b_a() {
    let f = Fixture::new("epoch");
    let original = f.manifest("m97-config-run");
    let stored = record_configuration(&f.writer, &original, Utc::now());
    let ro = ReadOnly::open(&f.data).unwrap();
    let old = capture_read_ticket(&f.context, &f.root).unwrap();
    let before = read_configuration(&ro, &old, "m97-config-run");
    let b = f.context.begin_open().unwrap();
    f.context.publish_open(b, &f.other).unwrap();
    let a = f.context.begin_open().unwrap();
    f.context.publish_open(a, &f.root).unwrap();
    let stale = read_configuration(&ro, &old, "m97-config-run");
    let fresh = capture_read_ticket(&f.context, &f.root).unwrap();
    let current = read_configuration(&ro, &fresh, "m97-config-run");
    drop(ro);
    f.finish();
    assert!(
        stored.is_ok() && matches!(before, Ok(ConfigurationRead::Recorded { .. })),
        "same-opening control unavailable"
    );
    assert_eq!(
        stale,
        Err(ConfigurationReadError::OpeningChanged),
        "path equality revived an old read"
    );
    assert!(
        matches!(current, Ok(ConfigurationRead::Recorded { .. })),
        "fresh actual opening cannot read its own manifest"
    );
}

#[test]
fn run_configuration_legacy_and_foreign_scope_never_become_recorded_or_empty() {
    let f = Fixture::new("scope");
    // Simulate a genuinely pre-migration row by using only old columns. The
    // new migration default, not the CLI-required insertion, marks it legacy.
    f.writer.execute("INSERT INTO runs (run_id,vault_id,store_uuid,mode,lane,started_at,outcome,usage_state,input_tokens,output_tokens,cache_read,cache_write,reserved_total_tokens,reserved_output_tokens,proposals_submitted,applied,rejected) VALUES ('m97-legacy',?1,?2,'attended','agent',?3,'running','pending',0,0,0,0,0,0,0,0,0)",
        rusqlite::params![f.scope.vault_id,f.scope.store_uuid,runtime::now_utc()]).unwrap();
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    let legacy = read_configuration(&ro, &ticket, "m97-legacy");
    let unknown = read_configuration(&ro, &ticket, "unknown-run");
    let generation = f.context.begin_open().unwrap();
    f.context.publish_open(generation, &f.other).unwrap();
    let foreign = capture_read_ticket(&f.context, &f.other).unwrap();
    let wrong = read_configuration(&ro, &foreign, "m97-config-run");
    drop(ro);
    f.finish();
    assert_eq!(
        legacy,
        Ok(ConfigurationRead::NotRecorded {
            reason: NotRecordedReason::Legacy
        })
    );
    assert_eq!(unknown, Err(ConfigurationReadError::WrongScope));
    assert_eq!(wrong, Err(ConfigurationReadError::WrongScope));
}

#[test]
fn run_configuration_explicit_delete_is_terminal_and_does_not_delete_run_history() {
    let f = Fixture::new("delete");
    let manifest = f.manifest("m97-config-run");
    let stored = record_configuration(&f.writer, &manifest, Utc::now());
    // Actual completion, not inference from capture time or current process slot.
    f.writer
        .execute(
            "UPDATE runs SET outcome='succeeded',ended_at=?2 WHERE run_id=?1",
            rusqlite::params![manifest.run_id, runtime::now_utc()],
        )
        .unwrap();
    let deleted = delete_configuration(&f.writer, &f.scope, &manifest.run_id, Utc::now());
    let repeat = delete_configuration(&f.writer, &f.scope, &manifest.run_id, Utc::now());
    let resurrected = record_configuration(&f.writer, &manifest, Utc::now());
    let rows: i64 = f
        .writer
        .query_row(
            "SELECT count(*) FROM runs WHERE run_id=?1",
            [&manifest.run_id],
            |r| r.get(0),
        )
        .unwrap();
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    let read = read_configuration(&ro, &ticket, &manifest.run_id);
    drop(ro);
    f.finish();
    assert!(stored.is_ok(), "new capture writer is closed");
    assert_eq!(deleted, Ok(DeleteOutcome::Deleted));
    assert_eq!(repeat, Ok(DeleteOutcome::AlreadyDeleted));
    assert_eq!(resurrected, Err(ManifestWriteError::Conflict));
    assert_eq!(rows, 1, "configuration deletion purged run history");
    assert_eq!(
        read,
        Ok(ConfigurationRead::NotRecorded {
            reason: NotRecordedReason::Deleted
        })
    );
}

#[test]
fn run_configuration_expiry_is_based_on_completion_and_pins_active_rows() {
    let f = Fixture::new("expiry");
    let completed = f.manifest("m97-config-run");
    let stored = record_configuration(&f.writer, &completed, Utc::now());
    f.run("m97-active");
    let active = f.manifest("m97-active");
    let active_stored = record_configuration(&f.writer, &active, Utc::now());
    let ended = Utc::now() - chrono::Duration::days(91);
    f.writer
        .execute(
            "UPDATE runs SET outcome='succeeded',ended_at=?2 WHERE run_id=?1",
            rusqlite::params![
                completed.run_id,
                ended.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            ],
        )
        .unwrap();
    f.writer
        .execute(
            "UPDATE runs SET started_at='2000-01-01T00:00:00.000Z' WHERE run_id=?1",
            [&active.run_id],
        )
        .unwrap();
    let pruned = prune_configuration(&f.writer, &f.scope.vault_id, Utc::now());
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    let old = read_configuration(&ro, &ticket, &completed.run_id);
    let live = read_configuration(&ro, &ticket, &active.run_id);
    drop(ro);
    f.finish();
    assert!(
        stored.is_ok() && active_stored.is_ok(),
        "new capture writer is closed"
    );
    assert!(pruned.is_ok());
    assert_eq!(
        old,
        Ok(ConfigurationRead::NotRecorded {
            reason: NotRecordedReason::Expired
        })
    );
    assert!(
        matches!(live, Ok(ConfigurationRead::Recorded { .. })),
        "old dispatch time evicted an active manifest"
    );
}

#[test]
fn run_configuration_app_maintenance_tick_expires_without_a_new_publication() {
    let f = Fixture::new("maintenance");
    let manifest = f.manifest("m97-config-run");
    let stored = record_configuration(&f.writer, &manifest, Utc::now());
    let ended = Utc::now() - chrono::Duration::days(91);
    f.writer
        .execute(
            "UPDATE runs SET outcome='succeeded',ended_at=?2 WHERE run_id=?1",
            rusqlite::params![
                manifest.run_id,
                ended.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            ],
        )
        .unwrap();
    // This is the exact consumer called by the fixed app-setup cleanup loop;
    // no new capture, read-side pruning or active vault is required.
    let tick = maintenance_tick(&f.data, Utc::now());
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    let read = read_configuration(&ro, &ticket, &manifest.run_id);
    let runs: i64 = f
        .writer
        .query_row(
            "SELECT count(*) FROM runs WHERE run_id=?1",
            [&manifest.run_id],
            |r| r.get(0),
        )
        .unwrap();
    drop(ro);
    f.finish();
    assert!(stored.is_ok(), "new immutable capture is closed");
    assert_eq!(
        tick,
        Ok(PruneReport {
            expired: 1,
            evicted: 0
        }),
        "app cleanup did not expire completed payload"
    );
    assert_eq!(
        read,
        Ok(ConfigurationRead::NotRecorded {
            reason: NotRecordedReason::Expired
        })
    );
    assert_eq!(runs, 1, "app maintenance purged run history");
}

#[test]
fn run_configuration_maintenance_never_creates_a_missing_database() {
    let data = crate::vault::testutil::temp_vault("m97-config-maintenance-missing");
    let result = maintenance_tick(&data, Utc::now());
    let created = runtime::runtime_db_path(&data).exists();
    std::fs::remove_dir_all(data).unwrap();
    assert_eq!(result, Err(ManifestWriteError::Unavailable));
    assert!(
        !created,
        "configuration maintenance created runtime storage"
    );
}

#[test]
fn run_configuration_oversize_metadata_refuses_without_changing_run_history() {
    let f = Fixture::new("oversize");
    let mut manifest = f.manifest("m97-config-run");
    // Only a fixed nonsecret metadata word is repeated. This SQL-kernel
    // negative is not a native authorization or observed-configuration proof.
    manifest.coverage = vec!["hash_only_instructions".into(); 5000];
    assert!(serde_json::to_vec(&manifest).unwrap().len() > 65536);
    let result = record_configuration(&f.writer, &manifest, Utc::now());
    let runs: i64 = f
        .writer
        .query_row(
            "SELECT count(*) FROM runs WHERE run_id=?1",
            [&manifest.run_id],
            |r| r.get(0),
        )
        .unwrap();
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    let read = read_configuration(&ro, &ticket, &manifest.run_id);
    drop(ro);
    f.finish();
    assert_eq!(result, Err(ManifestWriteError::TooLarge));
    assert_eq!(runs, 1, "size refusal purged the run");
    assert!(
        !matches!(read, Ok(ConfigurationRead::Recorded { .. })),
        "oversize payload became inspectable"
    );
}

#[test]
fn run_configuration_missing_recorded_payload_is_unavailable_not_legacy() {
    let f = Fixture::new("corrupt");
    let manifest = f.manifest("m97-config-run");
    let stored = record_configuration(&f.writer, &manifest, Utc::now());
    // Only exercise corruption once an actual writer has established the row;
    // the closed checkpoint fails its explicit new-functionality assertion.
    if stored.is_ok() {
        f.writer
            .execute(
                "DELETE FROM run_configurations WHERE run_id=?1",
                [&manifest.run_id],
            )
            .unwrap();
    }
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    let read = read_configuration(&ro, &ticket, &manifest.run_id);
    drop(ro);
    f.finish();
    assert!(stored.is_ok(), "new immutable writer is closed");
    assert_eq!(
        read,
        Err(ConfigurationReadError::Unavailable),
        "missing recorded payload was relabeled as legacy/empty"
    );
}

#[test]
fn run_configuration_actual_64mib_quota_pins_active_and_evicts_completed_only() {
    let f = Fixture::new("actual-64mib-quota");
    let identity = SelectorIdentity {
        sha256: crate::ledger::sha256_hex(b"Read"),
        metadata_label: None,
    };
    let mut template = f.manifest("m97-config-run");
    template.allowed_tools = vec![identity; 500];
    let bytes = serde_json::to_vec(&template).unwrap().len();
    assert!(
        (32_768..65_536).contains(&bytes),
        "quota fixture must use real bounded metadata, not a reduced policy"
    );
    let mut stored = Vec::new();
    let mut first_error = None;
    for index in 0..2048 {
        let id = if index == 0 {
            "m97-config-run".to_owned()
        } else {
            let id = format!("m97-active-{index:04}");
            f.run(&id);
            id
        };
        let mut value = template.clone();
        value.run_id = id.clone();
        match record_configuration(&f.writer, &value, Utc::now()) {
            Ok(_) => stored.push(id),
            Err(error) => {
                first_error = Some(error);
                break;
            }
        }
    }
    let mut bytes_within_cap = false;
    let mut kept_active = false;
    let mut new_record = None;
    let mut oldest_reason = None;
    let mut active_read = None;
    if stored.len() > 2 {
        let total: i64 = f
            .writer
            .query_row(
                "SELECT coalesce(sum(payload_bytes),0) FROM run_configurations WHERE vault_id=?1",
                [&f.scope.vault_id],
                |r| r.get(0),
            )
            .unwrap();
        bytes_within_cap = total <= 67_108_864 && total > 67_108_864 - 65_536;
        // Completion is recent: disposal must be quota, not 90-day expiry.
        let ended = Utc::now();
        f.writer
            .execute(
                "UPDATE runs SET outcome='succeeded',ended_at=?2 WHERE run_id=?1",
                rusqlite::params![
                    stored[0],
                    (ended - chrono::Duration::minutes(1))
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                ],
            )
            .unwrap();
        f.writer
            .execute(
                "UPDATE runs SET outcome='succeeded',ended_at=?2 WHERE run_id=?1",
                rusqlite::params![
                    stored[1],
                    ended.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                ],
            )
            .unwrap();
        f.run("m97-after-capacity");
        let mut next = template;
        next.run_id = "m97-after-capacity".into();
        new_record = Some(record_configuration(&f.writer, &next, Utc::now()));
        let ro = ReadOnly::open(&f.data).unwrap();
        let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
        oldest_reason = Some(read_configuration(&ro, &ticket, &stored[0]));
        active_read = Some(read_configuration(&ro, &ticket, stored.last().unwrap()));
        kept_active=f.writer.query_row("SELECT count(*) FROM run_configurations c JOIN runs r ON r.run_id=c.run_id WHERE r.outcome='running' AND r.run_id=?1",[stored.last().unwrap()],|r|r.get::<_,i64>(0)).unwrap()==1;
        drop(ro);
    }
    let runs: i64 = f
        .writer
        .query_row("SELECT count(*) FROM runs", [], |r| r.get(0))
        .unwrap();
    let captured = stored.len();
    f.finish();
    assert_eq!(
        first_error,
        Some(ManifestWriteError::ActiveCapacity),
        "required capture did not stop at actual pinned 64MiB capacity"
    );
    assert!(
        captured > 1000 && bytes_within_cap,
        "quota was bypassed or silently reduced"
    );
    assert_eq!(
        new_record,
        Some(Ok(Recorded::Stored)),
        "completed metadata did not make room"
    );
    assert_eq!(
        oldest_reason,
        Some(Ok(ConfigurationRead::NotRecorded {
            reason: NotRecordedReason::Expired
        })),
        "quota did not dispose the oldest completed payload"
    );
    assert!(
        kept_active && matches!(active_read, Some(Ok(ConfigurationRead::Recorded { .. }))),
        "quota evicted an active payload"
    );
    assert!(runs >= captured as i64, "quota purged run history");
}

#[test]
fn run_configuration_actual_deterministic_ambient_claim_stays_explicitly_uncovered() {
    let _status = runtime::status::test_lock();
    let previous = runtime::status::current();
    runtime::status::clear();
    let data = crate::vault::testutil::temp_vault("m97-configuration-deterministic-ambient");
    let (conn, vault) = runtime::dispatch::crash_fixture(&data);
    let now = chrono::DateTime::parse_from_rfc3339("2026-08-09T10:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let claimed = runtime::dispatch::claim(
        &conn,
        &vault,
        "store",
        "filed",
        runtime::budget::Reservation {
            total_tokens: 5000,
            output_tokens: 1000,
        },
        &["a.md".into()],
        Some("process:scout"),
        None,
        now,
    )
    .unwrap();
    let started = matches!(&claimed, runtime::dispatch::Dispatched::Started(_));
    let id = match claimed {
        runtime::dispatch::Dispatched::Started(lease) => Some(lease.run_id),
        _ => None,
    };
    runtime::catchup::open_session(
        &conn,
        runtime::sessions::session_id(),
        &vault,
        "store",
        Utc::now(),
    )
    .unwrap();
    let context = AuthorityContext::new(data.clone());
    let opening = context.begin_open().unwrap();
    context.publish_open(opening, &data).unwrap();
    let ro = ReadOnly::open(&data).unwrap();
    let ticket = capture_read_ticket(&context, &data).unwrap();
    // This claim has not entered spawn_run/meter::begin. It must not acquire a
    // fictional CLI capture obligation merely because it owns ambient work.
    let read = id.as_ref().map(|id| read_configuration(&ro, &ticket, id));
    drop(ro);
    drop(conn);
    std::fs::remove_dir_all(data).unwrap();
    runtime::status::set(previous);
    assert!(
        started,
        "actual generic ambient fixture did not claim its work"
    );
    assert_eq!(
        read,
        Some(Ok(ConfigurationRead::NotRecorded {
            reason: NotRecordedReason::Legacy
        })),
        "no-CLI deterministic claim was mislabeled as captured/failed/in progress"
    );
}

#[test]
fn run_configuration_actual_read_preserves_prior_artifact_digest_without_relaxing_capture() {
    let f = Fixture::new("historical-artifact");
    let original = f.manifest("m97-config-run");
    let stored = record_configuration(&f.writer, &original, Utc::now());
    let mut prior = original;
    prior.artifacts[0].sha256 = "f".repeat(64);
    let capture_prior = record_configuration(&f.writer, &prior, Utc::now());
    if stored.is_ok() {
        let bytes = serde_json::to_string(&prior).unwrap();
        f.writer
            .execute(
                "UPDATE run_configurations SET manifest_json=?2,payload_bytes=?3 WHERE run_id=?1",
                rusqlite::params![prior.run_id, bytes, bytes.len() as i64],
            )
            .unwrap();
    }
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    let read = read_configuration(&ro, &ticket, &prior.run_id);
    drop(ro);
    f.finish();
    assert!(stored.is_ok(), "capture control is closed");
    assert_eq!(
        capture_prior,
        Err(ManifestWriteError::InvalidMetadata),
        "new capture accepted a non-current artifact digest"
    );
    assert_eq!(
        read,
        Ok(ConfigurationRead::Recorded { manifest: prior }),
        "historical digest was compared with today's compiled artifact"
    );
}

#[test]
fn run_configuration_actual_read_rejects_unknown_and_path_canary_artifact_names() {
    let f = Fixture::new("historical-artifact-path");
    let original = f.manifest("m97-config-run");
    let stored = record_configuration(&f.writer, &original, Utc::now());
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    let mut results = Vec::new();
    for path in [
        "shared/policy/unrecognized.v1.json",
        "shared/policy/../M97_ARTIFACT_PATH_CANARY_7f03.json",
    ] {
        if stored.is_ok() {
            let mut changed = original.clone();
            changed.artifacts[0].artifact = path.into();
            let bytes = serde_json::to_string(&changed).unwrap();
            f.writer.execute("UPDATE run_configurations SET manifest_json=?2,payload_bytes=?3 WHERE run_id=?1",rusqlite::params![changed.run_id,bytes,bytes.len() as i64]).unwrap();
        }
        results.push(read_configuration(&ro, &ticket, &original.run_id));
    }
    drop(ro);
    f.finish();
    assert!(stored.is_ok(), "capture control is closed");
    for read in results {
        assert_eq!(
            read,
            Err(ConfigurationReadError::Unavailable),
            "unrecognized artifact name reached metadata inspection"
        );
    }
}

#[test]
fn run_configuration_registered_scope_missing_or_ambiguous_current_store_stays_unavailable() {
    let f = Fixture::new("scope-store-unavailable");
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    f.writer
        .execute(
            "DELETE FROM app_sessions WHERE session_id=?1 AND vault_id=?2",
            rusqlite::params![runtime::sessions::session_id(), f.scope.vault_id],
        )
        .unwrap();
    let missing = read_configuration(&ro, &ticket, "m97-config-run");
    for store in ["actual-fixture-store", "other-current-process-store"] {
        runtime::catchup::open_session(
            &f.writer,
            runtime::sessions::session_id(),
            &f.scope.vault_id,
            store,
            Utc::now(),
        )
        .unwrap();
    }
    let ambiguous = read_configuration(&ro, &ticket, "m97-config-run");
    drop(ro);
    f.finish();
    assert_eq!(
        missing,
        Err(ConfigurationReadError::Unavailable),
        "registered scope without a current store was mislabeled unknown"
    );
    assert_eq!(
        ambiguous,
        Err(ConfigurationReadError::Unavailable),
        "ambiguous current store was selected or mislabeled unknown"
    );
}

#[test]
fn run_configuration_terminal_unknown_completion_is_unavailable_while_active_null_is_recorded() {
    let f = Fixture::new("terminal-unknown-completion");
    let manifest = f.manifest("m97-config-run");
    let stored = record_configuration(&f.writer, &manifest, Utc::now());
    let ro = ReadOnly::open(&f.data).unwrap();
    let ticket = capture_read_ticket(&f.context, &f.root).unwrap();
    let active = read_configuration(&ro, &ticket, &manifest.run_id);
    // Malformed/incomplete-row injection, not an ordinary producer failure:
    // all actual new terminal producers stamp ended_at. Unknown age must not
    // become either a fabricated expiry or indefinite readable retention.
    f.writer
        .execute(
            "UPDATE runs SET outcome='succeeded',ended_at=NULL WHERE run_id=?1",
            [&manifest.run_id],
        )
        .unwrap();
    let terminal = read_configuration(&ro, &ticket, &manifest.run_id);
    let kept: i64 = f
        .writer
        .query_row(
            "SELECT count(*) FROM run_configurations WHERE run_id=?1",
            [&manifest.run_id],
            |r| r.get(0),
        )
        .unwrap();
    drop(ro);
    f.finish();
    assert!(stored.is_ok());
    assert!(
        matches!(active, Ok(ConfigurationRead::Recorded { .. })),
        "active null completion lost its pinned manifest"
    );
    assert_eq!(
        terminal,
        Err(ConfigurationReadError::Unavailable),
        "terminal unknown completion bypassed bounded retention visibility"
    );
    assert_eq!(
        kept, 1,
        "unknown completion invented an age and deleted payload"
    );
}
