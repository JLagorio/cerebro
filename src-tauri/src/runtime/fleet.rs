//! The fleet read model (M33.2).
//!
//! SELECT-only over `runs` and the two governance tables M31.6 writes. This
//! module computes nothing the rows do not already say: every aggregate it
//! serves is recomputable from the rows it reads, nothing is cached, and
//! nothing is written. If a number here needs a new fact recorded, that is a
//! Meter or governance change with its own test — never a side-write from a
//! read model.
//!
//! **A missing join is `None`, never a zero.** M31's measurement rule, and
//! the reason `RunDetail`'s two joins are `Option` rather than empty
//! collections: a run from before M31.6 recorded no cost components, and a
//! run that recorded ten of them costing nothing is a different fact. The UI
//! renders the first as "not recorded" and would render the second as zeros.
//! Collapsing them would make the honest answer unavailable.
//!
//! **"Fleet", never "ledger".** Same rule `surface.rs` states: the word
//! ledger belongs to the epistemic record in the vault. This is operational.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// The most rows one page will ever return, however large a limit is asked
/// for. A UI that wants more asks for another page; a UI that asks for
/// 10_000_000 gets 200 rather than an unbounded read on the main thread.
const MAX_LIMIT: u32 = 200;

/// The default page size when the caller names none.
const DEFAULT_LIMIT: u32 = 50;

/// Which runs to return. Every field is optional and absent means "any" —
/// the unfiltered page is the honest default for a table that spans vaults.
#[derive(Debug, Default, Deserialize)]
pub struct Filter {
    pub vault_id: Option<String>,
    pub lane: Option<String>,
    /// `attended` or `ambient`.
    pub mode: Option<String>,
    /// An exact actor string. There is deliberately no "unattributed" filter
    /// value here: NULL is matched by asking for no actor filter and reading
    /// the rows, because a magic string meaning NULL would collide with a
    /// real actor the day somebody named one that.
    pub actor: Option<String>,
    pub limit: Option<u32>,
}

/// One run, as the fleet shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FleetRun {
    pub run_id: String,
    /// `None` is a run written before M33.1, or bare attended chat. The UI
    /// renders it "unattributed" and nothing backfills it.
    pub actor: Option<String>,
    pub vault_id: Option<String>,
    pub mode: String,
    pub lane: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub outcome: String,
    /// `pending`, `exact`, or `unknown`. The token counts below are only
    /// meaningful when this is `exact`; the UI reads this field FIRST and
    /// renders "unknown" rather than the zeros a lost run leaves behind.
    pub usage_state: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub proposals_submitted: u64,
    pub applied: u64,
    pub rejected: u64,
    /// M34.3's hop lineage, surfaced in M41: the run this one was spawned
    /// FROM. `None` is a root — every run before handoffs existed, and every
    /// run a person or a schedule started directly.
    pub parent_run_id: Option<String>,
}

/// One row of `run_cost_components` (M31.6).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CostComponentRow {
    pub component: String,
    pub unit: String,
    pub model_id: Option<String>,
    pub quantity: u64,
    pub observed_cost_micros: Option<u64>,
    /// M31.5's flag: this component was derived rather than measured. A
    /// surface that shows an estimate as a measurement is worse than one
    /// that shows nothing.
    pub estimated: bool,
    pub pricing_snapshot_id: Option<String>,
    pub recorded_at: String,
}

/// One row of `assembly_metrics` (M31.6).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssemblyMetricsRow {
    pub manifest_id: String,
    pub intended_stakes: String,
    pub source_count: u64,
    pub evidence_item_count: u64,
    pub context_bytes: u64,
    pub retrieval_query_count: u64,
    pub blocked_intent_count: u64,
    pub answer_latency_micros: Option<u64>,
    pub recorded_at: String,
}

/// One run and everything the governance tables recorded about it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunDetail {
    pub run: FleetRun,
    /// `None` = no rows recorded for this run: pre-M31.6, or a path M31.6
    /// does not cover. NOT an empty vec, which would read as "measured, and
    /// it cost nothing".
    pub cost_components: Option<Vec<CostComponentRow>>,
    pub assembly: Option<AssemblyMetricsRow>,
}

