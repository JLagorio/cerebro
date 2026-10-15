//! The agent's activity read (M64.2c). ReadOnly is the only database handle;
//! time, zone and read scope are supplied by the caller. This does not fold
//! UI sessions or infer edits made outside Cerebro.

use std::collections::BTreeSet;

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use serde_json::{Map, Value};

use super::activity::{self, ActivityRun, ActivityWrite, Window};
use super::write_log::{self, RunWrites};
use super::ReadOnly;
use crate::vault::comments::{page_of_sidecar, sidecar_rel};

pub struct Args {
    window: Window,
    pub path: Option<String>,
    limit: usize,
    capped: bool,
    now: DateTime<Utc>,
}

fn at(raw: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(raw)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|_| format!("{raw} is not an RFC 3339 instant."))
}
fn endpoint(raw: &str) -> String {
    if raw.len() == 10 {
        if let Ok(day) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
            return day.and_hms_opt(0, 0, 0).unwrap().and_utc().to_rfc3339();
        }
    }
    raw.to_string()
}

impl Args {
    pub fn parse(args: &Map<String, Value>, now: DateTime<Utc>) -> Result<Self, String> {
        let from = args
            .get("from")
            .and_then(Value::as_str)
            .ok_or("read_activity needs from: an RFC 3339 time or YYYY-MM-DD.")?;
        let to = match args.get("to") {
            None => now.to_rfc3339(),
            Some(Value::String(to)) => endpoint(to),
            Some(_) => return Err("to must be an RFC 3339 time or YYYY-MM-DD.".into()),
        };
        let window = Window::parse(&endpoint(from), &to)?;
        let limit = match args.get("limit") {
            None => 50,
            Some(value) => value
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or("limit must be a whole number of at least 1.")?,
        };
        let path = match args.get("path") {
            None => None,
            Some(Value::String(path)) if !path.is_empty() => Some(path.clone()),
            Some(_) => return Err("path must be a vault-relative page path.".into()),
        };
        Ok(Self {
            window,
            path,
            limit: limit.min(100) as usize,
            capped: limit > 100,
            now,
        })
    }
}

fn page(path: &str) -> String {
    page_of_sidecar(path).unwrap_or_else(|| path.to_string())
}
fn who(actor: Option<&str>) -> String {
    match actor {
        None => "not recorded who".into(),
        Some(actor) if actor.starts_with("human:") => "you".into(),
        Some(actor) if actor.starts_with("client:") => format!("{} (other app)", &actor[7..]),
        Some("assistant" | "assistant:main" | "interactive") => "the assistant".into(),
        Some(actor) if actor == "claude-code" || actor.starts_with("claude-code/") => {
            "the assistant".into()
        }
        Some(actor) => actor.strip_prefix("process:").unwrap_or(actor).to_string(),
    }
}
fn stamp(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%d %H:%M").to_string()
}
fn span(first: &str, last: &str) -> Result<String, String> {
    let first = at(first)?;
    let last = at(last)?;
    Ok(if first == last {
        format!("{}Z", stamp(first))
    } else if first.date_naive() == last.date_naive() {
        format!("{}–{}Z", stamp(first), last.format("%H:%M"))
    } else {
        format!("{}Z–{}Z", stamp(first), stamp(last))
    })
}
fn write_line(write: &ActivityWrite) -> Result<String, String> {
    let path = page(&write.path);
    let action = match write.kind.as_str() {
        "vault.create" => format!("created {path}"),
        "vault.delete" => format!("deleted {path}"),
        "vault.rename" => match &write.to {
            Some(to) => format!("renamed {path} to {}", page(to)),
            None => format!("renamed {path}; destination not recorded"),
        },
        "vault.comment" => format!("commented on {path}"),
        _ => format!("edited {path}"),
    };
    Ok(format!(
        "- {} · {} · {action}{}",
        span(&write.first_at, &write.at)?,
        who(write.actor.as_deref()),
        if write.approved_by.is_some() {
            " · you allowed it"
        } else {
            ""
        }
    ))
}

