//! Real synchronous publication with an isolated, provider-free executable.
use super::*;
use crate::vault::testutil;
use crate::workspace_service::authority::AuthorityContext;
#[cfg(target_os = "macos")]
use rusqlite::OptionalExtension;
use std::os::unix::fs::PermissionsExt;
use std::time::Instant;

struct Fixture {
    home: PathBuf,
    vault: PathBuf,
    config: PathBuf,
    cli: readiness::Observation,
    request: AgentRequest,
    session: CliSession,
    meter: meter::Meter,
    approval: crate::policy::tool_approval::RunApproval,
    agents: cli_agents::RunAgents,
}
impl Fixture {
    fn new(vault: &Path, request: Option<&AgentRequest>, private_interpreter: bool) -> Self {
        let home = testutil::temp_vault("m99-real-publication");
        let binary = home.join("claude");
        let interpreter = if private_interpreter {
            let interpreter = home.join("interpreter");
            std::os::unix::fs::symlink("/bin/sh", &interpreter).unwrap();
            interpreter.to_string_lossy().into_owned()
        } else {
            "/bin/sh".into()
        };
        std::fs::write(&binary, format!("#!{interpreter}\nif [ \"$1\" = \"--version\" ]; then printf '2.1.250\\n'; exit 0; fi\nprintf started > \"$0.spawned\"\nprintf '{{\"type\":\"system\",\"subtype\":\"init\"}}\\n'\n/bin/sleep 30\n")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cli = readiness::test_support::fixture_observation(&binary);
        let mut request = request.cloned().unwrap_or_else(|| {
            serde_json::from_value(serde_json::json!({
                "message":"", "attended":true, "connectors":false
            }))
            .unwrap()
        });
        // Empty words keep this resource test on argv; stdin ownership has its
        // own native lifecycle suite. The executable never reads credentials.
        request.message.clear();
        request.mcp_url = Some("http://127.0.0.1:1/mcp".into());
        request.mcp_token = Some("isolated-publication-fixture".into());
        let data = home.join("runtime");
        std::fs::create_dir_all(&data).unwrap();
        crate::runtime::open(&data).unwrap();
        let meter = meter::Meter {
            data_dir: data,
            run_id: crate::ledger::new_run_id(),
            mode: meter::Mode::Attended,
            vault_id: None,
            store_uuid: None,
            started_at: chrono::Utc::now(),
            elapsed_limit_seconds: None,
            actor: Some(crate::mcp::DEFAULT_ACTOR.into()),
            parent_run_id: None,
            cause: None,
        };
        let session = CliSession::for_request(None, None).unwrap();
        let approval = crate::policy::tool_approval::plan_for(&request, true);
        Self {
            config: home.join("run-configs"),
            home,
            vault: vault.to_path_buf(),
            cli,
            request,
            session,
            meter,
            approval,
            agents: cli_agents::RunAgents::default(),
        }
    }
    fn publish<'a>(
        &self,
        state: &'a AgentState,
        preparation: &RunPreparation,
    ) -> Result<publication::Published<'a>, String> {
        // Existing controls remain explicit uncovered legacy publication. New
        // required-capture tests pass the real endpoint to the same core below.
        self.publish_with_configuration(state, preparation, None)
    }
    fn publish_with_configuration<'a>(
        &self,
        state: &'a AgentState,
        preparation: &RunPreparation,
        endpoint: Option<&crate::mcp::McpState>,
    ) -> Result<publication::Published<'a>, String> {
        publication::publish(publication::Input {
            state,
            preparation,
            vault: &self.vault,
            request: &self.request,
            cli: &self.cli,
            session: &self.session,
            config_dir: &self.config,
            meter: Some(&self.meter),
            configuration_mcp: endpoint,
            seat: Some((&self.meter.run_id, self.cli.version.as_deref())),
            pending: None,
            resumes_a_deferral: false,
            approval: &self.approval,
            agents: &self.agents,
        })
    }
    fn assert_absent(&self, state: &AgentState) {
        if self.config.is_dir() {
            assert!(std::fs::read_dir(&self.config).unwrap().next().is_none());
        }
        assert!(!self.home.join("claude.spawned").exists());
        assert_eq!(state.live(), 0);
        assert!(state.journal.vaults().is_empty());
        assert!(state
            .interactions
            .ask_plan(&self.meter.run_id, &[], self.cli.version.as_deref())
            .is_empty());
        let conn = crate::runtime::open_existing(&self.meter.data_dir).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM runs WHERE run_id=?1",
                [&self.meter.run_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "refused publication retained a meter row");
        let attempts: i64 = conn
            .query_row("SELECT count(*) FROM chat_parent_attempts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            attempts, 0,
            "refused publication retained parent-attempt metadata"
        );
    }
    fn assert_published(&self, state: &AgentState, started: &Started) {
        assert!(started.config_path.is_file());
        assert!(started.settings_path.as_ref().unwrap().is_file());
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&started.config_path).unwrap()).unwrap();
        assert_eq!(
            config["mcpServers"]["cerebro"]["url"],
            "http://127.0.0.1:1/mcp"
        );
        assert!(state.interactions.lists_prompt_tool(&self.meter.run_id));
        assert_eq!(state.live(), 1);
        assert!(matches!(
            state.events_since(started.run, &self.meter.run_id, 0),
            journal::EventsSince::Held { done: false, .. }
        ));
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.home.join("claude.spawned").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            self.home.join("claude.spawned").is_file(),
            "the real toy executable never started"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn reap(state: &AgentState, started: Started, run_id: &str, terminate: bool) {
    let Started {
        run,
        config_path,
        settings_path,
        supervised,
        stdout,
        input,
        books,
        ..
    } = started;
    // Hold stdout until reap; a tiny fixture write must not get a test-induced
    // broken pipe instead of the selected process stop being exercised.
    let _stdout = stdout;
    drop(input);
    if terminate {
        supervised.handle().terminate(Duration::ZERO);
    }
    let _ = supervised.finish(TAIL_WAIT);
    state.interactions.close_seat(run_id);
    state.journal.finish(run, Instant::now());
    state.finish(run);
    let _ = std::fs::remove_file(config_path);
    if let Some(path) = settings_path {
        let _ = std::fs::remove_file(path);
    }
    drop(books);
}

fn open(context: &AuthorityContext, state: &AgentState, root: &Path) {
    let number = context.begin_open().unwrap();
    state.begin_open(number).unwrap();
    crate::finish_legacy_open(context, number, root, state, || {}).unwrap();
}

/// Used by the actual thread-turn preparation regression, with that caller's
/// real prepared request and unchanged entry ticket.
pub(super) fn assert_stale_thread_request_cannot_publish(
    state: &AgentState,
    preparation: &RunPreparation,
    vault: &Path,
    request: &AgentRequest,
) -> String {
    let fixture = Fixture::new(vault, Some(request), false);
    let refusal = match fixture.publish(state, preparation) {
        Err(error) => error,
        Ok(published) => {
            let publication::Published { started, guard, .. } = published;
            drop(guard);
            reap(state, started, &fixture.meter.run_id, true);
            panic!("retired thread preparation published a real run")
        }
    };
    fixture.assert_absent(state);
    refusal
}

#[test]
fn real_publication_refuses_a_stale_roundtrip_before_seat_config_child_slot_or_journal() {
    let _sink = crate::runtime::sink::test_lock();
    let _shadow = crate::ledger::shadow::testing::lock();
    let vault = testutil::temp_vault("m99-publication-stale-vault");
    let origin = testutil::temp_vault("m99-publication-stale-origin");
    let context = AuthorityContext::new(origin.clone());
    let state = AgentState::default();
    open(&context, &state, &vault);
    let preparation = state.prepare_run(&vault).unwrap();
    let fixture = Fixture::new(&vault, None, false);
    crate::suspend_legacy_for_selected(&Default::default(), &Default::default(), &state).unwrap();
    open(&context, &state, &vault);
    assert!(fixture.publish(&state, &preparation).is_err());
    fixture.assert_absent(&state);
    // A fresh request in the reopened Legacy root really publishes all resources.
    let fresh = state.prepare_run(&vault).unwrap();
    let publication::Published { started, guard, .. } = fixture.publish(&state, &fresh).unwrap();
    fixture.assert_published(&state, &started);
    drop(guard);
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    std::fs::remove_dir_all(origin).unwrap();
}

#[test]
fn selected_suspension_stops_and_reaps_a_real_run_published_first() {
    let _sink = crate::runtime::sink::test_lock();
    let _shadow = crate::ledger::shadow::testing::lock();
    let vault = testutil::temp_vault("m99-publication-live-vault");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let fixture = Fixture::new(&vault, None, false);
    let publication::Published { started, guard, .. } =
        fixture.publish(&state, &preparation).unwrap();
    fixture.assert_published(&state, &started);
    let run = started.run;
    let run_id = fixture.meter.run_id.clone();
    let reader_state = state.clone();
    drop(guard);
    let reader = std::thread::spawn(move || reap(&reader_state, started, &run_id, false));
    let before = Instant::now();
    crate::suspend_legacy_for_selected(&Default::default(), &Default::default(), &state).unwrap();
    assert!(before.elapsed() < STOP_GRACE + EXIT_BOOKS_WAIT + Duration::from_secs(1));
    reader.join().unwrap();
    assert_eq!(state.live(), 0);
    assert_eq!(
        state.events_since(run, &fixture.meter.run_id, 0),
        journal::EventsSince::Unknown
    );
    assert!(std::fs::read_dir(&fixture.config).unwrap().next().is_none());
    assert!(state
        .interactions
        .ask_plan(&fixture.meter.run_id, &[], fixture.cli.version.as_deref())
        .is_empty());
    std::fs::remove_dir_all(vault).unwrap();
}

#[test]
fn real_publication_config_and_child_spawn_failures_close_the_seat_and_meter() {
    for bad_config in [true, false] {
        let vault = testutil::temp_vault("m99-publication-refusal-vault");
        let state = AgentState::default();
        let preparation = state.prepare_run(&vault).unwrap();
        let fixture = Fixture::new(&vault, None, !bad_config);
        if bad_config {
            std::fs::write(&fixture.config, "occupied").unwrap();
        } else {
            std::fs::remove_file(fixture.home.join("interpreter")).unwrap();
        }
        assert!(fixture.publish(&state, &preparation).is_err());
        fixture.assert_absent(&state);
        std::fs::remove_dir_all(vault).unwrap();
    }
}

#[test]
fn quit_after_real_child_before_slot_takes_back_publication_resources() {
    let vault = testutil::temp_vault("m99-publication-quit-vault");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let fixture = Fixture::new(&vault, None, false);
    let closing = state.clone();
    let result = with_before_insert_for_test(
        move || {
            closing.shut_down();
        },
        || fixture.publish(&state, &preparation),
    );
    assert!(result.is_err());
    // The child may have begun before quit won the slot. It is now reaped and
    // its real config/settings, seat, slot, journal and meter are gone.
    if fixture.config.is_dir() {
        assert!(std::fs::read_dir(&fixture.config).unwrap().next().is_none());
    }
    assert_eq!(state.live(), 0);
    assert!(state.journal.vaults().is_empty());
    assert!(state
        .interactions
        .ask_plan(&fixture.meter.run_id, &[], fixture.cli.version.as_deref())
        .is_empty());
    let conn = crate::runtime::open_existing(&fixture.meter.data_dir).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM runs WHERE run_id=?1",
            [&fixture.meter.run_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    std::fs::remove_dir_all(vault).unwrap();
}

// Real production publication and actual token mint/constant-time resolve.
// These probe sealed receipts and pending slot metadata, not native owner/window
// authentication, V35 admission, callable actions or an OS user gesture.
#[test]
fn real_publication_emits_a_sealed_receipt_only_after_child_slot_and_journal() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m96-real-publication-receipt");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let mut fixture = Fixture::new(&vault, None, false);
    let mcp = transport::without_socket();
    let (token, reservation) = transport::reserve_root(&mcp, &fixture.meter.run_id, &vault);
    fixture.request.mcp_token = Some(token.clone());
    let published = fixture.publish(&state, &preparation).unwrap();
    fixture.assert_published(&state, &published.started);
    let receipt = published.native_receipt();
    let has_receipt = receipt.is_some();
    let staged = receipt
        .as_ref()
        .is_some_and(|receipt| transport::stage_publication(&mcp, &reservation, receipt));
    let before_stop = transport::pending_binding(&mcp, &token);
    // Stop uses the actual source slot. Its metadata must cease immediately,
    // before any later reaper-driven MCP revocation; no revoke occurs here.
    assert!(state.stop(published.started.run).unwrap());
    let after_stop = transport::pending_binding(&mcp, &token);
    let publication::Published { started, guard, .. } = published;
    drop(guard);
    reap(&state, started, &fixture.meter.run_id, true);
    let reader = crate::runtime::ReadOnly::open(&fixture.meter.data_dir).unwrap();
    assert_eq!(
        reader
            .query_row("SELECT count(*) FROM action_account_grants", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        has_receipt,
        "actual successful publication returned no sealed native publication receipt"
    );
    assert!(
        staged && before_stop,
        "real publication metadata was unavailable before Stop"
    );
    assert!(
        !after_stop,
        "publication metadata survived the actual source Stop"
    );
}

#[test]
fn real_publication_pending_binding_is_exact_slot_and_ends_before_legacy_grace() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m96-real-publication-exact-slot");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let mut fixture = Fixture::new(&vault, None, false);
    let mcp = transport::without_socket();
    let (token, reservation) = transport::reserve_root(&mcp, &fixture.meter.run_id, &vault);
    fixture.request.mcp_token = Some(token.clone());
    let published = fixture.publish(&state, &preparation).unwrap();
    fixture.assert_published(&state, &published.started);
    let staged = published
        .native_receipt()
        .is_some_and(|receipt| transport::stage_publication(&mcp, &reservation, &receipt));
    let original_pending = transport::pending_binding(&mcp, &token);
    // A second REAL public legacy mint has the exact same run/actor/root, but
    // no native slot reservation. It must never inherit the first binding.
    let remint = mcp
        .run_token(
            Some(crate::mcp::DEFAULT_ACTOR),
            None,
            None,
            None,
            fixture.meter.run_id.clone(),
            &vault,
            crate::mcp::WriteAsks::UNASKED,
        )
        .unwrap();
    let remint_pending = transport::pending_binding(&mcp, &remint);
    assert!(transport::legacy_resolves(&mcp, &token));
    assert!(transport::legacy_resolves(&mcp, &remint));
    mcp.revoke(&token, crate::mcp::REVOKE_GRACE);
    let after_revoke = transport::pending_binding(&mcp, &token);
    let legacy_in_grace = transport::legacy_resolves(&mcp, &token);
    // All cleanup precedes expected RED assertions: no failing test leaves a
    // real child, configuration, seat, journal or run slot behind.
    let publication::Published { started, guard, .. } = published;
    drop(guard);
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        staged && original_pending,
        "actual publication was not bound to its exact reserved token slot"
    );
    assert!(
        !remint_pending,
        "public legacy remint inherited native metadata by run ID"
    );
    assert!(
        !after_revoke,
        "native pending binding survived immediate revocation"
    );
    assert!(
        legacy_in_grace,
        "native metadata retirement erased accepted legacy write grace"
    );
}