/// What one actor has done, summed from its rows.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActorSummary {
    pub actor: String,
    pub run_count: u64,
    /// Summed across runs whose `usage_state` is `exact` ONLY. A run that
    /// lost its usage contributes to `unknown_runs` instead of adding zero:
    /// a lifetime total that silently absorbed unmetered runs would read as
    /// a smaller bill than the one actually paid.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub unknown_runs: u64,
    /// Rows still carrying `outcome = 'running'` (M33b.4). This is the whole
    /// of what "working" means on the fleet surface: a run the dispatcher
    /// opened and has not finalized. It is a COUNT rather than a flag because
    /// the row count is what the table holds, and a surface that wants a
    /// boolean can ask whether it is above zero — the reverse is lossy the
    /// day the concurrency ceiling stops being one.
    pub running_runs: u64,
    /// The most recent run's outcome and start, or `None` for an actor with
    /// no runs at all — which is what a freshly written Agent record has.
    pub last_outcome: Option<String>,
    pub last_started_at: Option<String>,
}

const RUN_COLUMNS: &str = "run_id, actor, vault_id, mode, lane, started_at, ended_at, outcome, \
                           usage_state, input_tokens, output_tokens, proposals_submitted, \
                           applied, rejected, parent_run_id";

fn map_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<FleetRun> {
    Ok(FleetRun {
        run_id: row.get(0)?,
        actor: row.get(1)?,
        vault_id: row.get(2)?,
        mode: row.get(3)?,
        lane: row.get(4)?,
        started_at: row.get(5)?,
        ended_at: row.get(6)?,
        outcome: row.get(7)?,
        usage_state: row.get(8)?,
        input_tokens: row.get::<_, i64>(9)? as u64,
        output_tokens: row.get::<_, i64>(10)? as u64,
        proposals_submitted: row.get::<_, i64>(11)? as u64,
        applied: row.get::<_, i64>(12)? as u64,
        rejected: row.get::<_, i64>(13)? as u64,
        parent_run_id: row.get(14)?,
    })
}

