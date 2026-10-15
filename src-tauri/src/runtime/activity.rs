//! The History read (M64.2): who changed what in a vault, and when Cerebro
//! was open to see it.
//!
//! Three lanes come back raw, each read alone through [`ReadOnly`], so a
//! question about what happened can never change a row:
//!
//! - **writes**: `vault_writes` (M58.1), every kind, comments included, whose
//!   `[first_at, recorded_at]` span overlaps the window;
//! - **runs**: this vault's `runs` whose `[started_at, ended_at or now]`
//!   overlaps the window, read with Fleet's columns and row mapper, so a
//!   run's cause renders as Fleet renders it, plus `writes_booked`;
//! - **app sessions**: `app_sessions` (M49.9), from open to a clean close or
//!   the last heartbeat.
//!
//! Each lane is `Read` or `Unavailable`, so one failed SELECT fails one lane
//! and the others still say what they know (CV-05). `recording_since` is the
//! vault's first recorded write: days before it read "not recorded", even
//! when Cerebro was open.
//!
//! Nothing here folds. The session and day fold lives in TypeScript
//! (`src/engine/activity.ts`), so the mock backend and this one feed one fold
//! and there is no twin to disagree. Git commits and the ledger are read
//! elsewhere and merged by the page.
//!
//! **Text order is not time order.** Writers stamp different precisions, and
//! `.` sorts before `Z`, so `09:00:00.500Z` sorts before `09:00:00Z`. SQL
//! narrows on the stored text with a one-second margin, and Rust holds every
//! row to the exact instant.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use super::fleet::{map_run, FleetRun, RUN_COLUMNS};
use super::write_log::CONTENT_KINDS;
use super::ReadOnly;

/// The longest window one read covers.
pub const MAX_DAYS: i64 = 400;
/// The most write rows one read returns; past it, `more` is set.
pub const WRITE_CAP: usize = 20_000;
/// The most runs one read returns.
pub const RUN_CAP: usize = 5_000;
/// The most app-session spans one read returns.
pub const SPAN_CAP: usize = 5_000;

/// A window whose end is not after its start.
pub const BACKWARDS: &str = "History needs a window that starts before it ends.";
/// A window longer than [`MAX_DAYS`].
pub const TOO_LONG: &str = "History reads at most 400 days at a time.";

fn not_an_instant(value: &str) -> String {
    format!("{value} is not an RFC 3339 instant.")
}

/// The span History reads: `[since, until)`. `since` None reads from the
/// first row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub since: Option<DateTime<Utc>>,
    pub until: DateTime<Utc>,
}

impl Window {
    /// The window an IPC caller asks for, or the refusal in words. Each end is
    /// RFC 3339 with `Z` or an offset, read as the instant it names.
    pub fn parse(since: &str, until: &str) -> Result<Self, String> {
        let instant = |value: &str| {
            DateTime::parse_from_rfc3339(value)
                .map(|at| at.with_timezone(&Utc))
                .map_err(|_| not_an_instant(value))
        };
        let since_at = instant(since)?;
        let until_at = instant(until)?;
        if since_at >= until_at {
            return Err(BACKWARDS.to_string());
        }
        if until_at - since_at > Duration::days(MAX_DAYS) {
            return Err(TOO_LONG.to_string());
        }
        Ok(Window {
            since: Some(since_at),
            until: until_at,
        })
    }

    /// Everything before `until`, for internal callers with no lower bound.
    pub fn through(until: DateTime<Utc>) -> Self {
        Window { since: None, until }
    }

    /// Does `[from, to]` overlap the window?
    fn overlaps(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> bool {
        from < self.until && self.since.is_none_or(|since| to >= since)
    }

    /// The stored-text bound below which no overlapping row's end can sort:
    /// the second before `since`, with no fraction or zone.
    fn text_floor(&self) -> Option<String> {
        self.since
            .map(|since| seconds(since - Duration::seconds(1)))
    }

    /// The stored-text bound every overlapping row's start sorts below.
    fn text_ceiling(&self) -> String {
        seconds(self.until + Duration::seconds(1))
    }
}

/// `YYYY-MM-DDTHH:MM:SS`: a prefix every stored spelling of that second
/// starts with.
fn seconds(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// The stored spelling of one instant, read back.
fn instant(column: &str, value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|_| format!("{column} {value} is not an RFC 3339 instant"))
}

/// One page of rows, newest first. `more` is set when rows past `rows` were
/// left unread.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Page<T> {
    pub rows: Vec<T>,
    pub more: bool,
}

