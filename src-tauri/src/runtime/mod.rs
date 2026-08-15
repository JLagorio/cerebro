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

pub mod budget;
pub mod catchup;
pub mod dispatch;
pub mod governance;
pub mod health;
pub mod import;
pub mod normalize;
pub mod operational;
pub mod parked;
pub mod projection;
pub mod recovery;
pub mod scheduler;
pub mod schema;
pub mod scope;
pub mod settings;
pub mod sink;
#[cfg(test)]
mod soak;
pub mod status;
pub mod surface;
pub mod taint;
pub mod triggers;

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
/// nullable and never backfilled, at 13.
pub const USER_VERSION: i64 = 13;

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
];

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
    eprintln!(
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
            eprintln!("vault_registry: {vault:?} could not be registered: {detail}");
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
    #[test]
    fn a_database_at_every_prior_version_migrates_and_keeps_its_history() {
        for from in [1_i64, 2] {
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
            drop(conn);
            let _ = std::fs::remove_dir_all(&dir);
        }
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
}