// These new APIs are deliberately closed for root's RED checkpoint. They are
// scaffolding evidence, not a preexisting regression or native OS authentication.
// Each test publishes/reaps a real supervised toy child and uses actual MCP
// mints. No RunGrant, Seat, receipt or window/storage proof is fabricated.
fn reserve_original_slot(
    mcp: &crate::mcp::McpState,
    fixture: &Fixture,
) -> (String, Option<crate::mcp::NativeSlotWitness>) {
    mcp.run_token_with_native_slot(
        fixture.request.actor.as_deref(),
        fixture.request.scope.clone(),
        fixture.request.read_scope.clone(),
        None,
        fixture.meter.run_id.clone(),
        &fixture.vault,
        crate::mcp::WriteAsks::of(&fixture.request),
    )
    .unwrap()
}
fn current_original_receipt(
    mcp: &crate::mcp::McpState,
    witness: Option<&crate::mcp::NativeSlotWitness>,
) -> Option<Arc<NativePublicationReceipt>> {
    witness.and_then(|witness| mcp.current_native_publication(witness))
}

// Checking only owner/root/generation would accept a different preparation
// from the same opening. Copying request.session_id would retain caller text.
#[test]
fn native_producer_original_entry_is_required_after_actual_publication() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m96-original-entry");
    let other_vault = testutil::temp_vault("m96-other-entry-root");
    let origin = testutil::temp_vault("m96-entry-opening-origin");
    let context = AuthorityContext::new(origin.clone());
    let state = AgentState::default();
    open(&context, &state, &vault);
    let preparation = state.prepare_run(&vault).unwrap();
    let mut fixture = Fixture::new(&vault, None, false);
    fixture.request.session_id = Some("caller-provided-description".into());
    let mcp = transport::without_socket();
    let (token, _) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token);
    let published = fixture.publish(&state, &preparation).unwrap();
    let publication::Published {
        started,
        guard,
        receipt,
    } = published;
    drop(guard);
    let fresh = state.prepare_run(&vault).unwrap();
    let foreign = AgentState::default();
    let original_matches = receipt
        .as_ref()
        .is_some_and(|receipt| state.matches_publication_entry(&preparation, &vault, receipt));
    let fresh_matches = receipt
        .as_ref()
        .is_some_and(|receipt| state.matches_publication_entry(&fresh, &vault, receipt));
    let foreign_matches = receipt
        .as_ref()
        .is_some_and(|receipt| foreign.matches_publication_entry(&preparation, &vault, receipt));
    let wrong_root_matches = receipt.as_ref().is_some_and(|receipt| {
        state.matches_publication_entry(&preparation, &other_vault, receipt)
    });
    let actual_session_retained = receipt
        .as_ref()
        .is_some_and(|receipt| receipt.cli_session_id() == Some(fixture.session.id()));
    // Same physical root, different actual opening; no fresh capture may revive
    // the original publication. This uses the real M99/AuthorityContext gates.
    open(&context, &state, &vault);
    let reopened = state.prepare_run(&vault).unwrap();
    let stale_matches = receipt
        .as_ref()
        .is_some_and(|receipt| state.matches_publication_entry(&preparation, &vault, receipt));
    let recaptured_matches = receipt
        .as_ref()
        .is_some_and(|receipt| state.matches_publication_entry(&reopened, &vault, receipt));
    reap(&state, started, &fixture.meter.run_id, true);
    for path in [&vault, &other_vault, &origin] {
        std::fs::remove_dir_all(path).unwrap();
    }
    assert!(
        original_matches,
        "actual publication lost its original entry"
    );
    assert!(
        actual_session_retained,
        "receipt did not retain the actual checked CliSession"
    );
    assert!(
        !fresh_matches,
        "same-opening fresh preparation replaced the original entry"
    );
    assert!(
        !foreign_matches,
        "another AgentState accepted the publication"
    );
    assert!(
        !wrong_root_matches,
        "publication was accepted for another root"
    );
    assert!(
        !stale_matches && !recaptured_matches,
        "same-path reopening revived the old entry"
    );
}

// A run-ID join would lend the original receipt to a fresh actual mint. A book
// content-only join would carry it across replacement of the actual listener.
#[test]
fn native_producer_exact_mint_and_listener_select_only_the_original_publication() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m96-original-slot");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let mut fixture = Fixture::new(&vault, None, false);
    let mcp = transport::without_socket();
    let (token, witness) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token.clone());
    let before_publication = current_original_receipt(&mcp, witness.as_ref()).is_some();
    let published = fixture.publish(&state, &preparation).unwrap();
    let publication::Published {
        started,
        guard,
        receipt,
    } = published;
    drop(guard);
    let before_stage = current_original_receipt(&mcp, witness.as_ref()).is_some();
    let staged = receipt
        .as_ref()
        .is_some_and(|receipt| mcp.stage_actual_publication(receipt));
    let selected = current_original_receipt(&mcp, witness.as_ref());
    let original_selected = selected
        .as_ref()
        .zip(receipt.as_ref())
        .is_some_and(|(actual, expected)| actual.same_publication(expected));
    let (_, remint_witness) = reserve_original_slot(&mcp, &fixture);
    let remint_selected = current_original_receipt(&mcp, remint_witness.as_ref()).is_some();
    let public_remint = mcp
        .run_token(
            fixture.request.actor.as_deref(),
            fixture.request.scope.clone(),
            fixture.request.read_scope.clone(),
            None,
            fixture.meter.run_id.clone(),
            &vault,
            crate::mcp::WriteAsks::of(&fixture.request),
        )
        .unwrap();
    let public_remint_pending = transport::pending_binding(&mcp, &public_remint);
    let legacy_original = transport::legacy_resolves(&mcp, &token);
    let legacy_remint = transport::legacy_resolves(&mcp, &public_remint);
    transport::replace_listener_preserving_entries(&mcp);
    let after_listener_change = current_original_receipt(&mcp, witness.as_ref()).is_some();
    let legacy_after_change = transport::legacy_resolves(&mcp, &token);
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        witness.is_some(),
        "actual root mint emitted no sealed slot witness"
    );
    assert!(
        !before_publication && !before_stage,
        "mint alone supplied a publication receipt"
    );
    assert!(
        staged && original_selected,
        "exact actual slot did not select its real publication"
    );
    assert!(
        remint_witness.is_some(),
        "control mint did not emit its own distinct witness"
    );
    assert!(
        !remint_selected && !public_remint_pending,
        "remint inherited a receipt by run ID"
    );
    assert!(
        !after_listener_change,
        "old witness accepted another listener with copied descriptive entries"
    );
    assert!(
        legacy_original && legacy_remint && legacy_after_change,
        "descriptive witness handling changed valid legacy resolution"
    );
}

// Native provenance lookup must retire on any revoke marker, while the legacy
// bearer remains accepted for its original queued-write grace.
#[test]
fn native_producer_original_slot_revoke_retires_receipt_before_legacy_grace() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m96-slot-revoke");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let mut fixture = Fixture::new(&vault, None, false);
    let mcp = transport::without_socket();
    let (token, witness) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token.clone());
    let published = fixture.publish(&state, &preparation).unwrap();
    let publication::Published {
        started,
        guard,
        receipt,
    } = published;
    drop(guard);
    let staged = receipt
        .as_ref()
        .is_some_and(|receipt| mcp.stage_actual_publication(receipt));
    let before = current_original_receipt(&mcp, witness.as_ref()).is_some();
    mcp.revoke(&token, crate::mcp::REVOKE_GRACE);
    let after = current_original_receipt(&mcp, witness.as_ref()).is_some();
    let legacy_grace = transport::legacy_resolves(&mcp, &token);
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        staged && before,
        "real slot receipt was unavailable before revoke"
    );
    assert!(
        !after,
        "original receipt survived immediate native revocation"
    );
    assert!(
        legacy_grace,
        "native retirement erased legacy queued-write grace"
    );
}

// Looking only at cached metadata or entry generation would ignore actual Stop.
#[test]
fn native_producer_original_slot_stop_retires_receipt_without_mcp_revoke() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m96-slot-stop");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let mut fixture = Fixture::new(&vault, None, false);
    let mcp = transport::without_socket();
    let (token, witness) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token.clone());
    let published = fixture.publish(&state, &preparation).unwrap();
    let publication::Published {
        started,
        guard,
        receipt,
    } = published;
    drop(guard);
    let staged = receipt
        .as_ref()
        .is_some_and(|receipt| mcp.stage_actual_publication(receipt));
    let before = current_original_receipt(&mcp, witness.as_ref()).is_some();
    let stop_reported = state.stop(started.run).unwrap();
    let after = current_original_receipt(&mcp, witness.as_ref()).is_some();
    let stopped_entry_matches = receipt
        .as_ref()
        .is_some_and(|receipt| state.matches_publication_entry(&preparation, &vault, receipt));
    let legacy_still_resolves = transport::legacy_resolves(&mcp, &token);
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        staged && before,
        "real slot receipt was unavailable before Stop"
    );
    assert!(stop_reported, "actual live source slot did not accept Stop");
    assert!(
        !after && !stopped_entry_matches,
        "actual source Stop retained a usable receipt"
    );
    assert!(
        legacy_still_resolves,
        "Stop metadata check changed unrevoked legacy token state"
    );
}

// Real publication -> retained-connection SQL integration only. This does not
// authenticate an injected desktop window or manufacture a NativeRootEntry.
#[cfg(target_os = "macos")]
fn scoped_native_sql_fixture(vault: &Path) -> (Fixture, crate::runtime::VaultScope) {
    let mut fixture = Fixture::new(vault, None, false);
    fixture.session =
        CliSession::for_request(Some("00000000-0000-4000-8000-000000000032"), None).unwrap();
    let store = crate::ledger::store::load_or_mint(&crate::ledger::ledger_dir(vault)).unwrap();
    let conn = crate::runtime::open_existing(&fixture.meter.data_dir).unwrap();
    let vault_id = crate::runtime::scope::register(&conn, vault).unwrap();
    crate::runtime::catchup::open_session(
        &conn,
        crate::runtime::sessions::session_id(),
        &vault_id,
        &store.store_id,
        chrono::Utc::now(),
    )
    .unwrap();
    fixture.meter.vault_id = Some(vault_id.clone());
    fixture.meter.store_uuid = Some(store.store_id.clone());
    (
        fixture,
        crate::runtime::VaultScope {
            vault_id,
            store_uuid: Some(store.store_id),
        },
    )
}