fn run_line(
    ro: &ReadOnly,
    run: &ActivityRun,
    may_read: &dyn Fn(&str) -> bool,
) -> Result<String, String> {
    let writes = write_log::run_writes(ro, &run.run.run_id)?;
    let pages = match writes {
        RunWrites::NotRecorded => "pages written: not recorded".into(),
        RunWrites::Recorded(ref writes) | RunWrites::Partial(ref writes) => {
            let mut visible = BTreeSet::new();
            let mut hidden = BTreeSet::new();
            for write in writes {
                // A comment changes its sidecar, never the page. A rename
                // carries one page's identity forward, including its scope.
                if write.kind == "vault.comment" {
                    continue;
                }
                let from = page(&write.path);
                let target = write
                    .to
                    .as_deref()
                    .map(page)
                    .unwrap_or_else(|| from.clone());
                if write.kind == "vault.rename" {
                    visible.remove(&from);
                    hidden.remove(&from);
                }
                if may_read(&from) && may_read(&target) {
                    hidden.remove(&target);
                    visible.insert(target);
                } else {
                    visible.remove(&target);
                    hidden.insert(target);
                }
            }
            let mut words = if visible.is_empty() && hidden.is_empty() {
                "wrote no pages".into()
            } else {
                format!(
                    "wrote {} {}",
                    visible.len(),
                    if visible.len() == 1 { "page" } else { "pages" }
                )
            };
            if !visible.is_empty() {
                let paths: Vec<_> = visible.iter().take(25).map(String::as_str).collect();
                words.push_str(&format!(" · {}", paths.join(", ")));
                if visible.len() > paths.len() {
                    words.push_str(&format!(" and {} more pages", visible.len() - paths.len()));
                }
            }
            if !hidden.is_empty() {
                words.push_str(&format!(
                    " · {} {} withheld outside your read scope",
                    hidden.len(),
                    if hidden.len() == 1 { "page" } else { "pages" }
                ));
            }
            if run.writes_booked == 2 {
                words.push_str(" · shell changes not recorded");
            }
            words
        }
    };
    let time = match &run.run.ended_at {
        Some(end) => span(&run.run.started_at, end)?,
        None => format!("{}Z–now", stamp(at(&run.run.started_at)?)),
    };
    let actor = if run.run.actor.is_none() && run.run.mode == "attended" {
        "the assistant".into()
    } else {
        who(run.run.actor.as_deref())
    };
    Ok(format!(
        "- {time} · {actor} ran ({}) · {} · {pages}",
        run.run.outcome,
        run.run
            .cause
            .as_ref()
            .map_or("why not recorded", |cause| cause.why.as_str())
    ))
}

fn open_line(
    ro: &ReadOnly,
    vault: &str,
    window: &Window,
    tracked: Option<bool>,
    activity_recorded: bool,
) -> String {
    match tracked {
        Some(false) => return "When Cerebro was open is not recorded for this vault.".into(),
        None => return "When Cerebro was open could not be read.".into(),
        Some(true) => {}
    }
    let Ok(spans) = activity::app_session_spans(ro, vault, window, activity::SPAN_CAP) else {
        return "When Cerebro was open could not be read.".into();
    };
    if spans.rows.is_empty() && activity_recorded {
        return "When Cerebro was open is not recorded for this window.".into();
    }
    if spans.rows.is_empty() {
        return "Cerebro was not open in this window, so nothing here was recorded.".into();
    }
    let mut lines = Vec::new();
    for row in spans.rows.iter().take(20) {
        let Ok(start) = at(&row.opened_at) else {
            return "When Cerebro was open could not be read.".into();
        };
        let line = if row.precision == "open" {
            format!("{}Z–now", stamp(start))
        } else {
            match span(&row.opened_at, &row.until) {
                Ok(line) => line,
                Err(_) => return "When Cerebro was open could not be read.".into(),
            }
        };
        lines.push(line);
    }
    lines.reverse();
    let earlier = spans.rows.len().saturating_sub(20);
    let rest = if earlier == 0 && !spans.more {
        String::new()
    } else {
        format!(
            ", and {}{earlier} earlier",
            if spans.more { "at least " } else { "" }
        )
    };
    format!(
        "Cerebro was open {}{rest}; nothing is recorded while it is closed.",
        lines.join(", ")
    )
}

enum Event {
    Write(ActivityWrite),
    Run(Box<ActivityRun>),
}

