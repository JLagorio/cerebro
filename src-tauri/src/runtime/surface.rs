//! The control surface's read model (M25.7).
//!
//! One query, one shape. The panel needs the pause, the meter, the lanes,
//! recent activity, and every banner in one render — and building that from
//! six round trips would let the surface show a paused pipeline next to a
//! budget that was read a second earlier.
//!
//! **This is a projection and never an authority.** Every number here is
//! recomputed from `runtime.db` on each call; nothing caches, and nothing the
//! UI does is decided by what it last saw. The one place that matters is the
//! pause: the surface reads it, and the DISPATCHER reads it again inside its
//! own transaction, so a pause toggled between render and dispatch still
//! stops the dispatch.
//!
//! **"Activity log", never "ledger".** The word ledger is reserved for the
//! epistemic record in the vault. A list of runs and their token counts is
//! operational, and calling it a ledger would blur the one distinction this
//! whole milestone is built on.

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::Serialize;

use super::budget;
use super::health;
use super::scheduler::SchedulerState;

/// The global budget meter — today's ambient spend across EVERY vault
/// against one subscription's ceiling.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Meter {
    pub window_start_utc: String,
    pub window_end_utc: String,
    pub timezone_id: String,
    pub ceiling_state: String,
    pub ceiling_reasons: Vec<String>,
    /// `exact` or `unknown`. A day whose spend was lost is not a day with
    /// budget left, and the meter says which it is rather than showing a
    /// confident zero.
    pub accounting_state: String,
    pub runs_started: u64,
    pub max_daily_runs: u64,
    pub tokens_used: u64,
    pub max_daily_tokens: u64,
    pub output_tokens_used: u64,
    pub max_daily_output_tokens: u64,
    pub reserved_total_tokens: u64,
    pub reserved_output_tokens: u64,
}

/// One lane and whether it may run in this vault.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Lane {
    pub lane: String,
    pub priority: u64,
    pub enabled: bool,
}

/// One row of the Activity log: run → tokens → proposals → applied/rejected.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Activity {
    pub run_id: String,
    pub vault_id: Option<String>,
    pub mode: String,
    pub lane: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub outcome: String,
    pub usage_state: String,
    pub total_tokens: u64,
    pub output_tokens: u64,
    pub proposals_submitted: u64,
    pub applied: u64,
    pub rejected: u64,
}

/// A banner. `kind` decides the copy, and the three kinds are the three
/// faces of failure — the surface must not merge them into "something went
/// wrong".
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Banner {
    pub kind: String,
    pub detail: String,
    pub count: i64,
}

/// Work waiting for an owner decision, and which question it is waiting on.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Held {
    pub baseline_held: i64,
    pub recovery_held: i64,
    pub pending_review: i64,
    pub pending: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Overview {
    /// Subscription-wide. Persisted, so it survives a restart.
    pub global_pause: bool,
    /// Why the process itself is holding back, when it is: a failed
    /// migration or an unresolved recovery. Separate from the owner's pause
    /// because they are answered by different actions.
    pub runtime_status: String,
    pub meter: Meter,
    pub lanes: Vec<Lane>,
    pub activity: Vec<Activity>,
    pub banners: Vec<Banner>,
    pub held: Held,
}

/// How many rows of activity a panel asks for. Enough to see a day's shape,
/// small enough that the query is not a scan.
const ACTIVITY_LIMIT: usize = 50;

/// Where the scheduler holds one item, and which route put it there.
///
/// Serialized in snake_case like every other surface type, so the renderer
/// reads the same spellings the database stores rather than a second
/// vocabulary that could drift from it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ItemState {
    pub state: String,
    /// `None` until the deterministic pass has assessed the item.
    pub route: Option<String>,
}

/// One item's scheduler row, or `None` when the scheduler has never seen it.
///
/// `None` is a real answer — an unscanned vault, or ambient ingest that has
/// never been turned on — and the caller renders it as "not queued". An
/// error would say the question could not be answered, which is a different
/// thing and would put a broken banner on a working knowledge panel.
pub fn item_state(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    item_key: &str,
) -> Result<Option<ItemState>, String> {
    Ok(
        super::scheduler::get(conn, vault_id, store_uuid, item_key)?.map(|row| ItemState {
            state: row.state.as_str().to_string(),
            route: row.route,
        }),
    )
}

