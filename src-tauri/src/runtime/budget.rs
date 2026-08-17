//! The global daily ambient budget (M25.2).
//!
//! This app runs on **the owner's personal Claude CLI subscription**. There
//! is no API key and no organizational quota: every ambient run competes with
//! the owner's own chat. So the budget is global — one account, one daily
//! ceiling, summed across every vault the app has open — while everything
//! else in the runtime DB is vault-scoped.
//!
//! ## Three rules that shape the whole module
//!
//! **Attended chat is metered, never gated.** Nothing in here is reachable
//! from the chat panel. A person asking a question at 11pm on an exhausted
//! day gets an answer; only the background gets stopped.
//!
//! **A day owns its ceilings.** `budget_days` COPIES the effective settings
//! rather than referencing them, and pins the version and digest it copied.
//! An edit tomorrow cannot reinterpret what a gate decided this morning, and
//! a change-and-revert leaves two immutable versions behind so an M28
//! observation window can see that it happened.
//!
//! **Edits take effect at the next window, never immediately.** An edit that
//! applied at once would let the ceiling be raised after the spending, and
//! every refusal earlier that day would have been evaluated against a rule
//! that no longer exists.
//!
//! ## Degradation is one formula, not a second vocabulary
//!
//! The design says lanes shed lowest-priority-first at warning, and that
//! everything ambient halts at exhaustion. Rather than add a `lane_degraded`
//! reason — which would say *that* a lane shed without saying which pressure
//! shed it — each lane gets a shed threshold interpolated from its registry
//! priority: the lowest-priority lane sheds at `warning_ppm`, the highest at
//! 1,000,000. Exhaustion is then just the top of the same ramp, and the
//! refusal names the DIMENSION that is filling (`daily_tokens`,
//! `daily_output_tokens`, `daily_runs`) — which is the thing a person can
//! actually act on.

use std::str::FromStr;

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::Connection;

use crate::ledger::sha256_hex;

use super::settings;

/// The shipped v1 ceilings, compiled in from `shared/runtime/`.
const DEFAULTS_JSON: &str = include_str!("../../../shared/runtime/budget-defaults.v1.json");
const DEFAULTS_DIGEST: &str = include_str!("../../../shared/runtime/budget-defaults.v1.sha256");

/// The eight owner-editable ambient limits.
///
/// Field order is the canonical order: [`Ceilings::digest`] hashes serde's
/// bytes, so reordering these fields is a format change, not a refactor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ceilings {
    pub max_daily_runs: u64,
    pub max_daily_tokens: u64,
    pub max_daily_output_tokens: u64,
    pub max_ambient_run_tokens: u64,
    pub max_ambient_run_output_tokens: u64,
    pub max_consecutive_failures: u64,
    pub max_run_elapsed_seconds: u64,
    /// Parts per million of a ceiling at which the day is in `warning` and
    /// the lowest-priority lane sheds. 800,000 = 80%.
    pub warning_ppm: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Settings {
    pub ceilings: Ceilings,
    /// IANA zone id. The day is a LOCAL day; without the zone the boundary
    /// would be an arbitrary UTC midnight in somebody else's afternoon.
    pub timezone_id: String,
}

impl Settings {
    /// SHA-256 over canonical JSON. Pinned by every `budget_days` row and
    /// every gate decision, so "which rule was this decided under" survives
    /// any later edit.
    pub fn digest(&self) -> Result<String, String> {
        let canonical = serde_json::to_string(self).map_err(|e| e.to_string())?;
        Ok(sha256_hex(canonical.as_bytes()))
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DefaultsArtifact {
    format: u64,
    artifact_version: u64,
    defaults: Ceilings,
}

/// The shipped defaults, with the artifact's bytes checked against the
/// committed digest.
///
/// The digest is not ceremony: these numbers decide what the app is allowed
/// to spend, and an accidental reflow or a merge that dropped a zero would
/// otherwise be invisible until the bill arrived.
pub fn shipped_defaults() -> Result<Ceilings, String> {
    let expected = DEFAULTS_DIGEST.trim();
    let actual = sha256_hex(DEFAULTS_JSON.as_bytes());
    if actual != expected {
        return Err(format!(
            "shared/runtime/budget-defaults.v1.json hashes to {actual}, and the committed \
             digest says {expected} — regenerate the digest deliberately, or find out who \
             changed the ceilings"
        ));
    }
    let artifact: DefaultsArtifact =
        serde_json::from_str(DEFAULTS_JSON).map_err(|e| format!("budget defaults: {e}"))?;
    if artifact.format != 1 || artifact.artifact_version != 1 {
        return Err(format!(
            "budget defaults artifact is format {} version {}, this build speaks 1/1",
            artifact.format, artifact.artifact_version
        ));
    }
    Ok(artifact.defaults)
}

/// This machine's IANA zone, or UTC when the system will not say.
///
/// Captured ONCE, into the first settings version, and never re-read: a
/// laptop that crosses a timezone should not silently redefine what "today"
/// meant for the days already recorded.
pub fn system_timezone() -> String {
    iana_time_zone::get_timezone()
        .ok()
        .filter(|id| Tz::from_str(id).is_ok())
        .unwrap_or_else(|| "UTC".to_string())
}

fn zone(timezone_id: &str) -> Result<Tz, String> {
    Tz::from_str(timezone_id).map_err(|_| {
        format!(
            "budget timezone {timezone_id:?} is not an IANA zone this build knows — the day \
             boundary is unresolvable, so ambient work waits rather than guessing"
        )
    })
}

/// UTC instant of local midnight starting `date` in `tz`.
///
/// Both DST shapes are handled honestly. An AMBIGUOUS midnight (the clock
/// repeats) takes the earlier instant, so the day is 25 hours long. A
/// NONEXISTENT midnight (the clock jumps over it, which really happens —
/// Santiago, Havana, Beirut) takes the first minute that does exist, so the
/// day is 23 hours long. Neither is rounded to a convenient 24.
fn local_midnight_utc(tz: Tz, date: NaiveDate) -> Result<DateTime<Utc>, String> {
    for minute in 0..24 * 60 {
        let naive = date
            .and_hms_opt(minute / 60, minute % 60, 0)
            .ok_or("impossible local time")?;
        match tz.from_local_datetime(&naive) {
            chrono::LocalResult::Single(at) => return Ok(at.with_timezone(&Utc)),
            chrono::LocalResult::Ambiguous(earlier, _) => return Ok(earlier.with_timezone(&Utc)),
            chrono::LocalResult::None => continue,
        }
    }
    Err(format!("no local time exists on {date} in {tz}"))
}

/// The half-open local-day window containing `at`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub start_utc: String,
    pub end_utc: String,
    pub timezone_id: String,
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
fn parse_stamp(raw: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(raw)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|e| format!("{raw:?} is not an RFC3339 instant: {e}"))
}

/// Compute the window containing `at` under `timezone_id`.
pub fn window_containing(timezone_id: &str, at: DateTime<Utc>) -> Result<Window, String> {
    let tz = zone(timezone_id)?;
    let mut date = at.with_timezone(&tz).date_naive();
    // The local date usually IS the window, but a boundary that shifted can
    // put `at` one side of it; step at most once either way rather than
    // trusting the arithmetic.
    for _ in 0..3 {
        let start = local_midnight_utc(tz, date)?;
        let next = date.succ_opt().ok_or("date overflow")?;
        let end = local_midnight_utc(tz, next)?;
        if at < start {
            date = date.pred_opt().ok_or("date underflow")?;
            continue;
        }
        if at >= end {
            date = next;
            continue;
        }
        return Ok(Window {
            start_utc: stamp(start),
            end_utc: stamp(end),
            timezone_id: timezone_id.to_string(),
        });
    }
    Err(format!(
        "could not place {} in a local day of {timezone_id}",
        stamp(at)
    ))
}

/// The window AFTER the one containing `at` — when an edit made now becomes
/// effective.
pub fn next_window_start(timezone_id: &str, at: DateTime<Utc>) -> Result<String, String> {
    Ok(window_containing(timezone_id, at)?.end_utc)
}

// --- Settings versions ------------------------------------------------------

/// One immutable settings version as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub settings_version: u64,
    pub settings_digest: String,
    pub recorded_at: String,
    pub effective_window_start_utc: String,
    pub settings: Settings,
}

