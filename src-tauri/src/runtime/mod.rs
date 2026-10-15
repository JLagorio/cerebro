//! The runtime DB (M24.2, grown by M25.1) — `runtime.db` in the app's own
//! config directory, where operational noise lives so the epistemic ledger
//! does not have to.
//!
//! **Two records, two destinies (D5).** The append-only ledger receives
//! valid proposals, applied mutations, *meaningful* policy rejections, and
//! human decisions. This database receives the rest: schema mistakes,
//! malformed tool arguments, CAS races during internal retries, timeouts,
//! quota failures — and, from M25, scheduler queues, leases, token
//! accounting, budgets, retries, and transient connector health. An
//! operational fact is reflected INTO the ledger only when it materially
//! affects knowledge coverage: "connector unavailable for three days" is a
//! coverage event, "retry scheduled in 37 seconds" is never one.
//!
//! **App-global storage, never cross-vault identity.** One file serves every
//! vault the app opens, so scheduler, run, source, coverage-cache, session,
//! and failure rows carry `vault_id` and `store_uuid` (see [`scope`]).
//! Subscription spend is the deliberate exception: one CLI account means one
//! global daily ambient budget summed across vaults.
//!
//! Like the ledger index, it lives in the app's own config directory
//! (`config_dir()` in `lib.rs`) and never inside the vault: SQLite WAL plus a
//! cloud-sync daemon is how databases get corrupted (D2).
//! Unlike the ledger index it is NOT rebuildable from segments, so it is not
//! deleted on damage — a corrupt file is QUARANTINED beside a fresh one, and
//! the app enters the conservative recovery mode in [`recovery`] rather than
//! pretending the missing history was empty.
//!
//! ## Migrations
//!
//! Every schema change is a numbered `PRAGMA user_version` step run inside
//! one `BEGIN IMMEDIATE` transaction: DDL, then data copy, then VALIDATION,
//! then the version stamp, then commit. A failure rolls back to the prior
//! readable schema, pauses ambient work with the failing version named
//! ([`status`]), and never half-creates tables. A process killed mid-step
//! leaves the previous complete version, which the next open finishes.

pub mod activity;
pub mod activity_tool;
pub mod batch_journal;
pub mod budget;
pub mod catchup;
pub mod cause;
pub mod client_tokens;
pub mod connector_status;
pub mod dispatch;
pub mod done_marks;
pub mod fleet;
pub mod followups;
pub mod governance;
pub mod health;
pub mod import;
pub mod job_ledger;
pub mod normalize;
pub mod operational;
pub mod parked;
pub mod pending_writes;
pub mod projection;
pub mod read_only;
pub mod recovery;
pub mod reminders;
pub mod scheduler;
pub mod schema;
pub mod scope;
pub mod sessions;
pub mod settings;
pub mod sink;
#[cfg(test)]
mod soak;
pub mod status;
pub mod surface;
pub mod taint;
pub mod triggers;
pub mod vault_writes;
pub mod wakes;
pub mod write_log;

pub use read_only::ReadOnly;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use status::{RecoveryReason, RuntimeStatus};

/// The one runtime database, beside the ledger index in the app's config
/// directory.
pub const RUNTIME_DB: &str = "runtime.db";

/// A file that exists exactly while a process holds the database open.
///
/// SQLite cannot tell us on open whether the last process exited cleanly, and
/// the answer decides how hard we check the file: `quick_check` for an
/// ordinary open, the full `integrity_check` after a crash. A marker file is
/// the cheapest honest signal — it is created after the integrity gate and
/// removed by [`sink::disarm`], so a `kill -9` leaves it behind exactly as it
/// should.
pub const OPEN_MARKER: &str = "runtime.db.open";

/// The schema version this build speaks. M24 established 2 (`operational_log`
/// at M24.2, `parked_promotions` at M24.6); M25.1 adds the scoped scheduler,
/// meter, budget, coverage cache, and settings at 3. M28.0 adds the two
/// trigger-governance tables at 11. M31.5 adds the run-fact columns — plus
/// the two M31.6 will write, whole per D5 — at 12. M33.1 adds `runs.actor`,
/// nullable and never backfilled, at 13. M33b.1 rebuilds `ambient_dispatch`
/// keyed by `run_id` at 14, retiring the singleton column. M34.3 adds
/// `runs.parent_run_id`, nullable — NULL is a root, and every run before
/// this was one — at 15. M34.2 adds `job_ledger` — the renderer's three
/// scheduling ledgers, durably — at 16. M49.10 adds `vault_writes` — where
/// the `vault.*` write hashes moved out of the epistemic ledger — at 17.
/// M49.9 adds `runs.counters_booked` — 0 on every row that predates
/// booking, so its zeros read as not recorded — at 18. M54.11 adds
/// `connector_status` — the last status each connector was seen in, per
/// vault — at 19. M56.7 adds `runs.cause` and `runs.cli_session_id`, both
/// nullable and never backfilled, each under a CHECK, at 20. M56.9 adds the
/// two indexes a run's detail reads by — `operational_log` by run, and `runs`
/// by Claude Code session — at 21. M57.4c adds `pending_writes` — the page
/// writes an ask-first agent queued for Review, one open row per write by
/// constraint — at 22. M58.1 rebuilds `vault_writes` with each write's run,
/// approver and burst start, the `vault.create` and `vault.comment` kinds and
/// the by-time and by-run indexes, and adds `runs.writes_booked` — 0 on every
/// run before it, whose writes read as not recorded — at 23. M58.4 adds
/// `run_commits` — which run made which commit, the one record History names
/// an agent from — at 24. M63.1 adds `agent_wakes` — each trigger match an
/// agent must answer, admitted once and claimed with its run's lease — at 25.
/// M60.6 adds `batch_journal` — each database-wide change in flight, with
/// the pre-images that put its pages back if it stopped partway — at 26.
/// M64.3 adds durable reminder fires and Done marks at 27.
/// M62.5 adds personal token fingerprints and the client cause at 28.
/// M63.2 records wake authors and run ancestry at 29.
/// M63.8 adds an agent's durable self-followups at 30.
pub const USER_VERSION: i64 = 30;

pub fn runtime_db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RUNTIME_DB)
}

fn open_marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join(OPEN_MARKER)
}

/// RFC3339 UTC with milliseconds and a `Z` — the one spelling every stored
/// time in this database uses, and the shape its `CHECK` constraints expect.
pub fn now_utc() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// One numbered step. `validate` runs INSIDE the step's transaction, after
/// its DDL and before its version stamp, so a schema that built but does not
/// hold rolls back with everything else.
struct Migration {
    to: i64,
    sql: &'static str,
    validate: fn(&Connection) -> Result<(), String>,
}

fn validate_nothing(_: &Connection) -> Result<(), String> {
    Ok(())
}

/// M25's step has to seed the lane registry, and a lane vocabulary that
/// silently failed to seed would let the first dispatcher name a lane that
/// does not exist. Seeding IS the validation.
fn seed_and_validate_v3(conn: &Connection) -> Result<(), String> {
    for (lane, priority, enabled) in schema::LANES {
        conn.execute(
            "INSERT INTO lane_registry (lane, priority, enabled_by_default, introduced_version) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![lane, priority, i64::from(enabled), schema::LANE_INTRODUCED],
        )
        .map_err(|e| format!("seeding lane {lane}: {e}"))?;
    }
    let seeded: i64 = conn
        .query_row("SELECT count(*) FROM lane_registry", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if seeded != schema::LANES.len() as i64 {
        return Err(format!(
            "lane registry seeded {seeded} of {} lanes",
            schema::LANES.len()
        ));
    }
    // Every table the step promised, present and queryable. A `CREATE TABLE`
    // that parsed is not the same claim as a table the app can read.
    for table in EXPECTED_V3_TABLES {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| format!("validating {table}: {e}"))?;
    }
    Ok(())
}

/// The tables `user_version = 3` promises. Named rather than inferred: a
/// migration that quietly created six of seven tables is exactly the failure
/// this list turns into a rollback.
const EXPECTED_V3_TABLES: [&str; 20] = [
    "vault_registry",
    "lane_registry",
    "budget_settings_versions",
    "budget_days",
    "ambient_gate_decisions",
    "runs",
    "ambient_dispatch",
    "ambient_gate_state",
    "app_sessions",
    "scheduler",
    "backoff",
    "source_registration",
    "source_connection",
    "source_health",
    "runtime_health",
    "coverage_cache",
    "coverage_dimension_cache",
    "ingestion_failures",
    "responsibility_contracts",
    "catchup_outcomes",
];

const MIGRATIONS: &[Migration] = &[
    Migration {
        to: 1,
        sql: schema::SCHEMA_V1,
        validate: validate_nothing,
    },
    Migration {
        to: 2,
        sql: schema::SCHEMA_V2,
        validate: validate_nothing,
    },
    Migration {
        to: 3,
        sql: schema::SCHEMA_V3,
        validate: seed_and_validate_v3,
    },
    Migration {
        to: 4,
        sql: schema::SCHEMA_V4,
        validate: validate_v4,
    },
    Migration {
        to: 5,
        sql: schema::SCHEMA_V5,
        validate: validate_v5,
    },
    Migration {
        to: 6,
        sql: schema::SCHEMA_V6,
        validate: validate_v6,
    },
    Migration {
        to: 7,
        sql: schema::SCHEMA_V7,
        validate: validate_v7,
    },
    Migration {
        to: 8,
        sql: schema::SCHEMA_V8,
        validate: validate_v8,
    },
    Migration {
        to: 9,
        sql: schema::SCHEMA_V9,
        validate: validate_v9,
    },
    Migration {
        to: 10,
        sql: schema::SCHEMA_V10,
        validate: validate_v10,
    },
    Migration {
        to: 11,
        sql: schema::SCHEMA_V11,
        validate: validate_v11,
    },
    Migration {
        to: 12,
        sql: schema::SCHEMA_V12,
        validate: validate_v12,
    },
    Migration {
        to: 13,
        sql: schema::SCHEMA_V13,
        validate: validate_v13,
    },
    Migration {
        to: 14,
        sql: schema::SCHEMA_V14,
        validate: validate_v14,
    },
    Migration {
        to: 15,
        sql: schema::SCHEMA_V15,
        validate: validate_v15,
    },
    Migration {
        to: 16,
        sql: schema::SCHEMA_V16,
        validate: validate_v16,
    },
    Migration {
        to: 17,
        sql: schema::SCHEMA_V17,
        validate: validate_v17,
    },
    Migration {
        to: 18,
        sql: schema::SCHEMA_V18,
        validate: validate_v18,
    },
    Migration {
        to: 19,
        sql: schema::SCHEMA_V19,
        validate: validate_v19,
    },
    Migration {
        to: 20,
        sql: schema::SCHEMA_V20,
        validate: validate_v20,
    },
    Migration {
        to: 21,
        sql: schema::SCHEMA_V21,
        validate: validate_v21,
    },
    Migration {
        to: 22,
        sql: schema::SCHEMA_V22,
        validate: validate_v22,
    },
    Migration {
        to: 23,
        sql: schema::SCHEMA_V23,
        validate: validate_v23,
    },
    Migration {
        to: 24,
        sql: schema::SCHEMA_V24,
        validate: validate_v24,
    },
    Migration {
        to: 25,
        sql: schema::SCHEMA_V25,
        validate: validate_v25,
    },
    Migration {
        to: 26,
        sql: schema::SCHEMA_V26,
        validate: validate_v26,
    },
    Migration {
        to: 27,
        sql: schema::SCHEMA_V27,
        validate: validate_v27,
    },
    Migration {
        to: 28,
        sql: schema::SCHEMA_V28,
        validate: validate_v28,
    },
    Migration {
        to: 29,
        sql: schema::SCHEMA_V29,
        validate: validate_v29,
    },
    Migration {
        to: 30,
        sql: schema::SCHEMA_V30,
        validate: validate_v30,
    },
];

