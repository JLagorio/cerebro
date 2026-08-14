//! Three faces of failure, and none of them silence (M25.6).
//!
//! Before this milestone a failed run was recorded `failed` and forgotten.
//! After it, every way the pipeline can stop has a record, a distinct
//! sentence, and a surface that says it. The three are deliberately NOT the
//! same thing, and collapsing them is a review-blocking defect (§86):
//!
//! 1. **Reasoning-runtime health.** The CLI hit its quota. Evidence exists
//!    and cannot currently be processed. Nothing about the world changed;
//!    what changed is our ability to look at it. → `runtime_health`, plus a
//!    window backoff and "N items unprocessed".
//! 2. **Source health.** A connector stopped answering. Reality may be
//!    changing unobserved. → `source_connection` / `source_health`, and past
//!    a threshold a portable `coverage.gap`.
//! 3. **Ingestion failure.** A file will not scan, parse, or extract. One
//!    item is broken; everything else is fine. → `ingestion_failures`, and
//!    "N items failed ingestion" — worded nothing like a quota death.
//!
//! **Connection and health are separate signals.** A connector that answers
//! but returns errors is connected and unhealthy; one that refuses TCP is
//! neither. A single "is it working" boolean cannot say which, and the
//! difference decides whether retrying is worth anything.

use chrono::{DateTime, Duration, Utc};
use rusqlite::Connection;

use crate::ledger::schema::Dimension;

/// The CLI's quota window. Backoff is keyed to it rather than to a duration,
/// so two failures inside one window do not stack into a longer pause than
/// the provider actually imposes.
pub const QUOTA_WINDOW_HOURS: i64 = 5;

/// How long a source may be blind before its blindness becomes epistemic.
///
/// A single retry never opens a gap. Three days unreachable does, because
/// "we have not observed this in three days" changes what the base can claim
/// to know — which is the exact D5 test for promoting an operational fact
/// into the ledger.
pub const BLINDNESS_THRESHOLD_HOURS: i64 = 24;

/// The one reasoning-runtime component this build has.
pub const COMPONENT_CLI: &str = "claude-cli";

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// --- Reasoning-runtime health ----------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeState {
    Healthy,
    Degraded,
    Unavailable,
    Unknown,
}

impl RuntimeState {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeState::Healthy => "healthy",
            RuntimeState::Degraded => "degraded",
            RuntimeState::Unavailable => "unavailable",
            RuntimeState::Unknown => "unknown",
        }
    }
}

pub fn set_runtime_health(
    conn: &Connection,
    component: &str,
    state: RuntimeState,
    detail: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    // `since` only moves when the STATE moves: "degraded since 09:00" is a
    // useful sentence, and re-stamping it on every probe would turn it into
    // "degraded since a moment ago", forever.
    conn.execute(
        "INSERT INTO runtime_health (component, state, since, detail) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT (component) DO UPDATE SET \
           since = CASE WHEN runtime_health.state = excluded.state \
                   THEN runtime_health.since ELSE excluded.since END, \
           state = excluded.state, \
           detail = excluded.detail",
        rusqlite::params![component, state.as_str(), stamp(now), detail],
    )
    .map_err(|e| format!("runtime_health: {e}"))?;
    Ok(())
}

pub fn runtime_health(
    conn: &Connection,
    component: &str,
) -> Result<Option<(RuntimeState, String, Option<String>)>, String> {
    let result = conn.query_row(
        "SELECT state, since, detail FROM runtime_health WHERE component = ?1",
        [component],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        },
    );
    match result {
        Ok((state, since, detail)) => Ok(Some((
            match state.as_str() {
                "healthy" => RuntimeState::Healthy,
                "degraded" => RuntimeState::Degraded,
                "unavailable" => RuntimeState::Unavailable,
                _ => RuntimeState::Unknown,
            },
            since,
            detail,
        ))),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("runtime_health: {e}")),
    }
}

/// The window key a quota failure at `now` belongs to.
///
/// Whole 5-hour buckets since the epoch. Two failures in one window write one
/// backoff row rather than two, so a burst of refusals does not multiply into
/// a pause the provider never imposed.
pub fn quota_window_key(now: DateTime<Utc>) -> String {
    let bucket = now.timestamp() / (QUOTA_WINDOW_HOURS * 3600);
    format!("q{bucket}")
}