fn read_version(row: &rusqlite::Row<'_>) -> rusqlite::Result<Version> {
    Ok(Version {
        settings_version: row.get::<_, i64>(0)? as u64,
        settings_digest: row.get(1)?,
        recorded_at: row.get(2)?,
        effective_window_start_utc: row.get(3)?,
        settings: Settings {
            timezone_id: row.get(4)?,
            ceilings: Ceilings {
                max_daily_runs: row.get::<_, i64>(5)? as u64,
                max_daily_tokens: row.get::<_, i64>(6)? as u64,
                max_daily_output_tokens: row.get::<_, i64>(7)? as u64,
                max_ambient_run_tokens: row.get::<_, i64>(8)? as u64,
                max_ambient_run_output_tokens: row.get::<_, i64>(9)? as u64,
                max_consecutive_failures: row.get::<_, i64>(10)? as u64,
                max_run_elapsed_seconds: row.get::<_, i64>(11)? as u64,
                warning_ppm: row.get::<_, i64>(12)? as u64,
            },
        },
    })
}

const VERSION_COLUMNS: &str = "settings_version, settings_digest, recorded_at, \
     effective_window_start_utc, timezone_id, max_daily_runs, max_daily_tokens, \
     max_daily_output_tokens, max_ambient_run_tokens, max_ambient_run_output_tokens, \
     max_consecutive_failures, max_run_elapsed_seconds, warning_ppm";

/// The newest recorded version, effective or not.
pub fn latest_version(conn: &Connection) -> Result<Option<Version>, String> {
    let sql =
        format!("SELECT {VERSION_COLUMNS} FROM budget_settings_versions ORDER BY settings_version DESC LIMIT 1");
    match conn.query_row(&sql, [], read_version) {
        Ok(version) => Ok(Some(version)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("budget_settings_versions: {e}")),
    }
}

/// The version in force at an instant — the newest one whose handover has
/// already happened. Windows and instants are both compared as RFC3339 UTC,
/// which sorts lexically, so one query answers both questions.
fn version_effective_at(conn: &Connection, window_start: &str) -> Result<Option<Version>, String> {
    let sql = format!(
        "SELECT {VERSION_COLUMNS} FROM budget_settings_versions \
         WHERE effective_window_start_utc <= ?1 \
         ORDER BY effective_window_start_utc DESC, settings_version DESC LIMIT 1"
    );
    match conn.query_row(&sql, [window_start], read_version) {
        Ok(version) => Ok(Some(version)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("budget_settings_versions: {e}")),
    }
}

/// Append an immutable settings version.
///
/// Always appends, even when the content reverts to an older digest: two
/// identical digests with two version numbers is exactly what lets an M28 R2
/// observation window detect that somebody changed the budget and changed it
/// back, which one row could not express.
///
/// The FIRST version is effective from the start of the current window (there
/// is nothing before it to protect). Every later one is effective from the
/// next window boundary, computed under the CURRENTLY effective timezone —
/// including a version that changes the timezone, because the new zone is not
/// in force until the handover it schedules.
pub fn append_version(
    conn: &Connection,
    settings: &Settings,
    now: DateTime<Utc>,
) -> Result<Version, String> {
    zone(&settings.timezone_id)?;
    let current = latest_version(conn)?;
    let effective = match &current {
        None => window_containing(&settings.timezone_id, now)?.start_utc,
        Some(existing) => next_window_start(&existing.settings.timezone_id, now)?,
    };
    let settings_version = current.map(|v| v.settings_version + 1).unwrap_or(1);
    let digest = settings.digest()?;
    let recorded_at = stamp(now);
    conn.execute(
        "INSERT INTO budget_settings_versions \
         (settings_version, settings_digest, recorded_at, effective_window_start_utc, \
          timezone_id, max_daily_runs, max_daily_tokens, max_daily_output_tokens, \
          max_ambient_run_tokens, max_ambient_run_output_tokens, max_consecutive_failures, \
          max_run_elapsed_seconds, warning_ppm) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            settings_version as i64,
            digest,
            recorded_at,
            effective,
            settings.timezone_id,
            settings.ceilings.max_daily_runs as i64,
            settings.ceilings.max_daily_tokens as i64,
            settings.ceilings.max_daily_output_tokens as i64,
            settings.ceilings.max_ambient_run_tokens as i64,
            settings.ceilings.max_ambient_run_output_tokens as i64,
            settings.ceilings.max_consecutive_failures as i64,
            settings.ceilings.max_run_elapsed_seconds as i64,
            settings.ceilings.warning_ppm as i64,
        ],
    )
    .map_err(|e| format!("budget_settings_versions: {e}"))?;
    Ok(Version {
        settings_version,
        settings_digest: digest,
        recorded_at,
        effective_window_start_utc: effective,
        settings: settings.clone(),
    })
}

/// Ensure a first settings version exists, seeded from the shipped artifact
/// and this machine's zone.
pub fn ensure_initial_version(conn: &Connection, now: DateTime<Utc>) -> Result<Version, String> {
    if let Some(existing) = latest_version(conn)? {
        return Ok(existing);
    }
    append_version(
        conn,
        &Settings {
            ceilings: shipped_defaults()?,
            timezone_id: system_timezone(),
        },
        now,
    )
}

// --- The day ----------------------------------------------------------------

