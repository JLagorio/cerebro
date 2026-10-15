//! Restore a page to a version from its history (M58.4).
//!
//! A person's write, so it takes a person's receipt: `git_commands.rs`'s
//! `restore_note_version` judges the note target, then mints the receipt
//! from `knowledge::guard_human_write`, and [`restore_version`] does not
//! compile without it. Restore refuses what `save_note` refuses, in a vault
//! that keeps no history too.
//!
//! In order: the note target and the bundle guard; a repository; a full hash
//! found in the page's own history (`history::file_history`, 50 rows); a
//! version inside the vault, that did not remove the page, that is text and
//! not too large; and no running run that wrote the page (`live_run`: when
//! nobody can tell, it goes ahead and says so in the log).
//!
//! Then the write. Identical bytes write nothing. A page with changes not
//! yet in history is committed first, "Before restoring <title>", so the
//! version it replaces is one click away (Q10); if that commit fails,
//! nothing is written. The version's bytes then go through the one note
//! funnel with the hash read before that commit as its expectation (D2 (c)'s
//! undo clause), so a page that changed meanwhile writes nothing. Last,
//! "Restore <title> to <short> (<date>)" is committed; if that fails, the
//! restore stands and says so, since the replaced version is already in
//! history.

use std::path::Path;

use serde::Serialize;

use super::commit;
use super::history::{self, FileAt, FileChange};
use super::status;
use super::workspace;
use crate::vault::receipt::{Human, WriteReceipt};
use crate::vault::write::NoteWriteError;

/// How far back Restore looks for the version it was asked for.
pub const HISTORY_ROWS: usize = 50;

pub const NO_HISTORY: &str = "This vault keeps no history, so there is no version to restore.";
pub const NOT_IN_HISTORY: &str = "That version is not in this page's history.";
pub const OUTSIDE_VAULT: &str = "That version of the page is outside this vault.";
pub const REMOVED: &str = "That version removed the page, so there is nothing to restore.";
pub const NOT_TEXT: &str = "That version is not text, so it can't be restored here.";
pub const TOO_LARGE: &str = "That version is too large to restore here.";
pub const STILL_WRITING: &str =
    "An agent run is still writing this page. Stop it or let it finish, then restore.";
pub const RACED: &str =
    "The page changed while it was being restored, so nothing was written. Try again.";
/// Followed by git's own error.
pub const SAVE_FIRST: &str =
    "Couldn't save the current version to history first, so nothing was written: ";

/// What a Restore did. `unchanged`: the page already held that version, so
/// nothing was written or committed. `before`: the "Before restoring" commit,
/// when the page held changes not yet in history. `restored`: the "Restore …"
/// commit. `commit_error`: why that last commit failed, the page restored
/// all the same.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub unchanged: bool,
    pub before: Option<String>,
    pub restored: Option<String>,
    pub commit_error: Option<String>,
}

/// Restore `rel` to its bytes at `commit`, as the person. `live_run` says
/// whether a running run wrote `rel`: `Some(true)` refuses, `None` (the
/// runtime database could not say) goes ahead with one warning.
pub fn restore_version(
    vault: &Path,
    rel: &str,
    commit: &str,
    by: &WriteReceipt<Human>,
    live_run: impl FnOnce(&str) -> Option<bool>,
) -> Result<Restored, String> {
    restore_with(vault, rel, commit, by, live_run, || {})
}

/// [`restore_version`] with `between` run after the safety commit and before
/// the write: where a test makes the page change under a Restore.
#[cfg(test)]
pub(crate) fn restore_version_hooked(
    vault: &Path,
    rel: &str,
    commit: &str,
    by: &WriteReceipt<Human>,
    live_run: impl FnOnce(&str) -> Option<bool>,
    between: impl FnOnce(),
) -> Result<Restored, String> {
    restore_with(vault, rel, commit, by, live_run, between)
}