fn validate_v30(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT followup_id,vault_id,actor,note,due_at,requested_at,requested_by_run,state,claimed_at,run_id,ended_at,cancel_reason FROM agent_followups")
        .map_err(|e| format!("validating agent_followups: {e}"))?;
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_followups'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("validating agent_followups: {e}"))?;
    for clause in [
        "length(followup_id) = 32",
        "NOT followup_id GLOB '*[^0-9a-f]*'",
        "REFERENCES vault_registry (vault_id)",
        "actor LIKE 'process:_%'",
        "length(actor) <= 128",
        "length(note) BETWEEN 1 AND 500",
        "due_at LIKE '____-__-__T%Z'",
        "requested_at LIKE '____-__-__T%Z'",
        "length(requested_by_run) > 0",
        "state IN ('pending', 'claimed', 'fired', 'cancelled')",
        "claimed_at LIKE '____-__-__T%Z'",
        "ended_at LIKE '____-__-__T%Z'",
        "cancel_reason IN ('person', 'agent_gone', 'paused')",
        "state != 'claimed' OR claimed_at IS NOT NULL",
        "state != 'pending' OR claimed_at IS NULL",
        "(state = 'fired') = (run_id IS NOT NULL)",
        "(state = 'cancelled') = (cancel_reason IS NOT NULL)",
        "(state IN ('fired', 'cancelled')) = (ended_at IS NOT NULL)",
    ] {
        if !sql.contains(clause) {
            return Err(format!("agent_followups was created without {clause}"));
        }
    }
    let index: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='agent_followups_by_due'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("validating agent_followups index: {e}"))?;
    if !index.contains("(vault_id, state, due_at)") {
        return Err("agent_followups_by_due has the wrong columns".into());
    }
    Ok(())
}

/// Wake attribution remains optional for older rows, with bounded closed
/// author kinds and a real run foreign key for every recorded parent.
fn validate_v29(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT author, author_actor, parent_run_id FROM agent_wakes")
        .map_err(|e| format!("validating wake attribution: {e}"))?;
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_wakes'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("validating wake attribution: {e}"))?;
    for clause in [
        "author IN ('person', 'run', 'not_recorded')",
        "length(author_actor) BETWEEN 1 AND 128",
        "author IS NOT NULL",
        "parent_run_id TEXT REFERENCES runs (run_id)",
        "parent_run_id IS NULL OR author IS 'run'",
    ] {
        if !sql.contains(clause) {
            return Err(format!("wake attribution was created without {clause}"));
        }
    }
    Ok(())
}

/// Token fingerprints and the widened cause CHECK arrive together. SQLite
/// quotes a renamed column; compare its normalized stored SQL, not the DDL
/// string we intended to run.
fn validate_v28(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT token_id, vault_id, name, slug, secret_sha256, toolsets, write_scope, read_scope, created_at, last_used_at FROM client_tokens")
        .map_err(|e| format!("validating client_tokens: {e}"))?;
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'client_tokens'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("validating client_tokens: {e}"))?;
    for clause in [
        "length(token_id) = 32",
        "NOT token_id GLOB '*[^0-9a-f]*'",
        "REFERENCES vault_registry (vault_id)",
        "length(name) BETWEEN 1 AND 100",
        "length(slug) BETWEEN 1 AND 32",
        "NOT slug GLOB '*[^a-z0-9-]*'",
        "secret_sha256 TEXT NOT NULL UNIQUE",
        "length(secret_sha256) = 64",
        "NOT secret_sha256 GLOB '*[^0-9a-f]*'",
        "json_type(toolsets) = 'array'",
        "json_type(write_scope) = 'array'",
        "json_type(read_scope) = 'array'",
        "UNIQUE (vault_id, slug)",
    ] {
        if !sql.contains(clause) {
            return Err(format!("client_tokens was created without {clause}"));
        }
    }
    let index: Option<String> = conn.query_row("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'client_tokens_by_vault'", [], |r| r.get(0))
        .map_err(|e| format!("validating client_tokens_by_vault: {e}"))?;
    if !index.is_some_and(|sql| sql.contains("(vault_id, created_at)")) {
        return Err("client_tokens_by_vault has the wrong columns".into());
    }
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("validating runs.cause: {e}"))?;
    let sql = sql.replace('"', "");
    let kinds = cause::CauseKind::ALL
        .iter()
        .map(|kind| format!("'{}'", kind.as_str()))
        .collect::<Vec<_>>()
        .join(", ");
    if !sql.contains(&format!("json_extract(cause, '$.kind') IN ({kinds})"))
        || !sql.contains("length(cause) <= 2048")
    {
        return Err(
            "runs.cause was created without the complete kind CHECK, client included".into(),
        );
    }
    Ok(())
}

/// The readers' columns and the closed vocabularies must arrive together.
fn validate_v27(conn: &Connection) -> Result<(), String> {
    for (table, columns, clauses) in [
        (
            "reminder_fires",
            "vault_id, path, chip, ordinal, fire_at, outcome, claimed_at",
            &[
                "outcome IN ('fired', 'missed', 'moved', 'imported')",
                "PRIMARY KEY (vault_id, path, chip, ordinal, fire_at)",
                "length(chip) = 16",
                "ordinal >= 0",
                "length(path) BETWEEN 1 AND 1024",
                "length(fire_at) = 16",
                "claimed_at LIKE '____-__-__T%Z'",
            ][..],
        ),
        (
            "done_marks",
            "vault_id, lane, subject, until, revision, marked_at",
            &[
                "lane IN ('insight', 'run', 'reminder', 'change')",
                "until IN ('revision', 'forever')",
                "(until = 'revision') = (revision IS NOT NULL)",
                "PRIMARY KEY (vault_id, lane, subject)",
                "length(subject) BETWEEN 1 AND 1024",
                "length(revision) BETWEEN 1 AND 256",
                "marked_at LIKE '____-__-__T%Z'",
            ][..],
        ),
    ] {
        conn.prepare(&format!("SELECT {columns} FROM {table}"))
            .map_err(|e| format!("validating {table}: {e}"))?;
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| format!("validating {table}: {e}"))?;
        for clause in clauses {
            if !sql.contains(clause) {
                return Err(format!("{table} was created without {clause}"));
            }
        }
    }
    Ok(())
}

/// v26's promise (M60.6): every column of `batch_journal` reads, and the
/// by-vault index recovery reads it through exists. A step without the index
/// would still work, and quietly scan the table at every open.
fn validate_v26(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT batch_id, vault_id, state, files, actor, started_at FROM batch_journal")
        .map_err(|e| format!("validating batch_journal: {e}"))?;
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'index' \
             AND name = 'batch_journal_by_vault' AND tbl_name = 'batch_journal'",
            [],
            |row| row.get(0),
        )
        .ok();
    match sql {
        Some(sql) if sql.contains("vault_id, started_at") => Ok(()),
        Some(_) => Err("index batch_journal_by_vault has the wrong shape".to_string()),
        None => Err("index batch_journal_by_vault on batch_journal is missing".to_string()),
    }
}

/// v25's promise (M63.1): every column of `agent_wakes` reads, and its four
/// indexes exist in their shape: the live-key UNIQUE that makes admission an
/// INSERT OR IGNORE, the single-flight UNIQUE, the pending lookup and the
/// by-run lookup. A step without the first would admit one change twice.
fn validate_v25(conn: &Connection) -> Result<(), String> {
    conn.prepare(
        "SELECT wake_id, vault_id, agent, wake_key, trigger_digest, cause, admitted_at, \
         not_before, deferred, state, run_id, started_at, finished_at, outcome, reason, \
         detail, note FROM agent_wakes",
    )
    .map_err(|e| format!("validating agent_wakes: {e}"))?;
    for (index, unique) in [
        ("agent_wakes_live_key", true),
        ("agent_wakes_single_flight", true),
        ("agent_wakes_pending", false),
        ("agent_wakes_by_run", false),
    ] {
        let sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1 \
                 AND tbl_name = 'agent_wakes'",
                [index],
                |row| row.get(0),
            )
            .ok();
        let Some(sql) = sql else {
            return Err(format!("index {index} on agent_wakes is missing"));
        };
        if unique != sql.contains("UNIQUE") || !sql.contains("WHERE") {
            return Err(format!("index {index} on agent_wakes has the wrong shape"));
        }
    }
    Ok(())
}

/// v24's promise (M58.4): every column of `run_commits` reads, and its CHECK
/// holds a commit to a full lowercase hash, so a short or upper-case spelling
/// can never be recorded or matched.
fn validate_v24(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT vault_id, commit_sha, run_id, committed_at FROM run_commits")
        .map_err(|e| format!("validating run_commits: {e}"))?;
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_commits'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("validating run_commits: {e}"))?;
    for clause in [
        "length(commit_sha) IN (40, 64)",
        "'*[^0-9a-f]*'",
        "PRIMARY KEY (vault_id, commit_sha)",
    ] {
        if !sql.contains(clause) {
            return Err(format!("run_commits was created without {clause}"));
        }
    }
    Ok(())
}

/// v23's promise (M58.1): every column of the rebuilt `vault_writes` reads,
/// its CHECK names the five kinds and the approver's rule, its three indexes
/// exist, the v17 table is gone, and `runs.writes_booked` reads with its
/// default of 1, so a new run books its writes with no INSERT changing.
fn validate_v23(conn: &Connection) -> Result<(), String> {
    conn.prepare(
        "SELECT vault_id, kind, path, to_path, content_hash, actor, run_id, approved_by, \
         first_at, recorded_at FROM vault_writes",
    )
    .map_err(|e| format!("validating vault_writes: {e}"))?;
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_writes'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("validating vault_writes: {e}"))?;
    for clause in [
        "'vault.create'",
        "'vault.comment'",
        "approved_by LIKE 'human:_%'",
    ] {
        if !sql.contains(clause) {
            return Err(format!("vault_writes was rebuilt without {clause}"));
        }
    }
    for index in [
        "vault_writes_by_path",
        "vault_writes_by_time",
        "vault_writes_by_run",
    ] {
        let found: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = ?1 \
                 AND tbl_name = 'vault_writes'",
                [index],
                |row| row.get(0),
            )
            .map_err(|e| format!("validating {index}: {e}"))?;
        if found != 1 {
            return Err(format!("index {index} on vault_writes is missing"));
        }
    }
    let left: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'vault_writes_v17'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("checking for the old vault_writes: {e}"))?;
    if left != 0 {
        return Err("the v17 vault_writes survived its own migration".into());
    }
    let default: Option<String> = conn
        .query_row(
            "SELECT dflt_value FROM pragma_table_info('runs') WHERE name = 'writes_booked'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("validating runs.writes_booked: {e}"))?;
    if default.as_deref() != Some("1") {
        return Err(format!("runs.writes_booked defaults to {default:?}, not 1"));
    }
    Ok(())
}

/// v22's promise (M57.4c): every column of `pending_writes` reads, and its
/// three indexes exist, the partial UNIQUE that makes the dedupe a
/// constraint among them. A step without that index would queue one write
/// twice.
fn validate_v22(conn: &Connection) -> Result<(), String> {
    conn.prepare(
        "SELECT pending_id, vault_id, run_id, actor, tool, target, target_hash, input, \
         input_hash, grant_json, queued_at, state, decided_at, decided_by, reason, \
         applied_input, result, reported_run_id FROM pending_writes",
    )
    .map_err(|e| format!("validating pending_writes: {e}"))?;
    for (index, unique) in [
        ("pending_writes_open_once", true),
        ("pending_writes_open", false),
        ("pending_writes_unreported", false),
    ] {
        let sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1 \
                 AND tbl_name = 'pending_writes'",
                [index],
                |row| row.get(0),
            )
            .ok();
        let Some(sql) = sql else {
            return Err(format!("index {index} on pending_writes is missing"));
        };
        if unique != sql.contains("UNIQUE") || !sql.contains("WHERE") {
            return Err(format!(
                "index {index} on pending_writes has the wrong shape"
            ));
        }
    }
    Ok(())
}

/// v21's promise: both indexes a run's detail reads by exist (M56.9). A step
/// that built one of the two would leave the refusals read scanning the log.
fn validate_v21(conn: &Connection) -> Result<(), String> {
    for (index, table) in [
        ("operational_log_by_run", "operational_log"),
        ("runs_by_cli_session", "runs"),
    ] {
        let found: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = ?1 \
                 AND tbl_name = ?2",
                [index, table],
                |row| row.get(0),
            )
            .map_err(|e| format!("validating {index}: {e}"))?;
        if found != 1 {
            return Err(format!("index {index} on {table} is missing"));
        }
    }
    Ok(())
}