/// One local day of the subscription, as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Day {
    pub window_start_utc: String,
    pub window_end_utc: String,
    pub timezone_id: String,
    pub settings_version: u64,
    pub settings_digest: String,
    pub ceilings: Ceilings,
    pub accounting_exact: bool,
    pub ambient_tokens_used: u64,
    pub ambient_output_tokens: u64,
    pub reserved_total_tokens: u64,
    pub reserved_output_tokens: u64,
    pub ambient_runs_started: u64,
}

impl Day {
    fn committed_total(&self) -> u64 {
        self.ambient_tokens_used
            .saturating_add(self.reserved_total_tokens)
    }

    fn committed_output(&self) -> u64 {
        self.ambient_output_tokens
            .saturating_add(self.reserved_output_tokens)
    }

    /// Utilization in parts per million for each dimension. A zero ceiling is
    /// fully used at zero — a limit of none means none, not unlimited.
    fn utilization(&self) -> [(CeilingReason, u64); 3] {
        [
            (
                CeilingReason::DailyRuns,
                ppm(self.ambient_runs_started, self.ceilings.max_daily_runs),
            ),
            (
                CeilingReason::DailyTokens,
                ppm(self.committed_total(), self.ceilings.max_daily_tokens),
            ),
            (
                CeilingReason::DailyOutputTokens,
                ppm(
                    self.committed_output(),
                    self.ceilings.max_daily_output_tokens,
                ),
            ),
        ]
    }

    /// `under_budget | warning | exhausted`, plus every ceiling that is
    /// actually hit. Gate-only reasons never appear here.
    pub fn ceiling_state(&self) -> (&'static str, Vec<CeilingReason>) {
        let utilization = self.utilization();
        let hit: Vec<CeilingReason> = utilization
            .iter()
            .filter(|(_, used)| *used >= 1_000_000)
            .map(|(reason, _)| *reason)
            .collect();
        if !hit.is_empty() {
            return ("exhausted", hit);
        }
        let warning = utilization
            .iter()
            .any(|(_, used)| *used >= self.ceilings.warning_ppm);
        (if warning { "warning" } else { "under_budget" }, Vec::new())
    }
}

fn ppm(used: u64, ceiling: u64) -> u64 {
    if ceiling == 0 {
        return 1_000_000;
    }
    used.saturating_mul(1_000_000) / ceiling
}

/// Which daily ceiling is hit. Sorted by name wherever a set is stored, so
/// two processes writing the same set write the same bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CeilingReason {
    DailyOutputTokens,
    DailyRuns,
    DailyTokens,
}

impl CeilingReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CeilingReason::DailyOutputTokens => "daily_output_tokens",
            CeilingReason::DailyRuns => "daily_runs",
            CeilingReason::DailyTokens => "daily_tokens",
        }
    }
}

/// Why a preflight gate deferred. Closed, and every member is a sentence a
/// banner can say out loud.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum GateReason {
    AccountingUnknown,
    /// This ONE agent is paused (M33b.5). Distinct from [`GateReason::GlobalPause`]
    /// on purpose: "everything is stopped" and "this colleague is stopped" are
    /// different sentences, and a deferral record that merged them could not
    /// tell an owner which control they pressed.
    AgentPaused,
    AmbientBusy,
    ConsecutiveFailures,
    DailyOutputTokens,
    DailyRuns,
    DailyTokens,
    GlobalPause,
    LaneDisabled,
    QuotaBackoff,
    ReservationExceedsRemaining,
    ReservationExceedsRunCap,
}

impl GateReason {
    pub fn as_str(self) -> &'static str {
        match self {
            GateReason::AccountingUnknown => "accounting_unknown",
            GateReason::AgentPaused => "agent_paused",
            GateReason::AmbientBusy => "ambient_busy",
            GateReason::ConsecutiveFailures => "consecutive_failures",
            GateReason::DailyOutputTokens => "daily_output_tokens",
            GateReason::DailyRuns => "daily_runs",
            GateReason::DailyTokens => "daily_tokens",
            GateReason::GlobalPause => "global_pause",
            GateReason::LaneDisabled => "lane_disabled",
            GateReason::QuotaBackoff => "quota_backoff",
            GateReason::ReservationExceedsRemaining => "reservation_exceeds_remaining",
            GateReason::ReservationExceedsRunCap => "reservation_exceeds_run_cap",
        }
    }

    fn of_ceiling(reason: CeilingReason) -> GateReason {
        match reason {
            CeilingReason::DailyOutputTokens => GateReason::DailyOutputTokens,
            CeilingReason::DailyRuns => GateReason::DailyRuns,
            CeilingReason::DailyTokens => GateReason::DailyTokens,
        }
    }
}

fn reasons_json<T: Copy + Ord>(mut reasons: Vec<T>, name: impl Fn(T) -> &'static str) -> String {
    reasons.sort();
    reasons.dedup();
    let names: Vec<&str> = reasons.into_iter().map(name).collect();
    serde_json::to_string(&names).unwrap_or_else(|_| "[]".to_string())
}

/// Open (or read) the `budget_days` row for the window containing `now`.
///
/// Creation copies the effective version's complete ceiling snapshot and pins
/// its version and digest. Must be called inside the caller's transaction
/// when a gate is about to read it.
pub fn ensure_day(conn: &Connection, now: DateTime<Utc>) -> Result<Day, String> {
    let latest = ensure_initial_version(conn, now)?;
    // The version IN FORCE right now, which is not the newest one recorded:
    // an edit made an hour ago is waiting for its handover, and reading the
    // window boundary off it would file today's spending under tomorrow.
    let governing = version_effective_at(conn, &stamp(now))?.unwrap_or(latest);
    let mut window = window_containing(&governing.settings.timezone_id, now)?;
    // A version that changed the timezone hands over at a boundary computed
    // under the OLD zone, which need not be a local midnight in the new one.
    // The first window under a new zone is therefore short, and saying so is
    // better than back-dating it over hours the previous zone already
    // accounted for.
    if window.start_utc < governing.effective_window_start_utc {
        window.start_utc = governing.effective_window_start_utc.clone();
    }
    conn.execute(
        "INSERT OR IGNORE INTO budget_days \
         (window_start_utc, window_end_utc, timezone_id, settings_version, settings_digest, \
          max_daily_runs, max_daily_tokens, max_daily_output_tokens, max_ambient_run_tokens, \
          max_ambient_run_output_tokens, max_consecutive_failures, max_run_elapsed_seconds, \
          warning_ppm, accounting_state, ambient_tokens_used, ambient_output_tokens, \
          reserved_total_tokens, reserved_output_tokens, ambient_runs_started, ceiling_state, \
          ceiling_reasons) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'exact', 0, 0, 0, 0, 0, \
                 'under_budget', '[]')",
        rusqlite::params![
            window.start_utc,
            window.end_utc,
            governing.settings.timezone_id,
            governing.settings_version as i64,
            governing.settings_digest,
            governing.settings.ceilings.max_daily_runs as i64,
            governing.settings.ceilings.max_daily_tokens as i64,
            governing.settings.ceilings.max_daily_output_tokens as i64,
            governing.settings.ceilings.max_ambient_run_tokens as i64,
            governing.settings.ceilings.max_ambient_run_output_tokens as i64,
            governing.settings.ceilings.max_consecutive_failures as i64,
            governing.settings.ceilings.max_run_elapsed_seconds as i64,
            governing.settings.ceilings.warning_ppm as i64,
        ],
    )
    .map_err(|e| format!("budget_days: {e}"))?;
    read_day(conn, &window.start_utc)
}