/// A full commit hash: 40 or 64 lowercase hex.
fn full_hash(hash: &str) -> bool {
    matches!(hash.len(), 40 | 64)
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The page's title in a commit subject: its file name, humanized.
fn title_of(rel: &str) -> String {
    let stem = Path::new(rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(rel);
    crate::vault::parse::humanize_stem(stem)
}

fn restore_with(
    vault: &Path,
    rel: &str,
    commit: &str,
    by: &WriteReceipt<Human>,
    live_run: impl FnOnce(&str) -> Option<bool>,
    between: impl FnOnce(),
) -> Result<Restored, String> {
    let target = crate::vault::write::restore_target(vault, rel)?;
    crate::knowledge::guard_human_write(rel)?;
    let ws = workspace::resolve(vault);
    if !ws.is_repo() {
        return Err(NO_HISTORY.into());
    }
    if !full_hash(commit) {
        return Err(NOT_IN_HISTORY.into());
    }
    let row = history::file_history(&ws, rel, HISTORY_ROWS)?
        .into_iter()
        .find(|row| row.hash == commit)
        .ok_or_else(|| NOT_IN_HISTORY.to_string())?;
    let Some(path_at) = row.path_at.as_deref() else {
        return Err(OUTSIDE_VAULT.into());
    };
    if row.change == Some(FileChange::Deleted) {
        return Err(REMOVED.into());
    }
    let version = match history::file_at_commit(&ws, path_at, commit)? {
        FileAt::Text { text } => text,
        FileAt::Absent => return Err(REMOVED.into()),
        FileAt::Binary => return Err(NOT_TEXT.into()),
        FileAt::TooLarge { .. } => return Err(TOO_LARGE.into()),
    };
    match live_run(rel) {
        Some(true) => return Err(STILL_WRITING.into()),
        Some(false) => {}
        None => log::warn!(
            "restore: could not tell whether a run is writing {rel}; restoring it anyway"
        ),
    }
    let current = std::fs::read(&target).map_err(|e| format!("{rel}: {e}"))?;
    if current == version.as_bytes() {
        return Ok(Restored {
            unchanged: true,
            before: None,
            restored: None,
            commit_error: None,
        });
    }
    let expect = crate::ledger::sha256_hex(&current);
    let title = title_of(rel);
    let git_path = ws.to_git_relative(rel);
    let dirty = status::records(&ws)?
        .iter()
        .any(|record| record.git_path == git_path);
    let paths = vec![rel.to_string()];
    let before = if dirty {
        commit::commit_paths(&ws, &paths, &format!("Before restoring {title}"))
            .map_err(|e| format!("{SAVE_FIRST}{e}"))?
    } else {
        None
    };
    between();
    crate::vault::write::restore_note(vault, rel, &version, &expect, by).map_err(|error| {
        match error {
            NoteWriteError::Stale(_) => RACED.to_string(),
            NoteWriteError::Refused(message) => message,
        }
    })?;
    let day = chrono::DateTime::from_timestamp(row.date, 0)
        .map(|at| at.format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    let message = format!("Restore {title} to {} ({day})", row.short_hash);
    let (restored, commit_error) = match commit::commit_paths(&ws, &paths, &message) {
        Ok(hash) => (hash, None),
        Err(e) => (None, Some(e)),
    };
    Ok(Restored {
        unchanged: false,
        before,
        restored,
        commit_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::command;
    use crate::git::commit::tests::{assert_isolated, scratch_repo_dir};
    use crate::vault::testutil;
    use std::path::PathBuf;

    /// A person's receipt, as the command mints one.
    fn human() -> WriteReceipt<Human> {
        WriteReceipt::for_test(crate::vault::receipt::HUMAN_ACTOR, None)
    }

    fn nobody(_: &str) -> Option<bool> {
        Some(false)
    }

    /// A scratch repository with its own identity.
    fn repo(label: &str) -> PathBuf {
        let dir = scratch_repo_dir(label);
        std::fs::create_dir_all(&dir).unwrap();
        command::run_str(&dir, &["init"]).unwrap();
        assert_isolated(&dir);
        command::run_str(&dir, &["config", "user.email", "t@example.com"]).unwrap();
        command::run_str(&dir, &["config", "user.name", "t"]).unwrap();
        dir
    }

    fn put(dir: &Path, rel: &str, bytes: &str) {
        testutil::write(dir, rel, bytes);
    }

    fn commit_all(dir: &Path, message: &str) -> String {
        command::run_str(dir, &["add", "-A"]).unwrap();
        command::run_str(dir, &["commit", "-m", message]).unwrap();
        head(dir)
    }

    fn head(dir: &Path) -> String {
        command::run_str(dir, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string()
    }

    fn subjects(dir: &Path) -> Vec<String> {
        command::run_str(dir, &["log", "--format=%s"])
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn shown(dir: &Path, rev: &str, rel: &str) -> String {
        command::run_str(dir, &["show", &format!("{rev}:{rel}")]).unwrap()
    }

    const OLD: &str =
        "\u{feff}---\r\ntitle: Plan\r\n---\r\n\r\n# Plan\r\n\r\nThe old sentence.\r\n";
    const NEW: &str = "---\ntitle: Plan\n---\n\n# Plan\n\nThe new sentence.\n";

    #[test]
    fn restore_writes_the_versions_exact_bytes_and_one_commit() {
        let dir = repo("m58-restore-clean");
        put(&dir, "notes/my-plan.md", OLD);
        let old = commit_all(&dir, "old");
        put(&dir, "notes/my-plan.md", NEW);
        commit_all(&dir, "new");

        let restored = restore_version(&dir, "notes/my-plan.md", &old, &human(), nobody).unwrap();
        assert!(!restored.unchanged);
        assert_eq!(restored.before, None, "a clean page needs no safety commit");
        assert_eq!(restored.commit_error, None);
        assert_eq!(restored.restored.as_deref(), Some(head(&dir).as_str()));
        assert_eq!(
            std::fs::read(dir.join("notes/my-plan.md")).unwrap(),
            OLD.as_bytes()
        );
        let log = subjects(&dir);
        assert!(
            log[0].starts_with(&format!("Restore My plan to {} (", &old[..7])),
            "{log:?}"
        );
        assert_eq!(log.len(), 3, "one commit: {log:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_commits_the_current_version_first_when_it_is_not_in_history() {
        let dir = repo("m58-restore-dirty");
        put(&dir, "plan.md", OLD);
        let old = commit_all(&dir, "old");
        put(&dir, "plan.md", NEW);
        commit_all(&dir, "new");
        let unsaved = "# Plan\n\nTyped, never committed.\n";
        put(&dir, "plan.md", unsaved);

        let restored = restore_version(&dir, "plan.md", &old, &human(), nobody).unwrap();
        let before = restored.before.expect("a safety commit");
        assert_eq!(
            shown(&dir, &before, "plan.md"),
            unsaved,
            "it holds the replaced bytes"
        );
        assert_eq!(std::fs::read(dir.join("plan.md")).unwrap(), OLD.as_bytes());
        let log = subjects(&dir);
        assert_eq!(log[1], "Before restoring Plan", "{log:?}");
        assert!(log[0].starts_with("Restore Plan to "), "{log:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restoring_the_current_version_writes_nothing() {
        let dir = repo("m58-restore-same");
        put(&dir, "plan.md", NEW);
        let only = commit_all(&dir, "only");
        let restored = restore_version(&dir, "plan.md", &only, &human(), nobody).unwrap();
        assert_eq!(
            restored,
            Restored {
                unchanged: true,
                before: None,
                restored: None,
                commit_error: None,
            }
        );
        assert_eq!(subjects(&dir), vec!["only".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_refuses_knowledge_non_notes_deleted_versions_and_commits_outside_the_history() {
        let dir = repo("m58-restore-refuse");
        put(&dir, "plan.md", OLD);
        put(&dir, "other.md", "# Other\n");
        put(&dir, "gone.md", "# Gone\n");
        put(&dir, "knowledge/c.md", "# Concept\n");
        put(&dir, "data/table.csv", "a,b\n");
        let first = commit_all(&dir, "first");
        put(&dir, "other.md", "# Other\n\nEdited.\n");
        let other = commit_all(&dir, "other only");
        std::fs::remove_file(dir.join("gone.md")).unwrap();
        let removed = commit_all(&dir, "remove gone");
        put(&dir, "gone.md", "# Gone again\n");
        commit_all(&dir, "bring it back");
        let snapshot = |d: &Path| -> Vec<(PathBuf, Vec<u8>)> {
            let mut files: Vec<_> = walkdir::WalkDir::new(d)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file() && !e.path().starts_with(d.join(".git")))
                .map(|e| (e.path().to_path_buf(), std::fs::read(e.path()).unwrap()))
                .collect();
            files.sort();
            files
        };
        let before = snapshot(&dir);

        let refuse = |rel: &str, commit: &str| {
            restore_version(&dir, rel, commit, &human(), nobody).unwrap_err()
        };
        assert!(refuse("knowledge/c.md", &first).contains("read-only"));
        assert!(refuse("data/table.csv", &first).contains("not a note"));
        assert!(refuse(".git/config", &first).contains("not a note"));
        assert_eq!(
            refuse("plan.md", &other),
            NOT_IN_HISTORY,
            "another page's commit"
        );
        assert_eq!(
            refuse("plan.md", &first[..7]),
            NOT_IN_HISTORY,
            "a short hash"
        );
        assert_eq!(refuse("plan.md", &first.to_uppercase()), NOT_IN_HISTORY);
        assert_eq!(refuse("gone.md", &removed), REMOVED);
        assert_eq!(snapshot(&dir), before, "a refusal writes nothing");
        assert_eq!(subjects(&dir).len(), 4, "and commits nothing");

        let plain = testutil::temp_vault("m58-restore-plain");
        put(&plain, "plan.md", NEW);
        let err =
            restore_version(&plain, "plan.md", &"a".repeat(40), &human(), nobody).unwrap_err();
        assert_eq!(err, NO_HISTORY);
        std::fs::remove_dir_all(&plain).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_refuses_while_a_running_run_wrote_the_page() {
        let dir = repo("m58-restore-live");
        put(&dir, "plan.md", OLD);
        let old = commit_all(&dir, "old");
        put(&dir, "plan.md", NEW);
        commit_all(&dir, "new");
        let asked = std::cell::RefCell::new(None);
        let err = restore_version(&dir, "plan.md", &old, &human(), |rel| {
            *asked.borrow_mut() = Some(rel.to_string());
            Some(true)
        })
        .unwrap_err();
        assert_eq!(err, STILL_WRITING);
        assert_eq!(asked.borrow().as_deref(), Some("plan.md"));
        assert_eq!(std::fs::read_to_string(dir.join("plan.md")).unwrap(), NEW);

        // Nobody could tell: it goes ahead.
        let restored = restore_version(&dir, "plan.md", &old, &human(), |_| None).unwrap();
        assert!(!restored.unchanged);
        assert_eq!(std::fs::read(dir.join("plan.md")).unwrap(), OLD.as_bytes());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_restore_that_loses_the_race_writes_nothing() {
        let dir = repo("m58-restore-race");
        put(&dir, "plan.md", OLD);
        let old = commit_all(&dir, "old");
        put(&dir, "plan.md", NEW);
        commit_all(&dir, "new");
        put(&dir, "plan.md", "# Plan\n\nUnsaved.\n");
        let racer = "# Plan\n\nWritten in between.\n";
        let err = restore_version_hooked(&dir, "plan.md", &old, &human(), nobody, || {
            std::fs::write(dir.join("plan.md"), racer).unwrap();
        })
        .unwrap_err();
        assert_eq!(err, RACED);
        assert_eq!(std::fs::read_to_string(dir.join("plan.md")).unwrap(), racer);
        let log = subjects(&dir);
        assert_eq!(
            log[0], "Before restoring Plan",
            "no Restore commit: {log:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// One `vault_writes` row: kind, path, actor, run and hash.
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    #[test]
    fn restore_records_human_me_with_no_run() {
        let _sink = crate::runtime::sink::test_lock();
        let config = testutil::temp_vault("m58-restore-recorded-config");
        let dir = repo("m58-restore-recorded");
        put(&dir, "plan.md", OLD);
        let old = commit_all(&dir, "old");
        put(&dir, "plan.md", NEW);
        commit_all(&dir, "new");
        crate::runtime::sink::arm(&config).unwrap();
        restore_version(&dir, "plan.md", &old, &human(), nobody).unwrap();
        let vault_id = crate::runtime::scope::derive_vault_id(&dir);
        let rows: Vec<Row> = crate::runtime::sink::with_sink(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT kind, path, actor, run_id, content_hash FROM vault_writes \
                         WHERE vault_id = ?1 ORDER BY rowid",
                )
                .unwrap();
            stmt.query_map([&vault_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        })
        .unwrap();
        crate::runtime::sink::disarm();
        assert_eq!(
            rows,
            vec![(
                "vault.write".to_string(),
                "plan.md".to_string(),
                Some(crate::vault::receipt::HUMAN_ACTOR.to_string()),
                None,
                Some(crate::ledger::sha256_hex(OLD.as_bytes())),
            )]
        );
        for d in [&dir, &config] {
            std::fs::remove_dir_all(d).ok();
        }
    }
}
