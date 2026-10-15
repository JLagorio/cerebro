//! A run's changeset: each run commits only what it wrote (M58.3).
//!
//! **Ownership.** A run that may write claims its vault before its reader
//! starts ([`claim_run`]); the claim lasts until the run's commit has landed,
//! and is let go on Drop, a panic included. While it stands, the paths the
//! run wrote are its own: the ones its `vault_writes` rows name
//! (`write_log::run_writes`) and the ones its own Write and Edit calls wrote,
//! noted as each call completes (`RunClaim::note_cli_write`, from
//! `agent::cli_writes`; a deferred call's goes with the run that resumes it).
//! [`owned_paths`] is that map, and every other commit leaves those paths
//! alone (`commit::commit_all`), so a checkpoint never sweeps a live run's
//! half work into the person's commit. It runs no query when no run is live.
//!
//! **Settling.** When the run ends, [`settle_run`] commits exactly those
//! paths through `commit::commit_paths_in`, under the repository's lock, with
//! `Cerebro-Run`, `Cerebro-Actor` and `Cerebro-Ledger-Head` trailers for
//! people reading `git log`, and reads back what the commit changed from git's
//! own numstat. A binary file's counts are absent, never 0, and a total that
//! has only binaries to count is absent too (CV-05). `commit --only` takes a
//! path's whole diff, so an edit from before the run rides along: the people
//! who wrote a path since its last commit are named beside it
//! (`write_log::writers_since`). A run whose writes were never recorded reads
//! not_recorded, never "nothing"; a vault with no history lists the files
//! without counts; and a git failure lists them as unavailable.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::command;
use super::commit;
use super::status::{self, FileStatus};
use super::workspace::{self, GitWorkspaceInfo};
use crate::runtime::write_log::{self, RunWrites};
use crate::runtime::ReadOnly;

/// How long a run's commit waits for a checkpoint, a pull or another run's
/// commit to let go of the repository before it says History was busy.
pub const BUSY_WAIT: Duration = Duration::from_secs(5);

/// What a run's commit says when the repository stayed busy past
/// [`BUSY_WAIT`].
pub const BUSY: &str = "History was busy";

/// The longest commit subject, in characters, its ellipsis included.
pub const SUBJECT_CHARS: usize = 72;

/// The live run that owns a path (M58.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub run_id: String,
    pub actor: String,
}

/// One live run's claim on its vault.
struct LiveClaim {
    /// Canonical, so every spelling of the vault finds it.
    vault: PathBuf,
    /// Where the run's runtime database lives.
    data_dir: PathBuf,
    owner: Owner,
    /// The vault-relative paths its own Write and Edit calls named.
    cli: BTreeSet<String>,
}

fn claims() -> MutexGuard<'static, HashMap<u64, LiveClaim>> {
    static CLAIMS: OnceLock<Mutex<HashMap<u64, LiveClaim>>> = OnceLock::new();
    CLAIMS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn canonical(vault: &Path) -> PathBuf {
    std::fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf())
}

/// A live run's hold on the paths it writes. Released on Drop, a panic
/// included, so a run that dies never pins its paths.
pub struct RunClaim {
    id: u64,
    vault: PathBuf,
}

/// Claim `vault` for the run `run_id`, which runs as `actor` and books its
/// writes in `data_dir`'s runtime database.
pub fn claim_run(vault: &Path, data_dir: &Path, run_id: &str, actor: &str) -> RunClaim {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let vault = canonical(vault);
    claims().insert(
        id,
        LiveClaim {
            vault: vault.clone(),
            data_dir: data_dir.to_path_buf(),
            owner: Owner {
                run_id: run_id.to_string(),
                actor: actor.to_string(),
            },
            cli: BTreeSet::new(),
        },
    );
    RunClaim { id, vault }
}

impl RunClaim {
    /// Note a path the run's own Write or Edit named. `rel` is spelled as the
    /// scan lists it (`agent::cli_writes` lands it); one outside the vault, or
    /// under `.git/` or `.cerebro/`, is dropped.
    pub fn note_cli_write(&self, rel: &str) {
        if !keeps(rel) {
            return;
        }
        if let Some(claim) = claims().get_mut(&self.id) {
            claim.cli.insert(rel.to_string());
        }
    }