/// v20's promise: both run columns read, and the cause column carries its
/// CHECK. A column added without it would take any text, so the runs table's
/// own SQL must name the kind check, or the step rolls back (M56.7).
fn validate_v20(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT cause, cli_session_id FROM runs")
        .map_err(|e| format!("validating runs.cause and runs.cli_session_id: {e}"))?;
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("validating runs: {e}"))?;
    if !sql
        .replace('"', "")
        .contains("json_extract(cause, '$.kind')")
    {
        return Err("runs.cause was added without its kind CHECK".into());
    }
    Ok(())
}

/// v19's promise: the connector status table exists, keyed by vault and
/// connector (M54.11).
fn validate_v19(conn: &Connection) -> Result<(), String> {
    conn.prepare(
        "SELECT vault_id, connector, state, signal, seen_at, run_id FROM connector_status",
    )
    .map_err(|e| format!("validating connector_status: {e}"))?;
    Ok(())
}

/// v18's promise: a run row says whether its proposal counters were ever
/// booked (M49.9).
fn validate_v18(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT counters_booked FROM runs")
        .map_err(|e| format!("validating runs.counters_booked: {e}"))?;
    Ok(())
}

/// v17's promise: the operational vault-write log exists (M49.10).
fn validate_v17(conn: &Connection) -> Result<(), String> {
    conn.prepare(
        "SELECT vault_id, kind, path, to_path, content_hash, actor, recorded_at FROM vault_writes",
    )
    .map_err(|e| format!("validating vault_writes: {e}"))?;
    Ok(())
}

/// v16's promise is one table with its claim-bearing primary key. The CHECK
/// vocabulary is asserted by job_ledger's own tests; here it is enough that
/// the table prepares and the PK arbitrates (an INSERT OR IGNORE of a
/// duplicate key changing nothing).
fn validate_v16(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT vault_id, ledger, key, run_key, recorded_at FROM job_ledger")
        .map_err(|e| format!("validating job_ledger: {e}"))?;
    Ok(())
}

/// What `user_version = 14` promises (M33b.1) — and, unusually, one thing it
/// promises is ABSENT.
///
/// A rebuild that created the new table and never dropped the old one would
/// leave two tables with the same rows and no error, so the check names the
/// column that had to disappear: a `SELECT singleton_key` that still PREPARES
/// means the rename/copy/drop dance stopped halfway and every claim after it
/// would be gated against a table nothing writes. The old table's absence is
/// asserted the same way v9 asserts its predecessor's.
fn validate_v15(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT parent_run_id FROM runs")
        .map_err(|e| format!("validating runs.parent_run_id: {e}"))?;
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'runs_by_parent'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| format!("validating runs_by_parent: {e}"))
    .and_then(|found| {
        if found == 1 {
            Ok(())
        } else {
            Err("runs_by_parent index missing after v15".to_string())
        }
    })
}

fn validate_v14(conn: &Connection) -> Result<(), String> {
    conn.query_row("SELECT count(*) FROM ambient_dispatch", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|e| format!("validating ambient_dispatch: {e}"))?;
    if conn
        .prepare("SELECT singleton_key FROM ambient_dispatch")
        .is_ok()
    {
        return Err("the singleton column survived its own migration".to_string());
    }
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE name = 'ambient_dispatch_v13'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| format!("checking for the old lease table: {e}"))
    .and_then(|left| {
        if left == 0 {
            Ok(())
        } else {
            Err("the v13 lease table survived its own migration".to_string())
        }
    })?;
    conn.query_row(
        "SELECT count(*) FROM sqlite_master \
         WHERE type = 'index' AND name = 'ambient_dispatch_live'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| format!("validating ambient_dispatch_live: {e}"))
    .and_then(|found| {
        if found == 1 {
            Ok(())
        } else {
            Err("validating ambient_dispatch_live: index missing".to_string())
        }
    })
}

/// The one column `user_version = 13` promises (M33.1), checked the same way
/// v12 checks its ALTERs: a `SELECT` that prepares is a column the app can
/// actually read. The index is asserted too — without it every dossier query
/// degrades to a table scan silently, which is the kind of regression that
/// only shows up once somebody has a year of runs.
fn validate_v13(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT actor FROM runs")
        .map_err(|e| format!("validating runs.actor: {e}"))?;
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'runs_by_actor'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| format!("validating runs_by_actor: {e}"))
    .and_then(|found| {
        if found == 1 {
            Ok(())
        } else {
            Err("validating runs_by_actor: index missing".to_string())
        }
    })
}

/// The columns `user_version = 12` promises (M31.5). ALTERs rather than
/// tables, so the check names every column: a `SELECT` that prepares is a
/// column the app can actually read, including the two M31.6 writes later
/// (`estimated`, `answer_latency_micros`) — landed whole per D5.
fn validate_v12(conn: &Connection) -> Result<(), String> {
    for (table, columns) in [
        (
            "runs",
            "model_id, stop_reason, service_tier, total_cost_micros, num_turns, \
             duration_ms, duration_api_ms, cache_write_5m, cache_write_1h, server_tool_use",
        ),
        ("run_cost_components", "estimated"),
        ("assembly_metrics", "answer_latency_micros"),
    ] {
        conn.prepare(&format!("SELECT {columns} FROM {table}"))
            .map_err(|e| format!("validating {table}: {e}"))?;
    }
    Ok(())
}

/// The two governance tables `user_version = 11` promises (M28.0), checked
/// the same way. Two, and exactly two: the trigger registry may write
/// nothing else.
fn validate_v11(conn: &Connection) -> Result<(), String> {
    for table in ["trigger_input_snapshots", "trigger_evaluations"] {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| format!("validating {table}: {e}"))?;
    }
    Ok(())
}

/// The one table `user_version = 10` promises, checked the same way.
fn validate_v10(conn: &Connection) -> Result<(), String> {
    conn.query_row("SELECT count(*) FROM convergence_runs", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|e| format!("validating convergence_runs: {e}"))?;
    Ok(())
}

/// The four tables `user_version = 9` promises. `source_taint_assessments` is
/// among them because v9 REBUILDS it — a migration that renamed the old table
/// and failed to repopulate the new one would otherwise pass unnoticed until
/// the first read.
fn validate_v9(conn: &Connection) -> Result<(), String> {
    for table in [
        "resolver_outcomes",
        "run_cost_components",
        "assembly_metrics",
        "source_taint_assessments",
    ] {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| format!("validating {table}: {e}"))?;
    }
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE name = 'source_taint_assessments_v4'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| format!("checking for the old taint table: {e}"))
    .and_then(|left| {
        if left == 0 {
            Ok(())
        } else {
            Err("the v4 taint table survived its own migration".to_string())
        }
    })?;
    Ok(())
}

/// The one table `user_version = 8` promises, checked the same way.
fn validate_v8(conn: &Connection) -> Result<(), String> {
    conn.query_row("SELECT count(*) FROM source_monitor_state", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|e| format!("validating source_monitor_state: {e}"))?;
    Ok(())
}

/// The one table `user_version = 7` promises, checked the same way.
fn validate_v7(conn: &Connection) -> Result<(), String> {
    conn.query_row("SELECT count(*) FROM attention_signals", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|e| format!("validating attention_signals: {e}"))?;
    Ok(())
}

/// The one table `user_version = 4` promises, checked the same way v3's
/// twenty are: a `CREATE TABLE` that parsed is not the same claim as a table
/// the app can read.
fn validate_v4(conn: &Connection) -> Result<(), String> {
    conn.query_row("SELECT count(*) FROM source_taint_assessments", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|e| format!("validating source_taint_assessments: {e}"))?;
    Ok(())
}

/// The one table `user_version = 6` promises, checked the same way.
fn validate_v6(conn: &Connection) -> Result<(), String> {
    conn.query_row("SELECT count(*) FROM maintenance_findings", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|e| format!("validating maintenance_findings: {e}"))?;
    Ok(())
}

/// The two tables `user_version = 5` promises, checked the same way.
fn validate_v5(conn: &Connection) -> Result<(), String> {
    for table in ["working_memory_manifests", "discovery_plan_runs"] {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| format!("validating {table}: {e}"))?;
    }
    Ok(())
}

/// Open (creating if needed) the runtime DB at the current schema.
///
/// The order is deliberate: integrity BEFORE migration (there is no point
/// migrating a corrupt file, and a corrupt file must be preserved rather than
/// written to), then one transaction per outstanding version step.
pub fn open(data_dir: &Path) -> Result<Connection, String> {
    if let Some(parent) = runtime_db_path(data_dir).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let unclean = open_marker_path(data_dir).exists();
    let conn = open_checked(data_dir, unclean)?;
    migrate_to_current(&conn, data_dir)?;
    // The marker goes down only once the database is genuinely usable, so an
    // open that failed does not leave the next one doing the expensive check
    // for no reason.
    let _ = std::fs::write(open_marker_path(data_dir), b"");
    Ok(conn)
}

/// Open the file and prove it is readable, quarantining it if it is not.
///
/// `quick_check` is the ordinary gate; an unclean shutdown escalates to the
/// full `integrity_check`. On failure the ORIGINAL is preserved under a
/// timestamped name — it is the only diagnostic copy that will ever exist,
/// and deleting it to make room for a working database would destroy the
/// evidence of why the database stopped working.
fn open_checked(data_dir: &Path, unclean: bool) -> Result<Connection, String> {
    let path = runtime_db_path(data_dir);
    let existed = path.exists();
    let conn = connect(&path)?;
    if !existed {
        return Ok(conn);
    }
    let pragma = if unclean {
        "integrity_check"
    } else {
        "quick_check"
    };
    let verdict = conn
        .query_row(&format!("PRAGMA {pragma}"), [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap_or_else(|e| format!("{pragma} failed: {e}"));
    if verdict == "ok" {
        return Ok(conn);
    }
    drop(conn);
    let quarantined = quarantine(&path, &verdict)?;
    status::set(RuntimeStatus::Recovering {
        reason: RecoveryReason::DatabaseCorrupt {
            quarantined: quarantined.to_string_lossy().into_owned(),
        },
    });
    crate::crash::crash_point("runtime-db-quarantined");
    connect(&path)
}

fn connect(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    // Foreign keys are per-connection and OFF by default. Every scoping
    // guarantee in `schema.rs` is a foreign key; leaving them unenforced
    // would make the relational contract decorative.
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| e.to_string())?;
    // Two windows opening two vaults contend on the same file. Waiting is the
    // right answer; `database is locked` on a scheduler claim is not.
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Move a corrupt database aside, taking its WAL and shared-memory files with
/// it so the fresh database does not inherit a stale journal.
fn quarantine(path: &Path, verdict: &str) -> Result<PathBuf, String> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let mut target = path.with_extension(format!("db.corrupt-{stamp}"));
    // Never overwrite an earlier diagnostic copy.
    let mut nth = 1;
    while target.exists() {
        target = path.with_extension(format!("db.corrupt-{stamp}-{nth}"));
        nth += 1;
    }
    std::fs::rename(path, &target).map_err(|e| {
        format!(
            "runtime db failed {verdict:?} and could not be quarantined to {}: {e}",
            target.display()
        )
    })?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        if sidecar.exists() {
            let _ = std::fs::rename(
                &sidecar,
                PathBuf::from(format!("{}{suffix}", target.display())),
            );
        }
    }
    log::error!(
        "runtime db failed {verdict:?}; preserved at {} and replaced with a fresh database — \
         ambient work is paused until the owner rebaselines",
        target.display()
    );
    Ok(target)
}

fn user_version(conn: &Connection) -> Result<i64, String> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn migrate_to_current(conn: &Connection, data_dir: &Path) -> Result<(), String> {
    let version = user_version(conn)?;
    if version > USER_VERSION {
        return Err(format!(
            "{}: runtime db is at user_version {version}, this build speaks {USER_VERSION}",
            runtime_db_path(data_dir).display()
        ));
    }
    for migration in MIGRATIONS.iter().filter(|m| m.to > version) {
        step(conn, migration)?;
    }
    Ok(())
}

