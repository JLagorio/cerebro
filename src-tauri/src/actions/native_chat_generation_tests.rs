//! Provider-free native owner composition tests. Fixture observations enter the
//! production original-preparation/storage transaction; this is not OS smoke.
#![cfg(target_os = "macos")]
use super::*;
use crate::agent::interaction::{GateAnswer, GateCall, PersonAnswer, Remember, Seat, WireAnswer};
use serde_json::json;
const KEY: &str = "11111111111111111111111111111111";
const SESSION: &str = "12345678-1234-1234-1234-123456789abc";
struct Host {
    data: PathBuf,
    root: PathBuf,
    conn: Connection,
    owner: Arc<NativeOwnerState>,
    context: crate::workspace_service::authority::AuthorityContext,
    agents: crate::agent::AgentState,
    mcp: crate::mcp::McpState,
    scope: crate::runtime::VaultScope,
}
impl Host {
    fn new() -> Self {
        let data = crate::vault::testutil::temp_vault("m95-generation-data")
            .canonicalize()
            .unwrap();
        let root = crate::vault::testutil::temp_vault("m95-generation-root")
            .canonicalize()
            .unwrap();
        let store = crate::ledger::store::load_or_mint(&crate::ledger::ledger_dir(&root)).unwrap();
        let conn = crate::runtime::open(&data).unwrap();
        let vault = crate::runtime::scope::register(&conn, &root).unwrap();
        crate::runtime::catchup::open_session(
            &conn,
            crate::runtime::sessions::session_id(),
            &vault,
            &store.store_id,
            chrono::Utc::now(),
        )
        .unwrap();
        let registration = Arc::new(WindowRegistration {
            identity: NativeWindowIdentity {
                window: 100,
                view: 200,
                label: "main".into(),
            },
            origin: data.clone(),
            live: AtomicBool::new(true),
        });
        let owner = Arc::new(NativeOwnerState {
            registration,
            credential_cancellations: Arc::default(),
            action_cancellations: Arc::default(),
            storage: Mutex::new(StorageState {
                owner: Some(RuntimeOwner::open_existing(&data).unwrap()),
                failed: false,
            }),
        });
        let context = crate::workspace_service::authority::AuthorityContext::new(data.clone());
        let agents = crate::agent::AgentState::default();
        let generation = context.begin_open().unwrap();
        agents.begin_open(generation).unwrap();
        crate::finish_legacy_open(&context, generation, &root, &agents, || {}).unwrap();
        Self {
            data,
            root,
            conn,
            owner,
            context,
            agents,
            mcp: Default::default(),
            scope: crate::runtime::VaultScope {
                vault_id: vault,
                store_uuid: Some(store.store_id),
            },
        }
    }
    fn entry<'a>(&'a self, preparation: &'a crate::agent::RunPreparation) -> NativeRootEntry<'a> {
        let observed = WindowObservation {
            registration: self.owner.registration.clone(),
            injected: self.owner.registration.identity.clone(),
            current: self.owner.registration.identity.clone(),
            origin: self.data.clone(),
            entry: Url::parse("tauri://localhost/").unwrap(),
        };
        verify_window(&self.owner.registration, &observed, None).unwrap();
        NativeRootEntry {
            proof: AttendedWindowProof {
                owner: self.owner.clone(),
            },
            context: self.context.clone(),
            opening: self.context.capture_legacy_opening(&self.root).unwrap(),
            root: self.root.clone(),
            agents: &self.agents,
            preparation,
            mcp: &self.mcp,
            authority_id: crate::ledger::new_id128(),
        }
    }
    fn request(&self) -> crate::agent::AgentRequest {
        serde_json::from_value(json!({"message":"visible question","system_prompt":"assembled context","attended":true,"shell":"ask"})).unwrap()
    }
    fn count(&self, table: &str) -> i64 {
        self.conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
}
#[test]
fn native_generation_admission_is_committed_before_any_process_or_native_root() {
    let host = Host::new();
    let prep = host.agents.prepare_run(&host.root).unwrap();
    let entry = host.entry(&prep);
    let request = host.request();
    let GenerationStart::New(ticket) = entry.begin_generation(&host.scope, KEY, &request).unwrap()
    else {
        panic!("first launch")
    };
    assert_eq!(host.count("chat_generations"), 1);
    assert_eq!(host.count("chat_generation_runs"), 1);
    assert_eq!(host.agents.live(), 0);
    assert_eq!(host.count("runs"), 0);
    assert_eq!(host.count("action_native_runs"), 0);
    assert_eq!(host.count("chat_parent_attempts"), 0);
    let GenerationStart::Observed(seen) =
        entry.begin_generation(&host.scope, KEY, &request).unwrap()
    else {
        panic!("duplicate acquired a ticket")
    };
    assert_eq!(seen.current_run_id, ticket.run_id());
    let mut changed = request.clone();
    changed.message.push('!');
    assert!(entry
        .begin_generation(&host.scope, KEY, &changed)
        .err()
        .unwrap()
        .starts_with("request_key_conflict"));
    drop(ticket);
    let GenerationStart::Observed(seen) =
        entry.begin_generation(&host.scope, KEY, &request).unwrap()
    else {
        panic!("failed spawn replay")
    };
    assert_eq!(seen.state, "failed");
}
#[test]
fn native_generation_rejects_another_original_entry_or_a_retired_opening() {
    let host = Host::new();
    let prep = host.agents.prepare_run(&host.root).unwrap();
    let entry = host.entry(&prep);
    let GenerationStart::New(mut ticket) = entry
        .begin_generation(&host.scope, KEY, &host.request())
        .unwrap()
    else {
        panic!("ticket")
    };
    let other = host.agents.prepare_run(&host.root).unwrap();
    assert!(ticket.bind_session(SESSION, &other, &host.root).is_err());
    host.agents.suspend_run_admission();
    assert!(entry
        .begin_generation(
            &host.scope,
            "22222222222222222222222222222222",
            &host.request()
        )
        .is_err());
    assert_eq!(host.count("chat_generations"), 1);
}
#[test]
fn native_generation_commit_ack_loss_never_returns_a_dispatch_ticket() {
    let host = Host::new();
    let prep = host.agents.prepare_run(&host.root).unwrap();
    let entry = host.entry(&prep);
    super::super::tests::with_transaction_ack_probe(|| {
        super::super::tests::lose_next_transaction_ack();
        assert!(entry
            .begin_generation(&host.scope, KEY, &host.request())
            .is_err());
    });
    assert_eq!(host.count("chat_generations"), 1);
    assert_eq!(host.agents.live(), 0);
    host.owner.storage.lock().unwrap().owner =
        Some(RuntimeOwner::open_existing(&host.data).unwrap());
    assert!(matches!(
        entry.begin_generation(&host.scope, KEY, &host.request()),
        Ok(GenerationStart::Observed(_))
    ));
}
#[test]
fn native_generation_links_only_its_exact_held_answer_and_ignores_late_original_settlement() {
    let host = Host::new();
    let prep = host.agents.prepare_run(&host.root).unwrap();
    let entry = host.entry(&prep);
    let request = host.request();
    let GenerationStart::New(mut original) =
        entry.begin_generation(&host.scope, KEY, &request).unwrap()
    else {
        panic!("ticket")
    };
    original.bind_session(SESSION, &prep, &host.root).unwrap();
    original.published();
    let book = host.agents.interactions();
    book.open_seat(
        Seat::new(original.run_id(), SESSION, &host.root, &request)
            .with_generation(Some(original.tracker())),
        None,
    );
    let call = GateCall {
        session_id: SESSION.into(),
        tool_use_id: "call-one".into(),
        tool_name: "Write".into(),
        tool_input: json!({"file_path":"notes/example.md","content":"example"}),
        agent_id: String::new(),
    };
    assert_eq!(book.gate(original.run_id(), &call), GateAnswer::Defer);
    let card = book.confirm(SESSION, "call-one").unwrap();
    let answer = book
        .begin_answer(
            &host.root,
            &card.id,
            PersonAnswer::from_ipc(WireAnswer::Allow {
                remember: Remember::Once,
            }),
        )
        .unwrap();
    assert!(
        book.open_unlinked_seat(Seat::new("unlinked", SESSION, &host.root, &request), None)
            .is_err(),
        "an ordinary new prompt cannot adopt a bound answer by session alone"
    );
    let resume_prep = host.agents.prepare_run(&host.root).unwrap();
    let resume_entry = host.entry(&resume_prep);
    let mut resumed = resume_entry
        .resume_generation(&host.scope, &answer.snapshot, &answer.link)
        .unwrap();
    assert_eq!(resumed.generation_id(), original.generation_id());
    assert_ne!(resumed.run_id(), original.run_id());
    assert!(
        resume_entry
            .resume_generation(&host.scope, &answer.snapshot, &answer.link)
            .is_err(),
        "redelivery cannot mint another ticket"
    );
    original.finish(rows::End::Deferred).unwrap();
    resumed
        .bind_session(SESSION, &resume_prep, &host.root)
        .unwrap();
    book.open_answer_seat(
        Seat::new(resumed.run_id(), SESSION, &host.root, &request)
            .with_generation(Some(resumed.tracker())),
        &answer.link,
    )
    .unwrap();
    resumed.published();
    assert!(matches!(
        book.gate(resumed.run_id(), &call),
        GateAnswer::Allow { .. }
    ));
    assert!(
        !book.close_seat(resumed.run_id()),
        "consumed answer never restores a prior attempt"
    );
    resumed.finish(rows::End::Completed).unwrap();
    let GenerationStart::Observed(record) =
        entry.begin_generation(&host.scope, KEY, &request).unwrap()
    else {
        panic!("observed")
    };
    assert_eq!(record.state, "completed");
    assert_eq!(record.current_run_id, resumed.run_id());
    assert_eq!(host.count("chat_generation_runs"), 2);
}
#[test]
fn native_generation_digest_binds_prompt_and_grants_but_never_bearer_or_endpoint() {
    let original: crate::agent::AgentRequest =
        serde_json::from_value(json!({"message":"question","attended":true})).unwrap();
    let digest = request_digest(&original).unwrap();
    for (field, value) in [
        ("message", json!("different")),
        ("system_prompt", json!("hidden context")),
        ("model", json!("opus")),
        ("shell", json!("on")),
        ("connectors", json!(true)),
        ("scope", json!(["notes"])),
        ("read_scope", json!([])),
        ("allowed_tools", json!([])),
        ("actor", json!("process:other")),
        ("session_id", json!(SESSION)),
        ("fork", json!({"from":SESSION,"at":SESSION})),
    ] {
        let mut wire = json!({"message":"question","attended":true});
        wire[field] = value;
        let changed = serde_json::from_value(wire).unwrap();
        assert_ne!(request_digest(&changed).unwrap(), digest, "{field}");
    }
    let mut internal = original.clone();
    internal.mcp_token = Some("private-bearer".into());
    internal.mcp_url = Some("http://127.0.0.1:1/mcp".into());
    assert_eq!(request_digest(&internal).unwrap(), digest);
}

#[test]
fn native_generation_card_cancel_after_stream_settlement_closes_deferred_metadata() {
    let host = Host::new();
    let prep = host.agents.prepare_run(&host.root).unwrap();
    let entry = host.entry(&prep);
    let request = host.request();
    let GenerationStart::New(mut original) =
        entry.begin_generation(&host.scope, KEY, &request).unwrap()
    else {
        panic!("ticket")
    };
    original.bind_session(SESSION, &prep, &host.root).unwrap();
    original.published();
    let book = host.agents.interactions();
    book.open_seat(
        Seat::new(original.run_id(), SESSION, &host.root, &request)
            .with_generation(Some(original.tracker())),
        None,
    );
    let call = GateCall {
        session_id: SESSION.into(),
        tool_use_id: "cancel-call".into(),
        tool_name: "Write".into(),
        tool_input: json!({"file_path":"notes/example.md","content":"example"}),
        agent_id: String::new(),
    };
    assert_eq!(book.gate(original.run_id(), &call), GateAnswer::Defer);
    let card = book.confirm(SESSION, "cancel-call").unwrap();
    book.close_seat(original.run_id());
    original.finish(rows::End::Deferred).unwrap();
    assert!(book.cancel(&card.id, crate::agent::interaction::CancelReason::Stopped));
    let GenerationStart::Observed(record) =
        entry.begin_generation(&host.scope, KEY, &request).unwrap()
    else {
        panic!("observe")
    };
    assert_eq!(record.state, "cancelled");
    assert_eq!(host.agents.live(), 0);
}
#[test]
fn native_generation_reaped_resume_restores_the_exact_unconsumed_wait() {
    let host = Host::new();
    let prep = host.agents.prepare_run(&host.root).unwrap();
    let entry = host.entry(&prep);
    let request = host.request();
    let GenerationStart::New(mut original) =
        entry.begin_generation(&host.scope, KEY, &request).unwrap()
    else {
        panic!("ticket")
    };
    original.bind_session(SESSION, &prep, &host.root).unwrap();
    original.published();
    let book = host.agents.interactions();
    book.open_seat(
        Seat::new(original.run_id(), SESSION, &host.root, &request)
            .with_generation(Some(original.tracker())),
        None,
    );
    let call = GateCall {
        session_id: SESSION.into(),
        tool_use_id: "restore-call".into(),
        tool_name: "Write".into(),
        tool_input: json!({"file_path":"notes/example.md","content":"example"}),
        agent_id: String::new(),
    };
    assert_eq!(book.gate(original.run_id(), &call), GateAnswer::Defer);
    let card = book.confirm(SESSION, "restore-call").unwrap();
    book.close_seat(original.run_id());
    original.finish(rows::End::Deferred).unwrap();
    let allow = || {
        PersonAnswer::from_ipc(WireAnswer::Allow {
            remember: Remember::Once,
        })
    };
    let answer = book.begin_answer(&host.root, &card.id, allow()).unwrap();
    let resume_prep = host.agents.prepare_run(&host.root).unwrap();
    let resume_entry = host.entry(&resume_prep);
    let mut resumed = resume_entry
        .resume_generation(&host.scope, &answer.snapshot, &answer.link)
        .unwrap();
    resumed
        .bind_session(SESSION, &resume_prep, &host.root)
        .unwrap();
    resumed.published();
    book.open_answer_seat(
        Seat::new(resumed.run_id(), SESSION, &host.root, &request)
            .with_generation(Some(resumed.tracker())),
        &answer.link,
    )
    .unwrap();
    assert!(
        book.close_seat(resumed.run_id()),
        "reader learns that the exact held answer was restored"
    );
    resumed.restore_waiting().unwrap();
    let next_answer = book.begin_answer(&host.root, &card.id, allow()).unwrap();
    let next_prep = host.agents.prepare_run(&host.root).unwrap();
    let next_entry = host.entry(&next_prep);
    let next = next_entry
        .resume_generation(&host.scope, &next_answer.snapshot, &next_answer.link)
        .unwrap();
    assert_eq!(next.generation_id(), original.generation_id());
    assert_ne!(next.run_id(), resumed.run_id());
    assert_eq!(host.count("chat_generation_runs"), 3);
}

fn display_binding() -> crate::runtime::conversations::AttemptBinding {
    crate::runtime::conversations::AttemptBinding {
        thread_id: "archive-thread".into(),
        user_message_id: "visible-user".into(),
        assistant_message_id: "visible-answer".into(),
        parent_thread_id: None,
        branch_message_id: None,
        display_message: crate::runtime::conversations::DisplayMessage {
            text: "Human visible question".into(),
            addressed_label: Some("Researcher".into()),
            attachment_refs: vec!["files/report.pdf".into()],
        },
    }
}
#[test]
fn native_archive_detached_original_writer_uses_frozen_display_not_assembled_prompt() {
    let host = Host::new();
    let prep = host.agents.prepare_run(&host.root).unwrap();
    let entry = host.entry(&prep);
    host.conn.execute("INSERT INTO conversation_retention(owner_person,vault_id,store_uuid,choice) VALUES('human:me',?1,?2,'forever')",rusqlite::params![host.scope.vault_id,host.scope.store_uuid]).unwrap();
    let mut request = host.request();
    request.message = "ASSEMBLED_ADDRESS_AND_CONTEXT".into();
    request.system_prompt = Some("ASSEMBLED_SYSTEM".into());
    let binding = display_binding();
    let GenerationStart::New(mut ticket) = entry
        .begin_generation_with_archive(&host.scope, KEY, &request, Some(&binding))
        .unwrap()
    else {
        panic!("original ticket")
    };
    ticket.bind_session(SESSION, &prep, &host.root).unwrap();
    let mut collector = crate::agent::archive_codec::Collector::default();
    collector.observe(&crate::agent::AgentEvent::Text {
        message_id: "folded-parent".into(),
        text: "Retained answer".into(),
        parent: None,
        at: None,
    });
    // Retiring the opening detaches delivery, not the original writer's settlement.
    host.agents.suspend_run_admission();
    ticket
        .finish_with_archive(rows::End::Completed, Some(&collector.finish()))
        .unwrap();
    assert_eq!(host.count("conversation_content"), 1);
    let content: String = host
        .conn
        .query_row("SELECT content_json FROM conversation_content", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(content.contains("Human visible question") && content.contains("Retained answer"));
    assert!(
        !content.contains("ASSEMBLED_ADDRESS_AND_CONTEXT") && !content.contains("ASSEMBLED_SYSTEM")
    );
    assert_eq!(host.count("runs"), 0);
    assert_eq!(host.count("action_native_runs"), 0);
}
#[test]
fn native_archive_default_off_clears_question_and_never_enables_on_open() {
    let host = Host::new();
    let prep = host.agents.prepare_run(&host.root).unwrap();
    let entry = host.entry(&prep);
    assert_eq!(host.count("conversation_retention"), 0);
    let GenerationStart::New(mut ticket) = entry
        .begin_generation_with_archive(&host.scope, KEY, &host.request(), Some(&display_binding()))
        .unwrap()
    else {
        panic!("ticket")
    };
    ticket.finish(rows::End::Failed).unwrap();
    assert_eq!(host.count("conversation_content"), 0);
    assert_eq!(host.count("conversation_retention"), 0);
    let state: (String, Option<String>) = host
        .conn
        .query_row(
            "SELECT archive_state,display_json FROM conversation_bindings",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, ("off".into(), None));
}

#[test]
fn native_archive_invalid_carrier_cannot_suppress_original_terminal_settlement() {
    let host = Host::new();
    let prep = host.agents.prepare_run(&host.root).unwrap();
    let entry = host.entry(&prep);
    host.conn.execute("INSERT INTO conversation_retention(owner_person,vault_id,store_uuid,choice) VALUES('human:me',?1,?2,'forever')",rusqlite::params![host.scope.vault_id,host.scope.store_uuid]).unwrap();
    let GenerationStart::New(mut ticket) = entry
        .begin_generation_with_archive(&host.scope, KEY, &host.request(), Some(&display_binding()))
        .unwrap()
    else {
        panic!("ticket")
    };
    ticket.bind_session(SESSION, &prep, &host.root).unwrap();
    let invalid = crate::agent::archive_codec::ArchiveTurnV1 {
        version: 2,
        blocks: Vec::new(),
        availability: crate::agent::archive_codec::Availability::Complete,
        references: Vec::new(),
        last_uuid: None,
    };
    assert!(
        ticket
            .finish_with_archive(rows::End::Completed, Some(&invalid))
            .is_err(),
        "archive unavailability must remain visible"
    );
    let state: String = host
        .conn
        .query_row("SELECT state FROM chat_generations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(state, "completed");
    let pending:i64=host.conn.query_row("SELECT count(*) FROM conversation_bindings WHERE display_json IS NOT NULL OR pending_json IS NOT NULL",[],|row|row.get(0)).unwrap();
    assert_eq!(pending, 0);
    let content: String = host
        .conn
        .query_row("SELECT content_json FROM conversation_content", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(content.contains("unavailable"));
    assert!(!content.contains("\"version\":2"));
}