/// What a quota death produced, so a caller can say it out loud.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotaOutcome {
    pub window_key: String,
    pub until: String,
    /// Items returned to `pending` by the finalization that preceded this —
    /// the "N unprocessed" a banner names.
    pub unprocessed: i64,
}

/// Record a quota death: window-keyed backoff for every lane, degraded
/// runtime health, and the count of work now waiting.
///
/// The backoff is GLOBAL (`vault_id IS NULL`) because the quota belongs to
/// the subscription, not to a folder. A second vault would otherwise walk
/// straight into the same wall and spend the retry.
pub fn record_quota_failure(
    conn: &Connection,
    store_uuid: &str,
    detail: &str,
    now: DateTime<Utc>,
) -> Result<QuotaOutcome, String> {
    let window_key = quota_window_key(now);
    let until = stamp(now + Duration::hours(QUOTA_WINDOW_HOURS));
    let lanes = super::settings::lanes_by_priority(conn)?;
    for lane in &lanes {
        conn.execute(
            "INSERT INTO backoff (vault_id, lane, until, reason, quota_window_key) \
             VALUES (NULL, ?1, ?2, 'quota', ?3) \
             ON CONFLICT (lane, quota_window_key) WHERE vault_id IS NULL \
             DO UPDATE SET until = excluded.until",
            rusqlite::params![lane, until, window_key],
        )
        .map_err(|e| format!("backoff: {e}"))?;
    }
    set_runtime_health(
        conn,
        COMPONENT_CLI,
        RuntimeState::Degraded,
        Some(detail),
        now,
    )?;
    let unprocessed: i64 = conn
        .query_row(
            "SELECT count(*) FROM scheduler WHERE store_uuid = ?1 AND state = 'pending'",
            [store_uuid],
            |row| row.get(0),
        )
        .map_err(|e| format!("scheduler: {e}"))?;
    Ok(QuotaOutcome {
        window_key,
        until,
        unprocessed,
    })
}

/// A run succeeded: the runtime is demonstrably working again.
pub fn record_runtime_recovery(conn: &Connection, now: DateTime<Utc>) -> Result<(), String> {
    set_runtime_health(conn, COMPONENT_CLI, RuntimeState::Healthy, None, now)
}

// --- Source connection and health ------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Connected,
    Disconnected,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceState {
    Healthy,
    Unhealthy,
    Unknown,
}

impl ConnectionState {
    pub fn as_str(self) -> &'static str {
        match self {
            ConnectionState::Connected => "connected",
            ConnectionState::Disconnected => "disconnected",
            ConnectionState::Unknown => "unknown",
        }
    }
}

impl SourceState {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceState::Healthy => "healthy",
            SourceState::Unhealthy => "unhealthy",
            SourceState::Unknown => "unknown",
        }
    }
}

/// What a probe learned. The two answers are recorded separately because
/// they are separate facts: a source can answer and be wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub connection: ConnectionState,
    /// `None` when the probe could not reach the source at all — health is
    /// then genuinely UNKNOWN rather than bad. Asserting "unhealthy" from a
    /// refused connection would be a claim the probe did not earn.
    pub health: Option<SourceState>,
    pub detail: Option<String>,
}

impl Probe {
    pub fn connected(health: SourceState) -> Probe {
        Probe {
            connection: ConnectionState::Connected,
            health: Some(health),
            detail: None,
        }
    }

    pub fn unreachable(detail: &str) -> Probe {
        Probe {
            connection: ConnectionState::Disconnected,
            health: None,
            detail: Some(detail.to_string()),
        }
    }
}

/// Record a probe against the two separate tables.
pub fn record_probe(
    conn: &Connection,
    store_uuid: &str,
    source_id: &str,
    probe: &Probe,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let stamped = stamp(now);
    conn.execute(
        "INSERT INTO source_connection (store_uuid, source_id, state, since, detail) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT (store_uuid, source_id) DO UPDATE SET \
           since = CASE WHEN source_connection.state = excluded.state \
                   THEN source_connection.since ELSE excluded.since END, \
           state = excluded.state, detail = excluded.detail",
        rusqlite::params![
            store_uuid,
            source_id,
            probe.connection.as_str(),
            stamped,
            probe.detail
        ],
    )
    .map_err(|e| format!("source_connection: {e}"))?;
    let health = probe.health.unwrap_or(SourceState::Unknown);
    conn.execute(
        "INSERT INTO source_health (store_uuid, source_id, state, since, detail) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT (store_uuid, source_id) DO UPDATE SET \
           since = CASE WHEN source_health.state = excluded.state \
                   THEN source_health.since ELSE excluded.since END, \
           state = excluded.state, detail = excluded.detail",
        rusqlite::params![
            store_uuid,
            source_id,
            health.as_str(),
            stamped,
            probe.detail
        ],
    )
    .map_err(|e| format!("source_health: {e}"))?;
    Ok(())
}