/// One migration, one transaction. Validation runs before the version stamp;
/// any failure rolls the whole step back, leaves the prior schema readable,
/// and pauses ambient work with the failing version named.
fn step(conn: &Connection, migration: &Migration) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("runtime db migration {}: {e}", migration.to))?;
    crate::crash::crash_point(&format!("runtime-db-migration-{}-begun", migration.to));
    let applied = conn
        .execute_batch(migration.sql)
        .map_err(|e| e.to_string())
        .and_then(|()| {
            crate::crash::crash_point(&format!("runtime-db-migration-{}-ddl", migration.to));
            (migration.validate)(conn)
        })
        .and_then(|()| {
            crate::crash::crash_point(&format!("runtime-db-migration-{}-validated", migration.to));
            conn.pragma_update(None, "user_version", migration.to)
                .map_err(|e| e.to_string())
        });
    match applied {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("runtime db migration {}: {e}", migration.to))?;
            crate::crash::crash_point(&format!("runtime-db-migration-{}-committed", migration.to));
            Ok(())
        }
        Err(detail) => {
            let _ = conn.execute_batch("ROLLBACK");
            status::set(RuntimeStatus::MigrationFailed {
                attempted_version: migration.to,
                detail: detail.clone(),
            });
            Err(format!(
                "runtime db migration to user_version {} failed and rolled back: {detail}",
                migration.to
            ))
        }
    }
}

/// Connect to an EXISTING, current runtime database without migrating it.
///
/// [`open`] is the app's front door: it integrity-checks, migrates, and marks
/// the file open. That is right once at startup and wrong on a hot path — a
/// `quick_check` scales with the file, and a reader thread closing out a run
/// should not be able to trigger a schema migration as a side effect. This
/// refuses anything that is not already at the current version, so a caller
/// that skipped the front door finds out rather than writing into a schema it
/// does not understand.
pub fn open_existing(data_dir: &Path) -> Result<Connection, String> {
    let path = runtime_db_path(data_dir);
    if !path.exists() {
        return Err(format!("{}: no runtime database", path.display()));
    }
    let conn = connect(&path)?;
    let version = user_version(&conn)?;
    if version != USER_VERSION {
        return Err(format!(
            "{}: runtime db is at user_version {version}, this build speaks {USER_VERSION}",
            path.display()
        ));
    }
    Ok(conn)
}

/// Remove the open marker — a clean close. Anything else leaves it behind and
/// the next open pays for the full integrity check.
pub fn mark_closed(data_dir: &Path) {
    let _ = std::fs::remove_file(open_marker_path(data_dir));
}

/// The two ids that scope every vault-bound row, resolved as a vault opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultScope {
    /// The app's local registration of this path.
    pub vault_id: String,
    /// The ledger's portable identity, once a ledger has been minted here.
    /// `None` for a folder no ledger has claimed yet — the app still records
    /// scan failures and sessions against `vault_id`, and every PORTABLE row
    /// waits for the real thing rather than inventing one.
    pub store_uuid: Option<String>,
}