    /// The paths its own Write and Edit calls named, in order.
    pub fn cli_paths(&self) -> Vec<String> {
        claims()
            .get(&self.id)
            .map(|claim| claim.cli.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// The vault it claims, canonical.
    pub fn vault(&self) -> &Path {
        &self.vault
    }
}

impl Drop for RunClaim {
    fn drop(&mut self) {
        claims().remove(&self.id);
    }
}

/// Every path a live run in `vault` owns, with its run (M58.3): the paths
/// its `vault_writes` rows name, a rename's both ends, and the paths its own
/// Write and Edit calls named. The first claim to name a path keeps it. No
/// live run is no query.
pub fn owned_paths(vault: &Path) -> HashMap<String, Owner> {
    let key = canonical(vault);
    // Copied out, so the registry's lock is never held across a read.
    let live: Vec<(PathBuf, Owner, Vec<String>)> = claims()
        .values()
        .filter(|claim| claim.vault == key)
        .map(|claim| {
            (
                claim.data_dir.clone(),
                claim.owner.clone(),
                claim.cli.iter().cloned().collect(),
            )
        })
        .collect();
    let mut owned = HashMap::new();
    if live.is_empty() {
        return owned;
    }
    let mut readers: HashMap<PathBuf, Option<ReadOnly>> = HashMap::new();
    for (data_dir, owner, cli) in live {
        let ro = readers
            .entry(data_dir.clone())
            .or_insert_with(|| ReadOnly::open(&data_dir).ok());
        let rows = ro
            .as_ref()
            .and_then(|ro| write_log::run_writes(ro, &owner.run_id).ok());
        let mut paths = cli;
        if let Some(RunWrites::Recorded(rows) | RunWrites::Partial(rows)) = rows {
            for row in rows {
                paths.push(row.path);
                paths.extend(row.to);
            }
        }
        for path in paths.into_iter().filter(|p| keeps(p)) {
            owned.entry(path).or_insert_with(|| owner.clone());
        }
    }
    owned
}

/// Is `rel` a path a run's commit may take: vault-relative, never escaping,
/// and outside `.git/` and `.cerebro/`?
fn keeps(rel: &str) -> bool {
    if rel.is_empty() || rel.starts_with('/') || rel.starts_with('\\') {
        return false;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|part| *part == ".." || *part == ".git") {
        return false;
    }
    parts[0] != ".cerebro"
}

/// A run's paths: its rows' paths and renames' both ends, then its CLI
/// paths, each once, sorted, minus anything [`keeps`] refuses.
pub fn run_paths(rows: &[write_log::PageWrite], cli: &[String]) -> Vec<String> {
    let mut paths = BTreeSet::new();
    for row in rows {
        paths.insert(row.path.clone());
        if let Some(to) = &row.to {
            paths.insert(to.clone());
        }
    }
    paths.extend(cli.iter().cloned());
    paths.into_iter().filter(|p| keeps(p)).collect()
}

/// How a file changed in a run's commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// One file of a run's commit. A binary file's counts are None.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangedFile {
    pub path: String,
    pub previous_path: Option<String>,
    pub kind: ChangeKind,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    /// Other actors who wrote this path since its last commit: their edits
    /// ride in this commit too.
    pub also_by: Vec<String>,
}

/// What a run changed, as its panel's footer reads it. Tagged by `state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RunChangeset {
    /// The run's own commit, under its full hash. A total is None when every
    /// file it counts is binary; `binary` counts the binary files.
    Committed {
        run_id: String,
        commit: String,
        files: Vec<ChangedFile>,
        additions: Option<u64>,
        deletions: Option<u64>,
        binary: u64,
        shell_unrecorded: bool,
    },
    /// The run wrote nothing, or wrote the bytes that were already there.
    Nothing {
        run_id: String,
        shell_unrecorded: bool,
    },
    /// Nobody recorded what the run wrote: a run with no durable id, or one
    /// from before its writes were booked.
    NotRecorded {
        run_id: Option<String>,
        reason: String,
        files: Vec<String>,
    },
    /// The vault keeps no history, so there are files and no counts.
    NotARepo {
        run_id: String,
        files: Vec<String>,
        shell_unrecorded: bool,
    },
    /// The commit could not be made or read back.
    Unavailable {
        run_id: String,
        reason: String,
        files: Vec<String>,
        shell_unrecorded: bool,
    },
}

/// One row of `git show --numstat -z -M`: a binary file reads `-` for both
/// counts, which is None here, never 0.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumstatRow {
    pub path: String,
    pub previous_path: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

/// Parse `--numstat -z` output. A plain record is `adds\tdels\tpath\0`; a
/// rename leaves the path empty and follows it with `old\0new\0`.
pub fn parse_numstat_z(out: &str) -> Vec<NumstatRow> {
    let count = |raw: &str| raw.trim().parse::<u64>().ok();
    let mut rows = Vec::new();
    let mut fields = out.split('\0');
    while let Some(record) = fields.next() {
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, '\t');
        let (Some(adds), Some(dels), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (path, previous_path) = if path.is_empty() {
            let (Some(old), Some(new)) = (fields.next(), fields.next()) else {
                break;
            };
            (new.to_string(), Some(old.to_string()))
        } else {
            (path.to_string(), None)
        };
        rows.push(NumstatRow {
            path,
            previous_path,
            additions: count(adds),
            deletions: count(dels),
        });
    }
    rows
}

/// The label a run's commit subject opens with: an agent's handle, the
/// assistant, or a construct's name.
fn label_of(actor: &str) -> String {
    if let Some(handle) = actor.strip_prefix("process:") {
        return handle.to_string();
    }
    if actor == crate::mcp::DEFAULT_ACTOR {
        return "assistant".to_string();
    }
    if let Some(construct) = actor.strip_prefix("agent:m26-") {
        return construct.to_string();
    }
    actor.to_string()
}

