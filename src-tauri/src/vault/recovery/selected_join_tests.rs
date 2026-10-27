#![cfg(test)]
//! Private recovery schema migration through the actual Journal opener.
use super::*;

fn rows(conn: &Connection, sql: &str) -> Vec<Vec<rusqlite::types::Value>> {
    let mut statement = conn.prepare(sql).unwrap();
    let columns = statement.column_count();
    statement
        .query_map([], |row| {
            (0..columns).map(|column| row.get(column)).collect()
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn protected_retention_schema1_open_preserves_real_legacy_copies_and_settings() {
    let (vault, root, journal) = fixture();
    journal.set_enabled(&vault, true).unwrap();
    testutil::write(&vault, "page.md", "original legacy bytes\r\n");
    save(&journal, &vault, "first save\n").unwrap();
    {
        let lock = write::lock_paths(&vault, &["page.md"]).unwrap();
        journal
            .prepare(
                &lock,
                &vault,
                "page.md",
                "first save\n",
                "second save\n",
                None,
            )
            .unwrap();
    }
    let conn = journal.connect().unwrap();
    let before_copies = rows(&conn, "SELECT id,vault,path,lock_key,before_hash,after_hash,captured_at,state,bytes FROM copies ORDER BY id");
    let before_settings = rows(
        &conn,
        "SELECT vault,enabled,vault_path FROM settings ORDER BY vault",
    );
    assert_eq!(before_copies.len(), 2);
    // Preserve real service-produced rows while making the exact previous
    // private schema shape. This never manufactures a selected operation join.
    let has_join: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('copies') WHERE name='selected_join')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    if has_join {
        conn.execute_batch("ALTER TABLE copies DROP COLUMN selected_join")
            .unwrap();
    }
    conn.execute_batch("PRAGMA user_version=1; COMMIT").unwrap();
    drop(conn);
    drop(journal);
    // Unknown/missing authority must retain the real pending v1 copy on open.
    let parked = vault.with_extension("parked");
    fs::rename(&vault, &parked).unwrap();
    let reopened = Journal::open(&root).unwrap();
    let conn = reopened.connect().unwrap();
    assert_eq!(rows(&conn, "SELECT id,vault,path,lock_key,before_hash,after_hash,captured_at,state,bytes FROM copies ORDER BY id"), before_copies);
    assert_eq!(
        rows(
            &conn,
            "SELECT vault,enabled,vault_path FROM settings ORDER BY vault"
        ),
        before_settings
    );
    let supports_join: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('copies') WHERE name='selected_join')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        supports_join,
        "the actual opener must migrate v1 before accepting selected captures"
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM copies WHERE selected_join IS NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    drop(conn);
    fs::rename(&parked, &vault).unwrap();
    assert!(reopened.enabled(&vault).unwrap());
    let next = save(&reopened, &vault, "legacy editor still wins\n").unwrap();
    assert!(matches!(next.recovery, Outcome::Retained { .. }));
    assert_eq!(
        fs::read(vault.join("page.md")).unwrap(),
        b"legacy editor still wins\n"
    );
}

#[test]
fn protected_retention_unknown_schema_open_refuses_without_reset_or_off() {
    let (_vault, root, journal) = fixture();
    journal
        .connect()
        .unwrap()
        .pragma_update(None, "user_version", 99)
        .unwrap();
    drop(journal);
    let before = fs::read(root.join(DATABASE)).unwrap();
    assert!(Journal::open(&root).is_err());
    assert_eq!(fs::read(root.join(DATABASE)).unwrap(), before);
    assert!(root.join(MARKER).is_file());
}

fn stopped_migration(root: &Path, point: &str) {
    use std::{
        io::Read,
        process::Stdio,
        time::{Duration, Instant},
    };
    let output = root.join("migration-child-output.txt");
    let file = fs::File::create(&output).unwrap();
    let mut child = crate::spawn::command(std::env::current_exe().unwrap())
        .args([
            "vault::recovery::tests::selected_join::protected_retention_migration_stop_child",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_remove("CEREBRO_CRASH_POINT")
        .env("CEREBRO_STOP_POINT", point)
        .env("CEREBRO_SELECTED_MIGRATION_ROOT", root)
        .stdout(Stdio::from(file.try_clone().unwrap()))
        .stderr(Stdio::from(file))
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("owned migration child exceeded deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut text = String::new();
    fs::File::open(output)
        .unwrap()
        .take(65536)
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(
        status.code(),
        Some(86),
        "migration did not stop at {point}: {text}"
    );
}

#[test]
fn protected_retention_migration_stop_child() {
    let Ok(root) = std::env::var("CEREBRO_SELECTED_MIGRATION_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(std::env::temp_dir().canonicalize().unwrap()));
    Journal::open(&root).unwrap();
}

#[test]
fn protected_retention_schema_migration_stop_rolls_back_or_commits_without_losing_bytes() {
    for committed in [false, true] {
        let (vault, root, journal) = fixture();
        journal.set_enabled(&vault, true).unwrap();
        testutil::write(&vault, "page.md", "original retained legacy bytes\r\n");
        save(&journal, &vault, "replacement\n").unwrap();
        let conn = journal.connect().unwrap();
        let before = rows(&conn,"SELECT id,vault,path,lock_key,before_hash,after_hash,captured_at,state,bytes FROM copies ORDER BY id");
        let settings = rows(
            &conn,
            "SELECT vault,enabled,vault_path FROM settings ORDER BY vault",
        );
        let has_join: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('copies') WHERE name='selected_join')",[],|r|r.get(0)).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        if has_join {
            conn.execute_batch("ALTER TABLE copies DROP COLUMN selected_join")
                .unwrap();
        }
        conn.execute_batch("PRAGMA user_version=1; COMMIT").unwrap();
        drop(conn);
        drop(journal);
        stopped_migration(
            &root,
            if committed {
                "recovery-selected-schema-committed"
            } else {
                "recovery-selected-schema-staged"
            },
        );
        // Let SQLite perform its own real hot-journal rollback if needed.
        let conn =
            Connection::open_with_flags(root.join(DATABASE), OpenFlags::SQLITE_OPEN_READ_WRITE)
                .unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            if committed { 2 } else { 1 }
        );
        assert_eq!(rows(&conn,"SELECT id,vault,path,lock_key,before_hash,after_hash,captured_at,state,bytes FROM copies ORDER BY id"),before);
        assert_eq!(
            rows(
                &conn,
                "SELECT vault,enabled,vault_path FROM settings ORDER BY vault"
            ),
            settings
        );
        drop(conn);
        let reopened = Journal::open(&root).unwrap();
        assert!(reopened.enabled(&vault).unwrap());
        assert_eq!(rows(&reopened.connect().unwrap(),"SELECT id,vault,path,lock_key,before_hash,after_hash,captured_at,state,bytes FROM copies ORDER BY id"),before);
    }
}