/// Register an opening vault and read its portable store id.
///
/// Returns `None` when the runtime DB is not armed, which is the same silent
/// no-op the refusal sink takes: a workspace that opens without its
/// operational database is degraded, not broken, and the caller's job is
/// unchanged either way.
pub fn open_vault(vault: &Path) -> Option<VaultScope> {
    let store_uuid = crate::ledger::store::load(&crate::ledger::ledger_dir(vault))
        .ok()
        .flatten()
        .map(|info| info.store_id);
    sink::with_sink(|conn| match scope::register(conn, vault) {
        Ok(vault_id) => Some(VaultScope {
            vault_id,
            store_uuid: store_uuid.clone(),
        }),
        Err(detail) => {
            log::warn!("vault_registry: {vault:?} could not be registered: {detail}");
            None
        }
    })
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    /// Child body for the migration kill-point tests: open a database that is
    /// one version behind, with a crash point armed somewhere inside the
    /// step. The parent asserts what survived.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the migration kill-point tests"]
    fn crash_scenario_migrate() {
        let Ok(dir) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let _ = open(Path::new(&dir));
    }

    /// A database at version 2 with one row of real history — what every
    /// migration kill point is run against.
    fn at_version_two(label: &str) -> PathBuf {
        let dir = testutil::temp_vault(label);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute_batch(&format!(
            "BEGIN; {} {} PRAGMA user_version = 2; COMMIT;",
            schema::SCHEMA_V1,
            schema::SCHEMA_V2
        ))
        .unwrap();
        conn.execute(
            "INSERT INTO operational_log (recorded_at, surface, code, detail) \
             VALUES ('2026-08-09T00:00:00Z', 'test', 'malformed_arguments', 'x')",
            [],
        )
        .unwrap();
        drop(conn);
        dir
    }

    /// Killed anywhere inside a migration, the database is one of exactly two
    /// things: the prior complete version, or the new complete version.
    ///
    /// Every boundary of the step gets its own child process — before the
    /// DDL, after it, after validation, and after the commit — because "the
    /// transaction is atomic" is a claim about SQLite that this milestone
    /// depends on and therefore has to demonstrate rather than assume.
    #[test]
    fn a_kill_at_every_migration_boundary_leaves_one_complete_version() {
        for (point, expected) in [
            ("runtime-db-migration-3-begun", 2),
            ("runtime-db-migration-3-ddl", 2),
            ("runtime-db-migration-3-validated", 2),
            ("runtime-db-migration-3-committed", 3),
        ] {
            let dir = at_version_two(&format!("runtime-kill-{point}"));
            let status =
                testutil::run_crash_scenario("runtime::tests::crash_scenario_migrate", point, &dir);
            assert!(!status.success(), "{point}: the child must have aborted");

            let conn = Connection::open(runtime_db_path(&dir)).unwrap();
            let version = user_version(&conn).unwrap();
            assert_eq!(version, expected, "{point}: version after the kill");
            let kept: i64 = conn
                .query_row("SELECT count(*) FROM operational_log", [], |row| row.get(0))
                .unwrap();
            assert_eq!(kept, 1, "{point}: history survives every kill");
            if expected == 2 {
                assert!(
                    conn.query_row("SELECT count(*) FROM lane_registry", [], |r| r
                        .get::<_, i64>(0))
                        .is_err(),
                    "{point}: a killed step must not leave half its tables"
                );
            }
            drop(conn);

            // And the next open completes the job either way.
            let conn = open(&dir).unwrap();
            assert_eq!(user_version(&conn).unwrap(), USER_VERSION, "{point}");
            let lanes: i64 = conn
                .query_row("SELECT count(*) FROM lane_registry", [], |r| r.get(0))
                .unwrap();
            assert_eq!(lanes, 7, "{point}: the lane registry seeds exactly once");
            drop(conn);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn opening_twice_is_idempotent_and_keeps_the_rows() {
        let dir = testutil::temp_vault("runtime-open");
        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        conn.execute(
            "INSERT INTO operational_log (recorded_at, surface, code, detail) \
             VALUES ('2026-08-09T00:00:00Z', 'test', 'malformed_arguments', 'x')",
            [],
        )
        .unwrap();
        drop(conn);

        let conn = open(&dir).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM operational_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "a second open must not re-initialise");
        let lanes: i64 = conn
            .query_row("SELECT count(*) FROM lane_registry", [], |row| row.get(0))
            .unwrap();
        assert_eq!(lanes, 7, "a second open must not re-seed the lane registry");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every prior `user_version` migrates atomically and keeps its rows —
    /// the acceptance row "each prior user_version migrates or rolls back
    /// intact", run for real from each version this build has ever shipped.
    /// A database built from raw DDL never ran v3's seeding, so nothing here
    /// asks for lanes.
    #[test]
    fn a_database_at_every_prior_version_migrates_and_keeps_its_history() {
        for from in 1..USER_VERSION {
            let dir = testutil::temp_vault(&format!("runtime-upgrade-{from}"));
            std::fs::create_dir_all(&dir).unwrap();
            let conn = Connection::open(runtime_db_path(&dir)).unwrap();
            let mut sql = String::from("BEGIN;");
            for migration in MIGRATIONS.iter().filter(|m| m.to <= from) {
                sql.push_str(migration.sql);
            }
            sql.push_str(&format!("PRAGMA user_version = {from}; COMMIT;"));
            conn.execute_batch(&sql).unwrap();
            conn.execute(
                "INSERT INTO operational_log (recorded_at, surface, code, detail) \
                 VALUES ('2026-08-09T00:00:00Z', 'test', 'malformed_arguments', 'x')",
                [],
            )
            .unwrap();
            drop(conn);

            let conn = open(&dir).unwrap();
            assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
            let kept: i64 = conn
                .query_row("SELECT count(*) FROM operational_log", [], |row| row.get(0))
                .unwrap();
            assert_eq!(kept, 1, "the migration must not lose refusal history");
            for table in EXPECTED_V3_TABLES {
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap_or_else(|e| panic!("{table} missing after upgrade from {from}: {e}"));
            }
            validate_v20(&conn).unwrap_or_else(|e| panic!("upgrade from {from}: {e}"));
            validate_v21(&conn).unwrap_or_else(|e| panic!("upgrade from {from}: {e}"));
            validate_v22(&conn).unwrap_or_else(|e| panic!("upgrade from {from}: {e}"));
            validate_v24(&conn).unwrap_or_else(|e| panic!("upgrade from {from}: {e}"));
            drop(conn);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// v19 (M54.11): a database at 18, holding a vault and a run, comes back
    /// at 19 with both, and the new table takes a status row for that vault
    /// and refuses one for a vault nobody registered.
    #[test]
    fn v19_promises_connector_status() {
        let dir = testutil::temp_vault("runtime-upgrade-18");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        let mut sql = String::from("BEGIN;");
        for migration in MIGRATIONS.iter().filter(|m| m.to <= 18) {
            sql.push_str(migration.sql);
        }
        sql.push_str("PRAGMA user_version = 18; COMMIT;");
        conn.execute_batch(&sql).unwrap();
        let vault = "b".repeat(32);
        conn.execute(
            "INSERT INTO vault_registry (vault_id, vault_path, first_seen_at) \
             VALUES (?1, '/somewhere', '2026-10-13T00:00:00.000Z')",
            [&vault],
        )
        .unwrap();
        assert!(
            conn.prepare("SELECT * FROM connector_status").is_err(),
            "no status table before v19"
        );
        drop(conn);

        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        assert!(validate_v19(&conn).is_ok());
        let kept: i64 = conn
            .query_row("SELECT count(*) FROM vault_registry", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "the step keeps every row it found");
        let insert = |vault_id: &str| {
            conn.execute(
                "INSERT INTO connector_status (vault_id, connector, state, signal, seen_at, \
                 run_id) VALUES (?1, 'gmail', 'needs_sign_in', 'init', \
                 '2026-10-13T10:00:00.000Z', 'run-1')",
                [vault_id],
            )
        };
        assert!(insert(&vault).is_ok());
        assert!(
            insert(&"c".repeat(32)).is_err(),
            "a status row belongs to a registered vault"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A database built from raw DDL at `version`, with its lane registry
    /// seeded (v3's `validate` does that, and raw SQL does not run it), one
    /// vault and one finished run.
    fn at_version_with_a_run(label: &str, version: i64) -> (PathBuf, String) {
        let dir = testutil::temp_vault(label);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        let mut sql = String::from("BEGIN;");
        for migration in MIGRATIONS.iter().filter(|m| m.to <= version) {
            sql.push_str(migration.sql);
        }
        sql.push_str(&format!("PRAGMA user_version = {version}; COMMIT;"));
        conn.execute_batch(&sql).unwrap();
        for (lane, priority, enabled) in schema::LANES {
            conn.execute(
                "INSERT INTO lane_registry (lane, priority, enabled_by_default, \
                 introduced_version) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![lane, priority, i64::from(enabled), schema::LANE_INTRODUCED],
            )
            .unwrap();
        }
        let vault = "d".repeat(32);
        conn.execute(
            "INSERT INTO vault_registry (vault_id, vault_path, first_seen_at) \
             VALUES (?1, '/somewhere', '2026-10-13T00:00:00.000Z')",
            [&vault],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, ended_at, \
             outcome, usage_state, input_tokens, output_tokens, cache_read, cache_write, \
             reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, \
             rejected) VALUES ('before-causes', ?1, 'store', 'ambient', 'scheduled', \
             '2026-10-13T09:00:00.000Z', '2026-10-13T09:01:00.000Z', 'succeeded', 'exact', \
             5, 1, 0, 0, 0, 0, 0, 0, 0)",
            [&vault],
        )
        .unwrap();
        (dir, vault)
    }

    /// v20 (M56.7): a database at 19 keeps its runs, and the row from before
    /// reads NULL for both new columns — nothing is backfilled.
    #[test]
    fn a_v19_database_gains_cause_and_session_and_keeps_its_runs() {
        let (dir, _vault) = at_version_with_a_run("runtime-upgrade-19", 19);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        assert!(
            conn.prepare("SELECT cause FROM runs").is_err(),
            "no cause before v20"
        );
        drop(conn);

        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        assert!(validate_v20(&conn).is_ok());
        let (count, cause, session): (i64, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT count(*), max(cause), max(cli_session_id) FROM runs",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(count, 1, "the step keeps every run it found");
        assert_eq!((cause, session), (None, None), "and backfills nothing");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v21 (M56.9): a database at 20 keeps its runs and its log, and comes
    /// back with both indexes a run's detail reads by.
    #[test]
    fn a_v20_database_gains_the_run_indexes_and_keeps_its_rows() {
        let (dir, _vault) = at_version_with_a_run("runtime-upgrade-20", 20);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute(
            "INSERT INTO operational_log (recorded_at, surface, code, detail, run_id) \
             VALUES ('2026-10-14T00:00:00.000Z', 'create_note', 'write_outside_scope', 'x', \
             'before-causes')",
            [],
        )
        .unwrap();
        assert!(validate_v21(&conn).is_err(), "no indexes before v21");
        drop(conn);

        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        assert!(validate_v21(&conn).is_ok());
        let (runs, logged): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT count(*) FROM runs), (SELECT count(*) FROM operational_log)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((runs, logged), (1, 1), "the step keeps every row it found");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The v22 database M58.1 migrates from, holding one vault, one finished
    /// run, and two recorded writes: a save and a rename.
    fn at_v22_with_writes(label: &str) -> (PathBuf, String) {
        let (dir, vault) = at_version_with_a_run(label, 22);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute(
            "INSERT INTO vault_writes (vault_id, kind, path, to_path, content_hash, actor, \
             recorded_at) VALUES (?1, 'vault.write', 'notes/a.md', NULL, ?2, NULL, \
             '2026-10-13T09:00:00.000Z')",
            rusqlite::params![vault, "a".repeat(64)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vault_writes (vault_id, kind, path, to_path, content_hash, actor, \
             recorded_at) VALUES (?1, 'vault.rename', 'notes/a.md', 'notes/b.md', NULL, \
             'human:owner', '2026-10-13T09:05:00.000Z')",
            [&vault],
        )
        .unwrap();
        (dir, vault)
    }

    /// v23 (M58.1): every write a v22 database recorded survives the rebuild,
    /// in its order, with no run and no approver, its burst its own; and the
    /// rebuilt table takes the new kinds.
    #[test]
    fn a_previous_version_database_gains_run_ids_and_keeps_every_write() {
        let (dir, vault) = at_v22_with_writes("runtime-upgrade-22");
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        assert!(validate_v23(&conn).is_err(), "no run ids before v23");
        drop(conn);

        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        assert!(validate_v23(&conn).is_ok());
        type Kept = (
            i64,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
        );
        let kept: Vec<Kept> = {
            let mut stmt = conn
                .prepare(
                    "SELECT rowid, kind, actor, run_id, approved_by, first_at, recorded_at \
                     FROM vault_writes ORDER BY rowid",
                )
                .unwrap();
            stmt.query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        assert_eq!(
            kept,
            vec![
                (
                    1,
                    "vault.write".to_string(),
                    None,
                    None,
                    None,
                    "2026-10-13T09:00:00.000Z".to_string(),
                    "2026-10-13T09:00:00.000Z".to_string()
                ),
                (
                    2,
                    "vault.rename".to_string(),
                    Some("human:owner".to_string()),
                    None,
                    None,
                    "2026-10-13T09:05:00.000Z".to_string(),
                    "2026-10-13T09:05:00.000Z".to_string()
                ),
            ],
            "every row, in rowid order, run and approver NULL"
        );
        conn.execute(
            "INSERT INTO vault_writes (vault_id, kind, path, actor, run_id, first_at, \
             recorded_at) VALUES (?1, 'vault.comment', '.comments/notes/b.md.json', \
             'process:scout', 'run-1', '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z')",
            [&vault],
        )
        .unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v23's CHECKs: an unknown kind, a rename with nowhere to go, an
    /// approver on a person's own write, an approver who is no person, and an
    /// empty run id are each refused.
    #[test]
    fn the_new_checks_refuse_bad_rows() {
        let (dir, vault) = at_v22_with_writes("runtime-checks-23");
        let conn = open(&dir).unwrap();
        let insert = |kind: &str, to: Option<&str>, run: Option<&str>, approver: Option<&str>| {
            conn.execute(
                "INSERT INTO vault_writes (vault_id, kind, path, to_path, actor, run_id, \
                 approved_by, first_at, recorded_at) VALUES (?1, ?2, 'notes/a.md', ?3, \
                 'process:scout', ?4, ?5, '2026-10-14T00:00:00.000Z', \
                 '2026-10-14T00:00:00.000Z')",
                rusqlite::params![vault, kind, to, run, approver],
            )
        };
        assert!(insert("vault.write", None, Some("run-1"), Some("human:me")).is_ok());
        assert!(insert("vault.create", None, None, None).is_ok());
        assert!(
            insert("vault.copy", None, None, None).is_err(),
            "unknown kind"
        );
        assert!(
            insert("vault.rename", None, None, None).is_err(),
            "rename without to"
        );
        assert!(
            insert("vault.write", None, None, Some("human:me")).is_err(),
            "an approver needs a run"
        );
        assert!(
            insert("vault.write", None, Some("run-1"), Some("process:scout")).is_err(),
            "only a person approves"
        );
        assert!(
            insert("vault.write", None, Some(""), None).is_err(),
            "empty run id"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `runs.writes_booked`: the run from before v23 reads 0, not recorded;
    /// a run inserted after it, by an INSERT that never names the column,
    /// reads 1, booked.
    #[test]
    fn old_runs_read_writes_not_booked_and_new_runs_book_them() {
        let (dir, vault) = at_v22_with_writes("runtime-booked-23");
        let conn = open(&dir).unwrap();
        conn.execute(
            "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, outcome, \
             usage_state, input_tokens, output_tokens, cache_read, cache_write, \
             reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, \
             rejected) VALUES ('after-receipts', ?1, 'store', 'attended', 'agent', \
             '2026-10-14T09:00:00.000Z', 'running', 'pending', 0, 0, 0, 0, 0, 0, 0, 0, 0)",
            [&vault],
        )
        .unwrap();
        let booked = |run: &str| -> i64 {
            conn.query_row(
                "SELECT writes_booked FROM runs WHERE run_id = ?1",
                [run],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(booked("before-causes"), 0);
        assert_eq!(booked("after-receipts"), 1);
        assert!(
            conn.execute(
                "UPDATE runs SET writes_booked = 3 WHERE run_id = 'after-receipts'",
                []
            )
            .is_err(),
            "booked is 0, 1 or 2"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v23's validation names a missing index, so a step that built two of
    /// three rolls back.
    #[test]
    fn validate_catches_a_missing_index() {
        let (dir, _vault) = at_v22_with_writes("runtime-index-23");
        let conn = open(&dir).unwrap();
        assert!(validate_v23(&conn).is_ok());
        conn.execute_batch("DROP INDEX vault_writes_by_time")
            .unwrap();
        let err = validate_v23(&conn).unwrap_err();
        assert!(err.contains("vault_writes_by_time"), "{err}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v24 (M58.4): a database at 23 keeps its run and its writes, and comes
    /// back with `run_commits`, which takes a full lowercase hash for a run
    /// it knows and refuses a short one, an upper-case one, a run nobody
    /// recorded and a second row for the same commit.
    #[test]
    fn a_previous_version_database_gains_run_commits_and_keeps_every_row() {
        let (dir, vault) = at_version_with_a_run("runtime-upgrade-23", 23);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute(
            "INSERT INTO vault_writes (vault_id, kind, path, actor, run_id, first_at, \
             recorded_at) VALUES (?1, 'vault.write', 'notes/a.md', 'process:scout', \
             'before-causes', '2026-10-13T09:00:30.000Z', '2026-10-13T09:00:30.000Z')",
            [&vault],
        )
        .unwrap();
        assert!(validate_v24(&conn).is_err(), "no run_commits before v24");
        drop(conn);

        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        assert!(validate_v24(&conn).is_ok());
        let kept: (i64, i64) = conn
            .query_row(
                "SELECT (SELECT count(*) FROM runs), (SELECT count(*) FROM vault_writes)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(kept, (1, 1), "the step keeps every row it found");
        let insert = |sha: &str, run: &str| {
            conn.execute(
                "INSERT INTO run_commits (vault_id, commit_sha, run_id, committed_at) \
                 VALUES (?1, ?2, ?3, '2026-10-13T09:01:00.000Z')",
                rusqlite::params![vault, sha, run],
            )
        };
        let run = "before-causes";
        let takes = |sha: String, run: &str| insert(&sha, run).is_ok();
        assert!(takes("a".repeat(40), run), "a sha1 hash");
        assert!(takes("b".repeat(64), run), "a sha256 hash");
        assert!(!takes("a".repeat(40), run), "one row a commit");
        assert!(!takes("c".repeat(7), run), "a short hash");
        assert!(!takes("C".repeat(40), run), "an upper-case hash");
        assert!(!takes("g".repeat(40), run), "not hex");
        assert!(!takes("d".repeat(40), "nobody"), "a run nobody recorded");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v25 (M63.1): a database at 24 keeps its run and its commit, and comes
    /// back with `agent_wakes` and its four indexes.
    #[test]
    fn a_previous_version_database_gains_agent_wakes_and_keeps_its_rows() {
        let (dir, vault) = at_version_with_a_run("runtime-upgrade-24", 24);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute(
            "INSERT INTO run_commits (vault_id, commit_sha, run_id, committed_at) \
             VALUES (?1, ?2, 'before-causes', '2026-10-13T09:01:00.000Z')",
            rusqlite::params![vault, "a".repeat(40)],
        )
        .unwrap();
        assert!(validate_v25(&conn).is_err(), "no agent_wakes before v25");
        drop(conn);

        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        assert!(validate_v25(&conn).is_ok());
        let kept: (i64, i64) = conn
            .query_row(
                "SELECT (SELECT count(*) FROM runs), (SELECT count(*) FROM run_commits)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(kept, (1, 1), "the step keeps every row it found");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v25's CHECKs and indexes refuse every row `agent_wakes` must never
    /// hold, and take the ones it must.
    #[test]
    fn the_agent_wakes_checks_refuse_bad_rows() {
        let (dir, vault) = at_version_with_a_run("runtime-wake-checks", 24);
        let conn = open(&dir).unwrap();
        let seq = std::cell::Cell::new(0u32);
        // One row: `cols` names the extra columns, `vals` their SQL values.
        let insert = |agent: &str, key: &str, cols: &str, vals: &str| {
            seq.set(seq.get() + 1);
            let id = format!("{:032x}", seq.get());
            conn.execute(
                &format!(
                    "INSERT INTO agent_wakes (wake_id, vault_id, agent, wake_key, \
                     trigger_digest, cause, admitted_at{cols}) VALUES (?1, ?2, ?3, ?4, \
                     '0123456789abcdef', '{{\"kind\":\"event\"}}', \
                     '2026-10-13T09:00:00.000Z'{vals})"
                ),
                rusqlite::params![id, vault, agent, key],
            )
        };
        let at = "'2026-10-13T09:05:00.000Z'";
        assert!(
            insert("process:scout", "k1", "", "").is_ok(),
            "a pending wake"
        );
        assert!(
            insert("process:scout", "k1", "", "").is_err(),
            "a second live wake per key"
        );
        assert!(
            insert(
                "process:scout",
                "k2",
                ", state, run_id, started_at",
                &format!(", 'started', 'before-causes', {at}")
            )
            .is_ok(),
            "a started wake"
        );
        assert!(
            insert(
                "process:scout",
                "k3",
                ", state, run_id, started_at",
                &format!(", 'started', 'before-causes', {at}")
            )
            .is_err(),
            "a second started wake per agent"
        );
        assert!(
            insert(
                "process:scout",
                "k4",
                ", state, started_at",
                &format!(", 'started', {at}")
            )
            .is_err(),
            "started without a run"
        );
        assert!(
            insert(
                "process:scout",
                "k5",
                ", state, outcome, reason, detail",
                ", 'finished', 'cancelled', 'superseded', 'paused'"
            )
            .is_err(),
            "finished without finished_at"
        );
        assert!(
            insert(
                "process:scout",
                "k6",
                ", state, finished_at, outcome",
                &format!(", 'finished', {at}, 'skipped'")
            )
            .is_err(),
            "skipped without a reason"
        );
        assert!(
            insert(
                "process:scout",
                "k7",
                ", state, finished_at, outcome, reason",
                &format!(", 'finished', {at}, 'vanished', 'x'")
            )
            .is_err(),
            "an unknown outcome"
        );
        assert!(
            insert(
                "process:scout",
                "k8",
                ", state, finished_at, outcome, reason, detail",
                &format!(", 'finished', {at}, 'cancelled', 'superseded', 'paused'")
            )
            .is_ok(),
            "a cancelled wake"
        );
        assert!(
            insert(
                "process:scout",
                "k1",
                ", state, finished_at, outcome, reason",
                &format!(", 'finished', {at}, 'cancelled', 'expired'")
            )
            .is_ok(),
            "a finished wake never blocks its key"
        );
        assert!(
            insert(
                "process:scout",
                "k9",
                ", state, finished_at, outcome",
                &format!(", 'finished', {at}, 'coalesced'")
            )
            .is_err(),
            "coalesced without the run that took it"
        );
        assert!(
            insert("scout", "k10", "", "").is_err(),
            "an agent that is no process"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v25's validation names a missing index, so a step that built three of
    /// four rolls back.
    #[test]
    fn validate_catches_a_missing_wakes_index() {
        let dir = testutil::temp_vault("runtime-index-25");
        let conn = open(&dir).unwrap();
        assert!(validate_v25(&conn).is_ok());
        conn.execute_batch("DROP INDEX agent_wakes_single_flight")
            .unwrap();
        let err = validate_v25(&conn).unwrap_err();
        assert!(err.contains("agent_wakes_single_flight"), "{err}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v28_preserves_runs_causes_leases_and_commit_attribution() {
        let (dir, vault) = at_version_with_a_run("runtime-clients-upgrade", 27);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute(
            "UPDATE runs SET cause = '{\"kind\":\"event\",\"subject\":\"kept\"}'",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO ambient_dispatch (run_id, vault_id, store_uuid, lane, acquired_at, lease_expires_at) VALUES ('before-causes', ?1, 'store', 'scheduled', '2026-10-15T01:00:00Z', '2026-10-15T02:00:00Z')", [&vault]).unwrap();
        conn.execute("INSERT INTO run_commits (vault_id, commit_sha, run_id, committed_at) VALUES (?1, ?2, 'before-causes', '2026-10-15T01:00:00Z')", rusqlite::params![vault, "a".repeat(40)]).unwrap();
        drop(conn);
        let conn = open(&dir).unwrap();
        validate_v28(&conn).unwrap();
        let kept: (String, i64, i64) = conn.query_row("SELECT cause, (SELECT count(*) FROM ambient_dispatch), (SELECT count(*) FROM run_commits) FROM runs WHERE run_id='before-causes'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(
            kept,
            ("{\"kind\":\"event\",\"subject\":\"kept\"}".into(), 1, 1)
        );
        conn.execute("UPDATE runs SET cause = '{\"kind\":\"client\"}'", [])
            .unwrap();
        assert!(conn
            .execute("UPDATE runs SET cause = '{\"kind\":\"not-a-kind\"}'", [])
            .is_err());
        assert!(conn.execute("UPDATE runs SET cause = '{}'", []).is_err());
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn validate_v28_catches_a_cause_check_without_client() {
        let (dir, _) = at_version_with_a_run("runtime-clients-check", 27);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute_batch(&schema::SCHEMA_V28.replace(", 'client'", ""))
            .unwrap();
        assert!(validate_v28(&conn).unwrap_err().contains("client included"));
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn client_token_column_checks_refuse_bad_rows() {
        let dir = testutil::temp_vault("runtime-clients-columns");
        let conn = open(&dir).unwrap();
        let vault = scope::register(&conn, &dir).unwrap();
        let good = [
            "a".repeat(32),
            vault,
            "App".into(),
            "app".into(),
            "b".repeat(64),
            "[\"read\"]".into(),
            "[]".into(),
            "[\"notes\"]".into(),
        ];
        for (index, invalid) in [
            (0, "A".repeat(32)),
            (0, "short".into()),
            (1, "missing-vault".into()),
            (2, "".into()),
            (2, "x".repeat(101)),
            (3, "Not slug".into()),
            (3, "x".repeat(33)),
            (4, "not a hash".into()),
            (5, "{}".into()),
            (6, "null".into()),
            (7, "{}".into()),
        ] {
            let mut row = good.clone();
            row[index] = invalid;
            assert!(conn.execute("INSERT INTO client_tokens (token_id,vault_id,name,slug,secret_sha256,toolsets,write_scope,read_scope,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'2026-10-15T00:00:00Z')", rusqlite::params_from_iter(row)).is_err(), "column {index}");
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_kill_at_every_client_migration_boundary_preserves_history() {
        for (suffix, expected) in [
            ("begun", 27),
            ("ddl", 27),
            ("validated", 27),
            ("committed", 28),
        ] {
            let (dir, _) = at_version_with_a_run("runtime-client-migration", 27);
            let point = format!("runtime-db-migration-28-{suffix}");
            let status = testutil::run_crash_scenario(
                "runtime::tests::crash_scenario_migrate",
                &point,
                &dir,
            );
            assert!(!status.success());
            let conn = Connection::open(runtime_db_path(&dir)).unwrap();
            assert_eq!(user_version(&conn).unwrap(), expected);
            assert_eq!(
                conn.query_row("SELECT count(*) FROM runs", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(validate_v28(&conn).is_ok(), expected == 28);
            drop(conn);
            let conn = open(&dir).unwrap();
            validate_v28(&conn).unwrap();
            drop(conn);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_previous_version_database_gains_reminder_fires_and_done_marks() {
        let (dir, _) = at_version_with_a_run("runtime-upgrade-26", 26);
        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        validate_v27(&conn).unwrap();
        let rows: (i64,i64,i64) = conn.query_row("SELECT (SELECT count(*) FROM runs), (SELECT count(*) FROM reminder_fires), (SELECT count(*) FROM done_marks)", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(rows, (1, 0, 0));
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn the_v27_validator_refuses_tables_without_their_checks() {
        for table in ["reminder_fires", "done_marks"] {
            let dir = testutil::temp_vault("runtime-checks-27");
            let conn = open(&dir).unwrap();
            conn.execute_batch(&format!("CREATE TABLE stripped AS SELECT * FROM {table}; DROP TABLE {table}; ALTER TABLE stripped RENAME TO {table};")).unwrap();
            assert!(validate_v27(&conn).unwrap_err().contains(table));
            drop(conn);
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    #[test]
    fn a_kill_at_every_reminder_migration_boundary_preserves_history() {
        for (suffix, expected) in [
            ("begun", 26),
            ("ddl", 26),
            ("validated", 26),
            ("committed", 27),
        ] {
            let (dir, _) = at_version_with_a_run("runtime-reminder-kill", 26);
            let point = format!("runtime-db-migration-27-{suffix}");
            let status = testutil::run_crash_scenario(
                "runtime::tests::crash_scenario_migrate",
                &point,
                &dir,
            );
            assert!(!status.success());
            let conn = Connection::open(runtime_db_path(&dir)).unwrap();
            assert_eq!(user_version(&conn).unwrap(), expected);
            let count: i64 = conn
                .query_row("SELECT count(*) FROM runs", [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 1);
            assert_eq!(validate_v27(&conn).is_ok(), expected == 27);
            drop(conn);
            let conn = open(&dir).unwrap();
            validate_v27(&conn).unwrap();
            drop(conn);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// v26 (M60.6): a database at 25 keeps its run and its wake, and comes
    /// back with an empty `batch_journal` and its index.
    #[test]
    fn a_previous_version_database_gains_the_batch_journal_and_keeps_every_row() {
        let (dir, vault) = at_version_with_a_run("runtime-upgrade-25", 25);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute(
            "INSERT INTO agent_wakes (wake_id, vault_id, agent, wake_key, trigger_digest, cause, \
             admitted_at) VALUES (?1, ?2, 'process:scout', 'k', '0123456789abcdef', \
             '{\"kind\":\"event\"}', '2026-10-13T09:00:00.000Z')",
            rusqlite::params!["a".repeat(32), vault],
        )
        .unwrap();
        assert!(validate_v26(&conn).is_err(), "no batch_journal before v26");
        drop(conn);

        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        assert!(validate_v26(&conn).is_ok());
        let kept: (i64, i64, i64) = conn
            .query_row(
                "SELECT (SELECT count(*) FROM runs), (SELECT count(*) FROM agent_wakes), \
                 (SELECT count(*) FROM batch_journal)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(kept, (1, 1, 0), "the step keeps every row and adds none");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v26's CHECKs refuse every row `batch_journal` must never hold: a bad
    /// state, files that are no JSON array, an actor that is no person, a
    /// time in another spelling and an id of the wrong length.
    #[test]
    fn the_batch_journal_checks_refuse_bad_rows() {
        let (dir, vault) = at_version_with_a_run("runtime-batch-checks", 25);
        let conn = open(&dir).unwrap();
        let insert = |id: &str, state: &str, files: &str, actor: &str, at: &str| {
            conn.execute(
                "INSERT INTO batch_journal (batch_id, vault_id, state, files, actor, started_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, vault, state, files, actor, at],
            )
        };
        let at = "2026-10-14T09:00:00.000Z";
        let id = |n: u32| format!("{n:032x}");
        assert!(
            insert(&id(1), "staged", "[]", "human:me", at).is_ok(),
            "a staged row"
        );
        assert!(
            insert(&id(2), "applying", "[]", "human:me", at).is_ok(),
            "an applying row"
        );
        assert!(
            insert(&id(3), "done", "[]", "human:me", at).is_err(),
            "an unknown state"
        );
        assert!(
            insert(&id(4), "staged", "{}", "human:me", at).is_err(),
            "files not an array"
        );
        assert!(
            insert(&id(5), "staged", "[", "human:me", at).is_err(),
            "files not JSON"
        );
        assert!(
            insert(&id(6), "staged", "[]", "process:scout", at).is_err(),
            "an agent's batch"
        );
        assert!(
            insert(&id(7), "staged", "[]", "human:me", "2026-10-14 09:00").is_err(),
            "another time spelling"
        );
        assert!(
            insert("abc", "staged", "[]", "human:me", at).is_err(),
            "a short id"
        );
        assert!(
            insert(&"G".repeat(32), "staged", "[]", "human:me", at).is_err(),
            "an id that is not lowercase hex"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v26's validation names a missing index, so a step that built the
    /// table without it rolls back.
    #[test]
    fn validate_catches_a_missing_batch_journal_index() {
        let dir = testutil::temp_vault("runtime-index-26");
        let conn = open(&dir).unwrap();
        assert!(validate_v26(&conn).is_ok());
        conn.execute_batch("DROP INDEX batch_journal_by_vault")
            .unwrap();
        let err = validate_v26(&conn).unwrap_err();
        assert!(err.contains("batch_journal_by_vault"), "{err}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v22 (M57.4c): a database at 21 keeps its runs and its log, and comes
    /// back with the pending writes table and its three indexes.
    #[test]
    fn a_v21_database_gains_pending_writes_and_keeps_its_rows() {
        let (dir, _vault) = at_version_with_a_run("runtime-upgrade-21", 21);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute(
            "INSERT INTO operational_log (recorded_at, surface, code, detail, run_id) \
             VALUES ('2026-10-14T00:00:00.000Z', 'create_note', 'write_outside_scope', 'x', \
             'before-causes')",
            [],
        )
        .unwrap();
        assert!(validate_v22(&conn).is_err(), "no pending writes before v22");
        drop(conn);

        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        assert!(validate_v22(&conn).is_ok());
        let (runs, logged): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT count(*) FROM runs), (SELECT count(*) FROM operational_log)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((runs, logged), (1, 1), "the step keeps every row it found");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v22's CHECKs refuse every row the table must never hold.
    #[test]
    fn the_pending_writes_checks_refuse_each_bad_row() {
        let (dir, vault) = at_version_with_a_run("runtime-pending-checks", 21);
        let conn = open(&dir).unwrap();
        let insert = |overrides: &[(&str, &str)]| {
            let mut row: Vec<(&str, String)> = vec![
                ("pending_id", "a".repeat(32)),
                ("vault_id", vault.clone()),
                ("run_id", "run-1".into()),
                ("actor", "process:release-scout".into()),
                ("tool", "create_note".into()),
                ("target", "records/risks".into()),
                ("input", r#"{"folder":"records/risks","slug":"x"}"#.into()),
                ("input_hash", "b".repeat(64)),
                ("grant_json", "{}".into()),
                ("queued_at", "2026-10-14T10:00:00.000Z".into()),
                ("state", "pending".into()),
            ];
            for (key, value) in overrides {
                match row.iter_mut().find(|(k, _)| k == key) {
                    Some(slot) => slot.1 = (*value).to_string(),
                    None => row.push((key, (*value).to_string())),
                }
            }
            let columns: Vec<&str> = row.iter().map(|(k, _)| *k).collect();
            let marks: Vec<String> = (1..=row.len()).map(|i| format!("?{i}")).collect();
            let values: Vec<&String> = row.iter().map(|(_, v)| v).collect();
            conn.execute(
                &format!(
                    "INSERT INTO pending_writes ({}) VALUES ({})",
                    columns.join(", "),
                    marks.join(", ")
                ),
                rusqlite::params_from_iter(values),
            )
        };
        let decided = "2026-10-14T11:00:00.000Z";
        let (stranger, twin, decided_twin) = ("f".repeat(32), "c".repeat(32), "d".repeat(32));
        let big = format!(r#"{{"body":"{}"}}"#, "x".repeat(262_144));
        for (why, overrides) in [
            (
                "an unknown state",
                vec![("state", "maybe"), ("decided_at", decided)],
            ),
            ("non-JSON input", vec![("input", "not json")]),
            ("input that is no object", vec![("input", "[1]")]),
            ("oversize input", vec![("input", big.as_str())]),
            (
                "a decided row without decided_at",
                vec![("state", "applied")],
            ),
            (
                "a pending row with decided_at",
                vec![("decided_at", decided)],
            ),
            (
                "a rejection without a reason",
                vec![("state", "rejected"), ("decided_at", decided)],
            ),
            (
                "a refusal with a blank reason",
                vec![
                    ("state", "refused"),
                    ("decided_at", decided),
                    ("reason", " "),
                ],
            ),
            ("a non-process actor", vec![("actor", "claude-code")]),
            ("a bare process prefix", vec![("actor", "process:")]),
            (
                "an unregistered vault",
                vec![("vault_id", stranger.as_str())],
            ),
            ("a reported pending row", vec![("reported_run_id", "run-2")]),
        ] {
            assert!(insert(&overrides).is_err(), "{why} must be refused");
        }
        insert(&[]).expect("a well-formed row lands");
        insert(&[("pending_id", twin.as_str())])
            .expect_err("one open row per vault, actor, tool and input");
        insert(&[
            ("pending_id", decided_twin.as_str()),
            ("state", "rejected"),
            ("decided_at", decided),
            ("reason", "not yet"),
        ])
        .expect("a decided twin is no open row");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The refusals read is served by its index rather than a scan of the
    /// whole log, and the session read by its own.
    #[test]
    fn the_refusals_read_uses_its_index() {
        let dir = testutil::temp_vault("runtime-refusals-plan");
        drop(open(&dir).unwrap());
        let ro = ReadOnly::open(&dir).unwrap();
        let plan = |sql: &str, bound: &[&dyn rusqlite::ToSql]| -> String {
            let mut statement = ro.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let rows = statement
                .query_map(bound, |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows.join(" | ")
        };
        let [usage, stream, tool_calls, costs] = fleet::TELEMETRY_SURFACES;
        let refusals = plan(
            fleet::REFUSALS_SQL,
            rusqlite::params!["r1", usage, stream, tool_calls, costs],
        );
        assert!(refusals.contains("operational_log_by_run"), "{refusals}");
        let sessions = plan(
            "SELECT count(*) FROM runs WHERE cli_session_id = ?1",
            rusqlite::params!["00000000-0000-4000-8000-000000000001"],
        );
        assert!(sessions.contains("runs_by_cli_session"), "{sessions}");
        drop(ro);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The CHECK holds the vocabulary: a kind outside it, a value that is not
    /// JSON, a JSON array and an over-long object are each refused, and every
    /// kind `cause.rs` records is taken.
    #[test]
    fn the_cause_check_refuses_a_kind_outside_the_vocabulary() {
        let (dir, _vault) = at_version_with_a_run("runtime-cause-check", 19);
        let conn = open(&dir).unwrap();
        let set = |value: &str| {
            conn.execute(
                "UPDATE runs SET cause = ?1 WHERE run_id = 'before-causes'",
                [value],
            )
        };
        for kind in cause::CauseKind::ALL {
            let column = cause::RunCause::of(kind).to_column();
            assert!(set(&column).is_ok(), "{column}");
        }
        assert!(
            set(r#"{"kind":"scheduled"}"#).is_err(),
            "a lane is not a kind"
        );
        assert!(set(r#"{"kind":"telepathy"}"#).is_err());
        assert!(set("schedule").is_err(), "not JSON");
        assert!(set(r#"["schedule"]"#).is_err(), "not an object");
        assert!(set(r#"{"subject":"x"}"#).is_err(), "no kind at all");
        let long = format!(r#"{{"kind":"event","subject":"{}"}}"#, "x".repeat(2048));
        assert!(set(&long).is_err(), "over 2048 characters");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_session_check_refuses_a_path_shaped_id() {
        let (dir, _vault) = at_version_with_a_run("runtime-session-check", 19);
        let conn = open(&dir).unwrap();
        let set = |value: &str| {
            conn.execute(
                "UPDATE runs SET cli_session_id = ?1 WHERE run_id = 'before-causes'",
                [value],
            )
        };
        assert!(set("00000000-0000-4000-8000-000000000001").is_ok());
        for bad in [
            "../x1234",
            "a/b/c/d/e",
            "short",
            "--dangerously-skip-permissions",
            &"a".repeat(65),
        ] {
            assert!(set(bad).is_err(), "{bad}");
            assert!(!cause::is_cli_session_id(bad), "Rust refuses {bad} too");
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A v20 that added the column without its CHECK would take any text, so
    /// the validator refuses it and the step rolls back.
    #[test]
    fn a_cause_column_without_its_check_rolls_back() {
        let _lock = status::test_lock();
        let (dir, _vault) = at_version_with_a_run("runtime-cause-unchecked", 19);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        status::clear();
        let unchecked = Migration {
            to: 20,
            sql: "ALTER TABLE runs ADD COLUMN cause TEXT; \
                  ALTER TABLE runs ADD COLUMN cli_session_id TEXT;",
            validate: validate_v20,
        };
        let err = step(&conn, &unchecked).unwrap_err();
        assert!(err.contains("without its kind CHECK"), "{err}");
        assert_eq!(user_version(&conn).unwrap(), 19);
        assert!(conn.prepare("SELECT cause FROM runs").is_err());
        status::clear();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A database that was upgraded MID-RUN comes back holding the lease it
    /// held (M33b.1).
    ///
    /// The v14 rebuild is a create/copy/drop dance, and the failure mode a
    /// dance has that an `ALTER` does not is silently losing the rows: an
    /// empty new table looks exactly like a quiet background, and the run
    /// whose lease vanished would never be swept, never finalized, and never
    /// counted. So this asserts the row survived by run id — not that the
    /// table exists.
    #[test]
    fn a_lease_held_across_the_v14_rebuild_survives_it() {
        let dir = testutil::temp_vault("runtime-upgrade-13-lease");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        let mut sql = String::from("BEGIN;");
        for migration in MIGRATIONS.iter().filter(|m| m.to <= 13) {
            sql.push_str(migration.sql);
        }
        sql.push_str("PRAGMA user_version = 13; COMMIT;");
        conn.execute_batch(&sql).unwrap();
        // The lane registry is seeded by v3's `validate`, which raw SQL does
        // not run — and the lease's `lane` is a foreign key into it.
        for (lane, priority, enabled) in schema::LANES {
            conn.execute(
                "INSERT INTO lane_registry (lane, priority, enabled_by_default, \
                 introduced_version) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![lane, priority, i64::from(enabled), schema::LANE_INTRODUCED],
            )
            .unwrap();
        }
        let vault = "a".repeat(32);
        conn.execute(
            "INSERT INTO vault_registry (vault_id, vault_path, first_seen_at) \
             VALUES (?1, '/somewhere', '2026-08-09T00:00:00.000Z')",
            [&vault],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, outcome, \
             usage_state, input_tokens, output_tokens, cache_read, cache_write, \
             reserved_total_tokens, reserved_output_tokens, lease_expires_at, \
             proposals_submitted, applied, rejected) \
             VALUES ('mid-flight', ?1, 'store', 'ambient', 'filed', \
             '2026-08-09T10:00:00.000Z', 'running', 'pending', 0, 0, 0, 0, 5000, 1000, \
             '2026-08-09T10:20:00.000Z', 0, 0, 0)",
            [&vault],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ambient_dispatch \
             (singleton_key, run_id, vault_id, store_uuid, lane, acquired_at, lease_expires_at) \
             VALUES ('ambient', 'mid-flight', ?1, 'store', 'filed', \
             '2026-08-09T10:00:00.000Z', '2026-08-09T10:20:00.000Z')",
            [&vault],
        )
        .unwrap();
        drop(conn);

        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        let (run_id, expires): (String, String) = conn
            .query_row(
                "SELECT run_id, lease_expires_at FROM ambient_dispatch",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("the lease must have crossed the rebuild");
        assert_eq!(run_id, "mid-flight");
        assert_eq!(expires, "2026-08-09T10:20:00.000Z");
        assert!(
            conn.prepare("SELECT singleton_key FROM ambient_dispatch")
                .is_err(),
            "and the column that used to be the ceiling is gone"
        );
        // Which the validator would also have caught — asserted here too
        // because a validator that stopped running is the failure this pair
        // is meant to survive.
        assert!(validate_v14(&conn).is_ok());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_future_schema_is_refused_rather_than_used() {
        // A newer build's database opened by an older one would silently
        // read columns that mean something else now.
        let dir = testutil::temp_vault("runtime-future");
        let conn = open(&dir).unwrap();
        conn.pragma_update(None, "user_version", USER_VERSION + 7)
            .unwrap();
        drop(conn);
        let err = open(&dir).unwrap_err();
        assert!(err.contains("this build speaks"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failing_migration_rolls_back_intact_and_names_the_version() {
        // Injected failure: the step's validation refuses. The prior schema
        // must remain readable, its rows intact, and ambient work paused with
        // the failing version visible.
        let _lock = status::test_lock();
        let dir = testutil::temp_vault("runtime-migration-fails");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute_batch(&format!(
            "BEGIN; {} PRAGMA user_version = 1; COMMIT;",
            schema::SCHEMA_V1
        ))
        .unwrap();
        conn.execute(
            "INSERT INTO operational_log (recorded_at, surface, code, detail) \
             VALUES ('2026-08-09T00:00:00Z', 'test', 'malformed_arguments', 'x')",
            [],
        )
        .unwrap();

        status::clear();
        fn always_refuses(_: &Connection) -> Result<(), String> {
            Err("injected validation failure".into())
        }
        let doomed = Migration {
            to: 2,
            sql: schema::SCHEMA_V2,
            validate: always_refuses,
        };
        let err = step(&conn, &doomed).unwrap_err();
        assert!(err.contains("user_version 2"), "{err}");
        assert!(err.contains("rolled back"), "{err}");

        assert_eq!(user_version(&conn).unwrap(), 1, "version must not advance");
        let kept: i64 = conn
            .query_row("SELECT count(*) FROM operational_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, 1, "the prior schema must remain readable and intact");
        assert!(
            conn.query_row("SELECT count(*) FROM parked_promotions", [], |r| r
                .get::<_, i64>(0))
                .is_err(),
            "a rolled-back step must not half-create its tables"
        );
        assert!(
            !status::ambient_allowed(),
            "a failed migration pauses ambient"
        );
        assert_eq!(status::current().code(), "migration_failed");
        status::clear();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_database_is_quarantined_and_replaced_not_overwritten() {
        let _lock = status::test_lock();
        let dir = testutil::temp_vault("runtime-corrupt");
        let conn = open(&dir).unwrap();
        conn.execute(
            "INSERT INTO operational_log (recorded_at, surface, code, detail) \
             VALUES ('2026-08-09T00:00:00Z', 'test', 'malformed_arguments', 'x')",
            [],
        )
        .unwrap();
        drop(conn);
        mark_closed(&dir);

        // Corrupt the header the way a truncated sync would.
        let path = runtime_db_path(&dir);
        let mut bytes = std::fs::read(&path).unwrap();
        for byte in bytes.iter_mut().skip(4096).take(2048) {
            *byte ^= 0xff;
        }
        std::fs::write(&path, &bytes).unwrap();

        status::clear();
        let conn = open(&dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM operational_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0, "the replacement database starts empty");
        drop(conn);

        let preserved: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        assert_eq!(
            preserved.len(),
            1,
            "the only diagnostic copy must be preserved, not deleted: {preserved:?}"
        );
        assert!(
            !status::ambient_allowed(),
            "a quarantined database pauses ambient work"
        );
        assert_eq!(status::current().code(), "database_corrupt");
        status::clear();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_open_marker_records_whether_the_last_process_closed_cleanly() {
        let dir = testutil::temp_vault("runtime-marker");
        let conn = open(&dir).unwrap();
        assert!(
            open_marker_path(&dir).exists(),
            "an open database is marked"
        );
        drop(conn);
        mark_closed(&dir);
        assert!(!open_marker_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_database_is_created_beside_its_directory_not_inside_the_vault() {
        // D2: SQLite WAL inside a cloud-synced vault is how databases get
        // corrupted. The path is app-data by construction.
        let dir = testutil::temp_vault("runtime-path");
        assert_eq!(runtime_db_path(&dir), dir.join(RUNTIME_DB));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn foreign_keys_are_enforced_on_every_connection() {
        // Every scoping guarantee in the schema is a foreign key, and SQLite
        // leaves them off unless asked per connection.
        let dir = testutil::temp_vault("runtime-fk");
        let conn = open(&dir).unwrap();
        let err = conn
            .execute(
                "INSERT INTO ingestion_failures \
                 (vault_id, store_uuid, item_key, stage, detail, first_seen, last_seen) \
                 VALUES ('0000000000000000000000000000dead', 's', 'i', 'scan', 'd', \
                         '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z')",
                [],
            )
            .unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("foreign key"),
            "{err}"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_closed_enums_are_checks_not_conventions() {
        let dir = testutil::temp_vault("runtime-enums");
        let conn = open(&dir).unwrap();
        let vault = scope::register(&conn, &dir).unwrap();
        let insert = |mode: &str, lane: &str| {
            conn.execute(
                "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, \
                 outcome, usage_state, input_tokens, output_tokens, cache_read, cache_write, \
                 reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, \
                 rejected) \
                 VALUES (?1, ?2, 'store', ?3, ?4, '2026-08-09T00:00:00.000Z', 'running', \
                 'pending', 0, 0, 0, 0, 0, 0, 0, 0, 0)",
                rusqlite::params![format!("run-{mode}-{lane}"), vault, mode, lane],
            )
        };
        assert!(insert("ambient", "behind").is_ok());
        assert!(insert("sideways", "behind").is_err(), "mode is closed");
        assert!(insert("ambient", "telepathy").is_err(), "lane is closed");

        // An ambient run with no vault is a row nothing can attribute.
        let orphan = conn.execute(
            "INSERT INTO runs (run_id, mode, lane, started_at, outcome, usage_state, \
             input_tokens, output_tokens, cache_read, cache_write, reserved_total_tokens, \
             reserved_output_tokens, proposals_submitted, applied, rejected) \
             VALUES ('orphan', 'ambient', 'behind', '2026-08-09T00:00:00.000Z', 'running', \
             'pending', 0, 0, 0, 0, 0, 0, 0, 0, 0)",
            [],
        );
        assert!(orphan.is_err(), "ambient work is always somebody's vault");

        // Negative token counts are not a thing that happened.
        let negative = conn.execute(
            "UPDATE runs SET output_tokens = -1 WHERE run_id = 'run-ambient-behind'",
            [],
        );
        assert!(negative.is_err(), "token counts are non-negative");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_claim_without_a_lease_is_refused_by_the_schema() {
        // Crash recovery's whole promise is that every item is either
        // unclaimed or owned by ONE recoverable lease. An owner with no
        // expiry would be an item nothing could ever free.
        let dir = testutil::temp_vault("runtime-claim");
        let conn = open(&dir).unwrap();
        let vault = scope::register(&conn, &dir).unwrap();
        let insert = |state: &str, run: Option<&str>, expires: Option<&str>| {
            conn.execute(
                "INSERT INTO scheduler (vault_id, store_uuid, item_key, content_hash, \
                 normalized_prior_snapshot, normalizer_version, processing_epoch, state, \
                 claimed_by_run_id, claim_expires_at, first_seen, updated_at) \
                 VALUES (?1, 'store', ?2, ?3, '{}', 'v1', 0, ?4, ?5, ?6, \
                 '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z')",
                rusqlite::params![
                    vault,
                    format!("item-{state}-{}", run.unwrap_or("none")),
                    "a".repeat(64),
                    state,
                    run,
                    expires
                ],
            )
        };
        assert!(insert("pending", None, None).is_ok());
        assert!(
            insert("claimed", None, None).is_err(),
            "claimed without an owner is not a claim"
        );
        assert!(
            insert("claimed", Some("run-x"), None).is_err(),
            "an owner with no lease can never be recovered"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn at_version_28_with_a_wake(label: &str) -> std::path::PathBuf {
        let (dir, vault) = at_version_with_a_run(label, 28);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute("INSERT INTO agent_wakes (wake_id, vault_id, agent, wake_key, trigger_digest, cause, admitted_at) VALUES (?1, ?2, 'process:scout', ?3, ?4, '{\"kind\":\"event\",\"subject\":\"notes/a.md\"}', '2026-10-15T09:00:00Z')",
            rusqlite::params!["a".repeat(32), vault, "b".repeat(64), "1".repeat(16)]).unwrap();
        drop(conn);
        dir
    }

    #[test]
    fn v29_keeps_existing_wakes_with_unrecorded_authors_and_checks_new_kinds() {
        let dir = at_version_28_with_a_wake("runtime-wake-author-upgrade");
        let conn = open(&dir).unwrap();
        validate_v29(&conn).unwrap();
        let kept: (i64, Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT count(*), author, author_actor, parent_run_id FROM agent_wakes",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(kept, (1, None, None, None));
        assert!(conn
            .execute("UPDATE agent_wakes SET author = 'guessed'", [])
            .is_err());
        assert!(conn
            .execute("UPDATE agent_wakes SET author_actor = 'human:me'", [])
            .is_err());
        conn.execute(
            "UPDATE agent_wakes SET author = 'person', author_actor = 'human:me'",
            [],
        )
        .unwrap();
        assert!(conn
            .execute("UPDATE agent_wakes SET author_actor = ''", [])
            .is_err());
        assert!(conn
            .execute("UPDATE agent_wakes SET parent_run_id = 'before-causes'", [])
            .is_err());
        conn.execute("UPDATE agent_wakes SET author = 'run', author_actor = 'claude-code', parent_run_id = 'before-causes'", []).unwrap();
        assert!(conn
            .execute("UPDATE agent_wakes SET parent_run_id = 'missing-run'", [])
            .is_err());
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn validate_v29_refuses_an_unbounded_author_kind() {
        let dir = at_version_28_with_a_wake("runtime-wake-author-validator");
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute_batch(&schema::SCHEMA_V29.replace(
            "CHECK (author IS NULL OR author IN ('person', 'run', 'not_recorded'))",
            "",
        ))
        .unwrap();
        assert!(validate_v29(&conn).unwrap_err().contains("author IN"));
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_kill_at_every_wake_author_migration_boundary_keeps_the_wake() {
        for (suffix, expected) in [
            ("begun", 28),
            ("ddl", 28),
            ("validated", 28),
            ("committed", 29),
        ] {
            let dir = at_version_28_with_a_wake("runtime-wake-author-kill");
            let status = testutil::run_crash_scenario(
                "runtime::tests::crash_scenario_migrate",
                &format!("runtime-db-migration-29-{suffix}"),
                &dir,
            );
            assert!(!status.success());
            let conn = Connection::open(runtime_db_path(&dir)).unwrap();
            assert_eq!(user_version(&conn).unwrap(), expected);
            assert_eq!(
                conn.query_row("SELECT count(*) FROM agent_wakes", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(validate_v29(&conn).is_ok(), expected == 29);
            drop(conn);
            let conn = open(&dir).unwrap();
            validate_v29(&conn).unwrap();
            drop(conn);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_previous_version_database_gains_followups_and_keeps_its_rows() {
        let (dir, _) = at_version_with_a_run("runtime-followup-upgrade", 29);
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        assert!(validate_v30(&conn).is_err());
        drop(conn);
        let conn = open(&dir).unwrap();
        validate_v30(&conn).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM runs WHERE run_id='before-causes'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(user_version(&conn).unwrap(), USER_VERSION);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn validate_v30_refuses_followups_without_their_lifecycle_checks() {
        for clause in [
            "CHECK (state IN ('pending', 'claimed', 'fired', 'cancelled'))",
            "CHECK (cancel_reason IS NULL OR cancel_reason IN ('person', 'agent_gone', 'paused'))",
            "CHECK (state != 'claimed' OR claimed_at IS NOT NULL),",
            "CHECK ((state = 'fired') = (run_id IS NOT NULL)),",
            "CHECK ((state = 'cancelled') = (cancel_reason IS NOT NULL)),",
        ] {
            let (dir, _) = at_version_with_a_run("runtime-followup-validator", 29);
            let conn = Connection::open(runtime_db_path(&dir)).unwrap();
            conn.execute_batch(&schema::SCHEMA_V30.replace(clause, ""))
                .unwrap();
            assert!(validate_v30(&conn).is_err(), "{clause}");
            drop(conn);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_kill_at_every_followup_migration_boundary_keeps_existing_runs() {
        for (suffix, expected) in [
            ("begun", 29),
            ("ddl", 29),
            ("validated", 29),
            ("committed", 30),
        ] {
            let (dir, _) = at_version_with_a_run("runtime-followup-kill", 29);
            let status = testutil::run_crash_scenario(
                "runtime::tests::crash_scenario_migrate",
                &format!("runtime-db-migration-30-{suffix}"),
                &dir,
            );
            assert!(!status.success());
            let conn = Connection::open(runtime_db_path(&dir)).unwrap();
            assert_eq!(user_version(&conn).unwrap(), expected);
            assert_eq!(
                conn.query_row(
                    "SELECT count(*) FROM runs WHERE run_id='before-causes'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
            assert_eq!(validate_v30(&conn).is_ok(), expected == 30);
            drop(conn);
            let conn = open(&dir).unwrap();
            validate_v30(&conn).unwrap();
            drop(conn);
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