pub fn overview(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    now: DateTime<Utc>,
) -> Result<Overview, String> {
    let day = budget::ensure_day(conn, now)?;
    let (ceiling_state, ceiling_reasons) = day.ceiling_state();
    let meter = Meter {
        window_start_utc: day.window_start_utc.clone(),
        window_end_utc: day.window_end_utc.clone(),
        timezone_id: day.timezone_id.clone(),
        ceiling_state: ceiling_state.to_string(),
        ceiling_reasons: ceiling_reasons
            .iter()
            .map(|r| r.as_str().to_string())
            .collect(),
        accounting_state: if day.accounting_exact {
            "exact"
        } else {
            "unknown"
        }
        .to_string(),
        runs_started: day.ambient_runs_started,
        max_daily_runs: day.ceilings.max_daily_runs,
        tokens_used: day.ambient_tokens_used,
        max_daily_tokens: day.ceilings.max_daily_tokens,
        output_tokens_used: day.ambient_output_tokens,
        max_daily_output_tokens: day.ceilings.max_daily_output_tokens,
        reserved_total_tokens: day.reserved_total_tokens,
        reserved_output_tokens: day.reserved_output_tokens,
    };

    let mut lanes = Vec::new();
    for (priority, lane) in super::settings::lanes_by_priority(conn)?
        .into_iter()
        .enumerate()
    {
        let enabled = super::settings::lane_enabled(conn, vault_id, &lane)?;
        lanes.push(Lane {
            lane,
            priority: priority as u64,
            enabled,
        });
    }

    Ok(Overview {
        global_pause: super::settings::global_pause(conn),
        runtime_status: super::status::current().code().to_string(),
        meter,
        lanes,
        activity: activity(conn, None)?,
        banners: banners(conn, vault_id, store_uuid, &day)?,
        held: held(conn, vault_id, store_uuid)?,
    })
}

