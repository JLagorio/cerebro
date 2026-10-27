//! Actor/vault listing anchors and independently bounded descendant reads.
use super::{map_run, FleetRun, ReadOnly, DEFAULT_LIMIT, MAX_LIMIT, RUN_COLUMNS};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RunHistoryScope {
    Agent {
        vault: String,
        actor: String,
    },
    Construct {
        actor: String,
        vault: RegisteredVaults,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegisteredVaults {
    AllRegistered,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunCursor {
    pub started_at: String,
    pub run_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunsPage {
    pub runs: Vec<FleetRun>,
    pub next_cursor: Option<RunCursor>,
    pub effective_vault_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RunLineage {
    pub runs: Vec<FleetRun>,
    pub truncated: bool,
}

pub fn runs_page(
    ro: &ReadOnly,
    scope: &RunHistoryScope,
    cursor: Option<&RunCursor>,
    limit: Option<u32>,
) -> Result<RunsPage, String> {
    let (actor, effective_vault_ids) = match scope {
        RunHistoryScope::Agent { vault, actor } => {
            let canonical = crate::runtime::scope::canonical_path(Path::new(vault));
            let mut query = ro
                .prepare(
                    "SELECT vault_id FROM vault_registry WHERE vault_path = ?1 ORDER BY vault_id",
                )
                .map_err(|e| e.to_string())?;
            let ids = query
                .query_map([canonical], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            if ids.len() != 1 {
                return Err("The originating vault is not uniquely registered.".into());
            }
            (actor, ids)
        }
        RunHistoryScope::Construct {
            actor,
            vault: RegisteredVaults::AllRegistered,
        } => {
            let mut query = ro
                .prepare("SELECT vault_id FROM vault_registry ORDER BY vault_id")
                .map_err(|e| e.to_string())?;
            let ids = query
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            (actor, ids)
        }
    };
    if actor.is_empty() || actor.len() > 1024 {
        return Err("Invalid history actor.".into());
    }
    if cursor.is_some_and(|c| {
        c.started_at.is_empty()
            || c.started_at.len() > 128
            || c.run_id.is_empty()
            || c.run_id.len() > 1024
    }) {
        return Err("Invalid history cursor.".into());
    }
    let ids = serde_json::to_string(&effective_vault_ids).map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
    let sql = format!(
        "SELECT {RUN_COLUMNS} FROM runs WHERE actor = ?1 \
        AND vault_id IN (SELECT value FROM json_each(?2)) \
        AND (?3 IS NULL OR started_at < ?3 OR (started_at = ?3 AND run_id < ?4)) \
        ORDER BY started_at DESC, run_id DESC LIMIT ?5"
    );
    let mut statement = ro.prepare(&sql).map_err(|e| e.to_string())?;
    let mut runs = statement
        .query_map(
            rusqlite::params![
                actor,
                ids,
                cursor.map(|c| &c.started_at),
                cursor.map(|c| &c.run_id),
                limit as i64 + 1
            ],
            map_run,
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let has_more = runs.len() > limit;
    runs.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            runs.last().map(|run| RunCursor {
                started_at: run.started_at.clone(),
                run_id: run.run_id.clone(),
            })
        })
        .flatten();
    Ok(RunsPage {
        runs,
        next_cursor,
        effective_vault_ids,
    })
}
pub fn run_lineage(ro: &ReadOnly, root: &str) -> Result<RunLineage, String> {
    if root.is_empty() || root.len() > 1024 {
        return Err("Invalid lineage root.".into());
    }
    let exists: bool = ro
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE run_id = ?1)",
            [root],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("The run is unavailable.".into());
    }
    // Every returned descendant retains its ancestor in the traversal prefix.
    // Sorting a capped set by date and dropping its oldest row could orphan
    // all visible children. Each read and the number of reads are bounded.
    let sql = format!(
        "SELECT {RUN_COLUMNS} FROM runs WHERE parent_run_id = ?1 ORDER BY run_id LIMIT 202"
    );
    let mut statement = ro.prepare(&sql).map_err(|e| e.to_string())?;
    let mut visited = HashSet::from([root.to_owned()]);
    let mut waiting = VecDeque::from([root.to_owned()]);
    let mut runs = Vec::new();
    while let Some(parent) = waiting.pop_front() {
        let children = statement
            .query_map([parent], map_run)
            .map_err(|e| e.to_string())?;
        for child in children {
            let child = child.map_err(|e| e.to_string())?;
            if visited.contains(&child.run_id) {
                continue;
            }
            if runs.len() == 200 {
                return Ok(RunLineage {
                    runs,
                    truncated: true,
                });
            }
            visited.insert(child.run_id.clone());
            waiting.push_back(child.run_id.clone());
            runs.push(child);
        }
    }
    Ok(RunLineage {
        runs,
        truncated: false,
    })
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunOrigin {
    Registered { vault: String },
    Unavailable,
    NotRecorded,
}

pub fn run_origin(ro: &ReadOnly, vault_id: Option<&str>) -> Result<RunOrigin, String> {
    let Some(id) = vault_id else {
        return Ok(RunOrigin::NotRecorded);
    };
    let path = ro
        .query_row(
            "SELECT vault_path FROM vault_registry WHERE vault_id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match path {
        Some(vault) => RunOrigin::Registered { vault },
        None => RunOrigin::Unavailable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{runtime, vault::testutil};
    use rusqlite::Connection;
    use std::path::PathBuf;

    fn fixture(label: &str) -> (PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = runtime::open(&dir).unwrap();
        let id = runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, id)
    }
    fn seed(
        conn: &Connection,
        vault: &str,
        id: &str,
        actor: &str,
        time: &str,
        parent: Option<&str>,
    ) {
        conn.execute("INSERT INTO runs (run_id,vault_id,store_uuid,mode,lane,started_at,outcome,usage_state,input_tokens,output_tokens,cache_read,cache_write,reserved_total_tokens,reserved_output_tokens,proposals_submitted,applied,rejected,actor,parent_run_id) VALUES (?1,?2,'store','ambient','filed',?3,'succeeded','exact',0,0,0,0,0,0,0,0,0,?4,?5)", rusqlite::params![id,vault,time,actor,parent]).unwrap();
    }
    fn scope(dir: &std::path::Path) -> RunHistoryScope {
        RunHistoryScope::Agent {
            vault: dir.to_string_lossy().into_owned(),
            actor: "process:reviewer".into(),
        }
    }
    #[test]
    fn filters_before_limit_and_pages_equal_timestamps_including_child_anchors() {
        let (dir, conn, vault) = fixture("history-scoped-pagination");
        let other_dir = testutil::temp_vault("history-other-vault");
        let other = runtime::scope::register(&conn, &other_dir).unwrap();
        for n in 0..250 {
            seed(
                &conn,
                &vault,
                &format!("new-{n:03}"),
                "process:other",
                "2026-10-23T12:00:00Z",
                None,
            );
        }
        seed(
            &conn,
            &other,
            "other-vault",
            "process:reviewer",
            "2026-10-23T12:00:00Z",
            None,
        );
        for id in ["a", "b", "c"] {
            seed(
                &conn,
                &vault,
                id,
                "process:reviewer",
                "2026-10-22T12:00:00Z",
                Some("new-000"),
            );
        }
        let ro = ReadOnly::open(&dir).unwrap();
        let first = runs_page(&ro, &scope(&dir), None, Some(2)).unwrap();
        assert_eq!(
            first
                .runs
                .iter()
                .map(|r| r.run_id.as_str())
                .collect::<Vec<_>>(),
            ["c", "b"]
        );
        assert_eq!(first.effective_vault_ids, [vault]);
        assert!(first
            .runs
            .iter()
            .all(|run| run.parent_run_id.as_deref() == Some("new-000")));
        let second = runs_page(&ro, &scope(&dir), first.next_cursor.as_ref(), Some(2)).unwrap();
        assert_eq!(
            second
                .runs
                .iter()
                .map(|r| r.run_id.as_str())
                .collect::<Vec<_>>(),
            ["a"]
        );
        assert!(second.next_cursor.is_none());
        assert!(ro.prepare("DELETE FROM runs").unwrap().execute([]).is_err());
    }
    #[test]
    fn unknown_registry_path_is_unavailable_without_registration() {
        let (dir, conn, _) = fixture("history-unknown-registry");
        let ro = ReadOnly::open(&dir).unwrap();
        assert!(runs_page(&ro, &scope(&dir.join("unknown")), None, None).is_err());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM vault_registry", [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn construct_scope_is_explicit_and_limits_are_bounded() {
        let (dir, conn, vault) = fixture("history-construct-explicit");
        for n in 0..210 {
            seed(
                &conn,
                &vault,
                &format!("run-{n:03}"),
                "construct:test",
                "2026-10-22T12:00:00Z",
                None,
            );
        }
        let ro = ReadOnly::open(&dir).unwrap();
        let scope = RunHistoryScope::Construct {
            actor: "construct:test".into(),
            vault: RegisteredVaults::AllRegistered,
        };
        assert_eq!(runs_page(&ro, &scope, None, None).unwrap().runs.len(), 50);
        assert_eq!(
            runs_page(&ro, &scope, None, Some(u32::MAX))
                .unwrap()
                .runs
                .len(),
            200
        );
        let smallest = runs_page(&ro, &scope, None, Some(0)).unwrap();
        assert_eq!(smallest.runs.len(), 1);
        assert!(smallest.next_cursor.is_some());
        assert!(serde_json::from_str::<RunHistoryScope>(
            r#"{"kind":"construct","actor":"construct:test","vault":"/somewhere"}"#
        )
        .is_err());
    }

    #[test]
    fn origin_resolution_never_substitutes_the_active_vault() {
        let (dir, _conn, vault) = fixture("history-origin");
        let ro = ReadOnly::open(&dir).unwrap();
        assert!(matches!(
            run_origin(&ro, None).unwrap(),
            RunOrigin::NotRecorded
        ));
        assert!(matches!(
            run_origin(&ro, Some("removed")).unwrap(),
            RunOrigin::Unavailable
        ));
        let RunOrigin::Registered { vault: path } = run_origin(&ro, Some(&vault)).unwrap() else {
            panic!("registered path is required");
        };
        assert_eq!(path, runtime::scope::canonical_path(&dir));
    }

    #[test]
    fn capped_deep_lineage_preserves_each_returned_ancestor() {
        let (dir, conn, vault) = fixture("history-deep-lineage");
        seed(
            &conn,
            &vault,
            "root",
            "process:reviewer",
            "2026-10-22T12:00:00Z",
            None,
        );
        let mut parent = "root".to_owned();
        for n in 0..210 {
            let id = format!("child-{n:03}");
            seed(
                &conn,
                &vault,
                &id,
                "process:other",
                "2026-10-22T12:00:01Z",
                Some(&parent),
            );
            parent = id;
        }
        let ro = ReadOnly::open(&dir).unwrap();
        let result = run_lineage(&ro, "root").unwrap();
        assert_eq!(result.runs.len(), 200);
        assert!(result.truncated);
        let mut known = HashSet::from(["root".to_owned()]);
        for run in result.runs {
            assert!(known.contains(run.parent_run_id.as_ref().unwrap()));
            known.insert(run.run_id);
        }
    }
    #[test]
    fn bounded_lineage_keeps_cross_actor_origins_and_terminates_cycles() {
        let (dir, conn, vault) = fixture("history-bounded-lineage");
        let other_dir = testutil::temp_vault("history-lineage-other");
        let other = runtime::scope::register(&conn, &other_dir).unwrap();
        seed(
            &conn,
            &vault,
            "root",
            "process:reviewer",
            "2026-10-22T12:00:00Z",
            Some("child"),
        );
        seed(
            &conn,
            &other,
            "child",
            "process:other",
            "2026-10-22T12:00:01Z",
            Some("root"),
        );
        let ro = ReadOnly::open(&dir).unwrap();
        let cycle = run_lineage(&ro, "root").unwrap();
        assert_eq!(cycle.runs.len(), 1);
        assert_eq!(cycle.runs[0].vault_id.as_deref(), Some(other.as_str()));
        assert_eq!(cycle.runs[0].actor.as_deref(), Some("process:other"));
        assert!(!cycle.truncated);
        for n in 0..220 {
            seed(
                &conn,
                &vault,
                &format!("branch-{n:03}"),
                "process:other",
                "2026-10-22T12:00:02Z",
                Some("root"),
            );
        }
        let capped = run_lineage(&ro, "root").unwrap();
        assert_eq!(capped.runs.len(), 200);
        assert!(capped.truncated);
        assert_eq!(
            capped
                .runs
                .iter()
                .map(|r| &r.run_id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            200
        );
        assert!(run_lineage(&ro, "unknown").is_err());
    }
}