pub fn read_activity_answer(
    ro: &ReadOnly,
    vault: &str,
    args: &Args,
    may_read: &dyn Fn(&str) -> bool,
    zone: &str,
    tracked: Option<bool>,
) -> Result<String, String> {
    let paths = args
        .path
        .as_ref()
        .map(|path| vec![path.clone(), sidecar_rel(path)]);
    let writes = activity::write_rows(
        ro,
        vault,
        &args.window,
        paths.as_deref(),
        activity::WRITE_CAP,
    )?;
    let run_ids = paths.as_ref().map(|_| {
        writes
            .rows
            .iter()
            .filter_map(|row| row.run_id.clone())
            .collect::<Vec<_>>()
    });
    let runs = activity::run_rows_at(
        ro,
        vault,
        &args.window,
        run_ids.as_deref(),
        activity::RUN_CAP,
        args.now,
    )?;
    let more = writes.more || runs.more;
    let mut withheld = 0;
    let mut events = Vec::new();
    for row in writes.rows {
        if !may_read(&page(&row.path))
            || row.to.as_deref().is_some_and(|path| !may_read(&page(path)))
        {
            withheld += 1;
            continue;
        }
        events.push((at(&row.at)?, Event::Write(row)));
    }
    for row in runs.rows {
        events.push((at(&row.run.started_at)?, Event::Run(Box::new(row))));
    }
    events.sort_by_key(|row| std::cmp::Reverse(row.0));
    let total = events.len();
    let shown = total.min(args.limit);
    let mut lines=vec![format!("Activity from {} to {} (UTC; this machine's zone is {zone}). Showing {shown} of {}{total}.",
        args.window.since.unwrap().to_rfc3339_opts(SecondsFormat::Secs,true),args.window.until.to_rfc3339_opts(SecondsFormat::Secs,true),if more {"at least "}else{""})];
    if total > shown {
        lines.push(format!(
            "— {} more not shown; narrow the window or raise limit (at most 100).",
            total - shown
        ));
    }
    if more {
        lines.push(
            "The activity read reached its cap; narrow the window to count every row.".into(),
        );
    }
    if args.capped {
        lines.push("The requested limit was cut to 100.".into());
    }
    if withheld > 0 {
        lines.push(format!(
            "{withheld} rows withheld: they touch pages outside your read scope."
        ));
    }
    lines.push(open_line(
        ro,
        vault,
        &args.window,
        tracked,
        total > 0 || withheld > 0,
    ));
    for (_, event) in events.iter().take(args.limit) {
        lines.push(match event {
            Event::Write(row) => write_line(row)?,
            Event::Run(row) => run_line(ro, row, may_read)?,
        });
    }
    if total == 0 {
        lines.push(
            if withheld > 0 {
                "No activity within your read scope in this window."
            } else {
                "No recorded activity in this window."
            }
            .into(),
        );
    }
    lines.push(match activity::recording_since(ro, vault) {
        Ok(Some(since)) => format!(
            "Not recorded here: edits made outside Cerebro, and anything before {}.",
            at(&since)?.format("%Y-%m-%d")
        ),
        Ok(None) => "Cerebro has not recorded an edit in this vault yet.".into(),
        Err(_) => {
            "Not recorded here: edits made outside Cerebro. When recording began could not be read."
                .into()
        }
    });
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::path::PathBuf;

    struct Fixture {
        dir: PathBuf,
        conn: Connection,
        vault: String,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = testutil::temp_vault("activity-tool");
            let conn = crate::runtime::open(&dir).unwrap();
            let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
            Self { dir, conn, vault }
        }
        fn write(&self, value: Value) {
            let text = |key: &str| value[key].as_str();
            self.conn.execute("INSERT INTO vault_writes (vault_id,kind,path,to_path,actor,run_id,approved_by,first_at,recorded_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![self.vault,text("kind").unwrap_or("vault.write"),text("path").unwrap_or("notes/a.md"),text("to"),text("actor"),text("run"),text("approved"),text("first").unwrap_or("2026-07-27T14:00:00Z"),text("at").unwrap_or("2026-07-27T14:12:00Z")]).unwrap();
        }
        fn run(&self, id: &str, booked: i64) {
            self.conn.execute("INSERT INTO runs (run_id,vault_id,store_uuid,mode,lane,started_at,ended_at,outcome,usage_state,input_tokens,output_tokens,cache_read,cache_write,reserved_total_tokens,reserved_output_tokens,proposals_submitted,applied,rejected,actor,writes_booked,cause) VALUES (?1,?2,'store','ambient','scheduled','2026-07-28T08:00:00Z','2026-07-28T08:30:00Z','succeeded','exact',1,1,0,0,0,0,0,0,0,'process:release-scout',?3,'{\"kind\":\"schedule\",\"subject\":\"hidden/private.md\"}')",params![id,self.vault,booked]).unwrap();
        }
        fn session(&self) {
            self.conn.execute("INSERT INTO app_sessions (session_id,vault_id,store_uuid,opened_at,last_heartbeat_at,clean_closed_at,close_precision) VALUES ('session-secret',?1,'store','2026-07-27T08:00:00Z','2026-07-27T18:00:00Z','2026-07-27T18:00:00Z','clean_exact')",[&self.vault]).unwrap();
        }
        fn answer(
            &self,
            value: Value,
            allowed: &dyn Fn(&str) -> bool,
            tracked: Option<bool>,
        ) -> String {
            let args = Args::parse(
                value.as_object().unwrap(),
                at("2026-07-29T12:00:00Z").unwrap(),
            )
            .unwrap();
            read_activity_answer(
                &ReadOnly::open(&self.dir).unwrap(),
                &self.vault,
                &args,
                allowed,
                "America/Los_Angeles",
                tracked,
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn window() -> Value {
        json!({"from":"2026-07-27","to":"2026-07-29"})
    }

    #[test]
    fn writes_and_runs_are_newest_first_without_internal_ids() {
        let f = Fixture::new();
        f.session();
        f.run("run-secret", 1);
        f.write(json!({"actor":"human:owner"}));
        f.write(json!({"path":"notes/new.md","actor":"process:release-scout","run":"run-secret","at":"2026-07-28T08:10:00Z","first":"2026-07-28T08:10:00Z","approved":"human:me"}));
        let text = f.answer(window(), &|_| true, Some(true));
        assert!(text.contains("Showing 3 of 3."));
        assert!(text.contains("2026-07-27 14:00–14:12Z · you · edited notes/a.md"));
        assert!(text.contains(
            "release-scout ran (succeeded) · its schedule came due · wrote 1 page · notes/new.md"
        ));
        assert!(
            text.find("08:10Z · release-scout").unwrap() < text.find("ran (succeeded)").unwrap()
        );
        assert!(text.contains("you allowed it"));
        for secret in ["run-secret", "session-secret", "hidden/private.md"] {
            assert!(!text.contains(secret), "{text}");
        }
        assert!(text.contains("UTC; this machine's zone is America/Los_Angeles"));
    }
    #[test]
    fn people_clients_and_missing_attribution_are_honest() {
        let f = Fixture::new();
        for actor in [
            Some("human:me"),
            Some("human:owner"),
            Some("client:terminal"),
            None,
            Some("assistant"),
            Some("construct:ingest"),
        ] {
            f.write(json!({"actor":actor}));
        }
        let text = f.answer(window(), &|_| true, Some(false));
        assert_eq!(text.matches(" · you · ").count(), 2);
        for words in [
            "terminal (other app)",
            "not recorded who",
            "the assistant",
            "construct:ingest",
        ] {
            assert!(text.contains(words));
        }
    }
    #[test]
    fn read_scope_withholds_writes_rename_ends_and_run_pages() {
        let f = Fixture::new();
        f.run("scoped-run", 2);
        f.write(json!({"path":"notes/visible.md","run":"scoped-run"}));
        f.write(json!({"path":"hidden/private.md","run":"scoped-run"}));
        f.write(json!({"kind":"vault.rename","path":"notes/old.md","to":"hidden/new.md"}));
        let text = f.answer(window(), &|path| path.starts_with("notes/"), Some(true));
        assert!(text.contains("2 rows withheld: they touch pages outside your read scope."));
        assert!(text.contains("1 page withheld outside your read scope"));
        assert!(text.contains("shell changes not recorded"));
        assert!(!text.contains("hidden/"));
        assert!(!text.contains("notes/old.md"));
        assert!(text.contains("wrote 1 page · notes/visible.md"));
    }
    #[test]
    fn comments_use_the_page_and_path_reads_include_its_sidecar() {
        let f = Fixture::new();
        f.write(json!({"path":".comments/notes/a.md.json","kind":"vault.comment"}));
        f.write(json!({"path":"notes/other.md"}));
        let text = f.answer(
            json!({"from":"2026-07-27","to":"2026-07-29","path":"notes/a.md"}),
            &|p| p.starts_with("notes/"),
            Some(true),
        );
        assert!(text.contains("Showing 1 of 1"));
        assert!(text.contains("commented on notes/a.md"));
        assert!(!text.contains(".comments/"));
        assert!(!text.contains("other.md"));
    }
    #[test]
    fn open_closed_untracked_and_failed_spans_are_distinct() {
        let f = Fixture::new();
        f.session();
        assert!(f.answer(window(), &|_| true, Some(true)).contains(
            "Cerebro was open 2026-07-27 08:00–18:00Z; nothing is recorded while it is closed."
        ));
        assert!(f
            .answer(
                json!({"from":"2026-07-25","to":"2026-07-26"}),
                &|_| true,
                Some(true)
            )
            .contains("Cerebro was not open in this window, so nothing here was recorded."));
        assert!(f
            .answer(window(), &|_| true, Some(false))
            .contains("When Cerebro was open is not recorded for this vault."));
        f.conn.execute("DROP TABLE app_sessions", []).unwrap();
        assert!(f
            .answer(window(), &|_| true, Some(true))
            .contains("When Cerebro was open could not be read."));
    }
    #[test]
    fn limit_truncation_is_named_and_a_date_is_restated_as_utc() {
        let f = Fixture::new();
        for i in 0..60 {
            f.write(json!({"path":format!("notes/{i}.md")}));
        }
        let text = f.answer(window(), &|_| true, Some(true));
        assert!(text.contains("Showing 50 of 60."));
        assert!(text.contains("— 10 more not shown;"));
        assert!(text.contains("Activity from 2026-07-27T00:00:00Z to 2026-07-29T00:00:00Z"));
        let text = f.answer(
            json!({"from":"2026-07-27","to":"2026-07-29","limit":101}),
            &|_| true,
            Some(true),
        );
        assert!(text.contains("Showing 60 of 60."));
        assert!(text.contains("The requested limit was cut to 100."));
    }
    #[test]
    fn invalid_windows_and_limits_are_refused_before_a_read() {
        for value in [
            json!({}),
            json!({"from":"bad"}),
            json!({"from":"2026-07-29","to":"2026-07-27"}),
            json!({"from":"2025-01-01","to":"2026-07-29"}),
            json!({"from":"2026-07-27","limit":0}),
            json!({"from":"2026-07-27","limit":1.2}),
            json!({"from":"2026-07-27","path":42}),
        ] {
            assert!(Args::parse(
                value.as_object().unwrap(),
                at("2026-07-29T00:00:00Z").unwrap()
            )
            .is_err());
        }
    }
    #[test]
    fn missing_writes_are_not_zero_and_the_trailer_names_blind_spots() {
        let f = Fixture::new();
        f.run("old-run", 0);
        let text = f.answer(window(), &|_| true, Some(true));
        assert!(text.contains("pages written: not recorded"));
        assert!(text.contains("Cerebro has not recorded an edit in this vault yet."));
        f.write(json!({}));
        assert!(f.answer(window(), &|_| true, Some(true)).contains(
            "Not recorded here: edits made outside Cerebro, and anything before 2026-07-27."
        ));
    }
    #[test]
    fn run_pages_exclude_comments_and_follow_a_rename_once() {
        let f = Fixture::new();
        f.run("move-run", 1);
        f.write(json!({"kind":"vault.comment","path":".comments/notes/comment.md.json","run":"move-run"}));
        assert!(f
            .answer(window(), &|_| true, Some(true))
            .contains("wrote no pages"));
        f.write(json!({"path":"notes/old.md","run":"move-run"}));
        f.write(json!({"kind":"vault.rename","path":"notes/old.md","to":"notes/new.md","run":"move-run"}));
        let answer = f.answer(window(), &|_| true, Some(true));
        let run = answer.lines().find(|line| line.contains(" ran ")).unwrap();
        assert!(run.contains("wrote 1 page · notes/new.md"), "{run}");
        assert!(!run.contains("old.md"));
        assert!(!run.contains("comment.md"));
    }
    #[test]
    fn withheld_only_is_not_empty_and_old_rows_do_not_claim_the_app_was_closed() {
        let f = Fixture::new();
        f.write(json!({"path":"hidden/a.md"}));
        let answer = f.answer(window(), &|_| false, Some(true));
        assert!(answer.contains("1 rows withheld"));
        assert!(answer.contains("No activity within your read scope in this window."));
        assert!(!answer.contains("No recorded activity"));
        assert!(!answer.contains("Cerebro was not open"));
        assert!(answer.contains("When Cerebro was open is not recorded for this window."));
    }
}