/// A run's commit subject: `<label>: <summary>`, at most [`SUBJECT_CHARS`]
/// characters. `summary`'s first line when it has one, else
/// "changed N files".
pub fn run_commit_message(actor: &str, summary: Option<&str>, files: usize) -> String {
    let said = summary
        .and_then(|s| s.lines().map(str::trim).find(|line| !line.is_empty()))
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "changed {files} {}",
                if files == 1 { "file" } else { "files" }
            )
        });
    let subject = format!("{}: {said}", label_of(actor));
    if subject.chars().count() <= SUBJECT_CHARS {
        return subject;
    }
    let mut cut: String = subject.chars().take(SUBJECT_CHARS - 1).collect();
    cut = cut.trim_end().to_string();
    cut.push('\u{2026}');
    cut
}

/// The subject with its trailers: the run, its actor, and the ledger's head
/// when the vault keeps one.
fn with_trailers(subject: &str, run_id: &str, actor: &str, ledger_head: Option<&str>) -> String {
    let mut message = format!("{subject}\n\nCerebro-Run: {run_id}\nCerebro-Actor: {actor}");
    if let Some(head) = ledger_head {
        message.push_str(&format!("\nCerebro-Ledger-Head: {head}"));
    }
    message
}

/// What `settle_run` needs to know about one ended run.
pub struct SettleRun<'a> {
    pub vault: &'a Path,
    pub data_dir: &'a Path,
    /// The vault's runtime id, when the meter knew it.
    pub vault_id: Option<&'a str>,
    pub run_id: &'a str,
    /// The run's actor, when the meter knew it; else its row's, else the
    /// assistant's.
    pub actor: Option<&'a str>,
    /// The paths its own Write and Edit calls named (`RunClaim::cli_paths`).
    pub cli_paths: Vec<String>,
    /// What a person asked, for an attended run: its first line is the
    /// commit's summary.
    pub summary: Option<String>,
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// What a quit run's changeset says: Cerebro was quitting, so git was left
/// untouched (no `index.lock` left behind), and the next checkpoint takes
/// its files.
pub const QUITTING: &str = "Cerebro was quitting";

/// A run's recorded paths: its runtime database (when it opened), the paths,
/// whether the shell may have written more, and whether its writes were
/// recorded at all.
fn recorded(run: &SettleRun<'_>) -> (Result<ReadOnly, String>, Vec<String>, bool, bool) {
    let ro = ReadOnly::open(run.data_dir);
    let recorded = match &ro {
        Ok(ro) => write_log::run_writes(ro, run.run_id).ok(),
        Err(_) => None,
    };
    let (rows, shell_unrecorded, known) = match recorded {
        Some(RunWrites::Recorded(rows)) => (rows, false, true),
        Some(RunWrites::Partial(rows)) => (rows, true, true),
        Some(RunWrites::NotRecorded) | None => (Vec::new(), false, false),
    };
    let files = run_paths(&rows, &run.cli_paths);
    (ro, files, shell_unrecorded, known)
}

/// A run that ended while Cerebro quit: its files, uncommitted, and why.
pub fn quitting(run: SettleRun<'_>) -> RunChangeset {
    let (_, files, shell_unrecorded, _) = recorded(&run);
    RunChangeset::Unavailable {
        run_id: run.run_id.to_string(),
        reason: QUITTING.into(),
        files,
        shell_unrecorded,
    }
}

/// Settle one ended run (M58.3): commit what it wrote and say what changed.
/// See the module note for each state.
pub fn settle_run(run: SettleRun<'_>) -> RunChangeset {
    let (ro, files, shell_unrecorded, known) = recorded(&run);
    let run_id = run.run_id.to_string();
    if files.is_empty() {
        return if known {
            RunChangeset::Nothing {
                run_id,
                shell_unrecorded,
            }
        } else {
            RunChangeset::NotRecorded {
                run_id: Some(run_id),
                reason: "this run's writes were not recorded".into(),
                files,
            }
        };
    }
    let ws = workspace::resolve(run.vault);
    if !ws.is_repo() {
        return RunChangeset::NotARepo {
            run_id,
            files,
            shell_unrecorded,
        };
    }
    let identity = ro
        .as_ref()
        .ok()
        .and_then(|ro| write_log::run_identity(ro, run.run_id).ok().flatten());
    let actor = run
        .actor
        .map(str::to_string)
        .or_else(|| identity.as_ref().and_then(|run| run.actor.clone()))
        .unwrap_or_else(|| crate::mcp::DEFAULT_ACTOR.to_string());
    // An unattended run says why it started; an attended one, what was asked.
    let summary = run.summary.clone().or_else(|| {
        let cause = identity.as_ref().and_then(|run| run.cause.as_deref())?;
        let view = crate::runtime::cause::view_of_column(cause)?;
        (view.kind != crate::runtime::cause::CauseKind::Attended.as_str()).then_some(view.why)
    });
    let vault_id = run
        .vault_id
        .map(str::to_string)
        .unwrap_or_else(|| crate::runtime::scope::derive_vault_id(run.vault));
    let commit = Commit {
        ws: &ws,
        ro: ro.as_ref().ok(),
        vault_id: &vault_id,
        run_id: run.run_id,
        actor: &actor,
        summary: summary.as_deref(),
        files: &files,
        shell_unrecorded,
    };
    commit
        .make()
        .unwrap_or_else(|reason| RunChangeset::Unavailable {
            run_id,
            reason,
            files,
            shell_unrecorded,
        })
}

