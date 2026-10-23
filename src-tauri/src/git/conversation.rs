//! A conversation's changes, read back (M92.12).
//!
//! The rail's Changes card sums what a conversation's runs committed, each
//! reply holding its runs' changesets live or cached with the thread
//! (`changeset::settle_run`). A reply rebuilt from Claude Code's session file
//! holds none, so [`changes`] reads them back from Cerebro's own records,
//! through [`ReadOnly`]: the runs that ran as the conversation's session in
//! this vault (`runs.cli_session_id`, `runs.vault_id`), the newest
//! [`MAX_RUNS`] of them, and the commit `run_commits` says each made (M58.4),
//! or, in a vault that keeps no history, what each wrote
//! (`write_log::run_writes`). Then one bounded `git show` per commit, read by
//! the parsers a run's own commit reads its numstat with.
//!
//! **Recorded, never inferred** (CV-35). A run with no `run_commits` row
//! reads not recorded, whatever its commit's trailer says. A vault that keeps
//! no history lists the paths its `vault_writes` rows name. What only the
//! run's own reader knew, who else wrote each file, the mail it kept out of
//! git and whether its shell wrote unrecorded, reads None (CV-05). A run
//! still at work has committed nothing yet, and is left out.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::changeset::{self, ChangedFile, RunChangeset};
use super::command;
use super::workspace::{self, GitWorkspaceInfo};
use crate::runtime::write_log::{self, RunWrites};
use crate::runtime::ReadOnly;

/// The most runs one read takes, the newest; the answer says when it left
/// older ones out.
pub const MAX_RUNS: usize = 100;

/// Why a run in a vault that keeps history reads not recorded: no
/// `run_commits` row names it (CV-35).
pub const NO_COMMIT_RECORDED: &str = "no commit was recorded for this run";

/// Why a run in a vault that keeps no history reads not recorded: none of
/// its page writes was recorded, and its own Write and Edit calls never are.
pub const NO_WRITE_RECORDED: &str = "no page write was recorded for this run";

/// What a conversation's runs changed, read back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConversationChangesets {
    /// One per run, oldest first.
    pub changesets: Vec<RunChangeset>,
    /// More than [`MAX_RUNS`] runs ran as the session: the oldest are left
    /// out.
    pub truncated: bool,
}

/// The changesets of the ended runs that ran as `session_id` in `vault`. A
/// session id that is not one is refused in words, and a commit git cannot
/// read fails the whole read: what the conversation changed is then
/// unavailable, never a guess.
pub fn changes(
    ro: &ReadOnly,
    vault: &Path,
    session_id: &str,
) -> Result<ConversationChangesets, String> {
    if !crate::runtime::cause::is_cli_session_id(session_id) {
        return Err(format!("{session_id:?} is not a Claude Code session id."));
    }
    let vault_id = crate::runtime::scope::derive_vault_id(vault);
    let mut runs = session_runs(ro, &vault_id, session_id)?;
    let truncated = runs.len() > MAX_RUNS;
    runs.truncate(MAX_RUNS);
    runs.reverse();
    let commits = recorded_commits(ro, &vault_id, &runs)?;
    let ws = workspace::resolve(vault);
    let mut changesets = Vec::with_capacity(runs.len());
    for run_id in &runs {
        changesets.push(if !ws.is_repo() {
            without_history(ro, run_id)?
        } else {
            match commits.get(run_id) {
                Some(commit) => read_commit(&ws, run_id, commit)?,
                None => not_recorded(run_id, NO_COMMIT_RECORDED),
            }
        });
    }
    Ok(ConversationChangesets {
        changesets,
        truncated,
    })
}

