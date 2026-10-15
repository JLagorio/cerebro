//! What has changed.

use std::path::Path;

use serde::Serialize;

use super::command;
use super::workspace::GitWorkspaceInfo;
use crate::vault::receipt::{Human, WriteReceipt};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModifiedFile {
    /// Vault-relative.
    pub path: String,
    pub status: FileStatus,
    pub staged: bool,
    /// The live run whose commit this path waits for (M58.3,
    /// `changeset::owned_paths`): a checkpoint leaves it alone. None for a
    /// path no live run wrote.
    pub owner: Option<super::changeset::Owner>,
}

/// One `git status` record, as git spells its path (M58.3): what
/// `commit::commit_paths_in` matches the paths it was asked for against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StatusRecord {
    /// Repository-relative.
    pub git_path: String,
    /// A rename's old path, repository-relative.
    pub orig: Option<String>,
    pub status: FileStatus,
    pub staged: bool,
    pub conflicted: bool,
}

/// Parse one `git status --porcelain=v1 -z` record.
///
/// The two status characters are index-then-worktree. `??` is untracked, and
/// any of the `U`/`AA`/`DD` combinations mean a conflict — those must not be
/// reported as ordinary modifications, or the Changes surface would offer to
/// commit a half-merged file.
fn classify(code: &str) -> (FileStatus, bool) {
    let bytes: Vec<char> = code.chars().collect();
    let index = bytes.first().copied().unwrap_or(' ');
    let tree = bytes.get(1).copied().unwrap_or(' ');

    if code == "??" {
        return (FileStatus::Untracked, false);
    }
    if index == 'U' || tree == 'U' || (index == 'A' && tree == 'A') || (index == 'D' && tree == 'D')
    {
        return (FileStatus::Conflicted, false);
    }

    let staged = index != ' ' && index != '?';
    let effective = if staged { index } else { tree };
    let status = match effective {
        'A' => FileStatus::Added,
        'D' => FileStatus::Deleted,
        'R' => FileStatus::Renamed,
        _ => FileStatus::Modified,
    };
    (status, staged)
}

/// Every changed path in the vault's scope, as `git status --porcelain=v1
/// -z` lists it, untracked files one by one.
pub(crate) fn records(ws: &GitWorkspaceInfo) -> Result<Vec<StatusRecord>, String> {
    if !ws.is_repo() {
        return Ok(vec![]);
    }
    let dir = ws.dir();
    let mut args: Vec<String> = vec![
        "status".into(),
        "--porcelain=v1".into(),
        "-z".into(),
        "--untracked-files=all".into(),
    ];
    args.extend(ws.pathspec_args());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = command::run_str(&dir, &refs)?;
    Ok(parse_records(&out))
}

/// Parse `git status --porcelain=v1 -z`. A rename record is followed by a
/// second NUL field holding the old path.
fn parse_records(out: &str) -> Vec<StatusRecord> {
    let mut records = Vec::new();
    let mut parts = out.split('\0').filter(|s| !s.is_empty()).peekable();
    while let Some(record) = parts.next() {
        if record.len() < 4 {
            continue;
        }
        let (code, path) = record.split_at(2);
        let path = path.trim_start();
        let (status, staged) = classify(code);
        let orig = if status == FileStatus::Renamed {
            parts.next().map(str::to_string)
        } else {
            None
        };
        records.push(StatusRecord {
            git_path: path.to_string(),
            orig,
            conflicted: status == FileStatus::Conflicted,
            status,
            staged,
        });
    }
    records
}

/// What has changed in the vault, each path named with the live run that
/// owns it, if one does (M58.3). `owned_paths` runs no query when no run is
/// live.
pub fn modified_files(ws: &GitWorkspaceInfo) -> Result<Vec<ModifiedFile>, String> {
    if !ws.is_repo() {
        return Ok(vec![]);
    }
    let records = records(ws)?;
    let owners = if records.is_empty() {
        Default::default()
    } else {
        super::changeset::owned_paths(Path::new(&ws.vault_root))
    };
    Ok(records
        .into_iter()
        .filter_map(|record| {
            let path = ws.to_vault_relative(&record.git_path)?;
            Some(ModifiedFile {
                owner: owners.get(&path).cloned(),
                path,
                status: record.status,
                staged: record.staged,
            })
        })
        .collect())
}

/// Throw away a file's uncommitted changes. Untracked files are removed;
/// tracked ones are restored from HEAD.
///
/// Recorded under `by` (M58.1): a restored file as a `vault.write` with the
/// restored bytes' hash, a removed one as a `vault.delete`.
pub fn discard_file(
    ws: &GitWorkspaceInfo,
    vault_relative: &str,
    by: &WriteReceipt<Human>,
) -> Result<(), String> {
    if !ws.is_repo() {
        return Err("this vault is not a git repository".into());
    }
    let safe = command::safe_relative(vault_relative)?;
    let dir = ws.dir();
    let git_path = ws.to_git_relative(&safe);
    let lock = super::commit::repo_lock(&dir);
    let _held = super::commit::hold(&lock);

    let tracked = command::succeeds(&dir, &["ls-files", "--error-unmatch", &git_path]);
    let vault = Path::new(&ws.vault_root);
    if tracked {
        command::run_str(&dir, &["checkout", "HEAD", "--", &git_path])?;
        let hash = std::fs::read(vault.join(&safe))
            .ok()
            .map(|bytes| crate::ledger::sha256_hex(&bytes));
        record(vault, "vault.write", &safe, hash.as_deref(), by);
    } else {
        command::run_str(&dir, &["clean", "-f", "--", &git_path])?;
        record(vault, "vault.delete", &safe, None, by);
    }
    Ok(())
}