/// Recent runs, newest first. `vault_id: None` is every vault — the log is
/// filterable, and the unfiltered view is the honest default for a meter
/// that sums across vaults.
pub fn activity(conn: &Connection, vault_id: Option<&str>) -> Result<Vec<Activity>, String> {
    let sql = format!(
        "SELECT run_id, vault_id, mode, lane, started_at, ended_at, outcome, usage_state, \
         input_tokens, output_tokens, cache_read, cache_write, proposals_submitted, applied, \
         rejected FROM runs {} ORDER BY started_at DESC, run_id DESC LIMIT {ACTIVITY_LIMIT}",
        if vault_id.is_some() {
            "WHERE vault_id = ?1"
        } else {
            ""
        }
    );
    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Activity> {
        let input: i64 = row.get(8)?;
        let output: i64 = row.get(9)?;
        let cache_read: i64 = row.get(10)?;
        let cache_write: i64 = row.get(11)?;
        Ok(Activity {
            run_id: row.get(0)?,
            vault_id: row.get(1)?,
            mode: row.get(2)?,
            lane: row.get(3)?,
            started_at: row.get(4)?,
            ended_at: row.get(5)?,
            outcome: row.get(6)?,
            usage_state: row.get(7)?,
            total_tokens: (input + output + cache_read + cache_write) as u64,
            output_tokens: output as u64,
            proposals_submitted: row.get::<_, i64>(12)? as u64,
            applied: row.get::<_, i64>(13)? as u64,
            rejected: row.get::<_, i64>(14)? as u64,
        })
    };
    let rows = match vault_id {
        Some(vault) => statement.query_map([vault], map),
        None => statement.query_map([], map),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Every banner the surface should show, in the order it should show them.
///
/// Distinct kinds on purpose: a person who sees "quota" knows to wait, and a
/// person who sees "ingestion" knows to fix a file. One merged banner would
/// tell them neither.
fn banners(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    day: &budget::Day,
) -> Result<Vec<Banner>, String> {
    let mut banners = Vec::new();
    if let Some((state, since, detail)) = health::runtime_health(conn, health::COMPONENT_CLI)? {
        if state != health::RuntimeState::Healthy {
            let unprocessed: i64 = conn
                .query_row(
                    "SELECT count(*) FROM scheduler WHERE store_uuid = ?1 AND state = 'pending'",
                    [store_uuid],
                    |row| row.get(0),
                )
                .map_err(|e| format!("scheduler: {e}"))?;
            banners.push(Banner {
                kind: "runtime_health".into(),
                detail: detail.unwrap_or_else(|| format!("{} since {since}", state.as_str())),
                count: unprocessed,
            });
        }
    }
    let unhealthy: i64 = conn
        .query_row(
            "SELECT count(*) FROM source_connection \
             WHERE store_uuid = ?1 AND state = 'disconnected'",
            [store_uuid],
            |row| row.get(0),
        )
        .map_err(|e| format!("source_connection: {e}"))?;
    if unhealthy > 0 {
        banners.push(Banner {
            kind: "source_health".into(),
            detail: "a source is not answering — reality may be changing unobserved".into(),
            count: unhealthy,
        });
    }
    let failing = health::failing_items(conn, vault_id, store_uuid)?;
    if failing > 0 {
        banners.push(Banner {
            kind: "ingestion".into(),
            detail: "items could not be read — they are skipped, not lost".into(),
            count: failing,
        });
    }
    if !day.accounting_exact {
        banners.push(Banner {
            kind: "accounting_unknown".into(),
            detail: "today's spend could not be counted — ambient work is paused until the next \
                     day opens or you set a baseline"
                .into(),
            count: 0,
        });
    }
    Ok(banners)
}

fn held(conn: &Connection, vault_id: &str, store_uuid: &str) -> Result<Held, String> {
    let counts = super::scheduler::counts_by_state(conn, vault_id, store_uuid)?;
    let of = |name: &str| {
        counts
            .iter()
            .find(|(state, _)| state == name)
            .map(|(_, count)| *count)
            .unwrap_or(0)
    };
    Ok(Held {
        baseline_held: of(SchedulerState::BaselineHeld.as_str()),
        recovery_held: of(SchedulerState::RecoveryHeld.as_str()),
        pending_review: of(SchedulerState::PendingReview.as_str()),
        pending: of(SchedulerState::Pending.as_str()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::scheduler::{self, Row};
    use crate::vault::testutil;

    fn at(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        budget::append_version(
            &conn,
            &budget::Settings {
                ceilings: budget::shipped_defaults().unwrap(),
                timezone_id: "UTC".into(),
            },
            at("2026-08-09T00:30:00Z"),
        )
        .unwrap();
        (dir, conn, vault)
    }

    fn seed(conn: &Connection, vault: &str, key: &str, state: SchedulerState) {
        scheduler::put(
            conn,
            vault,
            "store",
            &Row {
                item_key: key.into(),
                source_id: None,
                content_hash: "a".repeat(64),
                snapshot: crate::runtime::normalize::snapshot(
                    &crate::vault::entry::Entry::empty_for_test(key),
                ),
                event_cursor: None,
                route: None,
                state,
            },
        )
        .unwrap();
    }

    #[test]
    fn a_quiet_day_shows_a_pause_off_an_empty_meter_and_no_banners() {
        let (dir, conn, vault) = fixture("surface-quiet");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let view = overview(&conn, &vault, "store", at("2026-08-09T10:00:00Z")).unwrap();
        assert!(!view.global_pause);
        assert_eq!(view.runtime_status, "ready");
        assert_eq!(view.meter.ceiling_state, "under_budget");
        assert_eq!(view.meter.accounting_state, "exact");
        assert_eq!(view.meter.max_daily_runs, 20);
        assert_eq!(view.lanes.len(), 7);
        assert!(view.lanes.iter().all(|l| l.enabled));
        assert!(view.banners.is_empty());
        assert!(view.activity.is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_three_faces_of_failure_are_three_banners_and_never_one() {
        // A person who sees "quota" knows to wait; a person who sees
        // "ingestion" knows to fix a file. Merging them would tell them
        // neither.
        let (dir, conn, vault) = fixture("surface-banners");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let now = at("2026-08-09T10:00:00Z");
        seed(&conn, &vault, "a.md", SchedulerState::Pending);
        health::record_quota_failure(&conn, "store", "usage limit reached", now).unwrap();
        conn.execute(
            "INSERT INTO source_registration (store_uuid, source_id, registration_event_id, \
             kind, source_key, authority_capability) \
             VALUES ('store', ?1, ?2, 'connector', 'connector:x', 'direct_system_artifact')",
            rusqlite::params!["a".repeat(32), "e".repeat(32)],
        )
        .unwrap();
        health::record_probe(
            &conn,
            "store",
            &"a".repeat(32),
            &health::Probe::unreachable("gone"),
            now,
        )
        .unwrap();
        health::record_ingestion_failure(
            &conn,
            &vault,
            "store",
            "broken.md",
            health::Stage::Parse,
            "unclosed frontmatter",
            now,
        )
        .unwrap();

        let view = overview(&conn, &vault, "store", now).unwrap();
        let kinds: Vec<&str> = view.banners.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["runtime_health", "source_health", "ingestion"]);
        assert_eq!(view.banners[0].count, 1, "N items unprocessed");
        assert_eq!(view.banners[2].count, 1, "N items failed ingestion");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_meter_sums_across_vaults_and_the_activity_log_can_be_filtered() {
        // One subscription, one ceiling — but "which vault spent it" is a
        // question the log has to be able to answer.
        let (dir, conn, vault_a) = fixture("surface-two-vaults");
        let other = testutil::temp_vault("surface-two-vaults-b");
        let vault_b = crate::runtime::scope::register(&conn, &other).unwrap();
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let now = at("2026-08-09T10:00:00Z");
        for (n, vault) in [(1, &vault_a), (2, &vault_b)] {
            conn.execute(
                "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, \
                 ended_at, outcome, usage_state, input_tokens, output_tokens, cache_read, \
                 cache_write, reserved_total_tokens, reserved_output_tokens, \
                 proposals_submitted, applied, rejected) \
                 VALUES (?1, ?2, 'store', 'ambient', 'filed', ?3, ?3, 'succeeded', 'exact', \
                 1, 10, 100, 0, 0, 0, 2, 1, 1)",
                rusqlite::params![
                    format!("run-{n}"),
                    vault,
                    format!("2026-08-09T1{n}:00:00.000Z")
                ],
            )
            .unwrap();
        }
        let window = budget::ensure_day(&conn, now).unwrap().window_start_utc;
        conn.execute(
            "UPDATE budget_days SET ambient_tokens_used = 222, ambient_output_tokens = 20, \
             ambient_runs_started = 2 WHERE window_start_utc = ?1",
            [&window],
        )
        .unwrap();

        let view = overview(&conn, &vault_a, "store", now).unwrap();
        assert_eq!(view.meter.tokens_used, 222, "one ceiling, both vaults");
        assert_eq!(view.meter.runs_started, 2);
        assert_eq!(view.activity.len(), 2, "unfiltered by default");
        assert_eq!(view.activity[0].run_id, "run-2", "newest first");
        assert_eq!(view.activity[0].total_tokens, 111);
        assert_eq!(view.activity[0].applied, 1);

        let filtered = activity(&conn, Some(&vault_a)).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].run_id, "run-1");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn held_work_is_counted_by_the_question_it_is_waiting_on() {
        let (dir, conn, vault) = fixture("surface-held");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        seed(&conn, &vault, "a.md", SchedulerState::BaselineHeld);
        seed(&conn, &vault, "b.md", SchedulerState::BaselineHeld);
        seed(&conn, &vault, "c.md", SchedulerState::RecoveryHeld);
        seed(&conn, &vault, "d.md", SchedulerState::PendingReview);
        seed(&conn, &vault, "e.md", SchedulerState::Pending);
        let view = overview(&conn, &vault, "store", at("2026-08-09T10:00:00Z")).unwrap();
        assert_eq!(view.held.baseline_held, 2);
        assert_eq!(view.held.recovery_held, 1);
        assert_eq!(view.held.pending_review, 1);
        assert_eq!(view.held.pending, 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unaccounted_day_says_so_rather_than_showing_a_confident_zero() {
        let (dir, conn, vault) = fixture("surface-unknown");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let now = at("2026-08-09T10:00:00Z");
        let window = budget::ensure_day(&conn, now).unwrap().window_start_utc;
        budget::mark_accounting_unknown(&conn, &window).unwrap();
        let view = overview(&conn, &vault, "store", now).unwrap();
        assert_eq!(view.meter.accounting_state, "unknown");
        assert!(view.banners.iter().any(|b| b.kind == "accounting_unknown"));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pause_and_the_lane_toggles_round_trip() {
        let (dir, conn, vault) = fixture("surface-toggles");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        super::super::settings::set_global_pause(&conn, true).unwrap();
        super::super::settings::set_lane_enabled(&conn, &vault, "stale", false).unwrap();
        let view = overview(&conn, &vault, "store", at("2026-08-09T10:00:00Z")).unwrap();
        assert!(view.global_pause);
        let stale = view.lanes.iter().find(|l| l.lane == "stale").unwrap();
        assert!(!stale.enabled);
        assert_eq!(stale.priority, 5);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