/// How long a source has been in its current connection state, and what it
/// is — the input to the blindness threshold.
pub fn connection_since(
    conn: &Connection,
    store_uuid: &str,
    source_id: &str,
) -> Result<Option<(ConnectionState, String)>, String> {
    let result = conn.query_row(
        "SELECT state, since FROM source_connection WHERE store_uuid = ?1 AND source_id = ?2",
        rusqlite::params![store_uuid, source_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    match result {
        Ok((state, since)) => Ok(Some((
            match state.as_str() {
                "connected" => ConnectionState::Connected,
                "disconnected" => ConnectionState::Disconnected,
                _ => ConnectionState::Unknown,
            },
            since,
        ))),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("source_connection: {e}")),
    }
}

/// Has this source been blind long enough for its blindness to be epistemic?
///
/// Returns the dimensions a gap would affect. Empty means "not yet" — and
/// "not yet" is the answer for the overwhelming majority of failures, which
/// is the point: a single retry must never reach the ledger.
pub fn blindness_gap_dimensions(
    conn: &Connection,
    store_uuid: &str,
    source_id: &str,
    now: DateTime<Utc>,
) -> Result<Vec<Dimension>, String> {
    let Some((state, since)) = connection_since(conn, store_uuid, source_id)? else {
        return Ok(Vec::new());
    };
    if state == ConnectionState::Connected {
        return Ok(Vec::new());
    }
    let Ok(since) = DateTime::parse_from_rfc3339(&since) else {
        return Ok(Vec::new());
    };
    if now - since.with_timezone(&Utc) < Duration::hours(BLINDNESS_THRESHOLD_HOURS) {
        return Ok(Vec::new());
    }
    // A source that has not answered in a day cannot be said to be healthy,
    // and nothing it might hold has been retrieved. Scope and retention are
    // NOT listed: what we knew about them yesterday is still what we know.
    Ok(vec![
        Dimension::SourceConnected,
        Dimension::SourceHealthy,
        Dimension::RetrievalAttempted,
    ])
}

// --- Ingestion failures ----------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Scan,
    Parse,
    Extraction,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Scan => "scan",
            Stage::Parse => "parse",
            Stage::Extraction => "extraction",
        }
    }
}

/// Record one item's ingestion failure. Visible-and-skipped: the item is
/// named, the rest of the vault proceeds, and nothing is silently dropped.
///
/// `first_seen` is preserved across repeats so a file that has been broken
/// for a week says so, rather than looking newly broken on every scan.
pub fn record_ingestion_failure(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    item_key: &str,
    stage: Stage,
    detail: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ingestion_failures \
         (vault_id, store_uuid, item_key, stage, detail, first_seen, last_seen, resolved_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL) \
         ON CONFLICT (vault_id, store_uuid, item_key, stage) DO UPDATE SET \
           detail = excluded.detail, last_seen = excluded.last_seen, resolved_at = NULL",
        rusqlite::params![
            vault_id,
            store_uuid,
            item_key,
            stage.as_str(),
            detail,
            stamp(now)
        ],
    )
    .map_err(|e| format!("ingestion_failures: {e}"))?;
    Ok(())
}

/// The item scanned cleanly this time. Resolved rather than deleted: "this
/// used to fail and stopped" is worth being able to see.
pub fn resolve_ingestion_failure(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    item_key: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE ingestion_failures SET resolved_at = ?4 \
         WHERE vault_id = ?1 AND store_uuid = ?2 AND item_key = ?3 AND resolved_at IS NULL",
        rusqlite::params![vault_id, store_uuid, item_key, stamp(now)],
    )
    .map_err(|e| format!("ingestion_failures: {e}"))?;
    Ok(())
}