/// One page of runs, newest first.
///
/// The WHERE clause is built from the filters that are PRESENT, and every
/// value travels as a bound parameter — the column names are the only thing
/// this function interpolates, and they are literals in this file.
pub fn runs(conn: &Connection, filter: &Filter) -> Result<Vec<FleetRun>, String> {
    let mut clauses: Vec<String> = Vec::new();
    let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::new();
    for (column, value) in [
        ("vault_id", &filter.vault_id),
        ("lane", &filter.lane),
        ("mode", &filter.mode),
        ("actor", &filter.actor),
    ] {
        if let Some(value) = value {
            clauses.push(format!("{column} = ?{}", bound.len() + 1));
            bound.push(value);
        }
    }
    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    // Clamped server-side: the renderer's number is a request, not a
    // permission.
    let limit = filter.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    // `run_id` breaks ties so a page is stable across calls — two runs that
    // started in the same second must not swap places between renders.
    let sql = format!(
        "SELECT {RUN_COLUMNS} FROM runs {where_clause} \
         ORDER BY started_at DESC, run_id DESC LIMIT {limit}"
    );
    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(bound.as_slice(), map_run)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// One run and its governance joins.
///
/// An unknown id is an ERROR, not an empty detail: the caller asked about a
/// specific run, and answering "here it is, with nothing in it" would make a
/// typo indistinguishable from an unmetered run.
pub fn run_detail(conn: &Connection, run_id: &str) -> Result<RunDetail, String> {
    let run = conn
        .query_row(
            &format!("SELECT {RUN_COLUMNS} FROM runs WHERE run_id = ?1"),
            [run_id],
            map_run,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("no run with id {run_id}"),
            other => other.to_string(),
        })?;

    let mut statement = conn
        .prepare(
            "SELECT component, unit, model_id, quantity, observed_cost_micros, estimated, \
             pricing_snapshot_id, recorded_at FROM run_cost_components WHERE run_id = ?1 \
             ORDER BY component",
        )
        .map_err(|e| e.to_string())?;
    let components = statement
        .query_map([run_id], |row| {
            Ok(CostComponentRow {
                component: row.get(0)?,
                unit: row.get(1)?,
                model_id: row.get(2)?,
                quantity: row.get::<_, i64>(3)? as u64,
                observed_cost_micros: row.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                estimated: row.get::<_, i64>(5)? != 0,
                pricing_snapshot_id: row.get(6)?,
                recorded_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let assembly = conn
        .query_row(
            "SELECT manifest_id, intended_stakes, source_count, evidence_item_count, \
             context_bytes, retrieval_query_count, blocked_intent_count, \
             answer_latency_micros, recorded_at FROM assembly_metrics WHERE run_id = ?1",
            [run_id],
            |row| {
                Ok(AssemblyMetricsRow {
                    manifest_id: row.get(0)?,
                    intended_stakes: row.get(1)?,
                    source_count: row.get::<_, i64>(2)? as u64,
                    evidence_item_count: row.get::<_, i64>(3)? as u64,
                    context_bytes: row.get::<_, i64>(4)? as u64,
                    retrieval_query_count: row.get::<_, i64>(5)? as u64,
                    blocked_intent_count: row.get::<_, i64>(6)? as u64,
                    answer_latency_micros: row.get::<_, Option<i64>>(7)?.map(|v| v as u64),
                    recorded_at: row.get(8)?,
                })
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })?;

    Ok(RunDetail {
        run,
        // Empty → None. See the module note: "measured at zero" and "never
        // measured" are different answers and this is where they part.
        cost_components: (!components.is_empty()).then_some(components),
        assembly,
    })
}

/// The one aggregation both summary reads are folds of.
///
/// `Some(actor)` narrows to one; `None` groups every ATTRIBUTED actor the
/// table holds. Written once rather than twice on purpose: the rules about
/// what may be summed — exact-usage rows only, unmetered rows counted instead
/// of added as zero — are the honesty of the number, and two copies of them
/// is two places for one to drift.
///
/// The last outcome and start arrive by correlated subquery rather than by
/// SQLite's bare-column-beside-max() behaviour, because the ordering here is
/// `started_at DESC, run_id DESC` — two runs that started in the same second
/// must resolve the same way they do in `runs()`, and `max()` alone cannot
/// break that tie.
fn summaries(conn: &Connection, actor: Option<&str>) -> Result<Vec<ActorSummary>, String> {
    // An unattributed run belongs to no actor, so it is not a row of this
    // read. It is still a row of `runs()`, which is where it stays visible.
    let where_clause = if actor.is_some() {
        "WHERE r.actor = ?1"
    } else {
        "WHERE r.actor IS NOT NULL"
    };
    let sql = format!(
        "SELECT r.actor, count(*), \
         coalesce(sum(CASE WHEN r.usage_state = 'exact' THEN r.input_tokens END), 0), \
         coalesce(sum(CASE WHEN r.usage_state = 'exact' THEN r.output_tokens END), 0), \
         sum(CASE WHEN r.usage_state <> 'exact' THEN 1 ELSE 0 END), \
         sum(CASE WHEN r.outcome = 'running' THEN 1 ELSE 0 END), \
         (SELECT x.outcome FROM runs x WHERE x.actor = r.actor \
          ORDER BY x.started_at DESC, x.run_id DESC LIMIT 1), \
         (SELECT x.started_at FROM runs x WHERE x.actor = r.actor \
          ORDER BY x.started_at DESC, x.run_id DESC LIMIT 1) \
         FROM runs r {where_clause} GROUP BY r.actor ORDER BY r.actor"
    );
    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let bound: Vec<&dyn rusqlite::ToSql> = match actor.as_ref() {
        Some(actor) => vec![actor],
        None => Vec::new(),
    };
    let rows = statement
        .query_map(bound.as_slice(), |row| {
            Ok(ActorSummary {
                actor: row.get(0)?,
                run_count: row.get::<_, i64>(1)? as u64,
                input_tokens: row.get::<_, i64>(2)? as u64,
                output_tokens: row.get::<_, i64>(3)? as u64,
                unknown_runs: row.get::<_, Option<i64>>(4)?.unwrap_or(0) as u64,
                running_runs: row.get::<_, Option<i64>>(5)?.unwrap_or(0) as u64,
                last_outcome: row.get(6)?,
                last_started_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Everything one actor's rows add up to.
///
/// An actor with no runs is not an error — a freshly written Agent record
/// has none, and "no runs yet" is the answer its dossier should show — so
/// this returns a zeroed summary with `last_outcome: None` rather than
/// refusing. The zeros are measured-at-zero (this actor has no rows); the
/// `None`s are not-recorded (nothing ever stamped a last outcome). They are
/// different claims and the caller renders them differently.
pub fn actor_summary(conn: &Connection, actor: &str) -> Result<ActorSummary, String> {
    Ok(summaries(conn, Some(actor))?
        .pop()
        .unwrap_or_else(|| ActorSummary {
            actor: actor.to_string(),
            run_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            unknown_runs: 0,
            running_runs: 0,
            last_outcome: None,
            last_started_at: None,
        }))
}

/// Every actor the run table has ever attributed anything to, summed
/// (M33b.3).
///
/// The fleet surface lists AGENTS, which are records in a vault — so this is
/// deliberately not that list. It answers the other half: what the runs know
/// about who ran. An agent record with no row here has never run, and an
/// actor here with no record is work the vault does not own a persona for
/// (the internal constructs, a renamed agent's old slug). The surface joins
/// the two and says which is which; collapsing either side into the other
/// here would decide that question in the wrong place.
///
/// An empty result is measured-at-zero — nothing attributed has ever run. A
/// missing database is an error, and the caller renders it as unavailable.
pub fn actor_summaries(conn: &Connection) -> Result<Vec<ActorSummary>, String> {
    summaries(conn, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    struct Seed<'a> {
        run_id: &'a str,
        actor: Option<&'a str>,
        started_at: &'a str,
        mode: &'a str,
        lane: &'a str,
        usage_state: &'a str,
        outcome: &'a str,
        input: i64,
        output: i64,
    }

    impl<'a> Seed<'a> {
        fn new(run_id: &'a str, actor: Option<&'a str>, started_at: &'a str) -> Self {
            Seed {
                run_id,
                actor,
                started_at,
                mode: "ambient",
                lane: "filed",
                usage_state: "exact",
                outcome: "succeeded",
                input: 100,
                output: 10,
            }
        }
    }

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    fn seed_runs(conn: &Connection, vault: &str, rows: &[Seed<'_>]) {
        for row in rows {
            conn.execute(
                // A run still going has NO end. Seeding one with an
                // `ended_at` would make the fixture describe a row the
                // dispatcher never writes.
                "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, \
                 ended_at, outcome, usage_state, input_tokens, output_tokens, cache_read, \
                 cache_write, reserved_total_tokens, reserved_output_tokens, \
                 proposals_submitted, applied, rejected, actor) \
                 VALUES (?1, ?2, 'store', ?3, ?4, ?5, \
                         CASE WHEN ?6 = 'running' THEN NULL ELSE ?5 END, \
                         ?6, ?7, ?8, ?9, 0, 0, 0, 0, 0, 0, 0, ?10)",
                rusqlite::params![
                    row.run_id,
                    vault,
                    row.mode,
                    row.lane,
                    row.started_at,
                    row.outcome,
                    row.usage_state,
                    row.input,
                    row.output,
                    row.actor,
                ],
            )
            .unwrap();
        }
    }

    #[test]
    fn runs_filter_by_actor_and_come_back_newest_first() {
        let (dir, conn, vault) = fixture("fleet-filter");
        seed_runs(
            &conn,
            &vault,
            &[
                Seed::new("r1", Some("process:digest"), "2026-08-09T10:00:00Z"),
                Seed::new("r2", None, "2026-08-09T11:00:00Z"),
                Seed::new("r3", Some("process:digest"), "2026-08-09T12:00:00Z"),
            ],
        );
        let page = runs(
            &conn,
            &Filter {
                actor: Some("process:digest".into()),
                ..Filter::default()
            },
        )
        .unwrap();
        assert_eq!(
            page.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(),
            vec!["r3", "r1"],
            "the actor filter narrows, and recency orders"
        );

        let all = runs(&conn, &Filter::default()).unwrap();
        assert_eq!(all.len(), 3, "no filter is every run");
        assert_eq!(
            all[1].actor, None,
            "and the unattributed run is returned as such, not hidden"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // M41.2 — M34.3 wrote hop lineage and nothing SELECTed it; the chain
    // trace starts here. NULL is a root, and every seeded legacy row reads
    // back as one rather than erroring on the new column.
    #[test]
    fn a_hop_carries_its_parent_and_a_root_carries_none() {
        let (dir, conn, vault) = fixture("fleet-parent");
        seed_runs(
            &conn,
            &vault,
            &[Seed::new(
                "root",
                Some("process:digest"),
                "2026-08-09T10:00:00Z",
            )],
        );
        conn.execute(
            "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, \
             ended_at, outcome, usage_state, input_tokens, output_tokens, cache_read, \
             cache_write, reserved_total_tokens, reserved_output_tokens, \
             proposals_submitted, applied, rejected, actor, parent_run_id) \
             VALUES ('hop', ?1, 'store', 'ambient', 'filed', '2026-08-09T10:05:00Z', \
                     '2026-08-09T10:06:00Z', 'succeeded', 'exact', 5, 1, 0, 0, 0, 0, \
                     0, 0, 0, 'process:knowledge', 'root')",
            rusqlite::params![vault],
        )
        .unwrap();

        let all = runs(&conn, &Filter::default()).unwrap();
        let hop = all.iter().find(|r| r.run_id == "hop").unwrap();
        assert_eq!(hop.parent_run_id.as_deref(), Some("root"));
        let root = all.iter().find(|r| r.run_id == "root").unwrap();
        assert_eq!(root.parent_run_id, None, "a root run reads back as one");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_limit_is_clamped_rather_than_trusted() {
        let (dir, conn, vault) = fixture("fleet-limit");
        let rows: Vec<Seed<'_>> = ["r0", "r1", "r2", "r3", "r4"]
            .into_iter()
            .map(|id| Seed::new(id, None, "2026-08-09T10:00:00Z"))
            .collect();
        seed_runs(&conn, &vault, &rows);
        let asked = runs(
            &conn,
            &Filter {
                limit: Some(2),
                ..Filter::default()
            },
        )
        .unwrap();
        assert_eq!(asked.len(), 2, "a small limit is honoured");
        let absurd = runs(
            &conn,
            &Filter {
                limit: Some(10_000_000),
                ..Filter::default()
            },
        )
        .unwrap();
        assert_eq!(absurd.len(), 5, "and an absurd one is clamped, not obeyed");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detail_without_cost_rows_is_absent_and_never_zero() {
        let (dir, conn, vault) = fixture("fleet-absent");
        seed_runs(
            &conn,
            &vault,
            &[Seed::new("r1", None, "2026-08-09T10:00:00Z")],
        );
        let detail = run_detail(&conn, "r1").unwrap();
        assert!(
            detail.cost_components.is_none(),
            "no rows means not recorded — an empty vec would read as measured-at-zero"
        );
        assert!(detail.assembly.is_none());
        assert_eq!(detail.run.run_id, "r1");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_run_id_is_refused_rather_than_answered_emptily() {
        let (dir, conn, _vault) = fixture("fleet-unknown");
        let refused = run_detail(&conn, "nope");
        assert!(
            refused.is_err(),
            "a typo and an unmetered run must not look the same"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lifetime_sum_skips_unmetered_runs_into_a_count_instead_of_adding_zero() {
        let (dir, conn, vault) = fixture("fleet-summary");
        let mut lost = Seed::new("r2", Some("process:digest"), "2026-08-09T11:00:00Z");
        lost.usage_state = "unknown";
        lost.input = 0;
        lost.output = 0;
        seed_runs(
            &conn,
            &vault,
            &[
                Seed::new("r1", Some("process:digest"), "2026-08-09T10:00:00Z"),
                lost,
                Seed::new("r3", Some("other"), "2026-08-09T12:00:00Z"),
            ],
        );
        let summary = actor_summary(&conn, "process:digest").unwrap();
        assert_eq!(summary.run_count, 2, "both runs happened");
        assert_eq!(summary.input_tokens, 100, "only the metered one is summed");
        assert_eq!(summary.output_tokens, 10);
        assert_eq!(
            summary.unknown_runs, 1,
            "and the unmetered one is COUNTED, so the total is visibly partial"
        );
        assert_eq!(summary.last_outcome.as_deref(), Some("succeeded"));
        assert_eq!(
            summary.last_started_at.as_deref(),
            Some("2026-08-09T11:00:00Z"),
            "the most recent run is this actor's, not the other's"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_actor_with_no_runs_summarises_to_nothing_rather_than_refusing() {
        // A freshly written Agent record. "No runs yet" is an answer its
        // dossier has to be able to show.
        let (dir, conn, _vault) = fixture("fleet-fresh");
        let summary = actor_summary(&conn, "process:brand-new").unwrap();
        assert_eq!(summary.run_count, 0);
        assert_eq!(summary.unknown_runs, 0);
        assert_eq!(summary.running_runs, 0);
        assert_eq!(summary.last_outcome, None);
        assert_eq!(summary.last_started_at, None);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_attributed_actor_comes_back_once_with_the_same_arithmetic(
    ) -> Result<(), Box<dyn std::error::Error>> {
        // M33b.3: the fleet asks about the whole table at once, and the
        // per-actor numbers must be the ones its dossier already shows —
        // same sums, same skips, same tie-break.
        let (dir, conn, vault) = fixture("fleet-roster");
        let mut lost = Seed::new("r2", Some("process:scout"), "2026-08-09T11:00:00Z");
        lost.usage_state = "unknown";
        lost.input = 0;
        lost.output = 0;
        seed_runs(
            &conn,
            &vault,
            &[
                Seed::new("r1", Some("process:scout"), "2026-08-09T10:00:00Z"),
                lost,
                Seed::new("r3", Some("agent:m26-ingest"), "2026-08-09T12:00:00Z"),
                // Unattributed: a row of `runs()`, never a row of the roster.
                Seed::new("r4", None, "2026-08-09T13:00:00Z"),
            ],
        );

        let roster = actor_summaries(&conn)?;
        assert_eq!(
            roster.iter().map(|s| s.actor.as_str()).collect::<Vec<_>>(),
            vec!["agent:m26-ingest", "process:scout"],
            "one row per attributed actor, byte-sorted, and NULL is not an actor"
        );
        let scout = &roster[1];
        assert_eq!(scout.run_count, 2, "both runs happened");
        assert_eq!(scout.input_tokens, 100, "only the metered one is summed");
        assert_eq!(
            scout.unknown_runs, 1,
            "and the unmetered one is COUNTED, so the total reads as partial"
        );
        assert_eq!(
            scout.last_started_at.as_deref(),
            Some("2026-08-09T11:00:00Z"),
            "the newest of THIS actor's runs, not the newest in the table"
        );
        assert_eq!(
            scout,
            &actor_summary(&conn, "process:scout")?,
            "the fold is the same fold — one aggregation, two entry points"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn a_run_still_going_is_counted_as_working_rather_than_inferred(
    ) -> Result<(), Box<dyn std::error::Error>> {
        // M33b.4. "Working" is not a guess from a recent timestamp — it is
        // the row the dispatcher opened and has not finalized.
        let (dir, conn, vault) = fixture("fleet-working");
        let mut going = Seed::new("r2", Some("process:scout"), "2026-08-09T11:00:00Z");
        going.outcome = "running";
        going.usage_state = "pending";
        going.input = 0;
        going.output = 0;
        seed_runs(
            &conn,
            &vault,
            &[
                Seed::new("r1", Some("process:scout"), "2026-08-09T10:00:00Z"),
                going,
                Seed::new("r3", Some("process:quiet"), "2026-08-09T09:00:00Z"),
            ],
        );

        let roster = actor_summaries(&conn)?;
        let scout = roster.iter().find(|s| s.actor == "process:scout").unwrap();
        assert_eq!(scout.running_runs, 1, "one row is open right now");
        assert_eq!(
            scout.unknown_runs, 1,
            "and a pending run has not said what it spent, so it is not summed"
        );
        let quiet = roster.iter().find(|s| s.actor == "process:quiet").unwrap();
        assert_eq!(
            quiet.running_runs, 0,
            "an actor with only finished runs is not working"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn a_table_with_no_attributed_runs_is_empty_rather_than_refused(
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Measured at zero: nothing attributed has run here. A REFUSAL is
        // what a missing database gets, and the surface renders the two
        // differently.
        let (dir, conn, vault) = fixture("fleet-nobody");
        seed_runs(
            &conn,
            &vault,
            &[Seed::new("r1", None, "2026-08-09T10:00:00Z")],
        );
        assert!(actor_summaries(&conn)?.is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