/// One discard's row in `vault_writes`, under `by`'s stamp.
fn record(vault: &Path, kind: &str, path: &str, hash: Option<&str>, by: &WriteReceipt<Human>) {
    crate::runtime::vault_writes::record(
        vault,
        &crate::runtime::vault_writes::WriteRow {
            kind,
            path,
            to: None,
            content_hash: hash,
            actor: Some(by.actor()),
            run_id: by.run_id(),
            approved_by: by.approved_by(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untracked_is_its_own_status() {
        assert_eq!(classify("??").0, FileStatus::Untracked);
    }

    #[test]
    fn conflicts_are_never_reported_as_modifications() {
        for code in ["UU", "AA", "DD", "AU", "UD"] {
            assert_eq!(classify(code).0, FileStatus::Conflicted, "code {code}");
        }
    }

    #[test]
    fn a_discard_is_recorded_as_your_write() {
        let _sink = crate::runtime::sink::test_lock();
        let config = crate::vault::testutil::temp_vault("discard-recorded-config");
        let dir = crate::vault::testutil::temp_vault("discard-recorded");
        crate::git::commit::init_repo(&dir).unwrap();
        let ws = crate::git::workspace::resolve(&dir);
        command::run_str(&ws.dir(), &["config", "user.email", "t@example.com"]).unwrap();
        command::run_str(&ws.dir(), &["config", "user.name", "t"]).unwrap();
        crate::vault::testutil::write(&dir, "notes/a.md", "# A\n");
        command::run_str(&ws.dir(), &["add", "notes/a.md"]).unwrap();
        command::run_str(&ws.dir(), &["commit", "-m", "seed"]).unwrap();
        crate::vault::testutil::write(&dir, "notes/a.md", "# A\n\nChanged.\n");
        crate::vault::testutil::write(&dir, "notes/new.md", "# New\n");
        crate::runtime::sink::arm(&config).unwrap();
        let by = WriteReceipt::ipc(crate::knowledge::guard_human_write("notes/a.md").unwrap());
        discard_file(&ws, "notes/a.md", &by).unwrap();
        let by = WriteReceipt::ipc(crate::knowledge::guard_human_write("notes/new.md").unwrap());
        discard_file(&ws, "notes/new.md", &by).unwrap();
        let vault_id = crate::runtime::scope::derive_vault_id(&dir);
        type Row = (
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let rows: Vec<Row> = crate::runtime::sink::with_sink(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT kind, path, content_hash, actor, run_id FROM vault_writes \
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
        let me = Some(crate::vault::receipt::HUMAN_ACTOR.to_string());
        assert_eq!(
            rows,
            vec![
                (
                    "vault.write".to_string(),
                    "notes/a.md".to_string(),
                    Some(crate::ledger::sha256_hex(b"# A\n")),
                    me.clone(),
                    None
                ),
                (
                    "vault.delete".to_string(),
                    "notes/new.md".to_string(),
                    None,
                    me,
                    None
                ),
            ]
        );
        for d in [&dir, &config] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// A path a live run wrote names its run and actor (M58.3), as long as
    /// the claim stands; a path no run wrote names nobody.
    #[test]
    fn modified_files_names_the_run_that_owns_a_path() {
        let vault = crate::vault::testutil::temp_vault("m58-status-owner");
        let data = crate::vault::testutil::temp_vault("m58-status-owner-data");
        crate::vault::testutil::write(&vault, "notes/a.md", "# A\n");
        crate::git::commit::init_repo(&vault).unwrap();
        crate::vault::testutil::write(&vault, "notes/a.md", "# A\n\nRun.\n");
        crate::vault::testutil::write(&vault, "notes/mine.md", "# Mine\n");
        let ws = crate::git::workspace::resolve(&vault);
        let claim =
            crate::git::changeset::claim_run(&vault, &data, "run-owner", "process:release-scout");
        claim.note_cli_write("notes/a.md");
        let owners: Vec<(String, Option<crate::git::changeset::Owner>)> = modified_files(&ws)
            .unwrap()
            .into_iter()
            .map(|file| (file.path, file.owner))
            .collect();
        assert_eq!(
            owners,
            vec![
                (
                    "notes/a.md".to_string(),
                    Some(crate::git::changeset::Owner {
                        run_id: "run-owner".into(),
                        actor: "process:release-scout".into(),
                    })
                ),
                ("notes/mine.md".to_string(), None),
            ]
        );
        let wire = serde_json::to_value(&modified_files(&ws).unwrap()[0]).unwrap();
        assert_eq!(wire["owner"]["runId"], "run-owner");
        drop(claim);
        assert!(modified_files(&ws).unwrap()[0].owner.is_none());
        for d in [&vault, &data] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn index_column_wins_and_marks_staged() {
        assert_eq!(classify("M "), (FileStatus::Modified, true));
        assert_eq!(classify(" M"), (FileStatus::Modified, false));
        assert_eq!(classify("A "), (FileStatus::Added, true));
        assert_eq!(classify(" D"), (FileStatus::Deleted, false));
    }
}