// Removing exact one-row CAS or same-authority check creates duplicate/adopted
// rows; copying a caller's session instead of the real receipt breaks the join.
#[cfg(target_os = "macos")]
#[test]
fn native_provenance_sql_records_actual_publication_once_without_inheriting_authority() {
    use crate::actions::native_owner::tests::PublicationSqlOwner;
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m96-provenance-sql-positive")
        .canonicalize()
        .unwrap();
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let (mut fixture, scope) = scoped_native_sql_fixture(&vault);
    let mut owner = PublicationSqlOwner::open(&fixture.meter.data_dir);
    let mcp = transport::without_socket();
    let (token, slot) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token);
    let publication::Published {
        started,
        guard,
        receipt,
    } = fixture.publish(&state, &preparation).unwrap();
    drop(guard);
    let staged = receipt
        .as_ref()
        .is_some_and(|r| mcp.stage_actual_publication(r));
    let selected = current_original_receipt(&mcp, slot.as_ref());
    let authority = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let result = selected
        .as_ref()
        .map(|r| owner.record(&vault, &scope, r, authority));
    let repeated = selected
        .as_ref()
        .map(|r| owner.record(&vault, &scope, r, authority));
    let other = selected
        .as_ref()
        .map(|r| owner.record(&vault, &scope, r, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    let conn = crate::runtime::open_existing(&fixture.meter.data_dir).unwrap();
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM action_native_runs", [], |r| r.get(0))
        .unwrap();
    let stored: Option<(String, String)> = conn
        .query_row(
            "SELECT authority_id,cli_session_id FROM action_native_runs WHERE run_id=?1",
            [&fixture.meter.run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap();
    let grants: i64 = conn
        .query_row("SELECT count(*) FROM action_account_grants", [], |r| {
            r.get(0)
        })
        .unwrap();
    drop(conn);
    drop(owner);
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        staged && selected.is_some(),
        "actual exact publication receipt was absent"
    );
    assert_eq!(
        result,
        Some(Ok(())),
        "actual publication SQL registration failed"
    );
    assert_eq!(
        repeated,
        Some(Ok(())),
        "same immutable candidate was not idempotent"
    );
    assert!(
        other.is_some_and(|r| r.is_err()),
        "another authority adopted existing provenance"
    );
    assert_eq!(rows, 1);
    assert_eq!(
        stored,
        Some((
            authority.into(),
            "00000000-0000-4000-8000-000000000032".into()
        ))
    );
    assert_eq!(
        grants, 0,
        "provenance registration created an account grant"
    );
}

// A legacy UPDATE Ok for zero rows cannot register a nonexistent run.
#[cfg(target_os = "macos")]
#[test]
fn native_provenance_sql_refuses_actual_missing_run_without_creating_rows() {
    use crate::actions::native_owner::tests::PublicationSqlOwner;
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m96-provenance-sql-missing")
        .canonicalize()
        .unwrap();
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let (mut fixture, scope) = scoped_native_sql_fixture(&vault);
    let mut owner = PublicationSqlOwner::open(&fixture.meter.data_dir);
    let mcp = transport::without_socket();
    let (token, slot) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token);
    let publication::Published {
        started,
        guard,
        receipt,
    } = fixture.publish(&state, &preparation).unwrap();
    drop(guard);
    let staged = receipt
        .as_ref()
        .is_some_and(|r| mcp.stage_actual_publication(r));
    let selected = current_original_receipt(&mcp, slot.as_ref());
    let conn = crate::runtime::open_existing(&fixture.meter.data_dir).unwrap();
    conn.execute("DELETE FROM runs WHERE run_id=?1", [&fixture.meter.run_id])
        .unwrap();
    let result = selected
        .as_ref()
        .map(|r| owner.record(&vault, &scope, r, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    let native: i64 = conn
        .query_row("SELECT count(*) FROM action_native_runs", [], |r| r.get(0))
        .unwrap();
    let runs: i64 = conn
        .query_row("SELECT count(*) FROM runs", [], |r| r.get(0))
        .unwrap();
    drop(conn);
    drop(owner);
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        staged && selected.is_some(),
        "control publication did not exist"
    );
    assert!(
        result.is_some_and(|r| r.is_err()),
        "zero-row CLI update was accepted as durability"
    );
    assert_eq!(
        (runs, native),
        (0, 0),
        "registration invented or retained missing-run provenance"
    );
}

// The real actor/session/process join must refuse and roll back tentative CLI
// binding plus native insert together; observations are made after rollback.
#[cfg(target_os = "macos")]
#[test]
fn native_provenance_sql_refuses_changed_actual_joins_and_rolls_back_cli_binding() {
    use crate::actions::native_owner::tests::PublicationSqlOwner;
    use crate::mcp::native_publication_test_support as transport;
    for changed in ["actor", "cli", "store", "process"] {
        let vault = testutil::temp_vault("m96-provenance-sql-wrong-join")
            .canonicalize()
            .unwrap();
        let state = AgentState::default();
        let preparation = state.prepare_run(&vault).unwrap();
        let (mut fixture, scope) = scoped_native_sql_fixture(&vault);
        let mut owner = PublicationSqlOwner::open(&fixture.meter.data_dir);
        let mcp = transport::without_socket();
        let (token, slot) = reserve_original_slot(&mcp, &fixture);
        fixture.request.mcp_token = Some(token);
        let publication::Published {
            started,
            guard,
            receipt,
        } = fixture.publish(&state, &preparation).unwrap();
        drop(guard);
        let staged = receipt
            .as_ref()
            .is_some_and(|r| mcp.stage_actual_publication(r));
        let selected = current_original_receipt(&mcp, slot.as_ref());
        let conn = crate::runtime::open_existing(&fixture.meter.data_dir).unwrap();
        conn.execute(
            "UPDATE runs SET cli_session_id=NULL WHERE run_id=?1",
            [&fixture.meter.run_id],
        )
        .unwrap();
        match changed {
            "actor" => {
                conn.execute(
                    "UPDATE runs SET actor='process:other' WHERE run_id=?1",
                    [&fixture.meter.run_id],
                )
                .unwrap();
            }
            "cli" => {
                conn.execute("UPDATE runs SET cli_session_id='11111111-1111-4111-8111-111111111111' WHERE run_id=?1", [&fixture.meter.run_id]).unwrap();
            }
            "store" => {
                conn.execute(
                    "UPDATE runs SET store_uuid='different-existing-run-store' WHERE run_id=?1",
                    [&fixture.meter.run_id],
                )
                .unwrap();
            }
            "process" => {
                conn.execute(
                    "UPDATE app_sessions SET close_precision='heartbeat_lower_bound'",
                    [],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        let result = selected
            .as_ref()
            .map(|r| owner.record(&vault, &scope, r, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        let native: i64 = conn
            .query_row("SELECT count(*) FROM action_native_runs", [], |r| r.get(0))
            .unwrap();
        let cli: Option<String> = conn
            .query_row(
                "SELECT cli_session_id FROM runs WHERE run_id=?1",
                [&fixture.meter.run_id],
                |r| r.get(0),
            )
            .unwrap();
        drop(conn);
        drop(owner);
        reap(&state, started, &fixture.meter.run_id, true);
        std::fs::remove_dir_all(vault).unwrap();
        assert!(
            staged && selected.is_some(),
            "control publication was absent for {changed}"
        );
        assert!(
            result.is_some_and(|r| r.is_err()),
            "changed actual {changed} join was accepted"
        );
        assert_eq!(native, 0, "failed {changed} join retained provenance");
        assert_eq!(
            cli.as_deref(),
            if changed == "cli" {
                Some("11111111-1111-4111-8111-111111111111")
            } else {
                None
            },
            "failed {changed} join did not roll back tentative CLI binding"
        );
    }
}

// New required-capture path uses the SAME actual publisher/spawn and actual
// endpoint. Closed API RED is missing functionality, not an old regression.
#[cfg(target_os = "macos")]
#[test]
fn run_configuration_actual_publication_commits_before_real_child_creation() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m97-config-actual-publication")
        .canonicalize()
        .unwrap();
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let (mut fixture, _scope) = scoped_native_sql_fixture(&vault);
    fixture.request.system_prompt = Some("M97_ACTUAL_SYSTEM_BODY_CANARY_7f03".into());
    fixture.request.model = Some("sk-ant-private-actual-model-canary-7f03".into());
    let mcp = transport::without_socket();
    let (token, _) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token);
    let before = std::rc::Rc::new(std::cell::Cell::new(false));
    let observed = before.clone();
    let data = fixture.meter.data_dir.clone();
    let id = fixture.meter.run_id.clone();
    let marker = fixture.home.join("claude.spawned");
    configuration::observe_before_child_for_test(move || {
        // No ActiveRoot acquisition under publication's admission guard. This
        // disposable fixture observation uses only a real ReadOnly SQL query.
        let ro = crate::runtime::ReadOnly::open(&data).unwrap();
        let payload = ro
            .query_row(
                "SELECT manifest_json FROM run_configurations WHERE run_id=?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let prompt_hash = crate::ledger::sha256_hex(b"M97_ACTUAL_SYSTEM_BODY_CANARY_7f03");
        observed.set(
            !marker.exists()
                && !payload.contains("M97_ACTUAL_SYSTEM_BODY_CANARY_7f03")
                && !payload.contains("sk-ant-private-actual-model-canary-7f03")
                && value["effective_system_prompt_sha256"].as_str() == Some(prompt_hash.as_str())
                && value["observed_model_at_dispatch"]["state"].as_str() == Some("unknown")
                && value["observed_cli_version"]["value"]["patch"].as_u64() == Some(250),
        );
    });
    let result = fixture.publish_with_configuration(&state, &preparation, Some(&mcp));
    let published = result.is_ok();
    if let Ok(publication::Published { started, guard, .. }) = result {
        drop(guard);
        reap(&state, started, &fixture.meter.run_id, true);
    }
    configuration::clear_before_child_for_test();
    let observed_before = before.get();
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        published,
        "new required configuration capture refused real publication"
    );
    assert!(
        observed_before,
        "configuration was not committed before the actual supervised child boundary"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn run_configuration_required_capture_failure_retires_actual_minted_bearer() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m97-config-failed-capture")
        .canonicalize()
        .unwrap();
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let (mut fixture, _scope) = scoped_native_sql_fixture(&vault);
    let mcp = transport::without_socket();
    // Actual endpoint token deliberately names a different real mint/run.
    let token = mcp
        .run_token(
            Some(crate::mcp::DEFAULT_ACTOR),
            None,
            None,
            None,
            "different-actual-mint".into(),
            &vault,
            crate::mcp::WriteAsks::UNASKED,
        )
        .unwrap();
    fixture.request.mcp_token = Some(token.clone());
    let result = fixture.publish_with_configuration(&state, &preparation, Some(&mcp));
    let refused = result.is_err();
    if let Ok(publication::Published { started, guard, .. }) = result {
        drop(guard);
        reap(&state, started, &fixture.meter.run_id, true);
    }
    let bearer_survives = transport::legacy_resolves(&mcp, &token);
    let child_started = fixture.home.join("claude.spawned").exists();
    let configs_left =
        fixture.config.is_dir() && std::fs::read_dir(&fixture.config).unwrap().next().is_some();
    let slots = state.live();
    let journaled = !state.journal.vaults().is_empty();
    std::fs::remove_dir_all(vault).unwrap();
    assert!(refused, "mismatched actual grant reached the child");
    assert!(
        !bearer_survives,
        "failed required capture leaked its real minted bearer"
    );
    assert!(
        !child_started && !configs_left && slots == 0 && !journaled,
        "failed capture retained publication resources"
    );
}

#[test]
fn run_configuration_ledger_off_keeps_actual_legacy_launch_and_token_cleanup() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m97-config-ledger-off")
        .canonicalize()
        .unwrap();
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let mut fixture = Fixture::new(&vault, None, false);
    let conn = crate::runtime::open_existing(&fixture.meter.data_dir).unwrap();
    fixture.meter.vault_id = Some(crate::runtime::scope::register(&conn, &vault).unwrap());
    // Deliberately no store: current V3 runs CHECK requires both ids NULL or
    // both present. Existing best-effort metering cannot open this scoped row.
    fixture.meter.store_uuid = None;
    let mcp = transport::without_socket();
    let token = mcp
        .run_token(
            Some(crate::mcp::DEFAULT_ACTOR),
            None,
            None,
            None,
            fixture.meter.run_id.clone(),
            &vault,
            crate::mcp::WriteAsks::UNASKED,
        )
        .unwrap();
    fixture.request.mcp_token = Some(token.clone());
    let before = transport::legacy_resolves(&mcp, &token);
    let result = fixture.publish_with_configuration(&state, &preparation, Some(&mcp));
    let published = result.is_ok();
    if let Ok(publication::Published { started, guard, .. }) = result {
        drop(guard);
        reap(&state, started, &fixture.meter.run_id, true);
    }
    // This fixture exercises publication rather than stream's existing reader
    // owner, so explicitly perform the same actual endpoint revoke at teardown.
    mcp.revoke(&token, Duration::ZERO);
    let after = transport::legacy_resolves(&mcp, &token);
    let rows: i64 = conn
        .query_row(
            "SELECT count(*) FROM runs WHERE run_id=?1",
            [&fixture.meter.run_id],
            |row| row.get(0),
        )
        .unwrap();
    let minted_store = crate::ledger::ledger_dir(&vault)
        .join("store.json")
        .exists();
    let slots = state.live();
    drop(conn);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        before && published,
        "optional store identity became a legacy launch gate"
    );
    assert!(
        !after && slots == 0,
        "actual legacy token/child cleanup was lost"
    );
    assert_eq!(
        rows, 0,
        "test unexpectedly created an incompatible scoped runtime row"
    );
    assert!(
        !minted_store,
        "configuration capture minted optional ledger identity"
    );
}

// Original producer lifetime only: these fixtures do not create a native origin
// or claim real AppHandle/WebviewWindow authentication.
#[test]
fn native_catalog_entry_survives_original_command_preparation_drop() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m96-catalog-entry-retained");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let mut fixture = Fixture::new(&vault, None, false);
    let mcp = transport::without_socket();
    let (token, slot) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token);
    let publication::Published {
        started,
        guard,
        receipt,
    } = fixture.publish(&state, &preparation).unwrap();
    drop(guard);
    let staged = receipt
        .as_ref()
        .is_some_and(|receipt| mcp.stage_actual_publication(receipt));
    let selected = current_original_receipt(&mcp, slot.as_ref());
    let observed = (|| {
        let receipt = selected.as_ref()?;
        let held = state
            .guard_publication_entry(&preparation, &vault, receipt)
            .ok()?;
        let retained = held.retain_original_entry();
        drop(held);
        let before = state.guard_retained_publication(&retained, receipt).is_ok();
        drop(preparation);
        let after = state
            .guard_retained_publication(&retained, receipt)
            .is_ok_and(|guard| guard.recheck());
        Some((before, after))
    })();
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        staged && selected.is_some(),
        "real original publication was not selected"
    );
    assert_eq!(
        observed.map(|value| value.0),
        Some(true),
        "original live preparation control failed"
    );
    assert_eq!(
        observed.map(|value| value.1),
        Some(true),
        "original command return destroyed the retained entry"
    );
}

#[test]
fn native_catalog_entry_never_adopts_fresh_preparation_or_another_agent_state() {
    let vault = testutil::temp_vault("m96-catalog-entry-foreign");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let fixture = Fixture::new(&vault, None, false);
    let publication::Published {
        started,
        guard,
        receipt,
    } = fixture.publish(&state, &preparation).unwrap();
    drop(guard);
    let observed = (|| {
        let receipt = receipt.as_ref()?;
        let held = state
            .guard_publication_entry(&preparation, &vault, receipt)
            .ok()?;
        let retained = held.retain_original_entry();
        drop(held);
        let original = state.guard_retained_publication(&retained, receipt).is_ok();
        let fresh = state.prepare_run(&vault).ok()?;
        let fresh_refused = state
            .guard_publication_entry(&fresh, &vault, receipt)
            .is_err();
        let foreign = AgentState::default();
        let foreign_refused = foreign
            .guard_retained_publication(&retained, receipt)
            .is_err();
        Some((original, fresh_refused, foreign_refused))
    })();
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    assert_eq!(observed, Some((true, true, true)));
}

#[test]
fn native_catalog_entry_refuses_actual_stop_and_new_opening_generation() {
    for change in ["stop", "opening"] {
        let vault = testutil::temp_vault("m96-catalog-entry-invalidated");
        let state = AgentState::default();
        let preparation = state.prepare_run(&vault).unwrap();
        let fixture = Fixture::new(&vault, None, false);
        let publication::Published {
            started,
            guard,
            receipt,
        } = fixture.publish(&state, &preparation).unwrap();
        drop(guard);
        let observed = (|| {
            let receipt = receipt.as_ref()?;
            let held = state
                .guard_publication_entry(&preparation, &vault, receipt)
                .ok()?;
            let retained = held.retain_original_entry();
            drop(held);
            let before = state.guard_retained_publication(&retained, receipt).is_ok();
            if change == "stop" {
                if !state.stop(started.run).ok()? {
                    return None;
                }
            } else {
                state.begin_open(1).ok()?;
            }
            let refused = state
                .guard_retained_publication(&retained, receipt)
                .is_err();
            Some((before, refused))
        })();
        reap(&state, started, &fixture.meter.run_id, true);
        std::fs::remove_dir_all(vault).unwrap();
        assert_eq!(
            observed,
            Some((true, true)),
            "retained source survived {change}"
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn run_configuration_actual_postcapture_spawn_failure_keeps_original_manifest_and_failed_before_start(
) {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m97-config-captured-spawn-failure")
        .canonicalize()
        .unwrap();
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let (mut fixture, _) = scoped_native_sql_fixture(&vault);
    let mcp = transport::without_socket();
    let (token, _) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token.clone());
    let binary = fixture.home.join("claude");
    configuration::observe_before_child_for_test(move || {
        std::fs::remove_file(binary).unwrap();
    });
    let result = fixture.publish_with_configuration(&state, &preparation, Some(&mcp));
    let refused = result.is_err();
    if let Ok(publication::Published { started, guard, .. }) = result {
        drop(guard);
        reap(&state, started, &fixture.meter.run_id, true);
    }
    configuration::clear_before_child_for_test();
    let conn = crate::runtime::open_existing(&fixture.meter.data_dir).unwrap();
    let durable=conn.query_row("SELECT r.outcome,r.configuration_publication_failure,c.manifest_json FROM runs r JOIN run_configurations c ON c.run_id=r.run_id WHERE r.run_id=?1",[&fixture.meter.run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?))).ok();
    let cleanup = !fixture.home.join("claude.spawned").exists()
        && state.live() == 0
        && state.journal.vaults().is_empty();
    let bearer_survives = transport::legacy_resolves(&mcp, &token);
    drop(conn);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        refused && cleanup,
        "post-capture refused spawn retained publication resources"
    );
    assert!(
        !bearer_survives,
        "failed postcapture publication retained its actual bearer"
    );
    assert!(
        durable.is_some_and(|(outcome, stage, payload)| outcome == "failed"
            && stage.as_deref() == Some("failed_before_start")
            && !payload.is_empty()),
        "captured run/manifest was discarded or wrong failure stage claimed"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn run_configuration_actual_child_then_slot_refusal_keeps_failed_publication() {
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault("m97-config-captured-slot-failure")
        .canonicalize()
        .unwrap();
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let (mut fixture, _) = scoped_native_sql_fixture(&vault);
    let mcp = transport::without_socket();
    let (token, _) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token.clone());
    let closing = state.clone();
    let result = with_before_insert_for_test(
        move || {
            closing.shut_down();
        },
        || fixture.publish_with_configuration(&state, &preparation, Some(&mcp)),
    );
    let refused = result.is_err();
    if let Ok(publication::Published { started, guard, .. }) = result {
        drop(guard);
        reap(&state, started, &fixture.meter.run_id, true);
    }
    let conn = crate::runtime::open_existing(&fixture.meter.data_dir).unwrap();
    let durable=conn.query_row("SELECT r.outcome,r.configuration_publication_failure,c.manifest_json FROM runs r JOIN run_configurations c ON c.run_id=r.run_id WHERE r.run_id=?1",[&fixture.meter.run_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?))).ok();
    let cleanup = state.live() == 0
        && state.journal.vaults().is_empty()
        && state
            .interactions
            .ask_plan(&fixture.meter.run_id, &[], fixture.cli.version.as_deref())
            .is_empty();
    let bearer_survives = transport::legacy_resolves(&mcp, &token);
    drop(conn);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(
        refused && cleanup,
        "child/slot refusal retained publication resources"
    );
    assert!(
        !bearer_survives,
        "post-child failed publication retained its actual bearer"
    );
    assert!(
        durable.is_some_and(|(outcome, stage, payload)| outcome == "failed"
            && stage.as_deref() == Some("failed_publication")
            && !payload.is_empty()),
        "post-child failure discarded captured history or claimed no child existed"
    );
}

// M95.6 candidate prerequisite tests use actual publication, original MCP mint,
// Stop/revoke and reap. They prove no native person/store/OS isolation facts.
fn supervised_job_request(parent_run_id: &str) -> child_jobs::types::ChildJobSpec {
    use child_jobs::types::*;
    ChildJobSpec {
        parent_run_id: parent_run_id.into(),
        parent_attempt_id: "request-correlation-is-not-native-attempt-proof".into(),
        objective: "Read public/note.md only".into(),
        instruction_source_version: "a".repeat(64),
        input_evidence_refs: vec![EvidenceRef {
            path: "public/note.md".into(),
            sha256: "b".repeat(64),
        }],
        result_schema_id: "read_evidence_summary.v1".into(),
        requested_grant: RequestedReadGrant {
            read_scope: vec!["public".into()],
        },
        budget: JobBudget {
            elapsed_seconds: 600,
            result_bytes: 262144,
        },
        deadline_at: 1600,
    }
}
#[test]
fn supervised_jobs_actual_publication_remains_unavailable_without_backend_and_creates_no_child() {
    use crate::mcp::native_publication_test_support as transport;
    use child_jobs::admission::{inspect_unavailable_candidate as inspect, PreflightRefusal as R};
    let vault = testutil::temp_vault("m95-jobs-backend-closed");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let mut fixture = Fixture::new(&vault, None, false);
    let mcp = transport::without_socket();
    let (token, witness) = reserve_original_slot(&mcp, &fixture);
    let witness = witness.expect("actual original mint lacks witness");
    fixture.request.mcp_token = Some(token.clone());
    let spec = supervised_job_request(&fixture.meter.run_id);
    let before = inspect(&mcp, &witness, &spec, 1000);
    let publication::Published {
        started,
        guard,
        receipt,
    } = fixture.publish(&state, &preparation).unwrap();
    drop(guard);
    let staged = receipt
        .as_ref()
        .is_some_and(|receipt| mcp.stage_actual_publication(receipt));
    let slots_before = transport::actual_slot_count(&mcp);
    let files_before = std::fs::read_dir(&fixture.config).unwrap().count();
    let refused = inspect(&mcp, &witness, &spec, 1000);
    let mut wrong = spec.clone();
    wrong.parent_run_id = crate::ledger::new_run_id();
    let wrong_parent = inspect(&mcp, &witness, &wrong, 1000);
    let repeated = inspect(&mcp, &witness, &spec, 1000);
    let same_slots = slots_before == transport::actual_slot_count(&mcp);
    let same_files = files_before == std::fs::read_dir(&fixture.config).unwrap().count();
    let live = state.live();
    let parent_resolves = transport::legacy_resolves(&mcp, &token);
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(staged, "actual publication was not staged");
    assert_eq!(before, R::ParentPublicationUnavailable);
    assert_eq!(refused, R::BackendIsolationUnverified);
    assert_eq!(repeated, R::BackendIsolationUnverified);
    assert_eq!(wrong_parent, R::ParentRunMismatch);
    assert!(
        same_slots && same_files && live == 1 && parent_resolves,
        "closed preflight altered parent/child resources"
    );
}
#[test]
fn supervised_jobs_remint_and_replaced_listener_never_supply_original_parent() {
    use crate::mcp::native_publication_test_support as transport;
    use child_jobs::admission::{inspect_unavailable_candidate as inspect, PreflightRefusal as R};
    let vault = testutil::temp_vault("m95-jobs-exact-slot");
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let mut fixture = Fixture::new(&vault, None, false);
    let mcp = transport::without_socket();
    let (token, witness) = reserve_original_slot(&mcp, &fixture);
    let witness = witness.unwrap();
    fixture.request.mcp_token = Some(token.clone());
    let publication::Published {
        started,
        guard,
        receipt,
    } = fixture.publish(&state, &preparation).unwrap();
    drop(guard);
    let staged = receipt
        .as_ref()
        .is_some_and(|receipt| mcp.stage_actual_publication(receipt));
    let spec = supervised_job_request(&fixture.meter.run_id);
    let original = inspect(&mcp, &witness, &spec, 1000);
    let (_, remint) = reserve_original_slot(&mcp, &fixture);
    let reminted = inspect(&mcp, &remint.unwrap(), &spec, 1000);
    transport::replace_listener_preserving_entries(&mcp);
    let replaced = inspect(&mcp, &witness, &spec, 1000);
    let legacy = transport::legacy_resolves(&mcp, &token);
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(vault).unwrap();
    assert!(staged);
    assert_eq!(original, R::BackendIsolationUnverified);
    assert_eq!(reminted, R::ParentPublicationUnavailable);
    assert_eq!(replaced, R::ParentPublicationUnavailable);
    assert!(legacy, "candidate checks changed legacy resolution");
}
#[test]
fn supervised_jobs_revoke_and_stop_retire_candidate_while_preserving_legacy_rules() {
    use crate::mcp::native_publication_test_support as transport;
    use child_jobs::admission::{inspect_unavailable_candidate as inspect, PreflightRefusal as R};
    for revoke in [true, false] {
        let vault = testutil::temp_vault("m95-jobs-parent-retirement");
        let state = AgentState::default();
        let preparation = state.prepare_run(&vault).unwrap();
        let mut fixture = Fixture::new(&vault, None, false);
        let mcp = transport::without_socket();
        let (token, witness) = reserve_original_slot(&mcp, &fixture);
        let witness = witness.unwrap();
        fixture.request.mcp_token = Some(token.clone());
        let publication::Published {
            started,
            guard,
            receipt,
        } = fixture.publish(&state, &preparation).unwrap();
        drop(guard);
        let staged = receipt
            .as_ref()
            .is_some_and(|receipt| mcp.stage_actual_publication(receipt));
        let spec = supervised_job_request(&fixture.meter.run_id);
        let before = inspect(&mcp, &witness, &spec, 1000);
        let stopped = if revoke {
            mcp.revoke(&token, crate::mcp::REVOKE_GRACE);
            true
        } else {
            state.stop(started.run).unwrap()
        };
        let after = inspect(&mcp, &witness, &spec, 1000);
        let legacy = transport::legacy_resolves(&mcp, &token);
        reap(&state, started, &fixture.meter.run_id, true);
        std::fs::remove_dir_all(vault).unwrap();
        assert!(staged && stopped);
        assert_eq!(before, R::BackendIsolationUnverified);
        assert_eq!(after, R::ParentPublicationUnavailable);
        assert!(
            legacy,
            "candidate retirement removed legacy unrevoked/grace access"
        );
    }
}

#[cfg(target_os = "macos")]
fn m95_attempt_row(conn: &rusqlite::Connection, run: &str) -> Option<(String, String)> {
    conn.query_row(
        "SELECT attempt_id,authority_id FROM chat_parent_attempts WHERE parent_run_id=?1",
        [run],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .expect("metadata read must succeed; SQL/schema failure is not a behavioral RED")
}

// Owns the existing toy publication through cleanup, even if a RED assertion
// panics. This is the existing real publication/retained SQL-kernel path; it
// never creates NativeRootEntry or claims native window authentication.
#[cfg(target_os = "macos")]
fn m95_with_published_parent(
    label: &str,
    check: impl FnOnce(
        &Fixture,
        &crate::runtime::VaultScope,
        &AgentState,
        &crate::agent::NativePublicationReceipt,
        &mut crate::actions::native_owner::tests::PublicationSqlOwner,
        &rusqlite::Connection,
    ),
) {
    use crate::actions::native_owner::tests::PublicationSqlOwner;
    use crate::mcp::native_publication_test_support as transport;
    let vault = testutil::temp_vault(label).canonicalize().unwrap();
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let (mut fixture, scope) = scoped_native_sql_fixture(&vault);
    let conn = crate::runtime::open_existing(&fixture.meter.data_dir).unwrap();
    let mut owner = PublicationSqlOwner::open(&fixture.meter.data_dir);
    let mcp = transport::without_socket();
    let (token, slot) = reserve_original_slot(&mcp, &fixture);
    fixture.request.mcp_token = Some(token);
    let publication::Published {
        started,
        guard,
        receipt,
    } = fixture.publish(&state, &preparation).unwrap();
    drop(guard);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert!(
            receipt
                .as_ref()
                .is_some_and(|r| mcp.stage_actual_publication(r)),
            "baseline real publication was not staged"
        );
        let selected = current_original_receipt(&mcp, slot.as_ref())
            .expect("baseline exact original publication must resolve");
        check(&fixture, &scope, &state, &selected, &mut owner, &conn);
    }));
    drop(owner);
    drop(conn);
    reap(&state, started, &fixture.meter.run_id, true);
    std::fs::remove_dir_all(&vault).unwrap();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[cfg(target_os = "macos")]