pub fn read_day(conn: &Connection, window_start: &str) -> Result<Day, String> {
    conn.query_row(
        "SELECT window_start_utc, window_end_utc, timezone_id, settings_version, \
         settings_digest, max_daily_runs, max_daily_tokens, max_daily_output_tokens, \
         max_ambient_run_tokens, max_ambient_run_output_tokens, max_consecutive_failures, \
         max_run_elapsed_seconds, warning_ppm, accounting_state, ambient_tokens_used, \
         ambient_output_tokens, reserved_total_tokens, reserved_output_tokens, \
         ambient_runs_started FROM budget_days WHERE window_start_utc = ?1",
        [window_start],
        |row| {
            Ok(Day {
                window_start_utc: row.get(0)?,
                window_end_utc: row.get(1)?,
                timezone_id: row.get(2)?,
                settings_version: row.get::<_, i64>(3)? as u64,
                settings_digest: row.get(4)?,
                ceilings: Ceilings {
                    max_daily_runs: row.get::<_, i64>(5)? as u64,
                    max_daily_tokens: row.get::<_, i64>(6)? as u64,
                    max_daily_output_tokens: row.get::<_, i64>(7)? as u64,
                    max_ambient_run_tokens: row.get::<_, i64>(8)? as u64,
                    max_ambient_run_output_tokens: row.get::<_, i64>(9)? as u64,
                    max_consecutive_failures: row.get::<_, i64>(10)? as u64,
                    max_run_elapsed_seconds: row.get::<_, i64>(11)? as u64,
                    warning_ppm: row.get::<_, i64>(12)? as u64,
                },
                accounting_exact: row.get::<_, String>(13)? == "exact",
                ambient_tokens_used: row.get::<_, i64>(14)? as u64,
                ambient_output_tokens: row.get::<_, i64>(15)? as u64,
                reserved_total_tokens: row.get::<_, i64>(16)? as u64,
                reserved_output_tokens: row.get::<_, i64>(17)? as u64,
                ambient_runs_started: row.get::<_, i64>(18)? as u64,
            })
        },
    )
    .map_err(|e| format!("budget_days {window_start}: {e}"))
}

/// Recompute and store the day's ceiling state. Called after any change to
/// its counters, so the stored value never lags the numbers it summarizes.
pub fn refresh_ceiling_state(conn: &Connection, window_start: &str) -> Result<(), String> {
    let day = read_day(conn, window_start)?;
    let (state, reasons) = day.ceiling_state();
    conn.execute(
        "UPDATE budget_days SET ceiling_state = ?2, ceiling_reasons = ?3 \
         WHERE window_start_utc = ?1",
        rusqlite::params![
            window_start,
            state,
            reasons_json(reasons, CeilingReason::as_str)
        ],
    )
    .map_err(|e| format!("budget_days: {e}"))?;
    Ok(())
}

/// Mark the day's accounting unknown. Never reversible within the day: a
/// number that was lost does not come back, and pretending otherwise is how
/// spend gets double-counted.
pub fn mark_accounting_unknown(conn: &Connection, window_start: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE budget_days SET accounting_state = 'unknown' WHERE window_start_utc = ?1",
        [window_start],
    )
    .map_err(|e| format!("budget_days: {e}"))?;
    Ok(())
}

// --- The gate ---------------------------------------------------------------

/// A reservation: the bounded allowance one ambient dispatch may spend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reservation {
    pub total_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Proceed,
    Deferred(Vec<GateReason>),
}

impl Decision {
    pub fn is_proceed(&self) -> bool {
        matches!(self, Decision::Proceed)
    }

    pub fn reasons(&self) -> &[GateReason] {
        match self {
            Decision::Proceed => &[],
            Decision::Deferred(reasons) => reasons,
        }
    }
}

/// The shed threshold for a lane, in ppm of its ceiling.
///
/// Lowest priority sheds at `warning_ppm`; highest sheds only at the ceiling
/// itself. With one registered lane the ramp collapses and it sheds at the
/// ceiling, which is the right answer: there is nothing lower to shed first.
fn shed_threshold(warning_ppm: u64, priority: u64, lanes: u64) -> u64 {
    if lanes <= 1 {
        return 1_000_000;
    }
    let span = 1_000_000u64.saturating_sub(warning_ppm);
    let steps = lanes - 1;
    let from_bottom = steps.saturating_sub(priority.min(steps));
    warning_ppm + span * from_bottom / steps
}