/// One lane of the read: what it found, or why it could not look.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Lane<T> {
    Read { rows: Vec<T>, more: bool },
    Unavailable { reason: String },
}

impl<T> From<Result<Page<T>, String>> for Lane<T> {
    fn from(read: Result<Page<T>, String>) -> Self {
        match read {
            Ok(page) => Lane::Read {
                rows: page.rows,
                more: page.more,
            },
            Err(reason) => Lane::Unavailable { reason },
        }
    }
}

/// When the vault's first write was recorded, or why that could not be read.
/// `at: None` is a vault no write was ever recorded for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Since {
    Read { at: Option<String> },
    Unavailable { reason: String },
}

/// One `vault_writes` row, as History reads it. Named apart from
/// `vault_writes::WriteRow`, which is a writer's description. `content` is
/// whether the kind changes a page (`write_log::CONTENT_KINDS`); `at` is
/// `recorded_at`, when the row (or the last write of its burst) landed.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActivityWrite {
    pub kind: String,
    pub content: bool,
    pub path: String,
    pub to: Option<String>,
    pub actor: Option<String>,
    pub run_id: Option<String>,
    pub approved_by: Option<String>,
    pub first_at: String,
    pub at: String,
}

/// One run, as Fleet reads it, with whether its writes were booked
/// (`runs.writes_booked`: 1 all, 2 booked but the shell may have written
/// elsewhere, 0 not recorded).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActivityRun {
    #[serde(flatten)]
    pub run: FleetRun,
    pub writes_booked: i64,
}

/// When Cerebro had the vault open: from `opened_at` to `until`, a clean
/// close or the last heartbeat. `precision` is the row's `close_precision`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppSessionSpan {
    pub opened_at: String,
    pub until: String,
    pub precision: String,
}

/// Everything History reads for one vault and window.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VaultActivity {
    pub writes: Lane<ActivityWrite>,
    pub runs: Lane<ActivityRun>,
    pub app_sessions: Lane<AppSessionSpan>,
    pub recording_since: Since,
}

/// Take rows in stored-text order, newest first, until `limit` are held and
/// the next row starts another second; then order the held rows by their
/// exact instant and cut to `limit`. Rows within one second may sort wrongly
/// as text, never across seconds, so no row past the cut can be newer than
/// one before it.
fn newest_first<T>(
    rows: impl Iterator<Item = Result<(DateTime<Utc>, i64, T), String>>,
    limit: usize,
) -> Result<Page<T>, String> {
    let mut held: Vec<(DateTime<Utc>, i64, T)> = Vec::new();
    let mut more = false;
    for row in rows {
        let row = row?;
        if held.len() >= limit {
            let last = held.last().map(|(at, _, _)| seconds(*at));
            if last.as_deref() != Some(seconds(row.0).as_str()) {
                more = true;
                break;
            }
        }
        held.push(row);
    }
    held.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    if held.len() > limit {
        held.truncate(limit);
        more = true;
    }
    Ok(Page {
        rows: held.into_iter().map(|(_, _, row)| row).collect(),
        more,
    })
}