const M95_NATIVE_AUTHORITY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// Primary causal RED: actual native row registration succeeds; empty metadata
// table is queryable, but existing production kernel records no attempt.
#[cfg(target_os = "macos")]
#[test]
fn m95_parent_attempt_actual_native_registration_records_one_minted_identity() {
    m95_with_published_parent(
        "m95-parent-attempt-record",
        |fixture, scope, _, receipt, owner, conn| {
            assert_eq!(
                owner.record(&fixture.vault, scope, receipt, M95_NATIVE_AUTHORITY),
                Ok(())
            );
            let native: (String, String, String, String) = conn.query_row(
            "SELECT authority_id,vault_id,store_uuid,cli_session_id FROM action_native_runs WHERE run_id=?1",
            [&fixture.meter.run_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).expect("baseline actual native row must exist before asserting new behavior");
            assert_eq!(
                native,
                (
                    M95_NATIVE_AUTHORITY.into(),
                    scope.vault_id.clone(),
                    scope.store_uuid.clone().unwrap(),
                    fixture.session.id().into()
                )
            );
            let attempt = m95_attempt_row(conn, &fixture.meter.run_id);
            assert!(
                attempt.is_some(),
                "M95 causal RED: successful real native registration recorded no parent attempt"
            );
            let (id, authority) = attempt.unwrap();
            assert_eq!(authority, M95_NATIVE_AUTHORITY);
            assert_eq!(id.len(), 32);
            assert!(id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            assert_ne!(id, fixture.meter.run_id);
            assert_ne!(id, M95_NATIVE_AUTHORITY);
            assert_ne!(id, fixture.session.id());
            let rows: i64 = conn
                .query_row("SELECT count(*) FROM chat_parent_attempts", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(rows, 1);
        },
    );
}

// Initially fails at the same missing-writer precondition as the primary RED.
// Only after that is repaired does this establish replay preservation.
#[cfg(target_os = "macos")]
#[test]
fn m95_parent_attempt_original_finalizer_replay_preserves_identity_and_refuses_adoption() {
    m95_with_published_parent(
        "m95-parent-attempt-replay",
        |fixture, scope, _, receipt, owner, conn| {
            assert_eq!(
                owner.record(&fixture.vault, scope, receipt, M95_NATIVE_AUTHORITY),
                Ok(())
            );
            let first = m95_attempt_row(conn, &fixture.meter.run_id)
                .expect("M95 missing-writer precondition: first native attempt must exist");
            assert_eq!(
                owner.record(&fixture.vault, scope, receipt, M95_NATIVE_AUTHORITY),
                Ok(())
            );
            assert_eq!(
                m95_attempt_row(conn, &fixture.meter.run_id),
                Some(first.clone())
            );
            assert!(owner
                .record(
                    &fixture.vault,
                    scope,
                    receipt,
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                )
                .is_err());
            assert_eq!(m95_attempt_row(conn, &fixture.meter.run_id), Some(first));
            let rows: i64 = conn
                .query_row("SELECT count(*) FROM chat_parent_attempts", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(rows, 1);
        },
    );
}

// Preservation control: a matching run selector + actual publication alone
// never writes metadata or installs the native owner origin.
#[cfg(target_os = "macos")]
#[test]
fn m95_parent_attempt_absent_native_finalization_cannot_publish_metadata_or_origin() {
    m95_with_published_parent(
        "m95-parent-attempt-no-entry",
        |fixture, _, state, _, _, conn| {
            assert_eq!(m95_attempt_row(conn, &fixture.meter.run_id), None);
            let native: i64 = conn
                .query_row("SELECT count(*) FROM action_native_runs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(native, 0);
            // No root entry/finalizer was supplied; inspect the actual process slot.
            let slots = lock(&state.slots);
            assert_eq!(slots.len(), 1);
            assert!(slots.values().all(|slot| slot.native_action_read.is_none()));
        },
    );
}

// Preservation control: existing join guards must fence the new write too.
#[cfg(target_os = "macos")]
#[test]
fn m95_parent_attempt_wrong_actual_join_rolls_back_all_native_metadata() {
    m95_with_published_parent(
        "m95-parent-attempt-wrong-join",
        |fixture, scope, _, receipt, owner, conn| {
            conn.execute(
                "UPDATE runs SET cli_session_id=NULL,actor='process:other' WHERE run_id=?1",
                [&fixture.meter.run_id],
            )
            .unwrap();
            assert!(owner
                .record(&fixture.vault, scope, receipt, M95_NATIVE_AUTHORITY)
                .is_err());
            assert_eq!(m95_attempt_row(conn, &fixture.meter.run_id), None);
            let native: i64 = conn
                .query_row("SELECT count(*) FROM action_native_runs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(native, 0);
            let session: Option<String> = conn
                .query_row(
                    "SELECT cli_session_id FROM runs WHERE run_id=?1",
                    [&fixture.meter.run_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(session, None);
        },
    );
}

// Uses the real retained owner's transaction and an error AFTER its production
// row kernel. Initially a preservation control, not independent new RED proof.
#[cfg(target_os = "macos")]
#[test]
fn m95_parent_attempt_precommit_refusal_rolls_back_attempt_with_native_row() {
    m95_with_published_parent(
        "m95-parent-attempt-rollback",
        |fixture, scope, _, receipt, owner, conn| {
            conn.execute(
                "UPDATE runs SET cli_session_id=NULL WHERE run_id=?1",
                [&fixture.meter.run_id],
            )
            .unwrap();
            assert!(owner
                .m95_record_then_refuse(&fixture.vault, scope, receipt, M95_NATIVE_AUTHORITY)
                .is_err());
            assert_eq!(m95_attempt_row(conn, &fixture.meter.run_id), None);
            let native: i64 = conn
                .query_row("SELECT count(*) FROM action_native_runs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(native, 0);
            let session: Option<String> = conn
                .query_row(
                    "SELECT cli_session_id FROM runs WHERE run_id=?1",
                    [&fixture.meter.run_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(session, None);
        },
    );
}

// A real committed-but-unacknowledged row remains data, never authority.
// This kernel probe does not claim end-to-end native origin installation.
#[cfg(target_os = "macos")]
#[test]
fn m95_parent_attempt_uncertain_commit_keeps_one_identity_without_origin_publication() {
    m95_with_published_parent(
        "m95-parent-attempt-lost-ack",
        |fixture, scope, state, receipt, owner, conn| {
            assert!(owner
                .m95_record_losing_ack(&fixture.vault, scope, receipt, M95_NATIVE_AUTHORITY)
                .is_err());
            let native: i64 = conn
                .query_row("SELECT count(*) FROM action_native_runs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                native, 1,
                "control must lose acknowledgement after actual commit"
            );
            let first = m95_attempt_row(conn, &fixture.meter.run_id)
            .expect("M95 missing-writer precondition: committed native row needs its same-transaction attempt");
            assert!(
                owner
                    .record(&fixture.vault, scope, receipt, M95_NATIVE_AUTHORITY)
                    .is_err(),
                "uncertain owner must stay retired"
            );
            assert_eq!(m95_attempt_row(conn, &fixture.meter.run_id), Some(first));
            assert!(lock(&state.slots)
                .values()
                .all(|slot| slot.native_action_read.is_none()));
        },
    );
}

// After successful creation, attempt metadata follows native row lifetime.
// It adds no deletion path and does not weaken existing native->runs FKs.
#[cfg(target_os = "macos")]
#[test]
fn m95_parent_attempt_lifetime_retains_closed_history_and_follows_explicit_parent_removal() {
    m95_with_published_parent(
        "m95-parent-attempt-lifetime",
        |fixture, scope, _, receipt, owner, conn| {
            assert_eq!(
                owner.record(&fixture.vault, scope, receipt, M95_NATIVE_AUTHORITY),
                Ok(())
            );
            let first = m95_attempt_row(conn, &fixture.meter.run_id).expect(
                "M95 missing-writer precondition: metadata must exist before testing its lifetime",
            );
            conn.execute("UPDATE runs SET outcome='cancelled',ended_at='2026-10-24T20:00:00Z' WHERE run_id=?1",
            [&fixture.meter.run_id]).unwrap();
            assert_eq!(m95_attempt_row(conn, &fixture.meter.run_id), Some(first));
            assert!(
                conn.execute("DELETE FROM runs WHERE run_id=?1", [&fixture.meter.run_id])
                    .is_err(),
                "existing native provenance still protects its runs parent"
            );
            conn.execute(
                "DELETE FROM action_native_runs WHERE run_id=?1",
                [&fixture.meter.run_id],
            )
            .unwrap();
            assert_eq!(m95_attempt_row(conn, &fixture.meter.run_id), None,
            "explicit native-parent removal must not orphan or be blocked solely by attempt metadata");
            conn.execute("DELETE FROM runs WHERE run_id=?1", [&fixture.meter.run_id])
                .unwrap();
        },
    );
}

// A second real root uses the same runtime/vault/store/session, but its own
// actual publication and durable run. This is not a copied receipt or registry.
#[cfg(target_os = "macos")]
fn m95_with_second_parent(
    first: &Fixture,
    scope: &crate::runtime::VaultScope,
    state: &AgentState,
    check: impl FnOnce(&Fixture, &crate::agent::NativePublicationReceipt),
) {
    use crate::mcp::native_publication_test_support as transport;
    let mut second = Fixture::new(&first.vault, None, false);
    second.meter.data_dir = first.meter.data_dir.clone();
    second.meter.vault_id = Some(scope.vault_id.clone());
    second.meter.store_uuid = scope.store_uuid.clone();
    second.session = first.session.clone();
    let preparation = state.prepare_run(&first.vault).unwrap();
    let mcp = transport::without_socket();
    let (token, slot) = reserve_original_slot(&mcp, &second);
    second.request.mcp_token = Some(token);
    let publication::Published {
        started,
        guard,
        receipt,
    } = second.publish(state, &preparation).unwrap();
    drop(guard);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert!(receipt
            .as_ref()
            .is_some_and(|r| mcp.stage_actual_publication(r)));
        let selected = current_original_receipt(&mcp, slot.as_ref()).unwrap();
        check(&second, &selected);
    }));
    reap(state, started, &second.meter.run_id, true);
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn m95_parent_attempt_distinct_original_roots_in_one_cli_session_keep_distinct_attempts() {
    m95_with_published_parent(
        "m95-parent-attempt-two-roots",
        |first, scope, state, receipt, owner, conn| {
            assert_eq!(
                owner.record(&first.vault, scope, receipt, M95_NATIVE_AUTHORITY),
                Ok(())
            );
            let original = m95_attempt_row(conn, &first.meter.run_id).unwrap();
            m95_with_second_parent(first, scope, state, |second, receipt| {
                assert_eq!(first.session.id(), second.session.id());
                assert_ne!(first.meter.run_id, second.meter.run_id);
                assert_eq!(
                    owner.record(
                        &second.vault,
                        scope,
                        receipt,
                        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    ),
                    Ok(())
                );
                let other = m95_attempt_row(conn, &second.meter.run_id).unwrap();
                assert_ne!(original.0, other.0);
                assert_eq!(
                    m95_attempt_row(conn, &first.meter.run_id),
                    Some(original.clone())
                );
                let rows: i64 = conn
                    .query_row("SELECT count(*) FROM chat_parent_attempts", [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                assert_eq!(rows, 2);
            });
        },
    );
}

#[cfg(target_os = "macos")]
#[test]
fn m95_parent_attempt_tampered_valid_foreign_authority_pair_refuses_without_repair() {
    m95_with_published_parent(
        "m95-parent-attempt-tampered-pair",
        |first, scope, state, receipt, owner, conn| {
            assert_eq!(
                owner.record(&first.vault, scope, receipt, M95_NATIVE_AUTHORITY),
                Ok(())
            );
            let original = m95_attempt_row(conn, &first.meter.run_id).unwrap();
            m95_with_second_parent(first, scope, state, |second, second_receipt| {
                let other_authority = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
                assert_eq!(
                    owner.record(&second.vault, scope, second_receipt, other_authority),
                    Ok(())
                );
                // Both references remain individually valid. Only the joined pair
                // says the first root is trying to adopt another root's authority.
                conn.execute(
                    "DELETE FROM chat_parent_attempts WHERE parent_run_id=?1",
                    [&second.meter.run_id],
                )
                .unwrap();
                conn.execute(
                    "UPDATE chat_parent_attempts SET authority_id=?2 WHERE parent_run_id=?1",
                    rusqlite::params![first.meter.run_id, other_authority],
                )
                .unwrap();
                let fk: i64 = conn
                    .query_row(
                        "SELECT count(*) FROM pragma_foreign_key_check('chat_parent_attempts')",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(fk, 0, "probe must retain individually valid foreign keys");
                assert!(owner
                    .record(&first.vault, scope, receipt, M95_NATIVE_AUTHORITY)
                    .is_err());
                assert_eq!(
                    m95_attempt_row(conn, &first.meter.run_id),
                    Some((original.0.clone(), other_authority.into())),
                    "refusal must neither repair the pair nor mint a replacement"
                );
            });
        },
    );
}

#[cfg(target_os = "macos")]
#[test]
fn m95_parent_attempt_missing_metadata_on_existing_native_root_never_remints() {
    m95_with_published_parent(
        "m95-parent-attempt-no-backfill",
        |fixture, scope, _, receipt, owner, conn| {
            assert_eq!(
                owner.record(&fixture.vault, scope, receipt, M95_NATIVE_AUTHORITY),
                Ok(())
            );
            assert!(m95_attempt_row(conn, &fixture.meter.run_id).is_some());
            conn.execute(
                "DELETE FROM chat_parent_attempts WHERE parent_run_id=?1",
                [&fixture.meter.run_id],
            )
            .unwrap();
            assert!(owner
                .record(&fixture.vault, scope, receipt, M95_NATIVE_AUTHORITY)
                .is_err());
            assert_eq!(
                m95_attempt_row(conn, &fixture.meter.run_id),
                None,
                "missing native attempt must refuse rather than remint on replay"
            );
            let native: i64 = conn
                .query_row("SELECT count(*) FROM action_native_runs", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(
                native, 1,
                "refusal must not remove the pre-existing native parent"
            );
        },
    );
}

// M95 delegation RED packet: real publication + retained SQL-owner kernel only.
// No authenticated native-window or installed NativeActionReadOrigin claim.
#[cfg(target_os = "macos")]
fn m95_with_delegation_parent(
    label: &str,
    shared: Option<(&Fixture, &crate::runtime::VaultScope)>,
    check: impl FnOnce(
        &Fixture,
        &crate::runtime::VaultScope,
        &mut crate::actions::native_owner::tests::PublicationSqlOwner,
        &rusqlite::Connection,
        crate::actions::native_owner::tests::chat_delegation::ParentProbe<'_>,
    ),
) {
    use crate::actions::native_owner::tests::{chat_delegation::ParentProbe, PublicationSqlOwner};
    use crate::mcp::native_publication_test_support as transport;
    let owns_vault = shared.is_none();
    let vault = match shared {
        Some((first, _)) => first.vault.clone(),
        None => testutil::temp_vault(label).canonicalize().unwrap(),
    };
    let (mut fixture, scope) = match shared {
        Some((first, scope)) => {
            let mut next = Fixture::new(&vault, None, false);
            next.meter.data_dir = first.meter.data_dir.clone();
            next.meter.vault_id = Some(scope.vault_id.clone());
            next.meter.store_uuid = scope.store_uuid.clone();
            next.session = first.session.clone();
            (next, scope.clone())
        }
        None => scoped_native_sql_fixture(&vault),
    };
    let state = AgentState::default();
    let preparation = state.prepare_run(&vault).unwrap();
    let conn = crate::runtime::open_existing(&fixture.meter.data_dir).unwrap();
    let mut owner = PublicationSqlOwner::open(&fixture.meter.data_dir);
    let mcp = transport::without_socket();
    let (token, slot) = reserve_original_slot(&mcp, &fixture);
    let slot = slot.unwrap();
    fixture.request.mcp_token = Some(token);
    let publication::Published {
        started,
        guard,
        receipt,
    } = fixture.publish(&state, &preparation).unwrap();
    drop(guard);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert!(receipt
            .as_ref()
            .is_some_and(|r| mcp.stage_actual_publication(r)));
        let receipt = current_original_receipt(&mcp, Some(&slot)).unwrap();
        let authority = if owns_vault {
            M95_NATIVE_AUTHORITY
        } else {
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        };
        assert_eq!(owner.record(&vault, &scope, &receipt, authority), Ok(()));
        let (attempt, recorded_authority) = m95_attempt_row(&conn, &fixture.meter.run_id).unwrap();
        assert_eq!(recorded_authority, authority);
        let parent = ParentProbe {
            agents: &state,
            preparation: &preparation,
            mcp: &mcp,
            slot: &slot,
            receipt: &receipt,
            root: &vault,
            scope: &scope,
            authority,
            attempt: &attempt,
        };
        check(&fixture, &scope, &mut owner, &conn, parent);
    }));
    drop(owner);
    drop(conn);
    reap(&state, started, &fixture.meter.run_id, true);
    if owns_vault {
        std::fs::remove_dir_all(&vault).unwrap();
    }
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[cfg(target_os = "macos")]
fn m95_delegation_spec(
    parent: &crate::actions::native_owner::tests::chat_delegation::ParentProbe<'_>,
) -> child_jobs::types::ChildJobSpec {
    let mut spec = supervised_job_request(parent.receipt.run_id());
    spec.parent_attempt_id = parent.attempt.to_owned();
    spec.deadline_at = 1600;
    spec.budget.elapsed_seconds = 600;
    spec.budget.result_bytes = 262144;
    spec
}

// Break caught: caller intent absent, reminted on replay, or pre-created child
// runs/configurations masquerading as internal identity reservations.
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_kernel_original_slot_intent_is_durable_and_replays_without_child_runs() {
    m95_with_delegation_parent(
        "m95-intent-replay",
        None,
        |fixture, _, owner, conn, parent| {
            let runs: i64 = conn
                .query_row("SELECT count(*) FROM runs", [], |r| r.get(0))
                .unwrap();
            let configs: i64 = conn
                .query_row("SELECT count(*) FROM run_configurations", [], |r| r.get(0))
                .unwrap();
            let first = owner.m95_prepare_intent(&parent, 0).expect(
                "M95 causal RED: actual retained original parent has no durable intent writer",
            );
            let again = owner.m95_prepare_intent(&parent, 0).unwrap();
            assert_eq!(first, again);
            assert_eq!(first.slot_id.len(), 32);
            assert_eq!(first.request_key.len(), 32);
            assert_ne!(first.slot_id, first.request_key);
            assert_ne!(first.request_key, fixture.meter.run_id);
            let stored: (String, String) = conn.query_row(
            "SELECT slot_id,request_key FROM chat_delegation_intents WHERE parent_run_id=?1 AND attempt_id=?2 AND slot_ordinal=0",
            rusqlite::params![parent.receipt.run_id(), parent.attempt],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
            assert_eq!(stored, (first.slot_id, first.request_key));
            assert_eq!(
                conn.query_row("SELECT count(*) FROM runs", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                runs
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM run_configurations", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                configs
            );
        },
    );
}

// Break caught: duplicate allocation or replay's new identities/deadline; empty
// or length-only digest; raw canary copied into metadata storage.
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_kernel_same_intent_digest_recovers_original_ids_after_expiry() {
    m95_with_delegation_parent(
        "m95-allocation-replay",
        None,
        |fixture, _, owner, conn, parent| {
            let intent = owner
                .m95_prepare_intent(&parent, 0)
                .expect("M95 missing intent precondition");
            let mut spec = m95_delegation_spec(&parent);
            spec.objective = "M95_TRANSIENT_OBJECTIVE_CANARY_798d".into();
            let first = owner
                .m95_reserve(&parent, &intent, &spec, 1000)
                .expect("M95 causal RED: actual owner has no transactional allocation writer");
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &spec, 1001),
                Ok(first.clone())
            );
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &spec, 1600),
                Ok(first.clone())
            );
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &spec, 9999),
                Ok(first.clone())
            );
            assert_eq!(first.deadline_at, 1600);
            assert_eq!(first.request_digest.len(), 64);
            assert!(first
                .request_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            assert_ne!(first.job_id, first.run_id);
            assert_ne!(first.run_id, fixture.meter.run_id);
            assert_ne!(first.session_id, fixture.session.id());
            assert!(crate::runtime::cause::is_cli_session_id(&first.session_id));
            let rows: i64 = conn
                .query_row("SELECT count(*) FROM child_job_reservations", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(rows, 1);
            let stored: (String, String, String, String, i64) = conn.query_row(
            "SELECT job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at FROM child_job_reservations WHERE slot_id=?1",
            [&intent.slot_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        ).unwrap();
            assert_eq!(
                u64::try_from(stored.4)
                    .expect("stored deadline must be a nonnegative SQLite integer"),
                first.deadline_at,
            );
            assert_eq!(
                stored,
                (
                    first.job_id,
                    first.run_id.clone(),
                    first.session_id,
                    first.request_digest,
                    1600
                )
            );
            assert_eq!(
                conn.query_row(
                    "SELECT count(*) FROM runs WHERE run_id=?1",
                    [&first.run_id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            let payload_columns: i64 = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('child_job_reservations') WHERE name IN ('objective','prompt','result_body','evidence_body','reasoning','bearer')",
            [], |r| r.get(0),
        ).unwrap();
            assert_eq!(payload_columns, 0);
        },
    );
}

// Break caught: frozen candidate field omitted from canonical digest, ambiguous
// concatenation, or v1 array reordering normalized into an authorized replay.
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_kernel_changed_immutable_fields_conflict_without_new_allocation() {
    use crate::actions::native_owner::tests::chat_delegation::Refusal;
    m95_with_delegation_parent("m95-digest-coverage", None, |_, _, owner, conn, parent| {
        let intent = owner
            .m95_prepare_intent(&parent, 0)
            .expect("M95 missing intent precondition");
        let mut spec = m95_delegation_spec(&parent);
        spec.input_evidence_refs = vec![
            child_jobs::types::EvidenceRef {
                path: "a.md".into(),
                sha256: "a".repeat(64),
            },
            child_jobs::types::EvidenceRef {
                path: "b.md".into(),
                sha256: "b".repeat(64),
            },
        ];
        spec.requested_grant.read_scope = vec!["a.md".into(), "b.md".into()];
        let original = owner.m95_reserve(&parent, &intent, &spec, 1000).unwrap();
        let mut changes = Vec::new();
        let mut next = spec.clone();
        next.objective.push('x');
        changes.push(next);
        let mut next = spec.clone();
        next.instruction_source_version = "b".repeat(64);
        changes.push(next);
        let mut next = spec.clone();
        next.input_evidence_refs[0].path = "c.md".into();
        changes.push(next);
        let mut next = spec.clone();
        next.input_evidence_refs[0].sha256 = "c".repeat(64);
        changes.push(next);
        let mut next = spec.clone();
        next.input_evidence_refs.reverse();
        changes.push(next);
        let mut next = spec.clone();
        next.requested_grant.read_scope.reverse();
        changes.push(next);
        let mut next = spec.clone();
        next.requested_grant.read_scope[0] = "c.md".into();
        changes.push(next);
        let mut next = spec.clone();
        next.budget.result_bytes -= 1;
        changes.push(next);
        let mut next = spec.clone();
        next.budget.elapsed_seconds -= 1;
        next.deadline_at -= 1;
        changes.push(next);
        let mut next = spec.clone();
        next.deadline_at -= 1;
        changes.push(next);
        for changed in changes {
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &changed, 1000),
                Err(Refusal::RequestKeyConflict)
            );
        }
        assert_eq!(
            owner.m95_reserve(&parent, &intent, &spec, 1000),
            Ok(original)
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    });
}

// Break caught: supplied-count admission, count/insert outside the transaction,
// or replay spending an additional concurrent/lifetime slot at capacity.
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_kernel_two_active_reservations_refuse_third_but_allow_replay() {
    use crate::actions::native_owner::tests::chat_delegation::Refusal;
    m95_with_delegation_parent("m95-concurrent-slots", None, |_, _, owner, conn, parent| {
        let spec = m95_delegation_spec(&parent);
        let one = owner
            .m95_prepare_intent(&parent, 0)
            .expect("M95 missing intent precondition");
        let two = owner.m95_prepare_intent(&parent, 1).unwrap();
        let three = owner.m95_prepare_intent(&parent, 2).unwrap();
        let original = owner.m95_reserve(&parent, &one, &spec, 1000).unwrap();
        owner.m95_reserve(&parent, &two, &spec, 1000).unwrap();
        assert_eq!(
            owner.m95_reserve(&parent, &three, &spec, 1000),
            Err(Refusal::Concurrency)
        );
        assert_eq!(owner.m95_reserve(&parent, &one, &spec, 1000), Ok(original));
        assert_eq!(
            conn.query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    });
}

// Break caught: reset allowance on each run/attempt rather than actual parent
// CLI session, or release of occupancy refunding lifetime reservations.
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_kernel_eight_lifetime_allowance_survives_new_root_attempt_in_same_session() {
    use crate::actions::native_owner::tests::chat_delegation::Refusal;
    m95_with_delegation_parent(
        "m95-session-lifetime",
        None,
        |first, scope, owner, conn, parent| {
            let spec = m95_delegation_spec(&parent);
            for ordinal in 0..8 {
                let intent = owner
                    .m95_prepare_intent(&parent, ordinal)
                    .expect("M95 missing intent precondition");
                let allocation = owner.m95_reserve(&parent, &intent, &spec, 1000).unwrap();
                owner
                    .m95_release_provisional_slot(&parent, &allocation)
                    .unwrap();
            }
            m95_with_delegation_parent(
                "m95-session-next-root",
                Some((first, scope)),
                |second, _, next_owner, _, next_parent| {
                    assert_eq!(first.session.id(), second.session.id());
                    assert_ne!(parent.attempt, next_parent.attempt);
                    let intent = next_owner.m95_prepare_intent(&next_parent, 0).unwrap();
                    let next_spec = m95_delegation_spec(&next_parent);
                    assert_eq!(
                        next_owner.m95_reserve(&next_parent, &intent, &next_spec, 1000),
                        Err(Refusal::SessionAdmissions)
                    );
                },
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                8
            );
        },
    );
}

#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_kernel_new_allocation_deadline_is_inclusive_without_consuming_slot() {
    use crate::actions::native_owner::tests::chat_delegation::Refusal;
    m95_with_delegation_parent(
        "m95-inclusive-deadline",
        None,
        |_, _, owner, conn, parent| {
            let spec = m95_delegation_spec(&parent);
            let intent = owner
                .m95_prepare_intent(&parent, 0)
                .expect("M95 missing intent precondition");
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &spec, 1600),
                Err(Refusal::Deadline)
            );
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &spec, 1601),
                Err(Refusal::Deadline)
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        },
    );
}

// Preservation controls exercise evidence the kernel adapter actually has.
// No fake native origin or synthetic publication replaces the real owner path.
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_kernel_wrong_attempt_store_and_closed_session_refuse() {
    use crate::actions::native_owner::tests::chat_delegation::Refusal;
    m95_with_delegation_parent(
        "m95-owner-selector-denials",
        None,
        |_, scope, owner, conn, mut parent| {
            let original = parent.attempt;
            parent.attempt = "cccccccccccccccccccccccccccccccc";
            assert_eq!(
                owner.m95_prepare_intent(&parent, 0),
                Err(Refusal::Unavailable)
            );
            parent.attempt = original;
            let wrong_scope = crate::runtime::VaultScope {
                vault_id: scope.vault_id.clone(),
                store_uuid: Some("wrong-store".into()),
            };
            let wrong_parent = crate::actions::native_owner::tests::chat_delegation::ParentProbe {
                scope: &wrong_scope,
                ..parent
            };
            assert_eq!(
                owner.m95_prepare_intent(&wrong_parent, 0),
                Err(Refusal::Unavailable)
            );
            conn.execute("UPDATE app_sessions SET close_precision='clean_exact',clean_closed_at='2026-10-24T00:00:00.000Z' WHERE session_id=?1", [crate::runtime::sessions::session_id()]).unwrap();
            assert_eq!(
                owner.m95_prepare_intent(&parent, 0),
                Err(Refusal::Unavailable)
            );
        },
    );
}

#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_kernel_replaced_listener_and_stopped_original_refuse() {
    use crate::actions::native_owner::tests::chat_delegation::Refusal;
    use crate::mcp::native_publication_test_support as transport;
    for stop in [false, true] {
        m95_with_delegation_parent("m95-source-retirement", None, |_, _, owner, _, parent| {
            if stop {
                let run = *lock(&parent.agents.slots).keys().next().unwrap();
                parent.agents.stop(run).unwrap();
            } else {
                transport::replace_listener_preserving_entries(parent.mcp);
            }
            assert_eq!(
                owner.m95_prepare_intent(&parent, 0),
                Err(Refusal::Unavailable)
            );
        });
    }
}

// Additive M95 kernel REDs. They compile against the existing refusal scaffold;
// their deeper assertions execute only after the missing intent writer exists.
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_extra_intent_lost_ack_is_durable_and_reopen_reuses_key() {
    use crate::actions::native_owner::tests::{chat_delegation::Refusal, PublicationSqlOwner};
    m95_with_delegation_parent("m95-intent-ack", None, |fixture, _, owner, conn, parent| {
        assert_eq!(
            owner.m95_prepare_losing_ack(&parent, 0),
            Err(Refusal::Unavailable)
        );
        let available: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_delegation_intents')",[],|r|r.get(0)).unwrap();
        assert!(
            available,
            "M95 missing durable intent storage after attempted lost-ack operation"
        );
        let stored: Option<(String,String)> = conn.query_row(
            "SELECT slot_id,request_key FROM chat_delegation_intents WHERE parent_run_id=?1 AND slot_ordinal=0",
            [parent.receipt.run_id()],|r|Ok((r.get(0)?,r.get(1)?)),
        ).optional().expect("intent metadata query must succeed");
        assert!(
            stored.is_some(),
            "M95 missing intent commit: lost acknowledgment left no durable native slot"
        );
        assert!(owner.m95_owner_is_retired());
        assert_eq!(
            owner.m95_prepare_intent(&parent, 0),
            Err(Refusal::Unavailable)
        );
        *owner = PublicationSqlOwner::open(&fixture.meter.data_dir);
        let replay = owner.m95_prepare_intent(&parent, 0).unwrap();
        assert_eq!(stored, Some((replay.slot_id, replay.request_key)));
    });
}
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_extra_allocation_lost_ack_reuses_tuple_without_deadline_extension() {
    use crate::actions::native_owner::tests::{chat_delegation::Refusal, PublicationSqlOwner};
    m95_with_delegation_parent(
        "m95-allocation-ack",
        None,
        |fixture, _, owner, conn, parent| {
            let intent = owner
                .m95_prepare_intent(&parent, 0)
                .expect("M95 missing intent precondition");
            let spec = m95_delegation_spec(&parent);
            assert_eq!(
                owner.m95_reserve_losing_ack(&parent, &intent, &spec, 1000),
                Err(Refusal::Unavailable)
            );
            let stored: (String,String,String,String,i64) = conn.query_row(
            "SELECT job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at FROM child_job_reservations WHERE slot_id=?1",
            [&intent.slot_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        ).expect("lost acknowledgment must follow a real durable allocation commit");
            assert!(owner.m95_owner_is_retired());
            *owner = PublicationSqlOwner::open(&fixture.meter.data_dir);
            let replay = owner.m95_reserve(&parent, &intent, &spec, 9999).unwrap();
            assert_eq!(
                stored,
                (
                    replay.job_id,
                    replay.run_id,
                    replay.session_id,
                    replay.request_digest,
                    i64::try_from(replay.deadline_at).unwrap()
                )
            );
            assert_eq!(replay.deadline_at, 1600);
            assert_eq!(
                conn.query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        },
    );
}
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_extra_insert_abort_keeps_prior_intent_and_rolls_back_allocation() {
    use crate::actions::native_owner::tests::{chat_delegation::Refusal, PublicationSqlOwner};
    m95_with_delegation_parent(
        "m95-allocation-abort",
        None,
        |fixture, _, owner, conn, parent| {
            let intent = owner
                .m95_prepare_intent(&parent, 0)
                .expect("M95 missing intent precondition");
            let spec = m95_delegation_spec(&parent);
            conn.execute_batch("CREATE TRIGGER m95_abort_reservation BEFORE INSERT ON child_job_reservations BEGIN SELECT RAISE(ABORT,'reservation insert fault'); END;").unwrap();
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &spec, 1000),
                Err(Refusal::Unavailable)
            );
            assert!(!owner.m95_owner_is_retired());
            assert_eq!(
                conn.query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            conn.execute_batch("DROP TRIGGER m95_abort_reservation")
                .unwrap();
            *owner = PublicationSqlOwner::open(&fixture.meter.data_dir);
            assert_eq!(owner.m95_prepare_intent(&parent, 0), Ok(intent.clone()));
            let allocation = owner.m95_reserve(&parent, &intent, &spec, 1000).unwrap();
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &spec, 1000),
                Ok(allocation)
            );
        },
    );
}
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_extra_durable_session_allowance_survives_owner_reopen() {
    use crate::actions::native_owner::tests::{chat_delegation::Refusal, PublicationSqlOwner};
    m95_with_delegation_parent(
        "m95-lifetime-reopen",
        None,
        |fixture, scope, owner, conn, parent| {
            let spec = m95_delegation_spec(&parent);
            for ordinal in 0..8 {
                *owner = PublicationSqlOwner::open(&fixture.meter.data_dir);
                let intent = owner
                    .m95_prepare_intent(&parent, ordinal)
                    .expect("M95 missing intent precondition");
                let allocation = owner.m95_reserve(&parent, &intent, &spec, 1000).unwrap();
                owner
                    .m95_release_provisional_slot(&parent, &allocation)
                    .unwrap();
                assert_eq!(
                    owner.m95_reserve(&parent, &intent, &spec, 9999),
                    Ok(allocation)
                );
            }
            m95_with_delegation_parent(
                "m95-next-after-reopen",
                Some((fixture, scope)),
                |_, _, next, _, other| {
                    let intent = next.m95_prepare_intent(&other, 0).unwrap();
                    let spec = m95_delegation_spec(&other);
                    assert_eq!(
                        next.m95_reserve(&other, &intent, &spec, 1000),
                        Err(Refusal::SessionAdmissions)
                    );
                },
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                8
            );
            assert_eq!(
                conn.query_row(
                    "SELECT sum(occupies_slot) FROM child_job_reservations",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        },
    );
}
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_extra_two_actual_roots_race_the_last_session_slot() {
    use crate::actions::native_owner::tests::{chat_delegation::Refusal, PublicationSqlOwner};
    m95_with_delegation_parent(
        "m95-last-slot-race",
        None,
        |fixture, scope, owner, conn, parent| {
            let spec = m95_delegation_spec(&parent);
            let occupied = owner
                .m95_prepare_intent(&parent, 0)
                .expect("M95 missing intent precondition");
            owner.m95_reserve(&parent, &occupied, &spec, 1000).unwrap();
            let left = owner.m95_prepare_intent(&parent, 1).unwrap();
            m95_with_delegation_parent(
                "m95-racing-native-root",
                Some((fixture, scope)),
                |_, _, next, _, other| {
                    let right = next.m95_prepare_intent(&other, 0).unwrap();
                    let right_spec = m95_delegation_spec(&other);
                    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
                    let data = &fixture.meter.data_dir;
                    let results = std::thread::scope(|threads| {
                        let gate = barrier.clone();
                        let first = threads.spawn(move || {
                            let mut owner = PublicationSqlOwner::open(data);
                            gate.wait();
                            owner.m95_reserve(&parent, &left, &spec, 1000)
                        });
                        let second = threads.spawn(move || {
                            let mut owner = PublicationSqlOwner::open(data);
                            barrier.wait();
                            owner.m95_reserve(&other, &right, &right_spec, 1000)
                        });
                        [first.join().unwrap(), second.join().unwrap()]
                    });
                    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
                    assert_eq!(
                        results
                            .iter()
                            .filter(|r| **r == Err(Refusal::Concurrency))
                            .count(),
                        1
                    );
                },
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                2
            );
        },
    );
}
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_extra_committed_intent_cannot_cross_parent_or_revoked_publication() {
    use crate::actions::native_owner::tests::chat_delegation::Refusal;
    m95_with_delegation_parent(
        "m95-intent-owner-access",
        None,
        |fixture, scope, owner, conn, parent| {
            let intent = owner
                .m95_prepare_intent(&parent, 0)
                .expect("M95 missing intent precondition");
            let spec = m95_delegation_spec(&parent);
            let original = owner.m95_reserve(&parent, &intent, &spec, 1000).unwrap();
            m95_with_delegation_parent(
                "m95-intent-other-parent",
                Some((fixture, scope)),
                |_, _, next, _, other| {
                    let other_spec = m95_delegation_spec(&other);
                    assert_eq!(
                        next.m95_reserve(&other, &intent, &other_spec, 1000),
                        Err(Refusal::Unavailable)
                    );
                },
            );
            parent.mcp.revoke(
                fixture.request.mcp_token.as_deref().unwrap(),
                crate::mcp::REVOKE_GRACE,
            );
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &spec, 1000),
                Err(Refusal::Unavailable)
            );
            let stored: String = conn
                .query_row("SELECT job_id FROM child_job_reservations", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(stored, original.job_id);
        },
    );
}
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_extra_tagged_digest_and_transient_content_do_not_persist() {
    use crate::actions::native_owner::tests::chat_delegation::Refusal;
    m95_with_delegation_parent(
        "m95-digest-privacy",
        None,
        |fixture, _, owner, conn, parent| {
            let intent = owner
                .m95_prepare_intent(&parent, 0)
                .expect("M95 missing intent precondition");
            let canary = "M95_PRIVATE_CANARY_c607748b";
            let mut spec = m95_delegation_spec(&parent);
            spec.objective = canary.into();
            spec.input_evidence_refs[0].path = format!("{canary}.md");
            spec.requested_grant.read_scope = vec!["a".into(), "bc".into()];
            let allocation = owner.m95_reserve(&parent, &intent, &spec, 1000).unwrap();
            let mut ambiguous = spec.clone();
            ambiguous.requested_grant.read_scope = vec!["ab".into(), "c".into()];
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &ambiguous, 1000),
                Err(Refusal::RequestKeyConflict)
            );
            let mut invalid = spec.clone();
            invalid.result_schema_id = "not-allowlisted.v1".into();
            assert!(owner.m95_reserve(&parent, &intent, &invalid, 1000).is_err());
            let mut invalid = spec.clone();
            invalid.objective = "x".repeat(16385);
            assert!(owner.m95_reserve(&parent, &intent, &invalid, 1000).is_err());
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &spec, 1000),
                Ok(allocation)
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            let db = crate::runtime::runtime_db_path(&fixture.meter.data_dir);
            for path in [db.clone(), PathBuf::from(format!("{}-wal", db.display()))] {
                match std::fs::read(path) {
                    Ok(bytes) => assert!(
                        !bytes
                            .windows(canary.len())
                            .any(|part| part == canary.as_bytes()),
                        "transient content entered runtime storage"
                    ),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                    Err(error) => panic!("runtime storage privacy read unavailable: {error}"),
                }
            }
        },
    );
}

#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_extra_intent_insert_abort_exposes_no_replacement_key() {
    use crate::actions::native_owner::tests::chat_delegation::Refusal;
    m95_with_delegation_parent("m95-intent-abort", None, |_, _, owner, conn, parent| {
        let first = owner
            .m95_prepare_intent(&parent, 0)
            .expect("M95 missing intent precondition");
        conn.execute_batch("CREATE TRIGGER m95_abort_intent BEFORE INSERT ON chat_delegation_intents BEGIN SELECT RAISE(ABORT,'intent insert fault'); END;").unwrap();
        assert_eq!(
            owner.m95_prepare_intent(&parent, 1),
            Err(Refusal::Unavailable)
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM chat_delegation_intents", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(owner.m95_prepare_intent(&parent, 0), Ok(first));
        conn.execute_batch("DROP TRIGGER m95_abort_intent").unwrap();
        let second = owner.m95_prepare_intent(&parent, 1).unwrap();
        assert_eq!(owner.m95_prepare_intent(&parent, 1), Ok(second));
        assert_eq!(
            conn.query_row("SELECT count(*) FROM chat_delegation_intents", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    });
}
#[cfg(target_os = "macos")]
#[test]
fn m95_delegation_extra_concurrent_duplicate_callers_recover_one_committed_tuple() {
    use crate::actions::native_owner::tests::PublicationSqlOwner;
    m95_with_delegation_parent(
        "m95-duplicate-race",
        None,
        |fixture, _, owner, conn, parent| {
            let intent = owner
                .m95_prepare_intent(&parent, 0)
                .expect("M95 missing intent precondition");
            let spec = m95_delegation_spec(&parent);
            let parent = &parent;
            let intent = &intent;
            let spec = &spec;
            let data = &fixture.meter.data_dir;
            let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
            let results = std::thread::scope(|threads| {
                let left_gate = gate.clone();
                let left = threads.spawn(move || {
                    let mut owner = PublicationSqlOwner::open(data);
                    left_gate.wait();
                    owner.m95_reserve(parent, intent, spec, 1000)
                });
                let right = threads.spawn(move || {
                    let mut owner = PublicationSqlOwner::open(data);
                    gate.wait();
                    owner.m95_reserve(parent, intent, spec, 1000)
                });
                [left.join().unwrap(), right.join().unwrap()]
            });
            assert!(results[0].is_ok());
            assert_eq!(results[0], results[1]);
            assert_eq!(
                conn.query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        },
    );
}

#[cfg(target_os = "macos")]
#[path = "child_freeze_publication_tests.rs"]
mod child_freeze_publication_tests;

#[cfg(target_os = "macos")]
#[path = "child_lifetime_publication_tests.rs"]
mod child_lifetime_publication_tests;

// Control tests use the actual published original process/receipt fixture.
// They create no native window, ActionSubject or callable provider authority.
#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_control_cancels_only_exact_original_request() {
    m95_with_delegation_parent("m96-rpc-exact", None, |_, _, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        let now = Instant::now();
        let first = book
            .register(
                parent.mcp,
                parent.slot,
                &serde_json::json!("original"),
                now + Duration::from_secs(30),
            )
            .expect("original actual call control");
        let other = book
            .register(
                parent.mcp,
                parent.slot,
                &serde_json::json!("other"),
                now + Duration::from_secs(30),
            )
            .unwrap();
        assert!(!book.cancel(parent.mcp, parent.slot, &serde_json::json!("unknown")));
        assert!(!first.stopped_at(now));
        assert!(book.cancel(parent.mcp, parent.slot, &serde_json::json!("original")));
        assert!(first.stopped_at(now));
        assert!(!other.stopped_at(now));
    });
}
#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_control_distinguishes_numeric_and_string_request_ids() {
    m95_with_delegation_parent("m96-rpc-id-types", None, |_, _, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        let now = Instant::now();
        let number = book
            .register(
                parent.mcp,
                parent.slot,
                &serde_json::json!(1),
                now + Duration::from_secs(30),
            )
            .unwrap();
        let string = book
            .register(
                parent.mcp,
                parent.slot,
                &serde_json::json!("1"),
                now + Duration::from_secs(30),
            )
            .unwrap();
        assert!(book.cancel(parent.mcp, parent.slot, &serde_json::json!(1)));
        assert!(number.stopped_at(now));
        assert!(!string.stopped_at(now));
    });
}
#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_control_rejects_same_id_from_another_actual_publication_or_clone() {
    m95_with_delegation_parent("m96-rpc-owner", None, |fixture, scope, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        let now = Instant::now();
        let original = book
            .register(
                parent.mcp,
                parent.slot,
                &serde_json::json!(1),
                now + Duration::from_secs(30),
            )
            .unwrap();
        assert!(!book.cancel_descriptive_clone(parent.mcp, parent.slot, &serde_json::json!(1)));
        m95_with_delegation_parent(
            "m96-rpc-other-owner",
            Some((fixture, scope)),
            |_, _, _, _, other| {
                assert!(!book.cancel(other.mcp, other.slot, &serde_json::json!(1)));
            },
        );
        assert!(!original.stopped_at(now));
        assert!(book.cancel(parent.mcp, parent.slot, &serde_json::json!(1)));
    });
}
#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_control_keeps_active_duplicate_closed_until_actual_owner_drop() {
    m95_with_delegation_parent("m96-rpc-drop", None, |_, _, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        let original = book
            .register(parent.mcp, parent.slot, &serde_json::json!(1), deadline)
            .unwrap();
        assert!(book
            .register(parent.mcp, parent.slot, &serde_json::json!(1), deadline)
            .is_none());
        let flag = original.flag();
        drop(original);
        assert!(flag.load(Ordering::SeqCst));
        let replacement = book
            .register(parent.mcp, parent.slot, &serde_json::json!(1), deadline)
            .unwrap();
        assert!(!replacement.stopped_at(Instant::now()));
    });
}
#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_control_deadline_stops_but_does_not_release_active_original_ownership() {
    m95_with_delegation_parent("m96-rpc-deadline", None, |_, _, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        let now = Instant::now();
        let deadline = now + Duration::from_secs(30);
        let original = book
            .register(parent.mcp, parent.slot, &serde_json::json!(1), deadline)
            .unwrap();
        assert!(!original.stopped_at(now));
        assert!(original.stopped_at(deadline));
        assert!(original.flag().load(Ordering::SeqCst));
        assert!(book
            .register(
                parent.mcp,
                parent.slot,
                &serde_json::json!(1),
                now + Duration::from_secs(60)
            )
            .is_none());
    });
}
#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_control_poison_publishes_raw_cancel_to_existing_workers() {
    m95_with_delegation_parent("m96-rpc-poison", None, |_, _, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        let original = book
            .register(
                parent.mcp,
                parent.slot,
                &serde_json::json!(1),
                Instant::now() + Duration::from_secs(30),
            )
            .unwrap();
        let raw = original.flag();
        book.poison();
        assert!(!book.cancel(parent.mcp, parent.slot, &serde_json::json!(1)));
        assert!(raw.load(Ordering::SeqCst));
        assert!(original.stopped_at(Instant::now()));
        assert!(book
            .register(
                parent.mcp,
                parent.slot,
                &serde_json::json!(2),
                Instant::now() + Duration::from_secs(30)
            )
            .is_none());
    });
}
#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_control_refuses_missing_complex_oversized_and_ambiguous_request_ids() {
    m95_with_delegation_parent("m96-rpc-malformed", None, |_, _, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        let policy: Value =
            serde_json::from_str(include_str!("../../../shared/policy/actions.v1.json")).unwrap();
        let max_id =
            usize::try_from(policy["historyInspection"]["maxIdBytes"].as_u64().unwrap()).unwrap();
        for id in [
            Value::Null,
            serde_json::json!(true),
            serde_json::json!({"id":1}),
            serde_json::json!([1]),
            serde_json::json!(""),
            serde_json::json!("x".repeat(max_id + 1)),
            serde_json::json!(1.5),
            serde_json::json!(9007199254740992_u64),
        ] {
            assert!(book
                .register(parent.mcp, parent.slot, &id, deadline)
                .is_none());
        }
    });
}
#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_control_refuses_an_already_elapsed_deadline() {
    m95_with_delegation_parent("m96-rpc-expired", None, |_, _, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        assert!(book
            .register(
                parent.mcp,
                parent.slot,
                &serde_json::json!(1),
                Instant::now()
            )
            .is_none());
    });
}