/// Preflight. Every applicable reason is collected, not just the first: a
/// person told only "daily_runs" who then raises the run ceiling and hits
/// "daily_tokens" one second later has been given a worse answer than the
/// truth.
///
/// Call inside the dispatch transaction — the counters it reads are the ones
/// the reservation is about to change.
///
/// `actor` (M33b.5) is who this dispatch would be attributed to, and it is a
/// separate axis from `lane` for the same reason `dispatch::claim` takes both:
/// ingest claims under five of the seven lanes, so a lane→construct guess
/// would refuse work on behalf of whoever happened to share a queue. `None` is
/// a dispatch nobody is attributed for, which has no per-agent pause to check.
///
/// **Both pauses are collected, and either is enough.** Resuming one agent
/// while the global pause is on still defers — with `global_pause` alone as
/// the reason, which is the truthful answer to "why did nothing happen".
pub fn gate(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    lane: &str,
    actor: Option<&str>,
    reservation: Reservation,
    now: DateTime<Utc>,
) -> Result<(Decision, Day), String> {
    let day = ensure_day(conn, now)?;
    let mut reasons: Vec<GateReason> = Vec::new();

    if settings::global_pause(conn) {
        reasons.push(GateReason::GlobalPause);
    }
    // The per-agent pause, beside the global one because they are the same
    // control at two widths. `?` and not a swallowed default: an unreadable
    // pause row must refuse rather than wave a run through (see
    // `settings::agent_paused`), exactly as the unreadable lane row below does.
    if let Some(actor) = actor {
        if settings::agent_paused(conn, vault_id, actor)? {
            reasons.push(GateReason::AgentPaused);
        }
    }
    if !day.accounting_exact {
        reasons.push(GateReason::AccountingUnknown);
    }
    if !settings::lane_enabled(conn, vault_id, lane)? {
        reasons.push(GateReason::LaneDisabled);
    }

    // Per-run caps come off the DAY's copied snapshot, never off current
    // settings: a reservation is checked against the rule the day was opened
    // under.
    if reservation.total_tokens > day.ceilings.max_ambient_run_tokens
        || reservation.output_tokens > day.ceilings.max_ambient_run_output_tokens
    {
        reasons.push(GateReason::ReservationExceedsRunCap);
    }

    // Daily headroom, and the lane-priority ramp, off the same three
    // dimensions.
    let priority = lane_priority(conn, lane)?;
    let lanes = lane_count(conn)?;
    let threshold = shed_threshold(day.ceilings.warning_ppm, priority, lanes);
    for (reason, used) in day.utilization() {
        if used >= threshold {
            reasons.push(GateReason::of_ceiling(reason));
        }
    }
    let fits_runs = day.ambient_runs_started < day.ceilings.max_daily_runs;
    let fits_total = day
        .committed_total()
        .saturating_add(reservation.total_tokens)
        <= day.ceilings.max_daily_tokens;
    let fits_output = day
        .committed_output()
        .saturating_add(reservation.output_tokens)
        <= day.ceilings.max_daily_output_tokens;
    if (!fits_runs || !fits_total || !fits_output)
        && !reasons.contains(&GateReason::ReservationExceedsRunCap)
    {
        // Distinct from the ceiling reasons above: there IS headroom, just
        // not enough for this dispatch. "Today is done" and "this job is too
        // big for what is left" are different sentences.
        reasons.push(GateReason::ReservationExceedsRemaining);
    }

    if consecutive_failures(conn, vault_id, store_uuid, lane)?
        >= day.ceilings.max_consecutive_failures
        && day.ceilings.max_consecutive_failures > 0
    {
        reasons.push(GateReason::ConsecutiveFailures);
    }
    if backoff_active(conn, vault_id, lane, now)? {
        reasons.push(GateReason::QuotaBackoff);
    }
    if ambient_busy(conn, now)? {
        reasons.push(GateReason::AmbientBusy);
    }

    reasons.sort();
    reasons.dedup();
    let decision = if reasons.is_empty() {
        Decision::Proceed
    } else {
        Decision::Deferred(reasons)
    };
    Ok((decision, day))
}

fn lane_priority(conn: &Connection, lane: &str) -> Result<u64, String> {
    conn.query_row(
        "SELECT priority FROM lane_registry WHERE lane = ?1",
        [lane],
        |row| row.get::<_, i64>(0),
    )
    .map(|p| p as u64)
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            format!("lane {lane:?} is not in the registry — no dispatcher may name it")
        }
        other => format!("lane_registry: {other}"),
    })
}

fn lane_count(conn: &Connection) -> Result<u64, String> {
    conn.query_row("SELECT count(*) FROM lane_registry", [], |row| {
        row.get::<_, i64>(0)
    })
    .map(|n| n as u64)
    .map_err(|e| format!("lane_registry: {e}"))
}

fn consecutive_failures(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    lane: &str,
) -> Result<u64, String> {
    conn.query_row(
        "SELECT consecutive_failures FROM ambient_gate_state \
         WHERE vault_id = ?1 AND store_uuid = ?2 AND lane = ?3",
        rusqlite::params![vault_id, store_uuid, lane],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n as u64)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(0),
        other => Err(format!("ambient_gate_state: {other}")),
    })
}