/// The write rows of `vault_id` whose `[first_at, recorded_at]` overlaps
/// `window`, every kind, newest first by `recorded_at`, then rowid. With
/// `paths`, only rows whose path or rename target is one of them.
pub fn write_rows(
    ro: &ReadOnly,
    vault_id: &str,
    window: &Window,
    paths: Option<&[String]>,
    limit: usize,
) -> Result<Page<ActivityWrite>, String> {
    let floor = window.text_floor();
    let mut statement = ro
        .prepare(
            "SELECT rowid, kind, path, to_path, actor, run_id, approved_by, first_at, \
             recorded_at FROM vault_writes \
             WHERE vault_id = ?1 AND (?2 IS NULL OR recorded_at >= ?2) AND first_at < ?3 \
             ORDER BY recorded_at DESC, rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = statement
        .query(rusqlite::params![vault_id, floor, window.text_ceiling()])
        .map_err(|e| e.to_string())?;
    let read = std::iter::from_fn(|| match rows.next() {
        Ok(Some(row)) => Some(write_of(row)),
        Ok(None) => None,
        Err(e) => Some(Err(e.to_string())),
    })
    .filter_map(|row| match row {
        Ok((first, at, rowid, write)) => {
            let wanted = window.overlaps(first, at)
                && paths.is_none_or(|paths| {
                    paths.contains(&write.path)
                        || write.to.as_ref().is_some_and(|to| paths.contains(to))
                });
            wanted.then_some(Ok((at, rowid, write)))
        }
        Err(e) => Some(Err(e)),
    });
    newest_first(read, limit)
}

type TimedWrite = (DateTime<Utc>, DateTime<Utc>, i64, ActivityWrite);

fn write_of(row: &rusqlite::Row<'_>) -> Result<TimedWrite, String> {
    let get = |e: rusqlite::Error| e.to_string();
    let kind: String = row.get(1).map_err(get)?;
    let first_at: String = row.get(7).map_err(get)?;
    let at: String = row.get(8).map_err(get)?;
    Ok((
        instant("first_at", &first_at)?,
        instant("recorded_at", &at)?,
        row.get(0).map_err(get)?,
        ActivityWrite {
            content: CONTENT_KINDS.contains(&kind.as_str()),
            kind,
            path: row.get(2).map_err(get)?,
            to: row.get(3).map_err(get)?,
            actor: row.get(4).map_err(get)?,
            run_id: row.get(5).map_err(get)?,
            approved_by: row.get(6).map_err(get)?,
            first_at,
            at,
        },
    ))
}

/// This vault's runs whose `[started_at, ended_at or now]` overlaps
/// `window`, newest first by `started_at`. With `run_ids`, only those
/// runs.
pub fn run_rows(
    ro: &ReadOnly,
    vault_id: &str,
    window: &Window,
    run_ids: Option<&[String]>,
    limit: usize,
) -> Result<Page<ActivityRun>, String> {
    run_rows_at(ro, vault_id, window, run_ids, limit, Utc::now())
}

/// The same read with a caller-captured clock, for deterministic tool answers.
pub fn run_rows_at(
    ro: &ReadOnly,
    vault_id: &str,
    window: &Window,
    run_ids: Option<&[String]>,
    limit: usize,
    now: DateTime<Utc>,
) -> Result<Page<ActivityRun>, String> {
    let floor = window.text_floor();
    let sql = format!(
        "SELECT {RUN_COLUMNS}, writes_booked, rowid FROM runs \
         WHERE vault_id = ?1 AND started_at < ?2 \
         AND (?3 IS NULL OR ended_at IS NULL OR ended_at >= ?3) \
         ORDER BY started_at DESC, run_id DESC"
    );
    let mut statement = ro.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = statement
        .query(rusqlite::params![vault_id, window.text_ceiling(), floor])
        .map_err(|e| e.to_string())?;
    let read = std::iter::from_fn(|| match rows.next() {
        Ok(Some(row)) => Some(run_of(row)),
        Ok(None) => None,
        Err(e) => Some(Err(e.to_string())),
    })
    .filter_map(|row| match row {
        Ok((rowid, run)) => {
            let started = match instant("started_at", &run.run.started_at) {
                Ok(at) => at,
                Err(e) => return Some(Err(e)),
            };
            let ended = match run.run.ended_at.as_deref().map(|e| instant("ended_at", e)) {
                Some(Ok(at)) => at,
                Some(Err(e)) => return Some(Err(e)),
                None => now,
            };
            let wanted = window.overlaps(started, ended)
                && run_ids.is_none_or(|ids| ids.contains(&run.run.run_id));
            wanted.then_some(Ok((started, rowid, run)))
        }
        Err(e) => Some(Err(e)),
    });
    newest_first(read, limit)
}

fn run_of(row: &rusqlite::Row<'_>) -> Result<(i64, ActivityRun), String> {
    let get = |e: rusqlite::Error| e.to_string();
    Ok((
        row.get(19).map_err(get)?,
        ActivityRun {
            run: map_run(row).map_err(get)?,
            writes_booked: row.get(18).map_err(get)?,
        },
    ))
}

/// When Cerebro had this vault open, for the spans that overlap `window`,
/// newest first by `opened_at`.
pub fn app_session_spans(
    ro: &ReadOnly,
    vault_id: &str,
    window: &Window,
    limit: usize,
) -> Result<Page<AppSessionSpan>, String> {
    let floor = window.text_floor();
    let mut statement = ro
        .prepare(
            "SELECT opened_at, COALESCE(clean_closed_at, last_heartbeat_at), close_precision, \
             rowid FROM app_sessions \
             WHERE vault_id = ?1 AND opened_at < ?2 \
             AND (?3 IS NULL OR COALESCE(clean_closed_at, last_heartbeat_at) >= ?3) \
             ORDER BY opened_at DESC, rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = statement
        .query(rusqlite::params![vault_id, window.text_ceiling(), floor])
        .map_err(|e| e.to_string())?;
    let read = std::iter::from_fn(|| match rows.next() {
        Ok(Some(row)) => Some(span_of(row)),
        Ok(None) => None,
        Err(e) => Some(Err(e.to_string())),
    })
    .filter_map(|row| match row {
        Ok((opened, until, rowid, span)) => window
            .overlaps(opened, until)
            .then_some(Ok((opened, rowid, span))),
        Err(e) => Some(Err(e)),
    });
    newest_first(read, limit)
}

type TimedSpan = (DateTime<Utc>, DateTime<Utc>, i64, AppSessionSpan);

fn span_of(row: &rusqlite::Row<'_>) -> Result<TimedSpan, String> {
    let get = |e: rusqlite::Error| e.to_string();
    let opened_at: String = row.get(0).map_err(get)?;
    let until: String = row.get(1).map_err(get)?;
    Ok((
        instant("opened_at", &opened_at)?,
        instant("until", &until)?,
        row.get(3).map_err(get)?,
        AppSessionSpan {
            opened_at,
            until,
            precision: row.get(2).map_err(get)?,
        },
    ))
}

/// The stored `first_at` of the vault's earliest recorded write, or None
/// when no write was ever recorded. The text minimum can be off within its
/// second (see the module note), so every row of that second is held to its
/// instant.
pub fn recording_since(ro: &ReadOnly, vault_id: &str) -> Result<Option<String>, String> {
    let least: Option<String> = ro
        .query_row(
            "SELECT MIN(first_at) FROM vault_writes WHERE vault_id = ?1",
            [vault_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let Some(least) = least else {
        return Ok(None);
    };
    let second = instant("first_at", &least)?;
    let mut statement = ro
        .prepare(
            "SELECT first_at FROM vault_writes \
             WHERE vault_id = ?1 AND first_at >= ?2 AND first_at < ?3",
        )
        .map_err(|e| e.to_string())?;
    let candidates = statement
        .query_map(
            rusqlite::params![
                vault_id,
                seconds(second),
                seconds(second + Duration::seconds(1))
            ],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut earliest = (second, least);
    for candidate in candidates {
        let at = instant("first_at", &candidate)?;
        if at < earliest.0 {
            earliest = (at, candidate);
        }
    }
    Ok(Some(earliest.1))
}

/// Every lane for `vault_id` in `window`, each read alone. A vault nothing
/// registered reads empty lanes and no `recording_since`: nothing was
/// recorded, which is what History says.
pub fn vault_activity(ro: &ReadOnly, vault_id: &str, window: &Window) -> VaultActivity {
    VaultActivity {
        writes: write_rows(ro, vault_id, window, None, WRITE_CAP).into(),
        runs: run_rows(ro, vault_id, window, None, RUN_CAP).into(),
        app_sessions: app_session_spans(ro, vault_id, window, SPAN_CAP).into(),
        recording_since: match recording_since(ro, vault_id) {
            Ok(at) => Since::Read { at },
            Err(reason) => Since::Unavailable { reason },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use rusqlite::Connection;

    const CASES: &str = include_str!("../../fixtures/activity-window-cases.json");

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    fn read(dir: &std::path::Path) -> ReadOnly {
        ReadOnly::open(dir).unwrap()
    }

    fn at(text: &str) -> DateTime<Utc> {
        instant("test", text).unwrap()
    }

    fn window(since: &str, until: &str) -> Window {
        Window::parse(since, until).unwrap()
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "a row is these columns; a struct for one test helper is noise"
    )]
    fn wrote(
        conn: &Connection,
        vault: &str,
        kind: &str,
        path: &str,
        to: Option<&str>,
        actor: Option<&str>,
        first_at: &str,
        recorded_at: &str,
    ) {
        conn.execute(
            "INSERT INTO vault_writes (vault_id, kind, path, to_path, content_hash, actor, \
             run_id, approved_by, first_at, recorded_at) \
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, ?6, ?7)",
            rusqlite::params![vault, kind, path, to, actor, first_at, recorded_at],
        )
        .unwrap();
    }

    fn edit(conn: &Connection, vault: &str, path: &str, first_at: &str, recorded_at: &str) {
        wrote(
            conn,
            vault,
            "vault.write",
            path,
            None,
            Some("human:me"),
            first_at,
            recorded_at,
        );
    }

    fn paths(lane: &Page<ActivityWrite>) -> Vec<(&str, &str)> {
        lane.rows
            .iter()
            .map(|w| (w.path.as_str(), w.at.as_str()))
            .collect()
    }

    fn cleanup(dir: &std::path::Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_window_is_parsed_or_refused_in_words() {
        let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
        assert_eq!(cases["max_days"], MAX_DAYS);
        assert_eq!(cases["words"]["backwards"], BACKWARDS);
        assert_eq!(cases["words"]["too_long"], TOO_LONG);
        assert_eq!(
            cases["words"]["not_an_instant"]
                .as_str()
                .unwrap()
                .replace("{value}", "x"),
            not_an_instant("x")
        );
        let list = cases["cases"].as_array().unwrap();
        assert!(list.len() >= 10);
        for case in list {
            let since = case["since"].as_str().unwrap();
            let until = case["until"].as_str().unwrap();
            let got = Window::parse(since, until);
            match case["refusal"].as_str() {
                None => {
                    let w = got.unwrap_or_else(|e| panic!("{case}: {e}"));
                    assert_eq!(
                        w.since,
                        Some(at(case["since_utc"].as_str().unwrap())),
                        "{case}"
                    );
                    assert_eq!(w.until, at(case["until_utc"].as_str().unwrap()), "{case}");
                }
                Some(word) => {
                    let template = cases["words"][word].as_str().unwrap();
                    let expected =
                        template.replace("{value}", case["value"].as_str().unwrap_or(""));
                    assert_eq!(got.err().as_deref(), Some(expected.as_str()), "{case}");
                }
            }
        }
    }

    #[test]
    fn rows_overlapping_the_window_come_newest_first() {
        let (dir, conn, vault) = fixture("activity-overlap");
        // Ends before the window.
        edit(
            &conn,
            &vault,
            "a.md",
            "2026-07-27T08:00:00.000Z",
            "2026-07-27T23:59:59.999Z",
        );
        // A burst that began before the window and ran into it.
        edit(
            &conn,
            &vault,
            "b.md",
            "2026-07-27T23:58:00.000Z",
            "2026-07-28T00:02:00.000Z",
        );
        edit(
            &conn,
            &vault,
            "c.md",
            "2026-07-28T09:00:00.000Z",
            "2026-07-28T09:05:00.000Z",
        );
        // A comment counts, as a comment.
        wrote(
            &conn,
            &vault,
            "vault.comment",
            ".comments/c.md.json",
            None,
            Some("human:owner"),
            "2026-07-28T10:00:00.000Z",
            "2026-07-28T10:00:00.000Z",
        );
        // Starts at the window's end: outside it.
        edit(
            &conn,
            &vault,
            "d.md",
            "2026-07-29T00:00:00.000Z",
            "2026-07-29T00:01:00.000Z",
        );
        let ro = read(&dir);
        let w = window("2026-07-28T00:00:00Z", "2026-07-29T00:00:00Z");
        let page = write_rows(&ro, &vault, &w, None, 100).unwrap();
        assert_eq!(
            paths(&page),
            [
                (".comments/c.md.json", "2026-07-28T10:00:00.000Z"),
                ("c.md", "2026-07-28T09:05:00.000Z"),
                ("b.md", "2026-07-28T00:02:00.000Z"),
            ]
        );
        assert!(!page.more);
        assert_eq!(page.rows[0].kind, "vault.comment");
        assert!(!page.rows[0].content, "a comment changes no page");
        assert!(page.rows[1].content);
        assert_eq!(page.rows[2].first_at, "2026-07-27T23:58:00.000Z");
        drop(ro);
        drop(conn);
        cleanup(&dir);
    }

    #[test]
    fn text_order_never_drops_a_row_at_a_seconds_boundary() {
        let (dir, conn, vault) = fixture("activity-boundary");
        // As text, `.900Z` sorts before `Z`; as time it is later.
        edit(
            &conn,
            &vault,
            "whole.md",
            "2026-07-28T09:00:00Z",
            "2026-07-28T09:00:00Z",
        );
        edit(
            &conn,
            &vault,
            "fraction.md",
            "2026-07-28T09:00:00.900Z",
            "2026-07-28T09:00:00.900Z",
        );
        let ro = read(&dir);
        // A window starting on the whole second still holds the later row.
        let w = window("2026-07-28T09:00:00Z", "2026-07-28T10:00:00Z");
        let all = write_rows(&ro, &vault, &w, None, 10).unwrap();
        assert_eq!(
            paths(&all),
            [
                ("fraction.md", "2026-07-28T09:00:00.900Z"),
                ("whole.md", "2026-07-28T09:00:00Z"),
            ]
        );
        // Cut to one, the newest by time survives, and more says so.
        let one = write_rows(&ro, &vault, &w, None, 1).unwrap();
        assert_eq!(paths(&one), [("fraction.md", "2026-07-28T09:00:00.900Z")]);
        assert!(one.more);
        // A window that ends inside the second holds only the earlier row.
        let early = window("2026-07-28T08:00:00Z", "2026-07-28T09:00:00.500Z");
        let page = write_rows(&ro, &vault, &early, None, 10).unwrap();
        assert_eq!(paths(&page), [("whole.md", "2026-07-28T09:00:00Z")]);
        // And one that starts inside it only the later.
        let late = window("2026-07-28T09:00:00.500Z", "2026-07-28T10:00:00Z");
        let page = write_rows(&ro, &vault, &late, None, 10).unwrap();
        assert_eq!(paths(&page), [("fraction.md", "2026-07-28T09:00:00.900Z")]);
        drop(ro);
        drop(conn);
        cleanup(&dir);
    }

    #[test]
    fn paths_match_a_row_or_its_rename_target() {
        let (dir, conn, vault) = fixture("activity-paths");
        edit(
            &conn,
            &vault,
            "notes/a.md",
            "2026-07-28T09:00:00.000Z",
            "2026-07-28T09:00:00.000Z",
        );
        wrote(
            &conn,
            &vault,
            "vault.rename",
            "notes/old.md",
            Some("notes/a.md"),
            Some("human:me"),
            "2026-07-28T08:00:00.000Z",
            "2026-07-28T08:00:00.000Z",
        );
        edit(
            &conn,
            &vault,
            "notes/b.md",
            "2026-07-28T10:00:00.000Z",
            "2026-07-28T10:00:00.000Z",
        );
        let ro = read(&dir);
        let w = window("2026-07-28T00:00:00Z", "2026-07-29T00:00:00Z");
        let wanted = ["notes/a.md".to_string()];
        let page = write_rows(&ro, &vault, &w, Some(&wanted), 10).unwrap();
        let got: Vec<(&str, Option<&str>)> = page
            .rows
            .iter()
            .map(|w| (w.path.as_str(), w.to.as_deref()))
            .collect();
        assert_eq!(
            got,
            [("notes/a.md", None), ("notes/old.md", Some("notes/a.md"))]
        );
        drop(ro);
        drop(conn);
        cleanup(&dir);
    }

    #[test]
    fn more_is_set_past_the_limit() {
        let (dir, conn, vault) = fixture("activity-more");
        for minute in 0..5 {
            let stamp = format!("2026-07-28T09:0{minute}:00.000Z");
            edit(&conn, &vault, &format!("p{minute}.md"), &stamp, &stamp);
        }
        let ro = read(&dir);
        let w = window("2026-07-28T00:00:00Z", "2026-07-29T00:00:00Z");
        let three = write_rows(&ro, &vault, &w, None, 3).unwrap();
        assert_eq!(
            three
                .rows
                .iter()
                .map(|r| r.path.as_str())
                .collect::<Vec<_>>(),
            ["p4.md", "p3.md", "p2.md"]
        );
        assert!(three.more);
        let five = write_rows(&ro, &vault, &w, None, 5).unwrap();
        assert_eq!(five.rows.len(), 5);
        assert!(!five.more, "exactly the limit leaves nothing unread");
        drop(ro);
        drop(conn);
        cleanup(&dir);
    }

    fn seed_run(
        conn: &Connection,
        vault: &str,
        run_id: &str,
        started_at: &str,
        ended_at: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, \
             ended_at, outcome, usage_state, input_tokens, output_tokens, cache_read, \
             cache_write, reserved_total_tokens, reserved_output_tokens, \
             proposals_submitted, applied, rejected, actor) \
             VALUES (?1, ?2, 'store', 'ambient', 'scheduled', ?3, ?4, \
                     CASE WHEN ?4 IS NULL THEN 'running' ELSE 'succeeded' END, \
                     'exact', 1, 1, 0, 0, 0, 0, 0, 0, 0, 'process:release-scout')",
            rusqlite::params![run_id, vault, started_at, ended_at],
        )
        .unwrap();
    }

    #[test]
    fn runs_overlapping_the_window_read_as_fleet_reads_them() {
        let (dir, conn, vault) = fixture("activity-runs");
        seed_run(
            &conn,
            &vault,
            "before",
            "2026-07-27T08:00:00.000Z",
            Some("2026-07-27T08:05:00.000Z"),
        );
        seed_run(
            &conn,
            &vault,
            "across",
            "2026-07-27T23:50:00.000Z",
            Some("2026-07-28T00:10:00.000Z"),
        );
        seed_run(
            &conn,
            &vault,
            "scout",
            "2026-07-28T09:15:00.000Z",
            Some("2026-07-28T09:19:00.000Z"),
        );
        seed_run(
            &conn,
            &vault,
            "still-going",
            "2026-07-26T09:00:00.000Z",
            None,
        );
        conn.execute(
            "UPDATE runs SET cause = ?1, cli_session_id = 'session-1', writes_booked = 2 \
             WHERE run_id = 'scout'",
            [r#"{"kind":"schedule","subject":null,"detail":"weekdays 08:30","due_at":"2026-07-28T08:30:00.000Z"}"#],
        )
        .unwrap();
        // Another vault's run never reads here.
        let other = crate::runtime::scope::register(&conn, &dir.join("elsewhere")).unwrap();
        seed_run(&conn, &other, "elsewhere", "2026-07-28T09:00:00.000Z", None);
        let ro = read(&dir);
        let w = window("2026-07-28T00:00:00Z", "2026-07-29T00:00:00Z");
        let page = run_rows(&ro, &vault, &w, None, 10).unwrap();
        let ids: Vec<&str> = page.rows.iter().map(|r| r.run.run_id.as_str()).collect();
        assert_eq!(ids, ["scout", "across", "still-going"]);
        let scout = &page.rows[0];
        let fleet = crate::runtime::fleet::runs(
            &ro,
            &crate::runtime::fleet::Filter {
                vault_id: Some(vault.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        let same = fleet.iter().find(|r| r.run_id == "scout").unwrap();
        assert_eq!(&scout.run, same, "the run reads as Fleet reads it");
        assert_eq!(
            scout.run.cause.as_ref().map(|c| c.kind.as_str()),
            Some("schedule")
        );
        assert_eq!(scout.run.cli_session_id.as_deref(), Some("session-1"));
        assert_eq!(scout.writes_booked, 2);
        let only = ["across".to_string()];
        let one = run_rows(&ro, &vault, &w, Some(&only), 10).unwrap();
        assert_eq!(one.rows.len(), 1);
        assert_eq!(one.rows[0].run.run_id, "across");
        drop(ro);
        drop(conn);
        cleanup(&dir);
    }

    fn seed_span(
        conn: &Connection,
        vault: &str,
        session: &str,
        opened_at: &str,
        heartbeat: &str,
        closed: Option<&str>,
        precision: &str,
    ) {
        conn.execute(
            "INSERT INTO app_sessions (session_id, vault_id, store_uuid, opened_at, \
             last_heartbeat_at, clean_closed_at, close_precision) \
             VALUES (?1, ?2, 'store', ?3, ?4, ?5, ?6)",
            rusqlite::params![session, vault, opened_at, heartbeat, closed, precision],
        )
        .unwrap();
    }

    #[test]
    fn spans_end_at_the_clean_close_or_the_last_heartbeat() {
        let (dir, conn, vault) = fixture("activity-spans");
        seed_span(
            &conn,
            &vault,
            "clean",
            "2026-07-27T08:00:00.000Z",
            "2026-07-27T18:00:00.000Z",
            Some("2026-07-27T18:00:00.000Z"),
            "clean_exact",
        );
        seed_span(
            &conn,
            &vault,
            "crashed",
            "2026-07-28T08:00:00.000Z",
            "2026-07-28T09:30:00.000Z",
            None,
            "heartbeat_lower_bound",
        );
        seed_span(
            &conn,
            &vault,
            "old",
            "2026-07-20T08:00:00.000Z",
            "2026-07-20T18:00:00.000Z",
            Some("2026-07-20T18:00:00.000Z"),
            "clean_exact",
        );
        let ro = read(&dir);
        let w = window("2026-07-27T00:00:00Z", "2026-07-29T00:00:00Z");
        let page = app_session_spans(&ro, &vault, &w, 10).unwrap();
        assert_eq!(
            page.rows,
            [
                AppSessionSpan {
                    opened_at: "2026-07-28T08:00:00.000Z".into(),
                    until: "2026-07-28T09:30:00.000Z".into(),
                    precision: "heartbeat_lower_bound".into(),
                },
                AppSessionSpan {
                    opened_at: "2026-07-27T08:00:00.000Z".into(),
                    until: "2026-07-27T18:00:00.000Z".into(),
                    precision: "clean_exact".into(),
                },
            ]
        );
        drop(ro);
        drop(conn);
        cleanup(&dir);
    }

    #[test]
    fn recording_since_is_the_first_write_or_none() {
        let (dir, conn, vault) = fixture("activity-since");
        let ro = read(&dir);
        assert_eq!(recording_since(&ro, &vault).unwrap(), None);
        drop(ro);
        edit(
            &conn,
            &vault,
            "b.md",
            "2026-07-22T09:00:00.000Z",
            "2026-07-22T09:00:00.000Z",
        );
        // The text minimum is `.500Z`, but the whole second came first.
        edit(
            &conn,
            &vault,
            "a.md",
            "2026-07-21T09:00:00.500Z",
            "2026-07-21T09:00:00.500Z",
        );
        edit(
            &conn,
            &vault,
            "a.md",
            "2026-07-21T09:00:00Z",
            "2026-07-21T09:00:00Z",
        );
        let ro = read(&dir);
        assert_eq!(
            recording_since(&ro, &vault).unwrap().as_deref(),
            Some("2026-07-21T09:00:00Z")
        );
        drop(ro);
        drop(conn);
        cleanup(&dir);
    }

    #[test]
    fn an_unregistered_vault_reads_never_recorded() {
        let (dir, conn, vault) = fixture("activity-unregistered");
        edit(
            &conn,
            &vault,
            "a.md",
            "2026-07-28T09:00:00.000Z",
            "2026-07-28T09:00:00.000Z",
        );
        let ro = read(&dir);
        let nobody = crate::runtime::scope::derive_vault_id(&dir.join("never-opened"));
        let w = window("2026-07-28T00:00:00Z", "2026-07-29T00:00:00Z");
        let got = vault_activity(&ro, &nobody, &w);
        assert_eq!(
            got,
            VaultActivity {
                writes: Lane::Read {
                    rows: vec![],
                    more: false
                },
                runs: Lane::Read {
                    rows: vec![],
                    more: false
                },
                app_sessions: Lane::Read {
                    rows: vec![],
                    more: false
                },
                recording_since: Since::Read { at: None },
            }
        );
        let json = serde_json::to_value(&got).unwrap();
        assert_eq!(json["writes"]["state"], "read");
        assert_eq!(json["recording_since"]["state"], "read");
        drop(ro);
        drop(conn);
        cleanup(&dir);
    }

    #[test]
    fn each_lane_fails_alone() {
        let (dir, conn, vault) = fixture("activity-lane-fails");
        edit(
            &conn,
            &vault,
            "a.md",
            "2026-07-28T09:00:00.000Z",
            "2026-07-28T09:00:00.000Z",
        );
        seed_run(
            &conn,
            &vault,
            "scout",
            "2026-07-28T09:15:00.000Z",
            Some("2026-07-28T09:19:00.000Z"),
        );
        conn.execute_batch("DROP TABLE app_sessions").unwrap();
        let ro = read(&dir);
        let w = window("2026-07-28T00:00:00Z", "2026-07-29T00:00:00Z");
        let got = vault_activity(&ro, &vault, &w);
        assert!(
            matches!(&got.app_sessions, Lane::Unavailable { reason } if reason.contains("app_sessions")),
            "{:?}",
            got.app_sessions
        );
        assert!(matches!(&got.writes, Lane::Read { rows, .. } if rows.len() == 1));
        assert!(matches!(&got.runs, Lane::Read { rows, .. } if rows.len() == 1));
        assert_eq!(
            got.recording_since,
            Since::Read {
                at: Some("2026-07-28T09:00:00.000Z".into())
            }
        );
        let json = serde_json::to_value(&got).unwrap();
        assert_eq!(json["app_sessions"]["state"], "unavailable");
        assert_eq!(json["runs"]["rows"][0]["run_id"], "scout");
        assert_eq!(json["runs"]["rows"][0]["writes_booked"], 1);
        drop(ro);
        drop(conn);
        cleanup(&dir);
    }

    /// The read cannot write: no statement runner, no pragma setter and no
    /// writable handle appear in its non-test source, and every top-level
    /// `pub fn` takes the read-only handle.
    #[test]
    fn activity_reads_never_write() {
        let source = include_str!("activity.rs");
        let body = &source[..source.find("#[cfg(test)]").unwrap()];
        for word in ["execute", "execute_batch", "pragma_update", "Connection"] {
            assert!(!body.contains(word), "activity.rs names {word}");
        }
        let mut seen = 0;
        for (i, line) in body.lines().enumerate() {
            if !line.starts_with("pub fn ") {
                continue;
            }
            seen += 1;
            let signature: String = body
                .lines()
                .skip(i)
                .take_while(|l| !l.ends_with('{'))
                .collect();
            assert!(
                signature.contains("ro: &ReadOnly") || line.contains("ro: &ReadOnly"),
                "{line} takes no &ReadOnly"
            );
        }
        assert!(seen >= 5, "found {seen} pub fns");
    }
}