/// One run's commit, being made.
struct Commit<'a> {
    ws: &'a GitWorkspaceInfo,
    ro: Option<&'a ReadOnly>,
    vault_id: &'a str,
    run_id: &'a str,
    actor: &'a str,
    summary: Option<&'a str>,
    files: &'a [String],
    shell_unrecorded: bool,
}

impl Commit<'_> {
    fn make(&self) -> Result<RunChangeset, String> {
        let ws = self.ws;
        let dir = ws.dir();
        let lock = commit::repo_lock(&dir);
        let Some(_held) = commit::hold_within(&lock, BUSY_WAIT) else {
            return Err(BUSY.into());
        };
        // Read before committing: how each path stood, and when it was last
        // committed, which is where "who else wrote it" starts.
        let before: HashMap<String, FileStatus> = status::records(ws)?
            .into_iter()
            .map(|record| (record.git_path, record.status))
            .collect();
        let changed = self
            .files
            .iter()
            .filter(|p| before.contains_key(&ws.to_git_relative(p)))
            .count();
        let since: BTreeMap<&str, Option<String>> = self
            .files
            .iter()
            .map(|p| (p.as_str(), last_committed(ws, p)))
            .collect();
        let head = crate::ledger::head(Path::new(&ws.vault_root)).map(|h| h.hash);
        let subject = run_commit_message(self.actor, self.summary, changed.max(1));
        let message = with_trailers(&subject, self.run_id, self.actor, head.as_deref());
        let Some(hash) = commit::commit_paths_in(ws, self.files, &message)? else {
            return Ok(RunChangeset::Nothing {
                run_id: self.run_id.to_string(),
                shell_unrecorded: self.shell_unrecorded,
            });
        };
        record_commit(self.vault_id, &hash, self.run_id);
        let until = stamp(Utc::now());
        let numstat = command::run_bounded_str(
            &dir,
            &["show", "--numstat", "-z", "-M", "--format=", &hash],
            command::LOCAL_TIMEOUT,
        )?;
        let mut files = Vec::new();
        for row in parse_numstat_z(&numstat) {
            let Some(path) = ws.to_vault_relative(&row.path) else {
                continue;
            };
            let previous_path = row
                .previous_path
                .as_deref()
                .and_then(|old| ws.to_vault_relative(old));
            let kind = if previous_path.is_some() {
                ChangeKind::Renamed
            } else {
                match before.get(&row.path) {
                    Some(FileStatus::Added | FileStatus::Untracked) => ChangeKind::Added,
                    Some(FileStatus::Deleted) => ChangeKind::Deleted,
                    Some(FileStatus::Renamed) => ChangeKind::Renamed,
                    _ => ChangeKind::Modified,
                }
            };
            let also_by = self.also_by(&path, since.get(path.as_str()).cloned().flatten(), &until);
            files.push(ChangedFile {
                path,
                previous_path,
                kind,
                additions: row.additions,
                deletions: row.deletions,
                also_by,
            });
        }
        let counted: Vec<&ChangedFile> = files.iter().filter(|f| f.additions.is_some()).collect();
        let total = |pick: fn(&ChangedFile) -> Option<u64>| {
            (!counted.is_empty()).then(|| counted.iter().filter_map(|f| pick(f)).sum())
        };
        Ok(RunChangeset::Committed {
            run_id: self.run_id.to_string(),
            commit: hash,
            additions: total(|f| f.additions),
            deletions: total(|f| f.deletions),
            binary: (files.len() - counted.len()) as u64,
            files,
            shell_unrecorded: self.shell_unrecorded,
        })
    }

    /// The other actors who wrote `path` between its last commit and now,
    /// this run left out.
    fn also_by(&self, path: &str, since: Option<String>, until: &str) -> Vec<String> {
        let Some(ro) = self.ro else {
            return Vec::new();
        };
        let mut actors: Vec<String> = Vec::new();
        for writer in write_log::writers_since(ro, self.vault_id, path, since.as_deref(), until)
            .unwrap_or_default()
        {
            if writer.run_id.as_deref() == Some(self.run_id) || actors.contains(&writer.actor) {
                continue;
            }
            actors.push(writer.actor);
        }
        actors
    }
}

/// Record that `run_id` made `commit` (M58.4, CV-35): the one row History
/// names an agent from, written here, right after `git commit` handed back
/// the full hash, and nowhere else. Best-effort like every sink write: an
/// unarmed sink, or a run the meter never recorded, records nothing and the
/// commit reads "unattributed", never a guess.
fn record_commit(vault_id: &str, commit: &str, run_id: &str) {
    crate::runtime::sink::with_sink(|conn| {
        if let Err(e) = conn.execute(
            "INSERT INTO run_commits (vault_id, commit_sha, run_id, committed_at) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![vault_id, commit, run_id, crate::runtime::now_utc()],
        ) {
            log::warn!("run_commits: could not record {commit}: {e}");
        }
    });
}

