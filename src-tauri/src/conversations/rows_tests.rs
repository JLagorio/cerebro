use super::*;
use crate::runtime::{chat_generations as generations, conversations as archive};
use rusqlite::{Transaction, TransactionBehavior};
const VAULT: &str = "cccccccccccccccccccccccccccccccc";
fn scope() -> Scope<'static> {
    Scope {
        owner: "human:me",
        vault: VAULT,
        store: "store",
        actor: "claude-code",
        process: "archive-read-process",
    }
}
struct Fixture {
    conn: Connection,
    data: std::path::PathBuf,
    root: std::path::PathBuf,
}
impl Fixture {
    fn new(choice: RetentionChoice) -> Self {
        let data = crate::vault::testutil::temp_vault("archive-read-data");
        let root = crate::vault::testutil::temp_vault("archive-read-vault");
        let conn = crate::runtime::open(&data).unwrap();
        conn.execute("INSERT INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,?2,'2026-10-26T00:00:00Z')",params![VAULT,root.to_str().unwrap()]).unwrap();
        let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
        archive::retention::set_rows(&tx, scope(), choice, 0).unwrap();
        tx.commit().unwrap();
        Self { conn, data, root }
    }
    fn completed(&self, n: u8, thread: &str) {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate).unwrap();
        let generations::Admission::New(receipt) =
            generations::begin_rows(&tx, scope(), &format!("{n:032x}"), &"a".repeat(64)).unwrap()
        else {
            panic!("original admission")
        };
        archive::begin_rows(
            &tx,
            scope(),
            &receipt,
            &archive::AttemptBinding {
                thread_id: thread.into(),
                user_message_id: format!("user-{n}"),
                assistant_message_id: format!("answer-{n}"),
                parent_thread_id: None,
                branch_message_id: None,
                display_message: DisplayMessage {
                    text: format!("Question {n}"),
                    addressed_label: None,
                    attachment_refs: Vec::new(),
                },
            },
            0,
        )
        .unwrap();
        let mut collector = crate::agent::archive_codec::Collector::default();
        collector.observe(&crate::agent::AgentEvent::Text {
            message_id: format!("folded-{n}"),
            text: format!("Answer {n}"),
            parent: None,
            at: None,
        });
        archive::stage_rows(&tx, scope(), &receipt.current_run_id, &collector.finish()).unwrap();
        tx.execute(
            "UPDATE chat_generation_runs SET state='completed' WHERE run_id=?1",
            [&receipt.current_run_id],
        )
        .unwrap();
        tx.execute(
            "UPDATE chat_generations SET state='completed' WHERE generation_id=?1",
            [&receipt.generation_id],
        )
        .unwrap();
        archive::settle_rows(
            &tx,
            scope(),
            &receipt.generation_id,
            &receipt.current_run_id,
            1000,
        )
        .unwrap();
        tx.commit().unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
fn conversation_archive_reads_equal_time_pages_with_scoped_cursors() {
    let fixture = Fixture::new(RetentionChoice::Forever);
    fixture.completed(1, "thread-a");
    fixture.completed(2, "thread-b");
    let first = threads(&fixture.conn, scope(), None, None, 1, 1001).unwrap();
    assert_eq!(first.items[0].id, "thread-b");
    let second = threads(
        &fixture.conn,
        scope(),
        first.next_cursor.as_deref(),
        None,
        1,
        1001,
    )
    .unwrap();
    assert_eq!(second.items[0].id, "thread-a");
    assert!(second.next_cursor.is_none());
    assert!(threads(
        &fixture.conn,
        Scope {
            store: "other",
            ..scope()
        },
        first.next_cursor.as_deref(),
        None,
        1,
        1001
    )
    .is_err());
}
#[test]
fn conversation_archive_reads_expiry_hides_body_title_and_search_without_failed_to_empty() {
    let fixture = Fixture::new(RetentionChoice::Days30);
    fixture.completed(1, "thread");
    assert_eq!(
        threads(
            &fixture.conn,
            scope(),
            None,
            Some("Answer 1"),
            50,
            2_592_000_999
        )
        .unwrap()
        .items
        .len(),
        1
    );
    assert!(threads(
        &fixture.conn,
        scope(),
        None,
        Some("Answer 1"),
        50,
        2_592_001_000
    )
    .unwrap()
    .items
    .is_empty());
    let page = messages(&fixture.conn, scope(), "thread", None, 50, 2_592_001_000).unwrap();
    assert_eq!(page.items[0].content_state, ContentState::Expired);
    assert!(page.items[0].content.is_none());
    assert!(
        threads(&fixture.conn, scope(), None, None, 50, 2_592_001_000)
            .unwrap()
            .items[0]
            .title
            .is_none()
    );
    let missing = Connection::open_in_memory().unwrap();
    assert!(threads(&missing, scope(), None, None, 50, 1001).is_err());
}
#[test]
fn conversation_archive_export_streams_checked_json_and_truthful_markdown() {
    let fixture = Fixture::new(RetentionChoice::Forever);
    fixture.completed(1, "thread");
    let mut output = Vec::new();
    let partial = crate::conversations::export::stream(
        &fixture.conn,
        scope(),
        "thread",
        ExportFormat::Json,
        &mut output,
    )
    .unwrap();
    assert!(!partial);
    let value: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(value["thread"]["id"], "thread");
    assert_eq!(
        value["messages"][0]["content"]["displayMessage"]["text"],
        "Question 1"
    );
    assert_eq!(value["partial"], false);
    assert_eq!(value["context"]["storeUuid"], "store");
    output.clear();
    crate::conversations::export::stream(
        &fixture.conn,
        scope(),
        "thread",
        ExportFormat::Markdown,
        &mut output,
    )
    .unwrap();
    let markdown = String::from_utf8(output).unwrap();
    for label in [
        "Store identity: store",
        "Parent thread: not recorded",
        "Branch message: not recorded",
        "Expires: no expiry recorded",
        "Persistence: Retained",
        "Answer 1",
    ] {
        assert!(markdown.contains(label), "missing {label}");
    }
    assert!(crate::conversations::export::stream(
        &fixture.conn,
        scope(),
        "missing",
        ExportFormat::Json,
        &mut Vec::new()
    )
    .is_err());
}

#[test]
fn conversation_archive_message_pages_bound_aggregate_bytes_without_losing_cursor_rows() {
    let fixture = Fixture::new(RetentionChoice::Forever);
    for n in 1..=4 {
        let tx = Transaction::new_unchecked(&fixture.conn, TransactionBehavior::Immediate).unwrap();
        let generations::Admission::New(receipt) =
            generations::begin_rows(&tx, scope(), &format!("{n:032x}"), &"a".repeat(64)).unwrap()
        else {
            panic!("original")
        };
        archive::begin_rows(
            &tx,
            scope(),
            &receipt,
            &archive::AttemptBinding {
                thread_id: "large-thread".into(),
                user_message_id: format!("u-{n}"),
                assistant_message_id: format!("a-{n}"),
                parent_thread_id: None,
                branch_message_id: None,
                display_message: DisplayMessage {
                    text: "Question".into(),
                    addressed_label: None,
                    attachment_refs: Vec::new(),
                },
            },
            0,
        )
        .unwrap();
        let turn = crate::agent::archive_codec::ArchiveTurnV1 {
            version: 1,
            blocks: vec![crate::agent::archive_codec::Block::Text {
                message_id: "answer".into(),
                text: "x".repeat(crate::agent::journal::RUN_BYTES - 4096),
            }],
            availability: crate::agent::archive_codec::Availability::Complete,
            references: Vec::new(),
            last_uuid: None,
        };
        archive::stage_rows(&tx, scope(), &receipt.current_run_id, &turn).unwrap();
        tx.execute(
            "UPDATE chat_generation_runs SET state='completed' WHERE run_id=?1",
            [&receipt.current_run_id],
        )
        .unwrap();
        tx.execute(
            "UPDATE chat_generations SET state='completed' WHERE generation_id=?1",
            [&receipt.generation_id],
        )
        .unwrap();
        archive::settle_rows(
            &tx,
            scope(),
            &receipt.generation_id,
            &receipt.current_run_id,
            1000,
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let first = messages(&fixture.conn, scope(), "large-thread", None, 50, 1001).unwrap();
    assert_eq!(first.items.len(), 3);
    assert!(serde_json::to_vec(&first).unwrap().len() <= crate::agent::journal::TOTAL_BYTES);
    let last = messages(
        &fixture.conn,
        scope(),
        "large-thread",
        first.next_cursor.as_deref(),
        50,
        1001,
    )
    .unwrap();
    assert_eq!(last.items.len(), 1);
    assert!(last.next_cursor.is_none());
    let ids = first
        .items
        .iter()
        .chain(&last.items)
        .map(|message| message.attempt_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(ids.len(), 4);
}

#[test]
fn conversation_archive_reads_session_from_original_attempt_member() {
    let fixture = Fixture::new(RetentionChoice::Forever);
    fixture.completed(1, "thread");
    fixture.completed(2, "thread");
    let session = "22222222-2222-4222-8222-222222222222";
    fixture.conn.execute("UPDATE chat_generation_runs SET cli_session_id=?1 WHERE run_id=(SELECT g.current_run_id FROM chat_generations g JOIN conversation_bindings b USING(generation_id) WHERE b.assistant_message_id='answer-1')",[session]).unwrap();
    let page = messages(&fixture.conn, scope(), "thread", None, 50, 1001).unwrap();
    let first = page
        .items
        .iter()
        .find(|message| message.assistant_message_id == "answer-1")
        .unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap()["sessionId"],
        session,
        "per-attempt session cannot borrow latest thread session"
    );
    let other = page
        .items
        .iter()
        .find(|message| message.assistant_message_id == "answer-2")
        .unwrap();
    assert!(serde_json::to_value(other).unwrap()["sessionId"].is_null());
}

#[test]
fn conversation_archive_reads_search_wildcards_and_backslashes_as_literal_text() {
    let fixture = Fixture::new(RetentionChoice::Forever);
    fixture.completed(1, "literal");
    fixture.completed(2, "other");
    let generation: String = fixture
        .conn
        .query_row(
            "SELECT generation_id FROM conversation_bindings WHERE thread_id='literal'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    fixture
        .conn
        .execute(
            "UPDATE conversation_search SET search_text=?2 WHERE generation_id=?1",
            params![generation, r"Question: 100% a_b C:\notes !quote' answer"],
        )
        .unwrap();
    for needle in ["100%", "a_b", r"C:\notes", "!quote'", "answer"] {
        let page = threads(&fixture.conn, scope(), None, Some(needle), 50, 1001).unwrap();
        assert!(
            page.items.iter().any(|thread| thread.id == "literal"),
            "literal query {needle}"
        );
        if needle != "answer" {
            assert!(
                !page.items.iter().any(|thread| thread.id == "other"),
                "wildcards must not match unrelated text"
            );
        }
    }
    assert!(threads(&fixture.conn, scope(), None, Some("a%b"), 50, 1001)
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn conversation_archive_reads_carries_source_title_expiry_for_inflight_boundary() {
    let fixture = Fixture::new(RetentionChoice::Days30);
    fixture.completed(1, "title-thread");
    let page = threads(&fixture.conn, scope(), None, None, 50, 1001).unwrap();
    let wire = serde_json::to_value(&page.items[0]).unwrap();
    assert_eq!(
        wire["titleExpiresAt"], "1970-01-31T00:00:01.000Z",
        "a source title read before expiry can arrive after it; renderer needs the original expiry"
    );
    assert!(
        threads(&fixture.conn, scope(), None, None, 50, 2_592_001_000)
            .unwrap()
            .items[0]
            .title
            .is_none()
    );
}

#[test]
fn conversation_archive_export_legacy_unknown_completion_keeps_truthful_provenance() {
    let fixture = Fixture::new(RetentionChoice::Forever);
    let batch = archive::legacy::ImportBatch {
        source_vault_path: fixture.root.to_string_lossy().into_owned(),
        thread_id: "old-thread".into(),
        attempts: vec![archive::legacy::LegacyAttempt {
            user_message_id: "old-question".into(),
            assistant_message_id: "old-answer".into(),
            display_message: DisplayMessage {
                text: "Cached question".into(),
                addressed_label: None,
                attachment_refs: Vec::new(),
            },
            answer: crate::agent::archive_codec::ArchiveTurnV1 {
                version: 1,
                blocks: vec![crate::agent::archive_codec::Block::Text {
                    message_id: "cached".into(),
                    text: "Cached answer".into(),
                }],
                availability: crate::agent::archive_codec::Availability::Partial,
                references: Vec::new(),
                last_uuid: None,
            },
            completed_at: None,
            session_id: None,
        }],
    };
    let tx = Transaction::new_unchecked(&fixture.conn, TransactionBehavior::Immediate).unwrap();
    archive::legacy::import_rows(&tx, scope(), &batch, 1000).unwrap();
    tx.commit().unwrap();
    let mut bytes = Vec::new();
    let partial = crate::conversations::export::stream(
        &fixture.conn,
        scope(),
        "old-thread",
        ExportFormat::Markdown,
        &mut bytes,
    )
    .unwrap();
    assert!(partial);
    let markdown = String::from_utf8(bytes).unwrap();
    assert!(markdown.contains("Original completion: not recorded"));
    assert!(markdown.contains("Origin: BrowserCache"));
    assert!(markdown.contains("Imported: 1970-01-01T00:00:01.000Z"));
}