/// How many items are currently failing ingestion — the "N items failed
/// ingestion" a banner names, worded nothing like a quota death.
pub fn failing_items(conn: &Connection, vault_id: &str, store_uuid: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT count(DISTINCT item_key) FROM ingestion_failures \
         WHERE vault_id = ?1 AND store_uuid = ?2 AND resolved_at IS NULL",
        rusqlite::params![vault_id, store_uuid],
        |row| row.get(0),
    )
    .map_err(|e| format!("ingestion_failures: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
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
        (dir, conn, vault)
    }

    fn register_source(conn: &Connection, store: &str, source: &str) {
        conn.execute(
            "INSERT INTO source_registration (store_uuid, source_id, registration_event_id, \
             kind, source_key, authority_capability) \
             VALUES (?1, ?2, ?3, 'connector', 'connector:x', 'direct_system_artifact')",
            rusqlite::params![store, source, "e".repeat(32)],
        )
        .unwrap();
    }

    #[test]
    fn a_quota_death_backs_off_every_lane_globally_and_names_what_is_waiting() {
        // The backoff is GLOBAL: the quota belongs to the subscription, so a
        // second vault must not walk into the same wall and spend the retry.
        let (dir, conn, vault) = fixture("health-quota");
        for key in ["a.md", "b.md"] {
            crate::runtime::scheduler::put(
                &conn,
                &vault,
                "store",
                &crate::runtime::scheduler::Row {
                    item_key: key.into(),
                    source_id: None,
                    content_hash: "a".repeat(64),
                    snapshot: crate::runtime::normalize::snapshot(
                        &crate::vault::entry::Entry::empty_for_test(key),
                    ),
                    event_cursor: None,
                    route: None,
                    state: crate::runtime::scheduler::SchedulerState::Pending,
                },
            )
            .unwrap();
        }
        let now = at("2026-08-09T10:00:00Z");
        let outcome = record_quota_failure(&conn, "store", "usage limit reached", now).unwrap();
        assert_eq!(outcome.unprocessed, 2, "N items unprocessed");
        assert_eq!(outcome.until, "2026-08-09T15:00:00.000Z");

        let rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM backoff WHERE vault_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 7, "one per registered lane, all global");

        let (state, _, detail) = runtime_health(&conn, COMPONENT_CLI).unwrap().unwrap();
        assert_eq!(state, RuntimeState::Degraded);
        assert_eq!(detail.as_deref(), Some("usage limit reached"));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_failures_in_one_window_are_one_backoff_not_two() {
        let (dir, conn, _) = fixture("health-window");
        record_quota_failure(&conn, "store", "limit", at("2026-08-09T10:00:00Z")).unwrap();
        record_quota_failure(&conn, "store", "limit", at("2026-08-09T11:00:00Z")).unwrap();
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM backoff", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 7, "still one per lane — the window is the key");

        // A LATER window is a different key and a new row.
        record_quota_failure(&conn, "store", "limit", at("2026-08-09T20:00:00Z")).unwrap();
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM backoff", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 14);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn runtime_health_since_moves_only_when_the_state_does() {
        // "degraded since 09:00" is useful; re-stamping on every probe would
        // make it "degraded since a moment ago", forever.
        let (dir, conn, _) = fixture("health-since");
        set_runtime_health(
            &conn,
            COMPONENT_CLI,
            RuntimeState::Degraded,
            None,
            at("2026-08-09T09:00:00Z"),
        )
        .unwrap();
        set_runtime_health(
            &conn,
            COMPONENT_CLI,
            RuntimeState::Degraded,
            None,
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap();
        let (_, since, _) = runtime_health(&conn, COMPONENT_CLI).unwrap().unwrap();
        assert_eq!(since, "2026-08-09T09:00:00.000Z");

        record_runtime_recovery(&conn, at("2026-08-09T11:00:00Z")).unwrap();
        let (state, since, _) = runtime_health(&conn, COMPONENT_CLI).unwrap().unwrap();
        assert_eq!(state, RuntimeState::Healthy);
        assert_eq!(since, "2026-08-09T11:00:00.000Z");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_source_that_refuses_the_connection_has_unknown_health_not_bad_health() {
        // The probe never reached it. Asserting "unhealthy" would be a claim
        // the probe did not earn.
        let (dir, conn, _) = fixture("health-probe");
        let source = "a".repeat(32);
        register_source(&conn, "store", &source);
        record_probe(
            &conn,
            "store",
            &source,
            &Probe::unreachable("connection refused"),
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap();
        let (connection, _) = connection_since(&conn, "store", &source).unwrap().unwrap();
        assert_eq!(connection, ConnectionState::Disconnected);
        let health: String = conn
            .query_row("SELECT state FROM source_health", [], |r| r.get(0))
            .unwrap();
        assert_eq!(health, "unknown");

        // Connected but erroring: connected AND unhealthy, which one boolean
        // could not have said.
        record_probe(
            &conn,
            "store",
            &source,
            &Probe::connected(SourceState::Unhealthy),
            at("2026-08-09T11:00:00Z"),
        )
        .unwrap();
        let (connection, _) = connection_since(&conn, "store", &source).unwrap().unwrap();
        assert_eq!(connection, ConnectionState::Connected);
        let health: String = conn
            .query_row("SELECT state FROM source_health", [], |r| r.get(0))
            .unwrap();
        assert_eq!(health, "unhealthy");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_single_retry_never_reaches_the_ledger_and_a_day_of_silence_does() {
        let (dir, conn, _) = fixture("health-threshold");
        let source = "a".repeat(32);
        register_source(&conn, "store", &source);
        let down = at("2026-08-09T10:00:00Z");
        record_probe(&conn, "store", &source, &Probe::unreachable("gone"), down).unwrap();

        assert!(
            blindness_gap_dimensions(&conn, "store", &source, at("2026-08-09T11:00:00Z"))
                .unwrap()
                .is_empty(),
            "an hour is a retry, not an epistemic event"
        );
        let dimensions =
            blindness_gap_dimensions(&conn, "store", &source, at("2026-08-10T11:00:00Z")).unwrap();
        assert_eq!(
            dimensions,
            vec![
                Dimension::SourceConnected,
                Dimension::SourceHealthy,
                Dimension::RetrievalAttempted
            ],
            "and scope and retention are NOT affected — what we knew yesterday, we still know"
        );

        // Reconnecting clears it.
        record_probe(
            &conn,
            "store",
            &source,
            &Probe::connected(SourceState::Healthy),
            at("2026-08-10T12:00:00Z"),
        )
        .unwrap();
        assert!(
            blindness_gap_dimensions(&conn, "store", &source, at("2026-08-11T12:00:00Z"))
                .unwrap()
                .is_empty()
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_file_is_named_kept_and_eventually_resolved() {
        let (dir, conn, vault) = fixture("health-ingestion");
        record_ingestion_failure(
            &conn,
            &vault,
            "store",
            "records/broken.md",
            Stage::Parse,
            "unclosed frontmatter",
            at("2026-08-01T10:00:00Z"),
        )
        .unwrap();
        record_ingestion_failure(
            &conn,
            &vault,
            "store",
            "records/broken.md",
            Stage::Parse,
            "unclosed frontmatter",
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(failing_items(&conn, &vault, "store").unwrap(), 1);
        let (first, last): (String, String) = conn
            .query_row(
                "SELECT first_seen, last_seen FROM ingestion_failures",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            first, "2026-08-01T10:00:00.000Z",
            "a file broken for a week says so"
        );
        assert_eq!(last, "2026-08-09T10:00:00.000Z");

        resolve_ingestion_failure(
            &conn,
            &vault,
            "store",
            "records/broken.md",
            at("2026-08-10T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(failing_items(&conn, &vault, "store").unwrap(), 0);
        let kept: i64 = conn
            .query_row("SELECT count(*) FROM ingestion_failures", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "resolved, not deleted");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_three_faces_of_failure_are_three_different_tables() {
        // §86, mechanized: a quota death, a dead connector, and a broken file
        // land in three places and can be told apart by a reader who was not
        // there when it happened.
        let (dir, conn, vault) = fixture("health-three-faces");
        let source = "a".repeat(32);
        register_source(&conn, "store", &source);
        let now = at("2026-08-09T10:00:00Z");
        record_quota_failure(&conn, "store", "usage limit", now).unwrap();
        record_probe(&conn, "store", &source, &Probe::unreachable("gone"), now).unwrap();
        record_ingestion_failure(
            &conn,
            &vault,
            "store",
            "a.md",
            Stage::Scan,
            "unreadable",
            now,
        )
        .unwrap();

        for (table, expected) in [
            ("runtime_health", 1),
            ("source_connection", 1),
            ("ingestion_failures", 1),
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, expected, "{table}");
        }
        // And the runtime failure did NOT touch source health.
        let health: String = conn
            .query_row("SELECT state FROM source_health", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            health, "unknown",
            "a dead CLI quota says nothing about whether the source is healthy"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