fn backoff_active(
    conn: &Connection,
    vault_id: &str,
    lane: &str,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    let now = stamp(now);
    conn.query_row(
        "SELECT count(*) FROM backoff \
         WHERE lane = ?2 AND until > ?3 AND (vault_id = ?1 OR vault_id IS NULL)",
        rusqlite::params![vault_id, lane, now],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(|e| format!("backoff: {e}"))
}

/// How many ambient leases are held by runs whose leases have not expired?
///
/// An EXPIRED lease is not busy — that is the crash-recovery path, and
/// treating it as busy would wedge ambient work forever after one kill.
///
/// **This is the one place the retired singleton primary key did something
/// this count does not.** With a stale, expired, not-yet-swept row present,
/// v3's `INSERT` failed its primary key and rolled the whole claim back; the
/// count says zero and the claim proceeds. The accounting is untouched either
/// way — the abandoned run's reservation is still debited against the day
/// until `recover_expired_leases` finalizes it `abandoned_usage_unknown` — so
/// what was lost is an ordering accident that reported itself as an error,
/// not a guarantee.
pub fn ambient_leases_held(conn: &Connection, now: DateTime<Utc>) -> Result<usize, String> {
    let now = stamp(now);
    conn.query_row(
        "SELECT count(*) FROM ambient_dispatch WHERE lease_expires_at > ?1",
        [now],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n.max(0) as usize)
    .map_err(|e| format!("ambient_dispatch: {e}"))
}

/// Is the background already running as many leases as it is allowed?
///
/// The ceiling is read here, inside the caller's transaction, rather than
/// passed in: a claim is checked against the number in force at the instant it
/// commits, and a ceiling lowered while a run is in flight takes effect on the
/// NEXT claim rather than retroactively refusing one already granted.
fn ambient_busy(conn: &Connection, now: DateTime<Utc>) -> Result<bool, String> {
    Ok(ambient_leases_held(conn, now)? >= settings::ambient_concurrency(conn))
}

/// Record what the gate saw and what it decided. Every column is the value
/// OBSERVED, not one re-derived later, which is what makes a historical
/// decision reproducible.
#[allow(clippy::too_many_arguments)]
pub fn record_decision(
    conn: &Connection,
    decision_id: &str,
    vault_id: &str,
    store_uuid: &str,
    lane: &str,
    reservation: Reservation,
    day: &Day,
    decision: &Decision,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ambient_gate_decisions \
         (decision_id, attempted_at, vault_id, store_uuid, lane, window_start_utc, \
          settings_version, settings_digest, total_reservation, output_reservation, \
          used_total_tokens, used_output_tokens, runs_started, reserved_total_tokens, \
          reserved_output_tokens, decision, reasons) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        rusqlite::params![
            decision_id,
            stamp(now),
            vault_id,
            store_uuid,
            lane,
            day.window_start_utc,
            day.settings_version as i64,
            day.settings_digest,
            reservation.total_tokens as i64,
            reservation.output_tokens as i64,
            day.ambient_tokens_used as i64,
            day.ambient_output_tokens as i64,
            day.ambient_runs_started as i64,
            day.reserved_total_tokens as i64,
            day.reserved_output_tokens as i64,
            if decision.is_proceed() {
                "proceed"
            } else {
                "deferred"
            },
            reasons_json(decision.reasons().to_vec(), GateReason::as_str),
        ],
    )
    .map_err(|e| format!("ambient_gate_decisions: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    fn at(raw: &str) -> DateTime<Utc> {
        parse_stamp(raw).unwrap()
    }

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    fn settings_in(tz: &str) -> Settings {
        Settings {
            ceilings: shipped_defaults().unwrap(),
            timezone_id: tz.to_string(),
        }
    }

    /// Regenerate `shared/runtime/budget-defaults.v1.sha256` after a
    /// DELIBERATE edit to the ceilings. Ignored, like the policy digest, so
    /// the suite never quietly blesses a change to what the app may spend.
    #[test]
    #[ignore = "regeneration is a deliberate act — run with --ignored after editing the artifact"]
    fn write_defaults_digest() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/runtime/budget-defaults.v1.sha256");
        std::fs::write(&path, format!("{}\n", sha256_hex(DEFAULTS_JSON.as_bytes()))).unwrap();
    }

    #[test]
    fn the_shipped_defaults_are_the_designs_numbers_and_their_bytes_are_pinned() {
        let defaults = shipped_defaults().expect("the committed digest must match the artifact");
        assert_eq!(
            defaults,
            Ceilings {
                max_daily_runs: 20,
                max_daily_tokens: 200_000,
                max_daily_output_tokens: 40_000,
                max_ambient_run_tokens: 20_000,
                max_ambient_run_output_tokens: 4_000,
                max_consecutive_failures: 3,
                max_run_elapsed_seconds: 600,
                warning_ppm: 800_000,
            }
        );
    }

    #[test]
    fn a_window_is_two_local_midnights_in_utc() {
        let window = window_containing("America/New_York", at("2026-08-09T16:00:00Z")).unwrap();
        assert_eq!(window.start_utc, "2026-08-09T04:00:00.000Z");
        assert_eq!(window.end_utc, "2026-08-10T04:00:00.000Z");
    }

    #[test]
    fn dst_produces_honest_23_and_25_hour_days() {
        // Spring forward: 2026-03-08 in New York is 23 hours.
        let spring = window_containing("America/New_York", at("2026-03-08T12:00:00Z")).unwrap();
        let hours = (parse_stamp(&spring.end_utc).unwrap()
            - parse_stamp(&spring.start_utc).unwrap())
        .num_hours();
        assert_eq!(hours, 23, "a rounded 24 would be a lie about the clock");

        // Fall back: 2026-11-01 is 25 hours.
        let fall = window_containing("America/New_York", at("2026-11-01T12:00:00Z")).unwrap();
        let hours = (parse_stamp(&fall.end_utc).unwrap() - parse_stamp(&fall.start_utc).unwrap())
            .num_hours();
        assert_eq!(hours, 25);
    }

    #[test]
    fn a_midnight_the_clock_skips_starts_the_day_at_the_first_minute_that_exists() {
        // Santiago springs forward AT midnight: 2026-09-06 has no 00:00 local.
        let window = window_containing("America/Santiago", at("2026-09-06T18:00:00Z")).unwrap();
        let start = parse_stamp(&window.start_utc).unwrap();
        assert!(start < at("2026-09-06T18:00:00Z"));
        assert!(
            parse_stamp(&window.end_utc).unwrap() > at("2026-09-06T18:00:00Z"),
            "the instant must land inside its own window"
        );
    }

    #[test]
    fn an_unknown_timezone_refuses_rather_than_falling_back_to_utc() {
        // A silent UTC fallback would move the day boundary by hours without
        // saying so, and every gate decision afterwards would be filed under
        // the wrong day.
        let err = window_containing("Mars/Olympus_Mons", at("2026-08-09T00:00:00Z")).unwrap_err();
        assert!(err.contains("not an IANA zone"), "{err}");
    }

    #[test]
    fn the_first_version_is_effective_now_and_later_ones_at_the_next_window() {
        let (dir, conn, _) = fixture("budget-versions");
        let first = append_version(&conn, &settings_in("UTC"), at("2026-08-09T10:00:00Z")).unwrap();
        assert_eq!(first.settings_version, 1);
        assert_eq!(first.effective_window_start_utc, "2026-08-09T00:00:00.000Z");

        let mut edited = settings_in("UTC");
        edited.ceilings.max_daily_runs = 5;
        let second = append_version(&conn, &edited, at("2026-08-09T11:00:00Z")).unwrap();
        assert_eq!(second.settings_version, 2);
        assert_eq!(
            second.effective_window_start_utc, "2026-08-10T00:00:00.000Z",
            "an edit may not reinterpret a day that has already been spent"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_change_and_revert_leaves_two_versions_not_one() {
        // The M28 R2 row: an observation window must be invalidatable by ANY
        // edit, and a revert that collapsed into silence would hide one.
        let (dir, conn, _) = fixture("budget-revert");
        let base = settings_in("UTC");
        append_version(&conn, &base, at("2026-08-09T10:00:00Z")).unwrap();
        let mut raised = base.clone();
        raised.ceilings.max_daily_tokens = 999_999;
        let up = append_version(&conn, &raised, at("2026-08-09T11:00:00Z")).unwrap();
        let back = append_version(&conn, &base, at("2026-08-09T12:00:00Z")).unwrap();

        assert_eq!(back.settings_digest, base.digest().unwrap());
        assert_ne!(up.settings_digest, back.settings_digest);
        assert_eq!(back.settings_version, 3, "versions are never reused");
        let count: i64 = conn
            .query_row("SELECT count(*) FROM budget_settings_versions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 3);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_day_copies_its_ceilings_and_a_later_edit_does_not_touch_it() {
        let (dir, conn, _) = fixture("budget-day-copy");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T01:00:00Z")).unwrap();
        let today = ensure_day(&conn, at("2026-08-09T10:00:00Z")).unwrap();
        assert_eq!(today.ceilings.max_daily_runs, 20);
        assert_eq!(today.settings_version, 1);

        let mut edited = settings_in("UTC");
        edited.ceilings.max_daily_runs = 1;
        append_version(&conn, &edited, at("2026-08-09T11:00:00Z")).unwrap();

        let reread = ensure_day(&conn, at("2026-08-09T23:00:00Z")).unwrap();
        assert_eq!(reread.ceilings.max_daily_runs, 20, "today keeps its rule");
        assert_eq!(reread.settings_version, 1);

        let tomorrow = ensure_day(&conn, at("2026-08-10T00:30:00Z")).unwrap();
        assert_eq!(
            tomorrow.ceilings.max_daily_runs, 1,
            "the edit lands tomorrow"
        );
        assert_eq!(tomorrow.settings_version, 2);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_timezone_edit_hands_over_at_the_old_zones_boundary() {
        let (dir, conn, _) = fixture("budget-tz-edit");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T01:00:00Z")).unwrap();
        let moved = append_version(
            &conn,
            &settings_in("America/New_York"),
            at("2026-08-09T11:00:00Z"),
        )
        .unwrap();
        assert_eq!(
            moved.effective_window_start_utc, "2026-08-10T00:00:00.000Z",
            "the new zone is not in force until the handover it schedules"
        );
        let first_under_new = ensure_day(&conn, at("2026-08-10T01:00:00Z")).unwrap();
        assert_eq!(first_under_new.timezone_id, "America/New_York");
        assert_eq!(
            first_under_new.window_start_utc, "2026-08-10T00:00:00.000Z",
            "the first day under a new zone is short, and says so"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn spend(conn: &Connection, window: &str, total: u64, output: u64, runs: u64) {
        conn.execute(
            "UPDATE budget_days SET ambient_tokens_used = ?2, ambient_output_tokens = ?3, \
             ambient_runs_started = ?4 WHERE window_start_utc = ?1",
            rusqlite::params![window, total as i64, output as i64, runs as i64],
        )
        .unwrap();
        refresh_ceiling_state(conn, window).unwrap();
    }

    #[test]
    fn each_ceiling_exhausts_independently_and_names_itself() {
        let (dir, conn, vault) = fixture("budget-gate-each");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T00:30:00Z")).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let day = ensure_day(&conn, now).unwrap();
        let window = day.window_start_utc.clone();
        let small = Reservation {
            total_tokens: 10,
            output_tokens: 5,
        };

        // Runs only.
        spend(&conn, &window, 0, 0, 20);
        let (decision, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert_eq!(
            decision.reasons(),
            &[
                GateReason::DailyRuns,
                GateReason::ReservationExceedsRemaining
            ]
        );

        // Total tokens only.
        spend(&conn, &window, 200_000, 0, 0);
        let (decision, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert_eq!(
            decision.reasons(),
            &[
                GateReason::DailyTokens,
                GateReason::ReservationExceedsRemaining
            ]
        );

        // Output tokens only.
        spend(&conn, &window, 0, 40_000, 0);
        let (decision, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert_eq!(
            decision.reasons(),
            &[
                GateReason::DailyOutputTokens,
                GateReason::ReservationExceedsRemaining
            ]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_quiet_day_lets_every_lane_through() {
        let (dir, conn, vault) = fixture("budget-gate-quiet");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T00:30:00Z")).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        for lane in settings::lanes_by_priority(&conn).unwrap() {
            let (decision, _) = gate(
                &conn,
                &vault,
                "store",
                &lane,
                None,
                Reservation {
                    total_tokens: 20_000,
                    output_tokens: 4_000,
                },
                now,
            )
            .unwrap();
            assert!(decision.is_proceed(), "{lane}: {:?}", decision.reasons());
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn at_the_warning_line_the_lowest_priority_lane_sheds_and_the_highest_does_not() {
        // Degradation by reverse registry priority, as one ramp: `schema` is
        // last in the registry and stops first; `filed` runs until the
        // ceiling itself.
        let (dir, conn, vault) = fixture("budget-degrade");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T00:30:00Z")).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let window = ensure_day(&conn, now).unwrap().window_start_utc;
        spend(&conn, &window, 160_000, 0, 0); // exactly 80%
        let small = Reservation {
            total_tokens: 10,
            output_tokens: 5,
        };
        let (schema, _) = gate(&conn, &vault, "store", "schema", None, small, now).unwrap();
        assert_eq!(schema.reasons(), &[GateReason::DailyTokens]);
        let (filed, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert!(filed.is_proceed(), "{:?}", filed.reasons());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn at_exhaustion_every_lane_halts_including_the_highest_priority_one() {
        let (dir, conn, vault) = fixture("budget-exhausted");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T00:30:00Z")).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let window = ensure_day(&conn, now).unwrap().window_start_utc;
        spend(&conn, &window, 200_000, 0, 0);
        let day = read_day(&conn, &window).unwrap();
        assert_eq!(day.ceiling_state().0, "exhausted");
        for lane in settings::lanes_by_priority(&conn).unwrap() {
            let (decision, _) = gate(
                &conn,
                &vault,
                "store",
                &lane,
                None,
                Reservation {
                    total_tokens: 10,
                    output_tokens: 5,
                },
                now,
            )
            .unwrap();
            assert!(
                decision.reasons().contains(&GateReason::DailyTokens),
                "{lane} must halt at exhaustion"
            );
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reservation_too_big_for_a_run_is_a_different_answer_from_a_full_day() {
        let (dir, conn, vault) = fixture("budget-run-cap");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T00:30:00Z")).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let (decision, _) = gate(
            &conn,
            &vault,
            "store",
            "filed",
            None,
            Reservation {
                total_tokens: 20_001,
                output_tokens: 4_000,
            },
            now,
        )
        .unwrap();
        assert_eq!(decision.reasons(), &[GateReason::ReservationExceedsRunCap]);

        let (output_cap, _) = gate(
            &conn,
            &vault,
            "store",
            "filed",
            None,
            Reservation {
                total_tokens: 100,
                output_tokens: 4_001,
            },
            now,
        )
        .unwrap();
        assert_eq!(
            output_cap.reasons(),
            &[GateReason::ReservationExceedsRunCap]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_dispatch_that_does_not_fit_the_remaining_headroom_says_so() {
        let (dir, conn, vault) = fixture("budget-headroom");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T00:30:00Z")).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let window = ensure_day(&conn, now).unwrap().window_start_utc;
        spend(&conn, &window, 190_000, 0, 0);
        let (decision, _) = gate(
            &conn,
            &vault,
            "store",
            "filed",
            None,
            Reservation {
                total_tokens: 20_000,
                output_tokens: 100,
            },
            now,
        )
        .unwrap();
        assert!(
            decision
                .reasons()
                .contains(&GateReason::ReservationExceedsRemaining),
            "{:?}",
            decision.reasons()
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_agents_pause_is_its_own_gate_reason_and_never_the_global_ones() {
        // M33b.5. Two controls, two reasons, recorded separately — an owner
        // reading a deferral has to be able to tell "I stopped everything"
        // from "I stopped this one".
        let (dir, conn, vault) = fixture("budget-agent-paused");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T00:30:00Z")).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let small = Reservation {
            total_tokens: 10,
            output_tokens: 5,
        };

        // A dispatch nobody is attributed for has no per-agent pause to check.
        settings::set_agent_paused(&conn, &vault, "process:digest", true).unwrap();
        let (anonymous, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert!(anonymous.is_proceed(), "{:?}", anonymous.reasons());

        let (paused, _) = gate(
            &conn,
            &vault,
            "store",
            "filed",
            Some("process:digest"),
            small,
            now,
        )
        .unwrap();
        assert_eq!(paused.reasons(), &[GateReason::AgentPaused]);
        assert_eq!(GateReason::AgentPaused.as_str(), "agent_paused");

        // And it is written into the deferral record under its own name, so
        // the reason survives the run that never happened.
        let day = ensure_day(&conn, now).unwrap();
        record_decision(
            &conn, "d-paused", &vault, "store", "filed", small, &day, &paused, now,
        )
        .unwrap();
        let reasons: String = conn
            .query_row(
                "SELECT reasons FROM ambient_gate_decisions WHERE decision_id = 'd-paused'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reasons, r#"["agent_paused"]"#);

        // Somebody else entirely is not stopped by it.
        let (other, _) = gate(
            &conn,
            &vault,
            "store",
            "filed",
            Some("process:scout"),
            small,
            now,
        )
        .unwrap();
        assert!(other.is_proceed(), "{:?}", other.reasons());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pause_accounting_lane_failures_backoff_and_busy_each_defer_on_their_own() {
        let (dir, conn, vault) = fixture("budget-gate-others");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T00:30:00Z")).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let window = ensure_day(&conn, now).unwrap().window_start_utc;
        let small = Reservation {
            total_tokens: 10,
            output_tokens: 5,
        };

        settings::set_global_pause(&conn, true).unwrap();
        let (paused, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert_eq!(paused.reasons(), &[GateReason::GlobalPause]);
        settings::set_global_pause(&conn, false).unwrap();

        mark_accounting_unknown(&conn, &window).unwrap();
        let (unknown, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert_eq!(unknown.reasons(), &[GateReason::AccountingUnknown]);
        conn.execute(
            "UPDATE budget_days SET accounting_state = 'exact' WHERE window_start_utc = ?1",
            [&window],
        )
        .unwrap();

        settings::set_lane_enabled(&conn, &vault, "filed", false).unwrap();
        let (off, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert_eq!(off.reasons(), &[GateReason::LaneDisabled]);
        settings::set_lane_enabled(&conn, &vault, "filed", true).unwrap();

        conn.execute(
            "INSERT INTO ambient_gate_state \
             (vault_id, store_uuid, lane, consecutive_failures) VALUES (?1, 'store', 'filed', 3)",
            [&vault],
        )
        .unwrap();
        let (failing, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert_eq!(failing.reasons(), &[GateReason::ConsecutiveFailures]);
        conn.execute("DELETE FROM ambient_gate_state", []).unwrap();

        conn.execute(
            "INSERT INTO backoff (vault_id, lane, until, reason, quota_window_key) \
             VALUES (NULL, 'filed', '2026-08-09T15:00:00.000Z', 'quota', 'w1')",
            [],
        )
        .unwrap();
        let (backed_off, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert_eq!(backed_off.reasons(), &[GateReason::QuotaBackoff]);
        conn.execute("DELETE FROM backoff", []).unwrap();

        conn.execute(
            "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, outcome, \
             usage_state, input_tokens, output_tokens, cache_read, cache_write, \
             reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, \
             rejected) VALUES ('r1', ?1, 'store', 'ambient', 'filed', \
             '2026-08-09T09:00:00.000Z', 'running', 'pending', 0, 0, 0, 0, 0, 0, 0, 0, 0)",
            [&vault],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ambient_dispatch \
             (run_id, vault_id, store_uuid, lane, acquired_at, lease_expires_at) \
             VALUES ('r1', ?1, 'store', 'filed', '2026-08-09T09:00:00.000Z', \
                     '2026-08-09T11:00:00.000Z')",
            [&vault],
        )
        .unwrap();
        let (busy, _) = gate(&conn, &vault, "store", "filed", None, small, now).unwrap();
        assert_eq!(busy.reasons(), &[GateReason::AmbientBusy]);

        // An EXPIRED lease is the crash-recovery path, not a busy signal.
        let (recovered, _) = gate(
            &conn,
            &vault,
            "store",
            "filed",
            None,
            small,
            at("2026-08-09T12:00:00Z"),
        )
        .unwrap();
        assert!(recovered.is_proceed(), "{:?}", recovered.reasons());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_gate_decision_pins_the_day_the_settings_and_the_counters_it_saw() {
        let (dir, conn, vault) = fixture("budget-decision");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T00:30:00Z")).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let window = ensure_day(&conn, now).unwrap().window_start_utc;
        spend(&conn, &window, 123, 45, 6);
        let reservation = Reservation {
            total_tokens: 10,
            output_tokens: 5,
        };
        let (decision, day) =
            gate(&conn, &vault, "store", "filed", None, reservation, now).unwrap();
        record_decision(
            &conn,
            "d1",
            &vault,
            "store",
            "filed",
            reservation,
            &day,
            &decision,
            now,
        )
        .unwrap();

        let (version, digest, used, output, runs, verdict, reasons): (
            i64,
            String,
            i64,
            i64,
            i64,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT settings_version, settings_digest, used_total_tokens, \
                 used_output_tokens, runs_started, decision, reasons \
                 FROM ambient_gate_decisions WHERE decision_id = 'd1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(version, 1);
        assert_eq!(digest, settings_in("UTC").digest().unwrap());
        assert_eq!((used, output, runs), (123, 45, 6));
        assert_eq!(verdict, "proceed");
        assert_eq!(
            reasons, "[]",
            "proceed carries an empty reason set, exactly"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_deferred_decision_stores_its_reasons_sorted_and_unique() {
        let (dir, conn, vault) = fixture("budget-decision-reasons");
        append_version(&conn, &settings_in("UTC"), at("2026-08-09T00:30:00Z")).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let window = ensure_day(&conn, now).unwrap().window_start_utc;
        spend(&conn, &window, 200_000, 40_000, 20);
        settings::set_global_pause(&conn, true).unwrap();
        let reservation = Reservation {
            total_tokens: 10,
            output_tokens: 5,
        };
        let (decision, day) =
            gate(&conn, &vault, "store", "filed", None, reservation, now).unwrap();
        record_decision(
            &conn,
            "d2",
            &vault,
            "store",
            "filed",
            reservation,
            &day,
            &decision,
            now,
        )
        .unwrap();
        let reasons: String = conn
            .query_row(
                "SELECT reasons FROM ambient_gate_decisions WHERE decision_id = 'd2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            reasons,
            r#"["daily_output_tokens","daily_runs","daily_tokens","global_pause","reservation_exceeds_remaining"]"#
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_zero_ceiling_means_none_rather_than_unlimited() {
        assert_eq!(ppm(0, 0), 1_000_000);
        assert_eq!(ppm(5, 10), 500_000);
    }

    #[test]
    fn the_shed_ramp_runs_from_the_warning_line_to_the_ceiling() {
        assert_eq!(shed_threshold(800_000, 6, 7), 800_000, "lowest sheds first");
        assert_eq!(
            shed_threshold(800_000, 0, 7),
            1_000_000,
            "highest sheds last"
        );
        assert!(shed_threshold(800_000, 3, 7) > 800_000);
        assert!(shed_threshold(800_000, 3, 7) < 1_000_000);
        assert_eq!(shed_threshold(800_000, 0, 1), 1_000_000, "nothing lower");
    }
}