/// When `path` was last committed, in the stored spelling, or None when it
/// never was (or git could not say).
fn last_committed(ws: &GitWorkspaceInfo, path: &str) -> Option<String> {
    let git_path = ws.to_git_relative(path);
    let out = command::run_str(
        &ws.dir(),
        &[
            "--literal-pathspecs",
            "log",
            "-1",
            "--format=%cI",
            "--",
            &git_path,
        ],
    )
    .ok()?;
    let at = DateTime::parse_from_rfc3339(out.trim()).ok()?;
    Some(stamp(at.with_timezone(&Utc)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::vault_writes::{record_at, WriteRow};
    use crate::vault::testutil;
    use rusqlite::Connection;

    /// A vault that keeps history (its own identity, `a.md`, `b.md` and
    /// `c.md` committed), a separate data dir with a runtime database, and
    /// the vault's id there.
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
            commit::init_repo(&vault).unwrap();
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
        fn run(&self, run_id: &str, actor: &str, booked: i64) {
            self.conn
                .execute(
                    "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, \
                     ended_at, outcome, usage_state, input_tokens, output_tokens, cache_read, \
                     cache_write, reserved_total_tokens, reserved_output_tokens, \
                     proposals_submitted, applied, rejected, writes_booked, actor) \
                     VALUES (?1, ?2, 'store', 'ambient', 'scheduled', '2026-10-14T09:00:00Z', \
                     '2026-10-14T09:01:00Z', 'succeeded', 'exact', 1, 1, 0, 0, 0, 0, 0, 0, 0, \
                     ?3, ?4)",
                    rusqlite::params![run_id, self.vault_id, booked, actor],
                )
                .unwrap();
        }

        fn wrote(&self, kind: &str, path: &str, actor: &str, run_id: Option<&str>) {
            record_at(
                &self.conn,
                &self.vault_id,
                &WriteRow {
                    kind,
                    path,
                    to: None,
                    content_hash: None,
                    actor: Some(actor),
                    run_id,
                    approved_by: None,
                },
                Utc::now(),
            )
            .unwrap();
        }

        fn settle(&self, run_id: &str, cli: Vec<String>) -> RunChangeset {
            settle_run(SettleRun {
                vault: &self.vault,
                data_dir: &self.data,
                vault_id: Some(&self.vault_id),
                run_id,
                actor: None,
                cli_paths: cli,
                summary: None,
            })
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

    fn committed(changeset: &RunChangeset) -> (&str, &[ChangedFile]) {
        match changeset {
            RunChangeset::Committed { commit, files, .. } => (commit, files),
            other => panic!("expected a commit, got {other:?}"),
        }
    }

    #[test]
    fn parse_numstat_z_reads_counts_binaries_and_renames() {
        let out = concat!(
            "3\t1\tnotes/a.md\0",
            "-\t-\timg/logo.png\0",
            "0\t0\t\0old/b.md\0new/b.md\0"
        );
        assert_eq!(
            parse_numstat_z(out),
            vec![
                NumstatRow {
                    path: "notes/a.md".into(),
                    previous_path: None,
                    additions: Some(3),
                    deletions: Some(1),
                },
                NumstatRow {
                    path: "img/logo.png".into(),
                    previous_path: None,
                    additions: None,
                    deletions: None,
                },
                NumstatRow {
                    path: "new/b.md".into(),
                    previous_path: Some("old/b.md".into()),
                    additions: Some(0),
                    deletions: Some(0),
                },
            ]
        );
        assert!(parse_numstat_z("").is_empty());
    }

    /// The roadmap's case: three files changed, the run wrote two, and the
    /// commit holds exactly those two while the third stays modified.
    #[test]
    fn a_run_commit_takes_only_its_paths() {
        let f = fixture("m58-only-its-paths", true);
        for name in ["a", "b", "c"] {
            testutil::write(
                &f.vault,
                &format!("{name}.md"),
                &format!("# {name}\n\nMore.\n"),
            );
        }
        f.run("run-1", "process:scout", 1);
        f.wrote("vault.write", "a.md", "process:scout", Some("run-1"));
        f.wrote("vault.write", "b.md", "process:scout", Some("run-1"));
        let changeset = f.settle("run-1", vec![]);
        let (hash, files) = committed(&changeset);
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, vec!["a.md", "b.md"]);
        let named = f.git(&["show", "--name-only", "--format=", hash]);
        assert_eq!(named.lines().collect::<Vec<_>>(), vec!["a.md", "b.md"]);
        let left = f.git(&["status", "--porcelain"]);
        assert_eq!(left.trim(), "M c.md", "the third file stays modified");
        assert_eq!(
            files[0],
            ChangedFile {
                path: "a.md".into(),
                previous_path: None,
                kind: ChangeKind::Modified,
                additions: Some(2),
                deletions: Some(0),
                also_by: vec![],
            }
        );
        f.done();
    }

    #[test]
    fn a_new_and_a_deleted_file_commit_with_the_run() {
        let f = fixture("m58-new-and-deleted", true);
        testutil::write(&f.vault, "notes/new.md", "# New\n");
        std::fs::remove_file(f.vault.join("c.md")).unwrap();
        f.run("run-2", "process:scout", 1);
        f.wrote(
            "vault.create",
            "notes/new.md",
            "process:scout",
            Some("run-2"),
        );
        f.wrote("vault.delete", "c.md", "process:scout", Some("run-2"));
        let changeset = f.settle("run-2", vec![]);
        let (_, files) = committed(&changeset);
        let kinds: Vec<(&str, ChangeKind)> = files
            .iter()
            .map(|file| (file.path.as_str(), file.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("c.md", ChangeKind::Deleted),
                ("notes/new.md", ChangeKind::Added)
            ]
        );
        assert!(f.git(&["status", "--porcelain"]).trim().is_empty());
        f.done();
    }

    #[test]
    fn paths_outside_the_vault_or_in_dot_git_are_dropped() {
        let row = |path: &str, to: Option<&str>| write_log::PageWrite {
            kind: if to.is_some() {
                "vault.rename"
            } else {
                "vault.write"
            }
            .into(),
            path: path.into(),
            to: to.map(str::to_string),
            at: "2026-10-14T09:00:00.000Z".into(),
            approved_by: None,
        };
        let rows = vec![
            row("notes/a.md", None),
            row("notes/old.md", Some("notes/new.md")),
            row("../outside.md", None),
            row(".git/config", None),
        ];
        let cli = vec![
            "/etc/passwd".to_string(),
            ".cerebro/connectors.json".to_string(),
            "sub/.git/HEAD".to_string(),
            "notes/a.md".to_string(),
            "notes/cli.md".to_string(),
        ];
        assert_eq!(
            run_paths(&rows, &cli),
            vec!["notes/a.md", "notes/cli.md", "notes/new.md", "notes/old.md"]
        );
    }

    #[test]
    fn unchanged_bytes_make_nothing() {
        let f = fixture("m58-unchanged", true);
        f.run("run-3", "process:scout", 1);
        f.wrote("vault.write", "a.md", "process:scout", Some("run-3"));
        let before = f.git(&["rev-parse", "HEAD"]);
        assert_eq!(
            f.settle("run-3", vec![]),
            RunChangeset::Nothing {
                run_id: "run-3".into(),
                shell_unrecorded: false
            }
        );
        assert_eq!(f.git(&["rev-parse", "HEAD"]), before, "no empty commit");
        f.done();
    }

    #[test]
    fn binary_files_read_binary_and_totals_skip_them() {
        let f = fixture("m58-binary", true);
        std::fs::write(f.vault.join("logo.png"), b"\x89PNG\0\0\x01").unwrap();
        testutil::write(&f.vault, "a.md", "# a\n\nOne.\nTwo.\n");
        f.run("run-4", "process:scout", 1);
        f.wrote("vault.write", "a.md", "process:scout", Some("run-4"));
        let changeset = f.settle("run-4", vec!["logo.png".into()]);
        let RunChangeset::Committed {
            files,
            additions,
            deletions,
            binary,
            ..
        } = &changeset
        else {
            panic!("expected a commit, got {changeset:?}");
        };
        let logo = files.iter().find(|file| file.path == "logo.png").unwrap();
        assert_eq!((logo.additions, logo.deletions), (None, None));
        assert_eq!((*additions, *deletions, *binary), (Some(3), Some(0), 1));

        // Only binaries to count: the totals are absent, never 0.
        std::fs::write(f.vault.join("logo.png"), b"\x89PNG\0\0\x02").unwrap();
        f.run("run-5", "process:scout", 1);
        let changeset = f.settle("run-5", vec!["logo.png".into()]);
        let RunChangeset::Committed {
            additions,
            deletions,
            binary,
            ..
        } = changeset
        else {
            panic!("expected a commit");
        };
        assert_eq!((additions, deletions, binary), (None, None, 1));
        f.done();
    }

    #[test]
    fn the_commit_carries_run_actor_and_ledger_trailers() {
        let f = fixture("m58-trailers", true);
        let writer = crate::ledger::writer::LedgerWriter::open(&f.vault, "m58-trailers").unwrap();
        let head = crate::ledger::head(&f.vault)
            .expect("an opened ledger has a head")
            .hash;
        drop(writer);
        testutil::write(&f.vault, "a.md", "# a\n\nScouted.\n");
        f.run("run-6", "process:release-scout", 1);
        f.wrote(
            "vault.write",
            "a.md",
            "process:release-scout",
            Some("run-6"),
        );
        let changeset = f.settle("run-6", vec![]);
        let (hash, _) = committed(&changeset);
        let message = f.git(&["log", "-1", "--format=%B", hash]);
        assert_eq!(
            message.trim_end(),
            format!(
                "release-scout: changed 1 file\n\nCerebro-Run: run-6\n\
                 Cerebro-Actor: process:release-scout\nCerebro-Ledger-Head: {head}"
            )
        );
        f.done();
    }

    #[test]
    fn a_file_the_person_also_wrote_is_flagged() {
        let f = fixture("m58-also-by", true);
        testutil::write(&f.vault, "a.md", "# a\n\nYours, then the run's.\n");
        f.wrote(
            "vault.write",
            "a.md",
            crate::vault::receipt::HUMAN_ACTOR,
            None,
        );
        f.run("run-7", "process:scout", 1);
        f.wrote("vault.write", "a.md", "process:scout", Some("run-7"));
        let changeset = f.settle("run-7", vec![]);
        let (_, files) = committed(&changeset);
        assert_eq!(files[0].also_by, vec!["human:me".to_string()]);
        f.done();
    }

    #[test]
    fn a_non_repo_lists_files_without_counts() {
        let f = fixture("m58-non-repo", false);
        f.run("run-8", "process:scout", 1);
        f.wrote("vault.write", "a.md", "process:scout", Some("run-8"));
        assert_eq!(
            f.settle("run-8", vec![]),
            RunChangeset::NotARepo {
                run_id: "run-8".into(),
                files: vec!["a.md".into()],
                shell_unrecorded: false,
            }
        );
        f.done();
    }

    #[test]
    fn no_recorded_writes_reads_not_recorded() {
        let f = fixture("m58-not-recorded", true);
        let wire = serde_json::to_value(f.settle("run-none", vec![])).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "state": "not_recorded",
                "run_id": "run-none",
                "reason": "this run's writes were not recorded",
                "files": [],
            })
        );
        f.done();
    }

    #[test]
    fn a_merge_in_progress_reads_unavailable() {
        let f = fixture("m58-merge", true);
        let git = |args: &[&str]| f.git(args);
        git(&["checkout", "-q", "-b", "side"]);
        testutil::write(&f.vault, "c.md", "# side\n");
        git(&["commit", "-q", "-am", "side"]);
        git(&["checkout", "-q", "main"]);
        testutil::write(&f.vault, "c.md", "# main\n");
        git(&["commit", "-q", "-am", "main"]);
        assert!(command::run_str(&f.vault, &["merge", "side"]).is_err());
        testutil::write(&f.vault, "a.md", "# a\n\nDuring the merge.\n");
        f.run("run-9", "process:scout", 1);
        f.wrote("vault.write", "a.md", "process:scout", Some("run-9"));
        let RunChangeset::Unavailable { files, .. } = f.settle("run-9", vec![]) else {
            panic!("a partial commit during a merge is refused");
        };
        assert_eq!(files, vec!["a.md".to_string()]);
        f.done();
    }

    /// Two run commits and a checkpoint at once, again and again: none of
    /// them meets another's `index.lock`.
    #[test]
    fn commits_are_single_flight_per_repository() {
        let f = fixture("m58-single-flight", true);
        let ws = workspace::resolve(&f.vault);
        for round in 0..6 {
            for name in ["a", "b", "c"] {
                testutil::write(
                    &f.vault,
                    &format!("{name}.md"),
                    &format!("# {name} {round}\n"),
                );
            }
            std::thread::scope(|scope| {
                let ws = &ws;
                let one =
                    scope.spawn(move || commit::commit_paths(ws, &["a.md".into()], "one").unwrap());
                let two =
                    scope.spawn(move || commit::commit_paths(ws, &["b.md".into()], "two").unwrap());
                let all = scope.spawn(move || commit::commit_all(ws, "checkpoint").unwrap());
                one.join().unwrap();
                two.join().unwrap();
                all.join().unwrap();
            });
            assert!(f.git(&["status", "--porcelain"]).trim().is_empty());
        }
        f.done();
    }

    #[test]
    fn run_commit_message_names_the_run_and_cuts_its_summary() {
        assert_eq!(
            run_commit_message("process:release-scout", Some("its schedule came due"), 2),
            "release-scout: its schedule came due"
        );
        assert_eq!(
            run_commit_message("claude-code", Some("\n  tidy the inbox\nand more"), 1),
            "assistant: tidy the inbox"
        );
        assert_eq!(
            run_commit_message("agent:m26-ingest", None, 1),
            "ingest: changed 1 file"
        );
        assert_eq!(
            run_commit_message("claude-code", None, 3),
            "assistant: changed 3 files"
        );
        let long = run_commit_message("claude-code", Some(&"word ".repeat(40)), 1);
        assert!(long.chars().count() <= SUBJECT_CHARS);
        assert!(long.ends_with('\u{2026}'));
        assert!(long.starts_with("assistant: word word"));
    }

    #[test]
    fn a_run_commit_carries_the_full_hash() {
        let f = fixture("m58-full-hash", true);
        testutil::write(&f.vault, "a.md", "# a\n\nFull.\n");
        f.run("run-10", "process:scout", 1);
        f.wrote("vault.write", "a.md", "process:scout", Some("run-10"));
        let changeset = f.settle("run-10", vec![]);
        let (hash, _) = committed(&changeset);
        assert_eq!(hash.len(), 40);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), hash);
        f.done();
    }

    /// M58.4: the commit `commit_paths` really made is recorded once, under
    /// its full hash and its run, and a settle that commits nothing records
    /// nothing.
    #[test]
    fn a_run_commit_is_recorded_once() {
        let _sink = crate::runtime::sink::test_lock();
        let f = fixture("m58-recorded", true);
        testutil::write(&f.vault, "a.md", "# a\n\nRecorded.\n");
        f.run("run-rec", "process:scout", 1);
        f.wrote("vault.write", "a.md", "process:scout", Some("run-rec"));
        crate::runtime::sink::arm(&f.data).unwrap();
        let changeset = f.settle("run-rec", vec![]);
        let again = f.settle("run-rec", vec![]);
        let rows: Vec<(String, String, String)> = crate::runtime::sink::with_sink(|conn| {
            let mut stmt = conn
                .prepare("SELECT vault_id, commit_sha, run_id FROM run_commits ORDER BY rowid")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        })
        .unwrap();
        crate::runtime::sink::disarm();
        let (hash, _) = committed(&changeset);
        assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), hash);
        assert!(matches!(again, RunChangeset::Nothing { .. }), "{again:?}");
        assert_eq!(
            rows,
            vec![(f.vault_id.clone(), hash.to_string(), "run-rec".to_string())]
        );
        f.done();
    }

    /// The row is stored as the scan spells the path, however the run spelled
    /// it, and so is a CLI path; git status agrees with both.
    #[test]
    fn owned_paths_match_git_status_however_a_path_was_spelled() {
        let _sink = crate::runtime::sink::test_lock();
        let f = fixture("m58-spelling", true);
        testutil::write(&f.vault, "notes/a.md", "# a\n");
        testutil::write(&f.vault, "notes/b.md", "# b\n");
        commit::commit_all(&workspace::resolve(&f.vault), "seed").unwrap();
        testutil::write(&f.vault, "notes/a.md", "# a\n\nRun.\n");
        testutil::write(&f.vault, "notes/b.md", "# b\n\nRun.\n");
        f.run("run-11", "process:scout", 1);
        crate::runtime::sink::arm(&f.data).unwrap();
        crate::runtime::vault_writes::record(
            &f.vault,
            &WriteRow {
                kind: "vault.write",
                path: "./notes/a.md",
                to: None,
                content_hash: None,
                actor: Some("process:scout"),
                run_id: Some("run-11"),
                approved_by: None,
            },
        );
        crate::runtime::sink::disarm();
        let claim = claim_run(&f.vault, &f.data, "run-11", "process:scout");
        let folds = f.vault.join("NOTES").exists();
        let cli = if folds { "Notes/B.md" } else { "notes/b.md" };
        let landed = crate::vault::write::landing_path(&f.vault, cli).unwrap();
        claim.note_cli_write(&landed);
        let ws = workspace::resolve(&f.vault);
        let owners: Vec<(String, Option<String>)> = status::modified_files(&ws)
            .unwrap()
            .into_iter()
            .map(|file| (file.path, file.owner.map(|o| o.run_id)))
            .collect();
        assert_eq!(
            owners,
            vec![
                ("notes/a.md".to_string(), Some("run-11".to_string())),
                ("notes/b.md".to_string(), Some("run-11".to_string())),
            ]
        );
        drop(claim);
        assert!(owned_paths(&f.vault).is_empty(), "the claim let go");
        f.done();
    }

    #[test]
    fn a_shell_granted_run_says_its_shell_changes_are_unrecorded() {
        let f = fixture("m58-shell", true);
        testutil::write(&f.vault, "a.md", "# a\n\nShell run.\n");
        f.run("run-12", "process:scout", 2);
        f.wrote("vault.write", "a.md", "process:scout", Some("run-12"));
        let RunChangeset::Committed {
            shell_unrecorded, ..
        } = f.settle("run-12", vec![])
        else {
            panic!("expected a commit");
        };
        assert!(shell_unrecorded);
        f.run("run-13", "process:scout", 2);
        assert_eq!(
            f.settle("run-13", vec![]),
            RunChangeset::Nothing {
                run_id: "run-13".into(),
                shell_unrecorded: true
            }
        );
        f.done();
    }

    /// A run's commit waits about five seconds for the repository, then says
    /// History was busy and lists its files, committing nothing.
    #[test]
    fn a_busy_repository_reads_history_was_busy() {
        let f = fixture("m58-busy", true);
        testutil::write(&f.vault, "a.md", "# a\n\nWaiting.\n");
        f.run("run-14", "process:scout", 1);
        f.wrote("vault.write", "a.md", "process:scout", Some("run-14"));
        let lock = commit::repo_lock(&f.vault);
        let held = commit::hold(&lock);
        let started = std::time::Instant::now();
        let changeset = f.settle("run-14", vec![]);
        drop(held);
        assert!(started.elapsed() >= BUSY_WAIT);
        assert!(started.elapsed() < BUSY_WAIT + Duration::from_secs(3));
        assert_eq!(
            changeset,
            RunChangeset::Unavailable {
                run_id: "run-14".into(),
                reason: BUSY.into(),
                files: vec!["a.md".into()],
                shell_unrecorded: false,
            }
        );
        assert_eq!(f.git(&["status", "--porcelain"]).trim(), "M a.md");
        f.done();
    }
}