#[cfg(target_os = "macos")]
#[test]
fn managed_names_are_present_in_early_original_attended_tools_list_before_native_install() {
    m95_with_delegation_parent("m96-early-tool-cache", None, |_, _, _, _, parent| {
        let names = crate::mcp::managed_tools_list_names_for_source_probe(
            parent.mcp,
            parent.slot,
            parent.agents.interactions(),
        );
        let policy: Value =
            serde_json::from_str(include_str!("../../../shared/policy/actions.v1.json")).unwrap();
        for name in policy["reservedTools"].as_array().unwrap() {
            assert!(
                names
                    .iter()
                    .any(|listed| Some(listed.as_str()) == name.as_str()),
                "early manifest cache silently hid a supported managed tool"
            );
        }
        assert!(parent
            .agents
            .native_action_read_for_publication(parent.receipt)
            .is_none());
    });
}
#[cfg(target_os = "macos")]
#[test]
fn managed_original_call_source_admission_refuses_until_actual_native_install() {
    m95_with_delegation_parent("m96-early-call-refusal", None, |_, _, _, _, parent| {
        assert!(
            parent.mcp.current_native_publication(parent.slot).is_some(),
            "actual published MCP receipt precondition"
        );
        assert!(parent.agents.native_action_read_for_publication(parent.receipt).is_none(),"publication/seat metadata alone must not yield the actual installed original native origin");
    });
}