/// The session's ended runs in this vault, newest first, one more than
/// [`MAX_RUNS`] at most, so a cut list can say so. Read by
/// `runs_by_cli_session` (schema v21); `run_id` breaks a tie in time.
fn session_runs(ro: &ReadOnly, vault_id: &str, session_id: &str) -> Result<Vec<String>, String> {
    let mut statement = ro
        .prepare(
            "SELECT run_id FROM runs WHERE cli_session_id = ?1 AND vault_id = ?2 \
             AND outcome <> 'running' ORDER BY started_at DESC, run_id DESC LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(
            rusqlite::params![session_id, vault_id, (MAX_RUNS + 1) as i64],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// The commit `run_commits` recorded for each of `runs` in this vault, by
/// run. A run commits once; were one recorded twice, its latest stands.
fn recorded_commits(
    ro: &ReadOnly,
    vault_id: &str,
    runs: &[String],
) -> Result<HashMap<String, String>, String> {
    if runs.is_empty() {
        return Ok(HashMap::new());
    }
    let marks: Vec<String> = (0..runs.len()).map(|n| format!("?{}", n + 2)).collect();
    let sql = format!(
        "SELECT run_id, commit_sha FROM run_commits WHERE vault_id = ?1 AND run_id IN ({}) \
         ORDER BY committed_at, rowid",
        marks.join(", ")
    );
    let mut statement = ro.prepare(&sql).map_err(|e| e.to_string())?;
    let params = std::iter::once(vault_id).chain(runs.iter().map(String::as_str));
    let rows = statement
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|e| e.to_string())
}

/// A run's commit as git reads it back: one `git show` under git's local
/// deadline, its files where they sit in the vault, each kind from its raw
/// record's letter and each count from its numstat. Only a full hash, the
/// one spelling `run_commits` holds, reaches git's argv.
fn read_commit(ws: &GitWorkspaceInfo, run_id: &str, commit: &str) -> Result<RunChangeset, String> {
    let full = matches!(commit.len(), 40 | 64)
        && commit
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !full {
        return Err(format!("{commit:?} is not a full commit hash."));
    }
    let out = command::run_bounded_str(
        &ws.dir(),
        &[
            "show",
            "-z",
            "-M",
            "--raw",
            "--numstat",
            "--format=",
            commit,
        ],
        command::LOCAL_TIMEOUT,
    )
    .map_err(|e| format!("reading commit {}: {e}", commit.get(..7).unwrap_or(commit)))?;
    let mut files = Vec::new();
    for row in changeset::parse_raw_numstat_z(&out) {
        let Some(path) = ws.to_vault_relative(&row.numstat.path) else {
            continue;
        };
        let previous_path = row
            .numstat
            .previous_path
            .as_deref()
            .and_then(|old| ws.to_vault_relative(old));
        files.push(ChangedFile {
            kind: changeset::kind_of(row.status, previous_path.is_some()),
            path,
            previous_path,
            additions: row.numstat.additions,
            deletions: row.numstat.deletions,
            also_by: None,
        });
    }
    Ok(changeset::committed(
        run_id,
        commit.to_string(),
        files,
        None,
        None,
    ))
}

/// A run in a vault that keeps no history: the paths its `vault_writes`
/// rows name, mail left out as its commit would leave it out. A run that
/// names none, or whose writes were never booked, is not recorded: its own
/// Write and Edit calls are in no row, so none is never "nothing".
fn without_history(ro: &ReadOnly, run_id: &str) -> Result<RunChangeset, String> {
    let rows = match write_log::run_writes(ro, run_id)? {
        RunWrites::Recorded(rows) | RunWrites::Partial(rows) => rows,
        RunWrites::NotRecorded => {
            return Ok(not_recorded(run_id, changeset::WRITES_NOT_RECORDED));
        }
    };
    let mut files = changeset::run_paths(&rows, &[]);
    files.retain(|path| !crate::policy::mail::is_kept_out_of_git(path));
    if files.is_empty() {
        return Ok(not_recorded(run_id, NO_WRITE_RECORDED));
    }
    Ok(RunChangeset::NotARepo {
        kept_out_of_git: None,
        run_id: run_id.to_string(),
        files,
        shell_unrecorded: None,
    })
}

fn not_recorded(run_id: &str, reason: &str) -> RunChangeset {
    RunChangeset::NotRecorded {
        kept_out_of_git: None,
        run_id: Some(run_id.to_string()),
        reason: reason.to_string(),
        files: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::changeset::{ChangeKind, NumstatRow, SettleRun, ShowRow};
    use crate::runtime::vault_writes::{record_at, WriteRow};
    use crate::vault::testutil;
    use chrono::Utc;
    use rusqlite::Connection;
    use std::path::PathBuf;

    const SESSION: &str = "00000000-0000-4000-8000-000000000092";
    const OTHER_SESSION: &str = "00000000-0000-4000-8000-000000000093";

    /// A vault (with history when asked: its own identity, `a.md`, `b.md`
    /// and `c.md` committed), a separate data dir with a runtime database,
    /// and the vault's id there.
    struct Fixture {
        vault: PathBuf,
        data: PathBuf,
        conn: Connection,
        vault_id: String,
    }

    fn fixture(label: &str, repo: bool) -> Fixture {
        let vault = testutil::temp_vault(label);
        let data = testutil::temp_vault(&format!("{label}-data"));
        for name in ["a", "b", "c"] {
            testutil::write(&vault, &format!("{name}.md"), &format!("# {name}\n"));
        }
        if repo {
            crate::git::commit::init_repo(&vault).unwrap();
            command::run_str(&vault, &["config", "user.email", "t@example.com"]).unwrap();
            command::run_str(&vault, &["config", "user.name", "t"]).unwrap();
        }
        let conn = crate::runtime::open(&data).unwrap();
        let vault_id = crate::runtime::scope::register(&conn, &vault).unwrap();
        Fixture {
            vault,
            data,
            conn,
            vault_id,
        }
    }

    impl Fixture {
        /// A run of `session` in the vault `vault_id`, started `second`s
        /// after nine, ended unless `outcome` is `running`.
        fn run_in(&self, vault_id: &str, run_id: &str, session: &str, second: u32, outcome: &str) {
            let started = format!("2026-10-23T09:{:02}:{:02}Z", second / 60, second % 60);
            let ended = (outcome != "running").then(|| started.clone());
            self.conn
                .execute(
                    "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, \
                     ended_at, outcome, usage_state, input_tokens, output_tokens, cache_read, \
                     cache_write, reserved_total_tokens, reserved_output_tokens, \
                     proposals_submitted, applied, rejected, writes_booked, actor, \
                     cli_session_id) \
                     VALUES (?1, ?2, 'store', 'attended', 'agent', ?3, ?4, ?5, 'exact', 1, 1, \
                     0, 0, 0, 0, 0, 0, 0, 1, 'claude-code', ?6)",
                    rusqlite::params![run_id, vault_id, started, ended, outcome, session],
                )
                .unwrap();
        }

        fn run(&self, run_id: &str, second: u32) {
            self.run_in(&self.vault_id, run_id, SESSION, second, "succeeded");
        }

        fn wrote(&self, path: &str, run_id: &str) {
            record_at(
                &self.conn,
                &self.vault_id,
                &WriteRow {
                    kind: "vault.write",
                    path,
                    to: None,
                    content_hash: None,
                    actor: Some("claude-code"),
                    run_id: Some(run_id),
                    approved_by: None,
                },
                Utc::now(),
            )
            .unwrap();
        }

        /// Record that `run_id` made `commit`, as `changeset::record_commit`
        /// does once its sink is armed.
        fn made(&self, run_id: &str, commit: &str) {
            self.conn
                .execute(
                    "INSERT INTO run_commits (vault_id, commit_sha, run_id, committed_at) \
                     VALUES (?1, ?2, ?3, '2026-10-23T10:00:00.000Z')",
                    rusqlite::params![self.vault_id, commit, run_id],
                )
                .unwrap();
        }

        fn settle(&self, run_id: &str) -> RunChangeset {
            changeset::settle_run(SettleRun {
                vault: &self.vault,
                data_dir: &self.data,
                vault_id: Some(&self.vault_id),
                run_id,
                actor: Some("claude-code"),
                cli_paths: Vec::new(),
                summary: None,
            })
        }

        fn read(&self) -> ConversationChangesets {
            let ro = ReadOnly::open(&self.data).unwrap();
            changes(&ro, &self.vault, SESSION).unwrap()
        }

        fn git(&self, args: &[&str]) -> String {
            command::run_str(&self.vault, args).unwrap()
        }

        fn done(self) {
            drop(self.conn);
            let _ = std::fs::remove_dir_all(&self.vault);
            let _ = std::fs::remove_dir_all(&self.data);
        }
    }

    fn committed_files(changeset: &RunChangeset) -> &[ChangedFile] {
        match changeset {
            RunChangeset::Committed { files, .. } => files,
            other => panic!("expected a commit, got {other:?}"),
        }
    }

    /// One commit, read live as the run settles it and read back later,
    /// says the same paths, kinds and counts; what only the live reader knew
    /// reads back as not recorded.
    #[test]
    fn a_commit_reads_back_as_its_run_settled_it() {
        let f = fixture("m92-heal-agrees", true);
        testutil::write(&f.vault, "a.md", "# a\n\nOne.\nTwo.\n");
        std::fs::remove_file(f.vault.join("c.md")).unwrap();
        testutil::write(&f.vault, "notes/new.md", "# New\n");
        std::fs::write(f.vault.join("logo.png"), b"\x89PNG\0\0\x01").unwrap();
        f.run("run-live", 1);
        for path in ["a.md", "c.md", "notes/new.md", "logo.png"] {
            f.wrote(path, "run-live");
        }
        let live = f.settle("run-live");
        let RunChangeset::Committed {
            commit,
            additions,
            deletions,
            binary,
            ..
        } = &live
        else {
            panic!("expected a commit, got {live:?}");
        };
        f.made("run-live", commit);

        let read = f.read();
        assert!(!read.truncated);
        assert_eq!(read.changesets.len(), 1);
        let healed = &read.changesets[0];
        let shape = |files: &[ChangedFile]| -> Vec<(String, ChangeKind, Option<u64>, Option<u64>)> {
            files
                .iter()
                .map(|f| (f.path.clone(), f.kind, f.additions, f.deletions))
                .collect()
        };
        assert_eq!(
            shape(committed_files(healed)),
            shape(committed_files(&live))
        );
        assert_eq!(
            shape(committed_files(healed)),
            vec![
                ("a.md".to_string(), ChangeKind::Modified, Some(3), Some(0)),
                ("c.md".to_string(), ChangeKind::Deleted, Some(0), Some(1)),
                ("logo.png".to_string(), ChangeKind::Added, None, None),
                (
                    "notes/new.md".to_string(),
                    ChangeKind::Added,
                    Some(1),
                    Some(0)
                ),
            ]
        );
        assert_eq!(
            healed,
            &RunChangeset::Committed {
                kept_out_of_git: None,
                run_id: "run-live".into(),
                commit: commit.clone(),
                files: committed_files(healed).to_vec(),
                additions: *additions,
                deletions: *deletions,
                binary: *binary,
                shell_unrecorded: None,
            }
        );
        assert!(committed_files(healed).iter().all(|f| f.also_by.is_none()));
        // Not recorded is null on the wire, never an empty list, 0 or false.
        let wire = serde_json::to_value(healed).unwrap();
        assert_eq!(wire["kept_out_of_git"], serde_json::Value::Null);
        assert_eq!(wire["shell_unrecorded"], serde_json::Value::Null);
        assert_eq!(wire["files"][0]["also_by"], serde_json::Value::Null);
        f.done();
    }

    #[test]
    fn a_rename_reads_back_as_its_run_settled_it() {
        let f = fixture("m92-heal-rename", true);
        std::fs::rename(f.vault.join("b.md"), f.vault.join("renamed.md")).unwrap();
        f.run("run-move", 1);
        f.wrote("b.md", "run-move");
        f.wrote("renamed.md", "run-move");
        let live = f.settle("run-move");
        let RunChangeset::Committed { commit, .. } = &live else {
            panic!("expected a commit, got {live:?}");
        };
        f.made("run-move", commit);
        let read = f.read();
        let healed = committed_files(&read.changesets[0]);
        let pick = |files: &[ChangedFile]| -> Vec<(String, Option<String>, ChangeKind)> {
            files
                .iter()
                .map(|f| (f.path.clone(), f.previous_path.clone(), f.kind))
                .collect()
        };
        assert_eq!(pick(healed), pick(committed_files(&live)));
        assert_eq!(
            pick(healed),
            vec![(
                "renamed.md".to_string(),
                Some("b.md".to_string()),
                ChangeKind::Renamed
            )]
        );
        f.done();
    }

    /// CV-35: a commit whose trailer names the run, with no `run_commits`
    /// row, is not the run's: the run reads not recorded.
    #[test]
    fn a_run_with_no_commit_record_reads_not_recorded_whatever_its_trailer_says() {
        let f = fixture("m92-heal-trailer", true);
        testutil::write(&f.vault, "a.md", "# a\n\nUnrecorded.\n");
        f.run("run-trailer", 1);
        f.wrote("a.md", "run-trailer");
        f.git(&[
            "commit",
            "-q",
            "-am",
            "assistant: tidy\n\nCerebro-Run: run-trailer\nCerebro-Actor: claude-code",
        ]);
        assert_eq!(
            f.read().changesets,
            vec![RunChangeset::NotRecorded {
                kept_out_of_git: None,
                run_id: Some("run-trailer".into()),
                reason: NO_COMMIT_RECORDED.into(),
                files: vec![],
            }]
        );
        f.done();
    }

    #[test]
    fn a_vault_with_no_history_lists_the_paths_its_runs_wrote() {
        let f = fixture("m92-heal-no-history", false);
        f.run("run-paths", 1);
        f.wrote("notes/b.md", "run-paths");
        f.wrote("a.md", "run-paths");
        f.wrote("sources/mail/kept.md", "run-paths");
        // A run that booked no page write: its own Write and Edit calls are
        // in no row, so it is not recorded, never "nothing".
        f.run("run-quiet", 2);
        assert_eq!(
            f.read().changesets,
            vec![
                RunChangeset::NotARepo {
                    kept_out_of_git: None,
                    run_id: "run-paths".into(),
                    files: vec!["a.md".into(), "notes/b.md".into()],
                    shell_unrecorded: None,
                },
                RunChangeset::NotRecorded {
                    kept_out_of_git: None,
                    run_id: Some("run-quiet".into()),
                    reason: NO_WRITE_RECORDED.into(),
                    files: vec![],
                },
            ]
        );
        f.done();
    }

    #[test]
    fn another_vaults_and_another_sessions_runs_are_left_out() {
        let f = fixture("m92-heal-scoped", false);
        let elsewhere = testutil::temp_vault("m92-heal-scoped-elsewhere");
        let other_vault = crate::runtime::scope::register(&f.conn, &elsewhere).unwrap();
        f.run("run-here", 1);
        f.wrote("a.md", "run-here");
        f.run_in(&other_vault, "run-other-vault", SESSION, 2, "succeeded");
        f.run_in(
            &f.vault_id,
            "run-other-session",
            OTHER_SESSION,
            3,
            "succeeded",
        );
        // Still at work: nothing it changed has landed.
        f.run_in(&f.vault_id, "run-live", SESSION, 4, "running");
        let read = f.read();
        let runs: Vec<Option<&str>> = read
            .changesets
            .iter()
            .map(|c| match c {
                RunChangeset::NotARepo { run_id, .. } => Some(run_id.as_str()),
                RunChangeset::NotRecorded { run_id, .. } => run_id.as_deref(),
                _ => None,
            })
            .collect();
        assert_eq!(runs, vec![Some("run-here")]);
        let _ = std::fs::remove_dir_all(&elsewhere);
        f.done();
    }

    #[test]
    fn the_cap_keeps_the_newest_runs_oldest_first_and_says_so() {
        let f = fixture("m92-heal-cap", false);
        for second in 0..=MAX_RUNS as u32 {
            f.run(&format!("run-{second:03}"), second);
        }
        let read = f.read();
        assert!(read.truncated);
        assert_eq!(read.changesets.len(), MAX_RUNS);
        let ids: Vec<String> = read
            .changesets
            .iter()
            .map(|c| match c {
                RunChangeset::NotRecorded {
                    run_id: Some(id), ..
                } => id.clone(),
                other => panic!("expected not recorded, got {other:?}"),
            })
            .collect();
        assert_eq!(ids.first().map(String::as_str), Some("run-001"));
        assert_eq!(ids.last().map(String::as_str), Some("run-100"));
        f.done();

        let exact = fixture("m92-heal-cap-exact", false);
        for second in 0..MAX_RUNS as u32 {
            exact.run(&format!("run-{second:03}"), second);
        }
        let read = exact.read();
        assert!(!read.truncated);
        assert_eq!(read.changesets.len(), MAX_RUNS);
        exact.done();
    }

    #[test]
    fn a_session_with_no_runs_reads_none_and_a_bad_id_is_refused() {
        let f = fixture("m92-heal-empty", true);
        assert_eq!(
            f.read(),
            ConversationChangesets {
                changesets: vec![],
                truncated: false,
            }
        );
        let ro = ReadOnly::open(&f.data).unwrap();
        for bad in ["", "short", "-starts-with-a-dash", "../../etc/passwd"] {
            assert!(changes(&ro, &f.vault, bad).is_err(), "{bad}");
        }
        drop(ro);
        f.done();
    }

    /// A commit the record names that git no longer has fails the read: the
    /// card says it could not read back, never that nothing changed.
    #[test]
    fn a_commit_git_cannot_read_fails_the_read() {
        let f = fixture("m92-heal-gone", true);
        f.run("run-gone", 1);
        f.made("run-gone", &"e".repeat(40));
        let ro = ReadOnly::open(&f.data).unwrap();
        let failed = changes(&ro, &f.vault, SESSION).unwrap_err();
        assert!(failed.starts_with("reading commit eeeeeee:"), "{failed}");
        drop(ro);
        f.done();
    }

    /// The parser against the git this machine runs: a rename, a binary, a
    /// path with a tab and one that starts with `:`.
    #[test]
    fn the_raw_parser_reads_what_git_writes() {
        let f = fixture("m92-heal-git-shape", true);
        command::run_str(&f.vault, &["mv", "b.md", "moved.md"]).unwrap();
        testutil::write(&f.vault, "a.md", "# a\n\nMore.\n");
        testutil::write(&f.vault, "sp ace/tab\tname.md", "x\n");
        testutil::write(&f.vault, ":colon.md", "y\n");
        std::fs::write(f.vault.join("logo.png"), b"\x89PNG\0\0\x01").unwrap();
        std::fs::remove_file(f.vault.join("c.md")).unwrap();
        f.git(&["add", "-A"]);
        f.git(&["commit", "-q", "-m", "shape"]);
        let head = f.git(&["rev-parse", "HEAD"]);
        let out = f.git(&[
            "show",
            "-z",
            "-M",
            "--raw",
            "--numstat",
            "--format=",
            head.trim(),
        ]);
        let mut rows = changeset::parse_raw_numstat_z(&out);
        rows.sort_by(|a, b| a.numstat.path.cmp(&b.numstat.path));
        let row = |status: char, path: &str, previous: Option<&str>, counts: Option<(u64, u64)>| {
            ShowRow {
                status: Some(status),
                numstat: NumstatRow {
                    path: path.into(),
                    previous_path: previous.map(str::to_string),
                    additions: counts.map(|(adds, _)| adds),
                    deletions: counts.map(|(_, dels)| dels),
                },
            }
        };
        assert_eq!(
            rows,
            vec![
                row('A', ":colon.md", None, Some((1, 0))),
                row('M', "a.md", None, Some((2, 0))),
                row('D', "c.md", None, Some((0, 1))),
                row('A', "logo.png", None, None),
                row('R', "moved.md", Some("b.md"), Some((0, 0))),
                row('A', "sp ace/tab\tname.md", None, Some((1, 0))),
            ]
        );
        f.done();
    }
}