#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_owner_remains_registered_through_actual_response_callback() {
    m95_with_delegation_parent("m96-rpc-response-owner", None, |_, _, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        let id = serde_json::json!("response");
        let deadline = Instant::now() + Duration::from_secs(30);
        let owner = book
            .register(parent.mcp, parent.slot, &id, deadline)
            .unwrap();
        let flag = owner.flag();
        owner.respond_with(serde_json::json!({"result":"bounded"}), |body| {
            assert_eq!(body["result"], "bounded");
            assert!(
                !flag.load(Ordering::SeqCst),
                "RPC control dropped before serialization/respond disposal"
            );
            assert!(
                book.register(parent.mcp, parent.slot, &id, deadline)
                    .is_none(),
                "old response still owns this exact request id"
            );
            assert!(book.cancel(parent.mcp, parent.slot, &id));
            assert!(flag.load(Ordering::SeqCst));
        });
        assert!(book
            .register(parent.mcp, parent.slot, &id, deadline)
            .is_some());
    });
}
#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_owner_survives_response_error_until_callback_returns() {
    m95_with_delegation_parent("m96-rpc-response-error", None, |_, _, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        let id = serde_json::json!("response-error");
        let deadline = Instant::now() + Duration::from_secs(30);
        let owner = book
            .register(parent.mcp, parent.slot, &id, deadline)
            .unwrap();
        let flag = owner.flag();
        let result: Result<(), ()> = owner.respond_with(serde_json::json!({}), |_| {
            assert!(
                book.register(parent.mcp, parent.slot, &id, deadline)
                    .is_none(),
                "write error occurs while old response is owned"
            );
            Err(())
        });
        assert!(result.is_err());
        assert!(flag.load(Ordering::SeqCst));
        let replacement = book
            .register(parent.mcp, parent.slot, &id, deadline)
            .unwrap();
        assert!(!replacement.stopped_at(Instant::now()));
    });
}
#[cfg(target_os = "macos")]
#[test]
fn managed_rpc_owner_is_disposed_only_after_response_unwinds() {
    m95_with_delegation_parent("m96-rpc-response-panic", None, |_, _, _, _, parent| {
        let book = crate::mcp::managed_call_test_support::Book::new();
        let id = serde_json::json!("response-panic");
        let deadline = Instant::now() + Duration::from_secs(30);
        let owner = book
            .register(parent.mcp, parent.slot, &id, deadline)
            .unwrap();
        let flag = owner.flag();
        let reached = std::cell::Cell::new(false);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            owner.respond_with(serde_json::json!({}), |_| {
                assert!(
                    book.register(parent.mcp, parent.slot, &id, deadline)
                        .is_none(),
                    "response still owns control before unwind"
                );
                reached.set(true);
                panic!("controlled response disposal");
            })
        }));
        assert!(result.is_err());
        assert!(reached.get(),"the controlled response callback must reach its own panic, not an earlier ownership assertion");
        assert!(flag.load(Ordering::SeqCst));
        assert!(book
            .register(parent.mcp, parent.slot, &id, deadline)
            .is_some());
    });
}
