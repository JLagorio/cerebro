//! The fleet read model (M33.2).
//!
//! It reads `runs`, the two governance tables M31.6 writes, the
//! `operational_log` rows recorded against a run (M56.9), what the run
//! wrote (`write_log::run_writes`, M58.1b), which run made which commit
//! (`run_commits`, M58.4), and what is waiting to wake an agent
//! (`agent_wakes`, M63.1b). `subject_runs` places recorded causes and their
//! bounded hop descendants on pages (M63.4b). It reads them through
//! [`ReadOnly`]: a handle SQLite refuses writes on, so this module
//! cannot change a row even by mistake. It computes nothing the rows do not
//! already say: every aggregate it serves is recomputable from the rows it
//! reads, and nothing is cached. If a number here needs a new fact recorded,
//! that is a Meter or governance change with its own test — never a
//! side-write from a read model.
//!
//! **A missing join is `None`, never a zero.** M31's measurement rule, and
//! the reason `RunDetail`'s two cost joins are `Option` rather than empty
//! collections: a run from before M31.6 recorded no cost components, and a
//! run that recorded ten of them costing nothing is a different fact. The UI
//! renders the first as "not recorded" and would render the second as zeros.
//! Collapsing them would make the honest answer unavailable. Refusals are the
//! other way round: they have been recorded with their run since M54.9, so an
//! empty list is measured-at-zero.
//!
//! **"Fleet", never "ledger".** Same rule `surface.rs` states: the word
//! ledger belongs to the epistemic record in the vault. This is operational.

use serde::{Deserialize, Serialize};

use super::cause::{view_of_column, CauseView};
use super::write_log::{run_writes, writers_since, RunWrites};
use super::ReadOnly;
use crate::vault::receipt::HUMAN_ACTOR;

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
    /// The three proposal counters are `None` — NOT RECORDED — on a row
    /// with `counters_booked = 0`: one written before M49.9, when nothing
    /// booked them and their zeros were never a measurement. On a booked
    /// row, `0` is measured-at-zero.
    pub proposals_submitted: Option<u64>,
    pub applied: Option<u64>,
    pub rejected: Option<u64>,
    /// M34.3's hop lineage, surfaced in M41: the run this one was spawned
    /// FROM. `None` is a root — every run before handoffs existed, and every
    /// run a person or a schedule started directly.
    pub parent_run_id: Option<String>,
    /// Why the run started (M56.7), with the kind's words in Rust's
    /// vocabulary (`cause::view_of_column`). `None` is a row from before
    /// causes were recorded, or an unattended request that named none: the
    /// UI reads it "why not recorded", and nothing backfills it.
    pub cause: Option<CauseView>,
    /// The Claude Code session the run ran as, from its stream (M56.7).
    /// `None` is not recorded: a row from before, or a run whose stream never
    /// named one (the app died under it).
    pub cli_session_id: Option<String>,
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

/// One refusal recorded against a run in `operational_log` (M56.9).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RefusalRow {
    pub code: String,
    pub surface: String,
    pub detail: String,
    pub rule: Option<String>,
    pub recorded_at: String,
}

/// One run, everything the governance tables recorded about it, and what it
/// was refused.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunDetail {
    pub run: FleetRun,
    /// `None` = no rows recorded for this run: pre-M31.6, or a path M31.6
    /// does not cover. NOT an empty vec, which would read as "measured, and
    /// it cost nothing".
    pub cost_components: Option<Vec<CostComponentRow>>,
    pub assembly: Option<AssemblyMetricsRow>,
    /// The model Claude Code reported answering, as the run's last assistant
    /// turn named it (`runs.model_id`). `None` is not recorded.
    pub model_id: Option<String>,
    /// What the run was refused, in id order, at most [`REFUSALS_SHOWN`].
    /// Telemetry rows filed under the same code are left out (see
    /// [`TELEMETRY_SURFACES`]). Empty is measured: nothing was refused.
    pub refusals: Vec<RefusalRow>,
    /// Every refusal row the run has, so a list the cap cut says so.
    pub refusals_total: u64,
    /// What the run wrote in the vault (M58.1b), as `runs.writes_booked`
    /// lets it be said: `Recorded` with an empty list is measured, it wrote
    /// nothing; `Partial` is booked, but the shell may have written
    /// elsewhere; `NotRecorded` is a run from before M58.1 booked writes,
    /// never an empty list.
    pub wrote: RunWrites,
}

/// Where a run's Claude Code session file is, and how many runs share it
/// (M56.9). What `fleet_run_transcript` needs to find and word a transcript.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TranscriptKey {
    /// `None` is not recorded: a row from before M56.7, or a run whose
    /// stream never named one.
    pub session_id: Option<String>,
    /// The vault the run ran in, joined through `vault_registry`. `None` for
    /// a run with no vault, or one whose vault is no longer registered.
    pub vault_path: Option<String>,
    pub started_at: String,
    /// The latest end (or start, for a run still going) across every run
    /// that shares the session: what tells Claude Code's sweep from a clear.
    pub last_activity_at: String,
    /// How many runs share the session; 1 for a run with none.
    pub runs_in_session: u64,
}

/// The most refusals one detail lists. The rest are counted.
pub const REFUSALS_SHOWN: u32 = 50;

/// The surfaces that file run-attributed `capability_unavailable` rows as
/// telemetry rather than as refusals, each read from the const where it is
/// written. The Refused list leaves these out and keeps everything else, so
/// a refusal surface added later shows instead of hiding.
pub const TELEMETRY_SURFACES: [&str; 4] = [
    crate::agent::meter::USAGE_SURFACE,
    crate::agent::meter::STREAM_SURFACE,
    super::governance::TOOL_CALLS_SURFACE,
    crate::assembly::ask::COSTS_SURFACE,
];

/// The refusals a run's detail lists. `?1` is the run; `?2`–`?5` are the
/// telemetry surfaces. Read by `operational_log_by_run` (schema v21).
pub(crate) const REFUSALS_SQL: &str = "SELECT code, surface, detail, rule, recorded_at \
     FROM operational_log WHERE run_id = ?1 AND surface NOT IN (?2, ?3, ?4, ?5) \
     ORDER BY id LIMIT 50";

const REFUSALS_COUNT_SQL: &str = "SELECT count(*) FROM operational_log \
     WHERE run_id = ?1 AND surface NOT IN (?2, ?3, ?4, ?5)";

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
    /// of what "working" means on the fleet surface: a run whose row was
    /// opened — by the ambient claim, or at an attended spawn since M49.9 —
    /// and has not been finalized. It is a COUNT rather than a flag because
    /// the row count is what the table holds, and a surface that wants a
    /// boolean can ask whether it is above zero — the reverse is lossy the
    /// day the concurrency ceiling stops being one.
    pub running_runs: u64,
    /// The most recent run's outcome and start, or `None` for an actor with
    /// no runs at all — which is what a freshly written Agent record has.
    pub last_outcome: Option<String>,
    pub last_started_at: Option<String>,
}

/// The run columns `map_run` reads, in its order. Shared with
/// `activity::run_rows` (M64.2), so History reads a run as Fleet does.
pub(crate) const RUN_COLUMNS: &str =
    "run_id, actor, vault_id, mode, lane, started_at, ended_at, outcome, \
                           usage_state, input_tokens, output_tokens, proposals_submitted, \
                           applied, rejected, parent_run_id, counters_booked, cause, \
                           cli_session_id";

pub(crate) fn map_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<FleetRun> {
    let booked = row.get::<_, i64>(15)? != 0;
    let counter = |index: usize| -> rusqlite::Result<Option<u64>> {
        Ok(booked.then_some(row.get::<_, i64>(index)? as u64))
    };
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
        proposals_submitted: counter(11)?,
        applied: counter(12)?,
        rejected: counter(13)?,
        parent_run_id: row.get(14)?,
        cause: row
            .get::<_, Option<String>>(16)?
            .as_deref()
            .and_then(view_of_column),
        cli_session_id: row.get(17)?,
    })
}

/// One page of runs, newest first.
///
/// The WHERE clause is built from the filters that are PRESENT, and every
/// value travels as a bound parameter — the column names are the only thing
/// this function interpolates, and they are literals in this file.
pub fn runs(ro: &ReadOnly, filter: &Filter) -> Result<Vec<FleetRun>, String> {
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
    let mut statement = ro.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(bound.as_slice(), map_run)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Runs whose recorded cause names one of these pages, plus two hop levels.
/// The subject set is one bound JSON value; every recursive level stays in
/// this vault. Empty means no read, and old runs without causes stay unplaced.
pub fn subject_runs(
    ro: &ReadOnly,
    vault_id: &str,
    subjects: &[String],
    limit: Option<u32>,
) -> Result<Vec<FleetRun>, String> {
    if subjects.is_empty() {
        return Ok(Vec::new());
    }
    if subjects.len() > 1000 {
        return Err("A page's runs can search at most 1000 page paths.".into());
    }
    if subjects.iter().any(|path| path.len() > 1024) {
        return Err("A page path for the runs search is longer than 1024 bytes.".into());
    }
    let subjects = serde_json::to_string(subjects).map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let sql = format!(
        "WITH RECURSIVE placed(run_id, depth) AS ( \
         SELECT run_id, 0 FROM runs WHERE vault_id = ?1 \
         AND json_extract(cause, '$.subject') IN (SELECT value FROM json_each(?2)) \
         UNION SELECT child.run_id, placed.depth + 1 FROM runs child \
         JOIN placed ON child.parent_run_id = placed.run_id \
         WHERE child.vault_id = ?1 AND placed.depth < 2) \
         SELECT {RUN_COLUMNS} FROM runs WHERE vault_id = ?1 \
         AND run_id IN (SELECT run_id FROM placed) \
         ORDER BY started_at DESC, run_id DESC LIMIT ?3"
    );
    let mut statement = ro.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(rusqlite::params![vault_id, subjects, limit], map_run)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Home's finished unattended work, scoped before the bounded read.
#[derive(Debug, Serialize)]
pub struct EndedRuns {
    pub runs: Vec<FleetRun>,
    pub truncated: bool,
}
pub fn ended_runs(ro: &ReadOnly, vault_id: &str, limit: Option<u32>) -> Result<EndedRuns, String> {
    let limit = limit.unwrap_or(200).clamp(1, 200) as usize;
    let actors = &crate::agent::meter::CONSTRUCT_ACTORS;
    let marks = (0..actors.len()).map(|_| "?").collect::<Vec<_>>().join(",");
    let sql=format!("SELECT {RUN_COLUMNS} FROM runs WHERE vault_id=? AND mode='ambient' \
        AND ended_at IS NOT NULL AND outcome!='running' AND (actor IS NULL OR actor NOT IN ({marks})) \
        ORDER BY ended_at DESC,run_id DESC LIMIT {}",limit+1);
    let mut bound: Vec<&dyn rusqlite::ToSql> = vec![&vault_id];
    for actor in actors {
        bound.push(actor);
    }
    let mut statement = ro.prepare(&sql).map_err(|e| e.to_string())?;
    let mut runs = statement
        .query_map(bound.as_slice(), map_run)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let truncated = runs.len() > limit;
    runs.truncate(limit);
    Ok(EndedRuns { runs, truncated })
}

fn unknown_run(run_id: &str) -> impl Fn(rusqlite::Error) -> String + '_ {
    move |e| match e {
        rusqlite::Error::QueryReturnedNoRows => format!("no run with id {run_id}"),
        other => other.to_string(),
    }
}

/// One run, its governance joins, its model and its refusals.
///
/// An unknown id is an ERROR, not an empty detail: the caller asked about a
/// specific run, and answering "here it is, with nothing in it" would make a
/// typo indistinguishable from an unmetered run.
pub fn run_detail(ro: &ReadOnly, run_id: &str) -> Result<RunDetail, String> {
    let (run, model_id) = ro
        .query_row(
            &format!("SELECT {RUN_COLUMNS}, model_id FROM runs WHERE run_id = ?1"),
            [run_id],
            |row| Ok((map_run(row)?, row.get::<_, Option<String>>(18)?)),
        )
        .map_err(unknown_run(run_id))?;

    let mut statement = ro
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

    let assembly = ro
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

    let [usage, stream, tool_calls, costs] = TELEMETRY_SURFACES;
    let bound = rusqlite::params![run_id, usage, stream, tool_calls, costs];
    let mut statement = ro.prepare(REFUSALS_SQL).map_err(|e| e.to_string())?;
    let refusals = statement
        .query_map(bound, |row| {
            Ok(RefusalRow {
                code: row.get(0)?,
                surface: row.get(1)?,
                detail: row.get(2)?,
                rule: row.get(3)?,
                recorded_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let refusals_total = ro
        .query_row(REFUSALS_COUNT_SQL, bound, |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())? as u64;
    let wrote = run_writes(ro, run_id)?;

    Ok(RunDetail {
        run,
        // Empty → None. See the module note: "measured at zero" and "never
        // measured" are different answers and this is where they part.
        cost_components: (!components.is_empty()).then_some(components),
        assembly,
        model_id,
        refusals,
        refusals_total,
        wrote,
    })
}

/// Where a run's transcript lives (M56.9): its session, its vault's path, and
/// the runs that share the session. An unknown id is an error, as it is for
/// [`run_detail`].
pub fn transcript_key(ro: &ReadOnly, run_id: &str) -> Result<TranscriptKey, String> {
    let (session_id, vault_path, started_at, own_activity) = ro
        .query_row(
            "SELECT r.cli_session_id, v.vault_path, r.started_at, \
             coalesce(r.ended_at, r.started_at) FROM runs r \
             LEFT JOIN vault_registry v ON v.vault_id = r.vault_id WHERE r.run_id = ?1",
            [run_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(unknown_run(run_id))?;
    let (runs_in_session, last_activity_at) = match &session_id {
        None => (1, own_activity),
        // Read by `runs_by_cli_session` (schema v21). The run itself is one
        // of the rows, so the count is at least 1 and the max is set.
        Some(session) => ro
            .query_row(
                "SELECT count(*), max(coalesce(ended_at, started_at)) FROM runs \
                 WHERE cli_session_id = ?1",
                [session],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?)),
            )
            .map_err(|e| e.to_string())?,
    };
    Ok(TranscriptKey {
        session_id,
        vault_path,
        started_at,
        last_activity_at,
        runs_in_session,
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
fn summaries(ro: &ReadOnly, actor: Option<&str>) -> Result<Vec<ActorSummary>, String> {
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
    let mut statement = ro.prepare(&sql).map_err(|e| e.to_string())?;
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
pub fn actor_summary(ro: &ReadOnly, actor: &str) -> Result<ActorSummary, String> {
    Ok(summaries(ro, Some(actor))?
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
pub fn actor_summaries(ro: &ReadOnly) -> Result<Vec<ActorSummary>, String> {
    summaries(ro, None)
}

/// The most commits one attribution read may ask about: a page of history.
pub const MAX_COMMIT_QUERIES: usize = 200;

/// One commit a history row asks about (M58.4). With `path`, the read also
/// says who else wrote that path for the commit, from `since` (the path's
/// previous commit time, `FileCommit::previous_at`) to the commit: `commit
/// --only` took the path's whole diff, so the span opens at the previous
/// commit, not at the run's start.
#[derive(Debug, Clone, Deserialize)]
pub struct CommitQuery {
    pub hash: String,
    pub path: Option<String>,
    pub since: Option<String>,
}

/// The run that made one commit, as `run_commits` recorded it (M58.4,
/// CV-35). `actor: None` is a run whose actor was never stamped.
/// `with_person` says your own writes rode along (`None` when no path was
/// asked), and `also_by` names any other run's actors that wrote the path in
/// the span, each once.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommitRun {
    pub hash: String,
    pub run_id: String,
    pub actor: Option<String>,
    pub with_person: Option<bool>,
    pub also_by: Vec<String>,
}

/// A full commit hash: 40 (sha1) or 64 (sha256) lowercase hex, the only
/// spelling `run_commits` stores.
fn full_hash(hash: &str) -> bool {
    matches!(hash.len(), 40 | 64)
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Which recorded runs made `queries`' commits in `vault_id` (M58.4).
///
/// History names an agent only from this record (CV-35): a commit with no
/// row comes back absent and reads "unattributed", whatever its trailer, its
/// message or its git author says. One SELECT, with placeholders, joins the
/// record to `runs`; then, for each recorded commit that asked a path,
/// `write_log::writers_since` over the span names your edits and any other
/// run's. Both times are `runtime::now_utc` stamps, so string order is time
/// order. A hash that is not full and lowercase, or more than
/// [`MAX_COMMIT_QUERIES`] of them, is refused in words.
pub fn commit_runs(
    ro: &ReadOnly,
    vault_id: &str,
    queries: &[CommitQuery],
) -> Result<Vec<CommitRun>, String> {
    if queries.len() > MAX_COMMIT_QUERIES {
        return Err(format!(
            "At most {MAX_COMMIT_QUERIES} commits can be asked about at once, not {}.",
            queries.len()
        ));
    }
    if let Some(bad) = queries.iter().find(|q| !full_hash(&q.hash)) {
        return Err(format!("{:?} is not a full commit hash.", bad.hash));
    }
    if queries.is_empty() {
        return Ok(Vec::new());
    }
    let marks: Vec<String> = (0..queries.len()).map(|n| format!("?{}", n + 2)).collect();
    let sql = format!(
        "SELECT c.commit_sha, c.run_id, r.actor, c.committed_at FROM run_commits c \
         JOIN runs r ON r.run_id = c.run_id \
         WHERE c.vault_id = ?1 AND c.commit_sha IN ({})",
        marks.join(", ")
    );
    let mut statement = ro.prepare(&sql).map_err(|e| e.to_string())?;
    let params = std::iter::once(vault_id).chain(queries.iter().map(|q| q.hash.as_str()));
    let recorded: Vec<(String, String, Option<String>, String)> = statement
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut answered = Vec::new();
    for query in queries {
        let Some((hash, run_id, actor, committed_at)) =
            recorded.iter().find(|(hash, ..)| *hash == query.hash)
        else {
            continue;
        };
        if answered.iter().any(|a: &CommitRun| a.hash == *hash) {
            continue;
        }
        let (with_person, also_by) = match &query.path {
            None => (None, Vec::new()),
            Some(path) => {
                let writers =
                    writers_since(ro, vault_id, path, query.since.as_deref(), committed_at)?;
                let mine = writers.iter().any(|w| w.actor == HUMAN_ACTOR);
                let mut others: Vec<String> = Vec::new();
                for writer in writers {
                    let other_run = writer.run_id.as_deref().is_some_and(|r| r != run_id);
                    if other_run && writer.actor != HUMAN_ACTOR && !others.contains(&writer.actor) {
                        others.push(writer.actor);
                    }
                }
                (Some(mine), others)
            }
        };
        answered.push(CommitRun {
            hash: hash.clone(),
            run_id: run_id.clone(),
            actor: actor.clone(),
            with_person,
            also_by,
        });
    }
    Ok(answered)
}

/// Whether a run that is still `running` wrote `path` in `vault_id` (M58.4):
/// Restore refuses such a page rather than racing the run. Content rows
/// only (`write_log::CONTENT_KINDS`), matched as every reader matches them.
pub fn live_run_wrote(ro: &ReadOnly, vault_id: &str, path: &str) -> Result<bool, String> {
    ro.query_row(
        "SELECT EXISTS (SELECT 1 FROM vault_writes w JOIN runs r ON r.run_id = w.run_id \
         WHERE w.vault_id = ?1 \
         AND ((w.path = ?2 AND w.kind IN ('vault.write', 'vault.create')) \
              OR (w.to_path = ?2 AND w.kind = 'vault.rename')) \
         AND r.outcome = 'running')",
        rusqlite::params![vault_id, path],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|e| e.to_string())
}

/// How far back the lobby lists wakes that were skipped or expired.
pub const FINISHED_WAKES_DAYS: i64 = 7;

/// One wake as the Agents lobby and an agent's Runs tab list it (M63.1b).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetWake {
    pub wake_id: String,
    pub agent: String,
    /// `pending`, `skipped` or `expired`: the three kinds of row listed.
    pub state: String,
    /// The stored outcome, reason and cancel why; `None` while pending.
    pub outcome: Option<String>,
    pub reason: Option<String>,
    pub detail: Option<String>,
    /// [`super::wakes::words`]: how the row's end reads.
    pub words: String,
    /// The cause stored at admission, in Rust's words. `None` only for a
    /// value the table's CHECK would never have let in.
    pub cause: Option<CauseView>,
    pub admitted_at: String,
    /// When a deferred wake is tried again; `None` is now.
    pub not_before: Option<String>,
    /// The gate's reasons, comma-separated, from its last deferral.
    pub deferred: Option<String>,
    pub finished_at: Option<String>,
    pub run_id: Option<String>,
    pub author: Option<String>,
    pub author_actor: Option<String>,
    pub parent_run_id: Option<String>,
    /// The pre-run check's question, answer or unavailability, when recorded.
    pub note: Option<serde_json::Value>,
}

const WAKE_COLUMNS: &str = "wake_id, agent, outcome, reason, detail, cause, admitted_at, \
     not_before, deferred, finished_at, run_id, author, author_actor, parent_run_id, note";

fn map_wake(row: &rusqlite::Row<'_>) -> rusqlite::Result<FleetWake> {
    let outcome: Option<String> = row.get(2)?;
    let reason: Option<String> = row.get(3)?;
    let detail: Option<String> = row.get(4)?;
    let cause: String = row.get(5)?;
    let state = match (outcome.as_deref(), reason.as_deref()) {
        (None, _) => "pending",
        (Some("cancelled"), Some(super::wakes::EXPIRED)) => "expired",
        _ => "skipped",
    };
    Ok(FleetWake {
        wake_id: row.get(0)?,
        agent: row.get(1)?,
        state: state.into(),
        words: super::wakes::words(outcome.as_deref(), reason.as_deref(), detail.as_deref()),
        outcome,
        reason,
        detail,
        cause: view_of_column(&cause),
        admitted_at: row.get(6)?,
        not_before: row.get(7)?,
        deferred: row.get(8)?,
        finished_at: row.get(9)?,
        run_id: row.get(10)?,
        author: row.get(11)?,
        author_actor: row.get(12)?,
        parent_run_id: row.get(13)?,
        note: row
            .get::<_, Option<String>>(14)?
            .and_then(|raw| serde_json::from_str(&raw).ok()),
    })
}

/// What is waiting to wake this vault's agents, and what did not (M63.1b):
/// every pending wake, oldest first, then the wakes skipped or expired in the
/// last [`FINISHED_WAKES_DAYS`] days, newest first, at most [`MAX_LIMIT`] in
/// all. `actor` narrows it to one agent. Wakes that ran (succeeded, failed,
/// interrupted, coalesced) are their runs' to show, and superseded cancels
/// the agent's own controls'.
pub fn wakes(
    ro: &ReadOnly,
    vault_id: &str,
    actor: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<FleetWake>, String> {
    let read = |sql: String, params: &[&dyn rusqlite::ToSql]| -> Result<Vec<FleetWake>, String> {
        let mut statement = ro.prepare(&sql).map_err(|e| format!("agent_wakes: {e}"))?;
        let rows = statement
            .query_map(params, map_wake)
            .map_err(|e| format!("agent_wakes: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("agent_wakes: {e}"))
    };
    let mut listed = read(
        format!(
            "SELECT {WAKE_COLUMNS} FROM agent_wakes WHERE vault_id = ?1 \
             AND (?2 IS NULL OR agent = ?2) AND state = 'pending' \
             ORDER BY admitted_at, rowid LIMIT {MAX_LIMIT}"
        ),
        &[&vault_id, &actor],
    )?;
    let room = MAX_LIMIT as usize - listed.len();
    if room == 0 {
        return Ok(listed);
    }
    let since = (now - chrono::Duration::days(FINISHED_WAKES_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    listed.extend(read(
        format!(
            "SELECT {WAKE_COLUMNS} FROM agent_wakes WHERE vault_id = ?1 \
             AND (?2 IS NULL OR agent = ?2) AND state = 'finished' \
             AND (outcome = 'skipped' OR (outcome = 'cancelled' AND reason = ?3)) \
             AND finished_at > ?4 \
             ORDER BY finished_at DESC, rowid DESC LIMIT {room}"
        ),
        &[&vault_id, &actor, &super::wakes::EXPIRED, &since],
    )?);
    Ok(listed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use rusqlite::Connection;

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

    /// Every read goes through the handle production uses.
    fn read(dir: &std::path::Path) -> ReadOnly {
        ReadOnly::open(dir).unwrap()
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

    fn subject_run(
        conn: &Connection,
        vault: &str,
        id: &str,
        subject: Option<&str>,
        parent: Option<&str>,
    ) {
        seed_runs(
            conn,
            vault,
            &[Seed::new(id, Some("process:scout"), "2026-07-28T12:00:00Z")],
        );
        let cause = subject.map(|path| {
            serde_json::json!({"kind":"assigned","subject":path,"detail":"via agent"}).to_string()
        });
        conn.execute(
            "UPDATE runs SET cause=?2, parent_run_id=?3 WHERE run_id=?1",
            rusqlite::params![id, cause, parent],
        )
        .unwrap();
    }

    #[test]
    fn subject_runs_lists_runs_about_the_given_pages_newest_first() {
        let (dir, conn, vault) = fixture("page-runs-order");
        subject_run(&conn, &vault, "a", Some("work/a.md"), None);
        subject_run(&conn, &vault, "b", Some("work/a.md"), None);
        subject_run(&conn, &vault, "z", Some("elsewhere.md"), None);
        let rows = subject_runs(&read(&dir), &vault, &["work/a.md".into()], None).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(
            rows[0].cause.as_ref().unwrap().detail.as_deref(),
            Some("via agent")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn subject_runs_include_the_hops_a_listed_run_started() {
        let (dir, conn, vault) = fixture("page-runs-hops");
        subject_run(&conn, &vault, "root", Some("project.md"), None);
        subject_run(&conn, &vault, "child", None, Some("root"));
        subject_run(&conn, &vault, "grandchild", None, Some("child"));
        subject_run(&conn, &vault, "too-deep", None, Some("grandchild"));
        let rows = subject_runs(&read(&dir), &vault, &["project.md".into()], None).unwrap();
        let ids = rows.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&"child") && ids.contains(&"grandchild"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn subject_runs_never_reach_another_vault() {
        let (dir, conn, vault) = fixture("page-runs-vault");
        subject_run(&conn, &vault, "root", Some("project.md"), None);
        let other = crate::runtime::scope::register(&conn, &dir.join("another-vault")).unwrap();
        subject_run(&conn, &other, "foreign", Some("project.md"), Some("root"));
        subject_run(&conn, &vault, "returning", None, Some("foreign"));
        let rows = subject_runs(&read(&dir), &vault, &["project.md".into()], None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].run_id, "root");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_run_without_a_cause_is_never_placed_on_a_page() {
        let (dir, conn, vault) = fixture("page-runs-unknown");
        subject_run(&conn, &vault, "old", None, None);
        assert!(
            subject_runs(&read(&dir), &vault, &["project.md".into()], None)
                .unwrap()
                .is_empty()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn subject_runs_with_no_pages_read_nothing() {
        let (dir, conn, vault) = fixture("page-runs-empty");
        conn.execute("DROP TABLE runs", []).unwrap();
        assert!(subject_runs(&read(&dir), &vault, &[], None)
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn subject_runs_clamp_the_limit() {
        let (dir, conn, vault) = fixture("page-runs-limit");
        for index in 0..205 {
            subject_run(
                &conn,
                &vault,
                &format!("r{index:03}"),
                Some("project.md"),
                None,
            );
        }
        let ro = read(&dir);
        assert_eq!(
            subject_runs(&ro, &vault, &["project.md".into()], Some(u32::MAX))
                .unwrap()
                .len(),
            200
        );
        assert_eq!(
            subject_runs(&ro, &vault, &["project.md".into()], Some(2))
                .unwrap()
                .len(),
            2
        );
        assert!(subject_runs(&ro, &vault, &["project.md".into()], Some(0))
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn subject_runs_refuse_too_many_pages() {
        let (dir, _conn, vault) = fixture("page-runs-bounds");
        let ro = read(&dir);
        assert!(subject_runs(&ro, &vault, &vec!["p".into(); 1001], None)
            .unwrap_err()
            .contains("1000"));
        assert!(subject_runs(&ro, &vault, &["é".repeat(513)], None)
            .unwrap_err()
            .contains("1024 bytes"));
        assert!(subject_runs(&ro, &vault, &["é".repeat(512)], None).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ended_runs_are_this_vaults_finished_unattended_agent_runs() {
        let (dir, conn, vault) = fixture("home-ended");
        let mut panel = Seed::new("panel", Some("process:scout"), "2026-07-28T13:00:00Z");
        panel.mode = "attended";
        let mut live = Seed::new("live", Some("process:scout"), "2026-07-28T13:00:00Z");
        live.outcome = "running";
        let mut failed = Seed::new("failed", Some("process:scout"), "2026-07-28T12:00:00Z");
        failed.outcome = "failed";
        seed_runs(
            &conn,
            &vault,
            &[
                panel,
                live,
                failed,
                Seed::new("unknown", None, "2026-07-28T11:00:00Z"),
            ],
        );
        let other = dir.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let other = crate::runtime::scope::register(&conn, &other).unwrap();
        seed_runs(
            &conn,
            &other,
            &[Seed::new("other", None, "2026-07-28T14:00:00Z")],
        );
        let ended = ended_runs(&read(&dir), &vault, None).unwrap();
        assert_eq!(
            ended
                .runs
                .iter()
                .map(|r| r.run_id.as_str())
                .collect::<Vec<_>>(),
            vec!["failed", "unknown"]
        );
        assert!(!ended.truncated);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn ended_runs_never_lists_a_construct() {
        let (dir, conn, vault) = fixture("home-constructs");
        for (i, actor) in crate::agent::meter::CONSTRUCT_ACTORS.iter().enumerate() {
            seed_runs(
                &conn,
                &vault,
                &[Seed::new(
                    &format!("construct-{i}"),
                    Some(actor),
                    "2026-07-28T12:00:00Z",
                )],
            );
        }
        assert!(ended_runs(&read(&dir), &vault, None)
            .unwrap()
            .runs
            .is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn ended_runs_says_when_it_truncated() {
        let (dir, conn, vault) = fixture("home-limit");
        for i in 0..200 {
            seed_runs(
                &conn,
                &vault,
                &[Seed::new(&format!("r{i:03}"), None, "2026-07-28T12:00:00Z")],
            );
        }
        let first = ended_runs(&read(&dir), &vault, None).unwrap();
        assert_eq!(first.runs.len(), 200);
        assert!(!first.truncated);
        seed_runs(
            &conn,
            &vault,
            &[Seed::new("r200", None, "2026-07-28T12:00:00Z")],
        );
        let more = ended_runs(&read(&dir), &vault, Some(999)).unwrap();
        assert_eq!(more.runs.len(), 200);
        assert!(more.truncated);
        assert_eq!(
            ended_runs(&read(&dir), &vault, Some(0)).unwrap().runs.len(),
            1
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
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
            &read(&dir),
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

        let all = runs(&read(&dir), &Filter::default()).unwrap();
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

        let all = runs(&read(&dir), &Filter::default()).unwrap();
        let hop = all.iter().find(|r| r.run_id == "hop").unwrap();
        assert_eq!(hop.parent_run_id.as_deref(), Some("root"));
        let root = all.iter().find(|r| r.run_id == "root").unwrap();
        assert_eq!(root.parent_run_id, None, "a root run reads back as one");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // M49.9: before booking existed nothing wrote the proposal counters, so
    // a row that predates v18 holds zeros nobody measured. It reads back as
    // NOT RECORDED; an attended row opened at spawn reads back as booked —
    // what the run booked while it wrote survives its finish, and a quiet
    // run's zero is measured-at-zero. A row the meter could only write at
    // the end stood for no booking, and reads as not recorded too. The
    // fixture stands at v17 — the version a dev database may already be at
    // — and upgrades through v18.
    #[test]
    fn a_row_from_before_booking_reads_as_not_recorded_and_a_new_row_as_booked() {
        use crate::runtime::{dispatch, schema, MIGRATIONS};
        let _sink = crate::runtime::sink::test_lock();
        let dir = testutil::temp_vault("fleet-unbooked");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(crate::runtime::runtime_db_path(&dir)).unwrap();
        let mut sql = String::from("BEGIN;");
        for migration in MIGRATIONS.iter().filter(|m| m.to <= 17) {
            sql.push_str(migration.sql);
        }
        sql.push_str("PRAGMA user_version = 17; COMMIT;");
        conn.execute_batch(&sql).unwrap();
        // v3's `validate` seeds the lane registry, and raw SQL does not run it.
        for (lane, priority, enabled) in schema::LANES {
            conn.execute(
                "INSERT INTO lane_registry (lane, priority, enabled_by_default, \
                 introduced_version) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![lane, priority, i64::from(enabled), schema::LANE_INTRODUCED],
            )
            .unwrap();
        }
        // A pre-M49.9 row: 0 applied that nobody ever wrote.
        conn.execute(
            "INSERT INTO runs (run_id, mode, lane, started_at, ended_at, outcome, usage_state, \
             input_tokens, output_tokens, cache_read, cache_write, reserved_total_tokens, \
             reserved_output_tokens, proposals_submitted, applied, rejected) \
             VALUES ('legacy', 'attended', 'agent', '2026-08-09T10:00:00.000Z', \
             '2026-08-09T10:01:00.000Z', 'succeeded', 'exact', 5, 1, 0, 0, 0, 0, 0, 0, 0)",
            [],
        )
        .unwrap();
        drop(conn);

        let conn = crate::runtime::open(&dir).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(
            version,
            crate::runtime::USER_VERSION,
            "v17 upgrades through v18 to the current version"
        );
        let at = chrono::DateTime::parse_from_rfc3339("2026-09-27T10:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let finish = |run_id: &str| {
            dispatch::meter_attended(
                &conn,
                run_id,
                None,
                None,
                dispatch::RunOutcome::Succeeded,
                None,
                None,
                None,
                None,
                None,
                at,
                at,
            )
            .unwrap()
        };
        // The production order: open at spawn, book mid-run through the
        // sink (as a write inside the run does), finish.
        crate::runtime::sink::arm(&dir).unwrap();
        dispatch::begin_attended(&conn, "fresh", None, None, None, None, None, at).unwrap();
        crate::policy::commit::CommitOutcome {
            commit_set_id: "set".into(),
            transition: crate::policy::commit::TransitionCode::Apply,
            results: vec![crate::policy::submit::SubmitResult::Applied {
                proposal_id: "p1".into(),
                resulting_versions: vec![],
            }],
            batch_id: "batch".into(),
            replayed: false,
            kept: vec![],
            projected: Vec::new(),
        }
        .book("fresh");
        crate::runtime::sink::disarm();
        finish("fresh");
        dispatch::begin_attended(&conn, "quiet", None, None, None, None, None, at).unwrap();
        finish("quiet");
        finish("late");

        let all = runs(&read(&dir), &Filter::default()).unwrap();
        let legacy = all.iter().find(|r| r.run_id == "legacy").unwrap();
        assert_eq!(
            (legacy.proposals_submitted, legacy.applied, legacy.rejected),
            (None, None, None),
            "zeros nobody booked are not recorded, never a measurement"
        );
        let fresh = all.iter().find(|r| r.run_id == "fresh").unwrap();
        assert_eq!(
            (fresh.proposals_submitted, fresh.applied, fresh.rejected),
            (Some(1), Some(1), Some(0)),
            "what the run booked while it wrote survives its finish"
        );
        let quiet = all.iter().find(|r| r.run_id == "quiet").unwrap();
        assert_eq!(
            (quiet.proposals_submitted, quiet.applied, quiet.rejected),
            (Some(0), Some(0), Some(0)),
            "a booked row's zero is measured-at-zero"
        );
        let late = all.iter().find(|r| r.run_id == "late").unwrap();
        assert_eq!(
            (late.proposals_submitted, late.applied, late.rejected),
            (None, None, None),
            "a row written only at the end stood for no booking"
        );
        assert_eq!(
            run_detail(&read(&dir), "legacy").unwrap().run.applied,
            None,
            "the detail read says the same"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // M56.7 — why a run started reads back in Rust's words, beside the
    // values it was written with; a row with none reads as none.
    #[test]
    fn a_run_reads_back_its_cause_in_rusts_words() {
        use crate::runtime::cause::{CauseKind, RunCause};
        let (dir, conn, vault) = fixture("fleet-cause");
        seed_runs(
            &conn,
            &vault,
            &[Seed::new(
                "r1",
                Some("process:release-scout"),
                "2026-07-28T09:15:00Z",
            )],
        );
        let cause = RunCause::new(
            CauseKind::Schedule,
            None,
            Some("weekdays 08:30"),
            Some("2026-07-28T08:30:00Z"),
        );
        conn.execute(
            "UPDATE runs SET cause = ?1 WHERE run_id = 'r1'",
            [cause.to_column()],
        )
        .unwrap();
        let run = runs(&read(&dir), &Filter::default()).unwrap().remove(0);
        assert_eq!(
            run.cause,
            Some(CauseView {
                kind: "schedule".into(),
                why: "its schedule came due".into(),
                subject: None,
                detail: Some("weekdays 08:30".into()),
                due_at: Some("2026-07-28T08:30:00.000Z".into()),
            })
        );
        assert_eq!(run_detail(&read(&dir), "r1").unwrap().run.cause, run.cause);
        let wire = serde_json::to_value(&run).unwrap();
        assert_eq!(wire["cause"]["subject"], serde_json::Value::Null);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_null_cause_reads_back_as_none() {
        let (dir, conn, vault) = fixture("fleet-cause-null");
        seed_runs(
            &conn,
            &vault,
            &[Seed::new("legacy", None, "2026-07-28T04:20:00Z")],
        );
        let run = runs(&read(&dir), &Filter::default()).unwrap().remove(0);
        assert_eq!(run.cause, None, "why not recorded, never a guess");
        assert_eq!(run.cli_session_id, None);
        let wire = serde_json::to_value(&run).unwrap();
        assert_eq!(wire["cause"], serde_json::Value::Null);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_reads_back_its_cli_session() {
        let (dir, conn, vault) = fixture("fleet-cli-session");
        seed_runs(
            &conn,
            &vault,
            &[Seed::new("r1", None, "2026-07-28T09:15:00Z")],
        );
        crate::runtime::dispatch::record_cli_session(
            &conn,
            "r1",
            "00000000-0000-4000-8000-000000000001",
        )
        .unwrap();
        let run = run_detail(&read(&dir), "r1").unwrap().run;
        assert_eq!(
            run.cli_session_id.as_deref(),
            Some("00000000-0000-4000-8000-000000000001")
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One `operational_log` row, as the sinks write it.
    fn log_row(conn: &Connection, run_id: Option<&str>, surface: &str, code: &str, detail: &str) {
        conn.execute(
            "INSERT INTO operational_log (recorded_at, surface, code, rule, detail, run_id) \
             VALUES ('2026-10-14T09:00:00.000Z', ?1, ?2, NULL, ?3, ?4)",
            rusqlite::params![surface, code, detail, run_id],
        )
        .unwrap();
    }

    // M56.9 — the refusals recorded with the run, in id order; the four
    // telemetry surfaces, another run's row and a row with no run stay out.
    #[test]
    fn run_detail_lists_the_refusals_recorded_against_the_run() {
        let (dir, conn, vault) = fixture("fleet-refusals");
        seed_runs(
            &conn,
            &vault,
            &[
                Seed::new("r1", Some("process:release-scout"), "2026-10-14T09:00:00Z"),
                Seed::new("r2", None, "2026-10-14T09:05:00Z"),
            ],
        );
        log_row(
            &conn,
            Some("r1"),
            "create_note",
            "write_outside_scope",
            "scoped to records/risks",
        );
        for surface in TELEMETRY_SURFACES {
            log_row(
                &conn,
                Some("r1"),
                surface,
                "capability_unavailable",
                "telemetry",
            );
        }
        log_row(
            &conn,
            Some("r2"),
            "create_note",
            "write_outside_scope",
            "another run",
        );
        log_row(
            &conn,
            None,
            "knowledge.bundle",
            "write_outside_scope",
            "no run",
        );
        log_row(
            &conn,
            Some("r1"),
            "agent.permission",
            "capability_unavailable",
            "Bash",
        );

        let detail = run_detail(&read(&dir), "r1").unwrap();
        assert_eq!(
            detail
                .refusals
                .iter()
                .map(|r| (r.surface.as_str(), r.code.as_str(), r.detail.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (
                    "create_note",
                    "write_outside_scope",
                    "scoped to records/risks"
                ),
                ("agent.permission", "capability_unavailable", "Bash"),
            ],
            "id order, telemetry and other rows left out"
        );
        assert_eq!(detail.refusals_total, 2);
        assert_eq!(detail.refusals[0].rule, None);
        assert_eq!(detail.refusals[0].recorded_at, "2026-10-14T09:00:00.000Z");

        let quiet = run_detail(&read(&dir), "r2").unwrap();
        assert_eq!(quiet.refusals.len(), 1, "r2 sees only its own");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refusals_past_the_cap_are_counted_not_dropped() {
        let (dir, conn, vault) = fixture("fleet-refusals-cap");
        seed_runs(
            &conn,
            &vault,
            &[Seed::new("r1", None, "2026-10-14T09:00:00Z")],
        );
        for n in 0..60 {
            log_row(
                &conn,
                Some("r1"),
                "create_note",
                "write_outside_scope",
                &format!("refusal {n}"),
            );
        }
        let detail = run_detail(&read(&dir), "r1").unwrap();
        assert_eq!(detail.refusals.len(), REFUSALS_SHOWN as usize);
        assert!(REFUSALS_SQL.ends_with(&format!("LIMIT {REFUSALS_SHOWN}")));
        assert_eq!(detail.refusals_total, 60, "the rest are counted");
        assert_eq!(detail.refusals[0].detail, "refusal 0", "oldest first");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_detail_carries_the_model_the_stream_named_or_none() {
        let (dir, conn, vault) = fixture("fleet-model");
        seed_runs(
            &conn,
            &vault,
            &[
                Seed::new("named", None, "2026-10-14T09:00:00Z"),
                Seed::new("silent", None, "2026-10-14T09:05:00Z"),
            ],
        );
        conn.execute(
            "UPDATE runs SET model_id = 'claude-opus-5' WHERE run_id = 'named'",
            [],
        )
        .unwrap();
        let ro = read(&dir);
        assert_eq!(
            run_detail(&ro, "named").unwrap().model_id.as_deref(),
            Some("claude-opus-5")
        );
        let silent = run_detail(&ro, "silent").unwrap();
        assert_eq!(silent.model_id, None, "not recorded, never a guess");
        assert!(silent.refusals.is_empty());
        assert_eq!(silent.refusals_total, 0);
        let wire = serde_json::to_value(&silent).unwrap();
        assert_eq!(wire["model_id"], serde_json::Value::Null);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_key_resolves_the_runs_vault_session_and_siblings() {
        let (dir, conn, vault) = fixture("fleet-transcript-key");
        let session = "00000000-0000-4000-8000-000000000001";
        seed_runs(
            &conn,
            &vault,
            &[
                Seed::new("first", None, "2026-10-14T09:00:00Z"),
                Seed::new("second", None, "2026-10-14T10:00:00Z"),
                Seed::new("alone", None, "2026-10-14T11:00:00Z"),
            ],
        );
        for run in ["first", "second"] {
            crate::runtime::dispatch::record_cli_session(&conn, run, session).unwrap();
        }
        // An attended row with no vault, in a session of its own.
        conn.execute(
            "INSERT INTO runs (run_id, mode, lane, started_at, ended_at, outcome, usage_state, \
             input_tokens, output_tokens, cache_read, cache_write, reserved_total_tokens, \
             reserved_output_tokens, proposals_submitted, applied, rejected, cli_session_id) \
             VALUES ('vaultless', 'attended', 'agent', '2026-10-14T12:00:00Z', \
             '2026-10-14T12:01:00Z', 'succeeded', 'exact', 5, 1, 0, 0, 0, 0, 0, 0, 0, \
             '00000000-0000-4000-8000-000000000002')",
            [],
        )
        .unwrap();
        let registered: String = conn
            .query_row(
                "SELECT vault_path FROM vault_registry WHERE vault_id = ?1",
                [&vault],
                |r| r.get(0),
            )
            .unwrap();

        let ro = read(&dir);
        let first = transcript_key(&ro, "first").unwrap();
        assert_eq!(first.session_id.as_deref(), Some(session));
        assert_eq!(first.vault_path.as_deref(), Some(registered.as_str()));
        assert_eq!(first.started_at, "2026-10-14T09:00:00Z");
        assert_eq!(first.runs_in_session, 2, "both runs share the session");
        assert_eq!(
            first.last_activity_at, "2026-10-14T10:00:00Z",
            "the session's last activity is its latest run's"
        );

        let alone = transcript_key(&ro, "alone").unwrap();
        assert_eq!(alone.session_id, None);
        assert_eq!(alone.runs_in_session, 1);
        assert_eq!(alone.last_activity_at, "2026-10-14T11:00:00Z");

        let vaultless = transcript_key(&ro, "vaultless").unwrap();
        assert_eq!(vaultless.vault_path, None, "no vault gives no path");
        assert_eq!(vaultless.runs_in_session, 1);
        assert_eq!(vaultless.last_activity_at, "2026-10-14T12:01:00Z");

        let unknown = transcript_key(&ro, "nope").unwrap_err();
        assert!(unknown.contains("no run with id nope"), "{unknown}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_detail_carries_what_the_run_wrote() {
        let (dir, conn, vault) = fixture("fleet-wrote");
        seed_runs(
            &conn,
            &vault,
            &[
                Seed::new("wrote", Some("process:scout"), "2026-10-14T09:00:00Z"),
                Seed::new("idle", Some("process:scout"), "2026-10-14T09:05:00Z"),
                Seed::new("old", None, "2026-10-14T09:10:00Z"),
            ],
        );
        conn.execute("UPDATE runs SET writes_booked = 0 WHERE run_id = 'old'", [])
            .unwrap();
        let hash = "a".repeat(64);
        crate::runtime::vault_writes::record_at(
            &conn,
            &vault,
            &crate::runtime::vault_writes::WriteRow {
                kind: "vault.create",
                path: "records/risks/x.md",
                to: None,
                content_hash: Some(&hash),
                actor: Some("process:scout"),
                run_id: Some("wrote"),
                approved_by: None,
            },
            chrono::Utc::now(),
        )
        .unwrap();
        let ro = read(&dir);
        let RunWrites::Recorded(rows) = run_detail(&ro, "wrote").unwrap().wrote else {
            panic!("a run booked from the start lists its writes");
        };
        assert_eq!(
            rows.iter().map(|w| w.path.as_str()).collect::<Vec<_>>(),
            ["records/risks/x.md"]
        );
        assert_eq!(
            run_detail(&ro, "idle").unwrap().wrote,
            RunWrites::Recorded(vec![]),
            "booked and empty is measured: it wrote nothing"
        );
        let old = run_detail(&ro, "old").unwrap();
        assert_eq!(old.wrote, RunWrites::NotRecorded);
        let wire = serde_json::to_value(&old).unwrap();
        assert_eq!(
            wire["wrote"],
            serde_json::json!({ "state": "not_recorded" })
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A commit `run_id` made in `vault`, recorded at `at`.
    fn recorded_commit(conn: &Connection, vault: &str, sha: &str, run_id: &str, at: &str) {
        conn.execute(
            "INSERT INTO run_commits (vault_id, commit_sha, run_id, committed_at) \
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![vault, sha, run_id, at],
        )
        .unwrap();
    }

    /// One `vault_writes` row whose burst ran from `first` to `last`.
    #[expect(
        clippy::too_many_arguments,
        reason = "a row is these columns; a struct for one test helper is noise"
    )]
    fn wrote(
        conn: &Connection,
        vault: &str,
        kind: &str,
        path: &str,
        actor: &str,
        run_id: Option<&str>,
        first: &str,
        last: &str,
    ) {
        let to = (kind == "vault.rename").then_some(path);
        let from = if to.is_some() { "elsewhere.md" } else { path };
        conn.execute(
            "INSERT INTO vault_writes (vault_id, kind, path, to_path, actor, run_id, first_at, \
             recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![vault, kind, from, to, actor, run_id, first, last],
        )
        .unwrap();
    }

    fn ask(hash: &str, path: Option<&str>, since: Option<&str>) -> CommitQuery {
        CommitQuery {
            hash: hash.to_string(),
            path: path.map(str::to_string),
            since: since.map(str::to_string),
        }
    }

    // M58.4 (CV-35): a commit names a run only from its record. A sha nobody
    // recorded reads none, whatever it says of itself; so does one recorded
    // for another vault. A hash that is short, upper-case, or one of more
    // than 200, is refused in words.
    #[test]
    fn a_commit_names_a_run_only_from_its_record() {
        let (dir, conn, vault) = fixture("fleet-commit-runs");
        let other_dir = testutil::temp_vault("fleet-commit-runs-other");
        let other = crate::runtime::scope::register(&conn, &other_dir).unwrap();
        seed_runs(
            &conn,
            &vault,
            &[Seed::new(
                "run-scout",
                Some("process:release-scout"),
                "2026-10-14T09:50:00.000Z",
            )],
        );
        let (mine, theirs, unknown) = ("a".repeat(40), "b".repeat(40), "c".repeat(64));
        recorded_commit(
            &conn,
            &vault,
            &mine,
            "run-scout",
            "2026-10-14T10:00:00.000Z",
        );
        recorded_commit(
            &conn,
            &other,
            &theirs,
            "run-scout",
            "2026-10-14T10:00:00.000Z",
        );

        let ro = read(&dir);
        let answered = commit_runs(
            &ro,
            &vault,
            &[
                ask(&mine, None, None),
                ask(&theirs, None, None),
                ask(&unknown, None, None),
            ],
        )
        .unwrap();
        assert_eq!(
            answered,
            vec![CommitRun {
                hash: mine.clone(),
                run_id: "run-scout".into(),
                actor: Some("process:release-scout".into()),
                with_person: None,
                also_by: vec![],
            }]
        );
        assert_eq!(commit_runs(&ro, &vault, &[]).unwrap(), vec![]);
        for bad in [mine.to_uppercase(), mine[..7].to_string(), "g".repeat(40)] {
            let err = commit_runs(&ro, &vault, &[ask(&bad, None, None)]).unwrap_err();
            assert!(err.contains("not a full commit hash"), "{bad}: {err}");
        }
        let many: Vec<CommitQuery> = (0..201).map(|_| ask(&mine, None, None)).collect();
        let err = commit_runs(&ro, &vault, &many).unwrap_err();
        assert!(err.contains("At most 200"), "{err}");
        drop(conn);
        for d in [&dir, &other_dir] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    // M58.4: your edits ride along in a run's commit from the path's previous
    // commit on, those from before the run included. One from before the
    // previous commit doesn't count; a coalesced burst that straddles it
    // does.
    #[test]
    fn with_person_counts_your_edits_since_the_paths_previous_commit() {
        let (dir, conn, vault) = fixture("fleet-with-person");
        seed_runs(
            &conn,
            &vault,
            &[Seed::new(
                "run-1",
                Some("process:scout"),
                "2026-10-14T09:50:00.000Z",
            )],
        );
        let since = "2026-10-14T09:30:00.000Z";
        let at = "2026-10-14T10:00:00.000Z";
        let (old, before_run, straddle) = ("1".repeat(40), "2".repeat(40), "3".repeat(40));
        for sha in [&old, &before_run, &straddle] {
            recorded_commit(&conn, &vault, sha, "run-1", at);
        }
        for path in ["old.md", "before.md", "straddle.md"] {
            let t = "2026-10-14T09:55:00.000Z";
            wrote(
                &conn,
                &vault,
                "vault.write",
                path,
                "process:scout",
                Some("run-1"),
                t,
                t,
            );
        }
        let h = HUMAN_ACTOR;
        let (early, mid) = ("2026-10-14T09:00:00.000Z", "2026-10-14T09:40:00.000Z");
        wrote(
            &conn,
            &vault,
            "vault.write",
            "old.md",
            h,
            None,
            early,
            early,
        );
        wrote(&conn, &vault, "vault.write", "before.md", h, None, mid, mid);
        let (burst_start, burst_end) = ("2026-10-14T09:20:00.000Z", "2026-10-14T09:35:00.000Z");
        wrote(
            &conn,
            &vault,
            "vault.write",
            "straddle.md",
            h,
            None,
            burst_start,
            burst_end,
        );
        // A comment never counts as a change to the page.
        wrote(&conn, &vault, "vault.comment", "old.md", h, None, mid, mid);

        let answered = commit_runs(
            &read(&dir),
            &vault,
            &[
                ask(&old, Some("old.md"), Some(since)),
                ask(&before_run, Some("before.md"), Some(since)),
                ask(&straddle, Some("straddle.md"), Some(since)),
            ],
        )
        .unwrap();
        let with: Vec<Option<bool>> = answered.iter().map(|a| a.with_person).collect();
        assert_eq!(with, vec![Some(false), Some(true), Some(true)]);
        assert!(
            answered.iter().all(|a| a.also_by.is_empty()),
            "{answered:?}"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // M58.4: another run's write to the path in the span is named, each
    // actor once; the commit's own run is not.
    #[test]
    fn another_actors_write_in_the_span_is_named() {
        let (dir, conn, vault) = fixture("fleet-also-by");
        seed_runs(
            &conn,
            &vault,
            &[
                Seed::new("run-1", Some("process:scout"), "2026-10-14T09:50:00.000Z"),
                Seed::new("run-2", Some("process:digest"), "2026-10-14T09:40:00.000Z"),
            ],
        );
        let sha = "e".repeat(40);
        recorded_commit(&conn, &vault, &sha, "run-1", "2026-10-14T10:00:00.000Z");
        let t = "2026-10-14T09:45:00.000Z";
        wrote(
            &conn,
            &vault,
            "vault.write",
            "a.md",
            "process:scout",
            Some("run-1"),
            t,
            t,
        );
        wrote(
            &conn,
            &vault,
            "vault.write",
            "a.md",
            "process:digest",
            Some("run-2"),
            t,
            t,
        );
        let t2 = "2026-10-14T09:46:00.000Z";
        wrote(
            &conn,
            &vault,
            "vault.create",
            "a.md",
            "process:digest",
            Some("run-2"),
            t2,
            t2,
        );

        let answered = commit_runs(&read(&dir), &vault, &[ask(&sha, Some("a.md"), None)]).unwrap();
        assert_eq!(answered[0].also_by, vec!["process:digest".to_string()]);
        assert_eq!(answered[0].with_person, Some(false));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // M58.4: Restore refuses a page a running run wrote. A finished run's
    // write is history; a running one's write, or rename into the path, is
    // not.
    #[test]
    fn live_run_wrote_sees_only_running_runs() {
        let (dir, conn, vault) = fixture("fleet-live-run");
        let mut live = Seed::new("live", Some("process:scout"), "2026-10-14T09:50:00.000Z");
        live.outcome = "running";
        seed_runs(
            &conn,
            &vault,
            &[
                live,
                Seed::new("done", Some("process:digest"), "2026-10-14T09:00:00.000Z"),
            ],
        );
        let t = "2026-10-14T09:55:00.000Z";
        wrote(
            &conn,
            &vault,
            "vault.write",
            "done.md",
            "process:digest",
            Some("done"),
            t,
            t,
        );
        wrote(
            &conn,
            &vault,
            "vault.write",
            "live.md",
            "process:scout",
            Some("live"),
            t,
            t,
        );
        wrote(
            &conn,
            &vault,
            "vault.rename",
            "moved.md",
            "process:scout",
            Some("live"),
            t,
            t,
        );
        wrote(
            &conn,
            &vault,
            "vault.comment",
            "said.md",
            "process:scout",
            Some("live"),
            t,
            t,
        );
        let ro = read(&dir);
        assert!(!live_run_wrote(&ro, &vault, "done.md").unwrap());
        assert!(live_run_wrote(&ro, &vault, "live.md").unwrap());
        assert!(live_run_wrote(&ro, &vault, "moved.md").unwrap());
        assert!(
            !live_run_wrote(&ro, &vault, "said.md").unwrap(),
            "a comment is no write"
        );
        assert!(!live_run_wrote(&ro, &vault, "nobody.md").unwrap());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The read model cannot write: no statement runner, no pragma setter and
    /// no writable handle appear in its non-test source.
    #[test]
    fn fleet_reads_never_write() {
        let source = include_str!("fleet.rs");
        let body = &source[..source.find("#[cfg(test)]").unwrap()];
        for word in ["execute", "execute_batch", "pragma_update", "Connection"] {
            assert!(!body.contains(word), "fleet.rs names {word}");
        }
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
            &read(&dir),
            &Filter {
                limit: Some(2),
                ..Filter::default()
            },
        )
        .unwrap();
        assert_eq!(asked.len(), 2, "a small limit is honoured");
        let absurd = runs(
            &read(&dir),
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
        let detail = run_detail(&read(&dir), "r1").unwrap();
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
        let refused = run_detail(&read(&dir), "nope");
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
        let summary = actor_summary(&read(&dir), "process:digest").unwrap();
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
        let summary = actor_summary(&read(&dir), "process:brand-new").unwrap();
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

        let roster = actor_summaries(&read(&dir))?;
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
            &actor_summary(&read(&dir), "process:scout")?,
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

        let roster = actor_summaries(&read(&dir))?;
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
        assert!(actor_summaries(&read(&dir))?.is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    // --- what is waiting to wake an agent (M63.1b) ----------------------------

    /// A finished wake's (outcome, reason, detail, run_id).
    type WakeEnd<'a> = (&'a str, Option<&'a str>, Option<&'a str>, Option<&'a str>);

    struct WakeSeed<'a> {
        id: char,
        agent: &'a str,
        admitted_at: &'a str,
        /// `None` is pending.
        end: Option<WakeEnd<'a>>,
        finished_at: Option<&'a str>,
    }

    fn pending<'a>(id: char, agent: &'a str, admitted_at: &'a str) -> WakeSeed<'a> {
        WakeSeed {
            id,
            agent,
            admitted_at,
            end: None,
            finished_at: None,
        }
    }

    fn seed_wakes(conn: &Connection, vault: &str, rows: &[WakeSeed<'_>]) {
        for row in rows {
            let id = row.id.to_string().repeat(32);
            let (outcome, reason, detail, run_id) = row.end.unwrap_or(("", None, None, None));
            let started = run_id.map(|_| row.admitted_at);
            conn.execute(
                "INSERT INTO agent_wakes (wake_id, vault_id, agent, wake_key, trigger_digest, \
                 cause, admitted_at, state, run_id, started_at, finished_at, outcome, reason, \
                 detail) VALUES (?1, ?2, ?3, ?4, '0123456789abcdef', ?5, ?6, ?7, ?8, ?9, ?10, \
                 ?11, ?12, ?13)",
                rusqlite::params![
                    id,
                    vault,
                    row.agent,
                    row.id.to_string().repeat(64),
                    format!(
                        r#"{{"kind":"event","subject":"records/risks/{}.md","detail":"it changes in records/risks"}}"#,
                        row.id
                    ),
                    row.admitted_at,
                    if row.end.is_none() { "pending" } else { "finished" },
                    run_id,
                    started,
                    row.finished_at,
                    row.end.map(|_| outcome),
                    reason,
                    detail,
                ],
            )
            .unwrap();
        }
    }

    const NOW: &str = "2026-10-13T12:00:00Z";

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(NOW)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn fleet_wakes_lists_pending_skipped_and_expired_but_not_succeeded_or_superseded() {
        let (dir, conn, vault) = fixture("fleet-wakes");
        seed_runs(
            &conn,
            &vault,
            &[Seed::new(
                "r1",
                Some("process:scout"),
                "2026-10-13T08:00:00Z",
            )],
        );
        let scout = "process:scout";
        seed_wakes(
            &conn,
            &vault,
            &[
                pending('b', scout, "2026-10-13T10:00:00Z"),
                pending('a', scout, "2026-10-13T09:00:00Z"),
                WakeSeed {
                    end: Some(("skipped", Some("cycle"), None, None)),
                    finished_at: Some("2026-10-13T07:00:00Z"),
                    ..pending('c', scout, "2026-10-13T06:00:00Z")
                },
                WakeSeed {
                    end: Some(("cancelled", Some("expired"), None, None)),
                    finished_at: Some("2026-10-12T07:00:00Z"),
                    ..pending('d', scout, "2026-10-05T06:00:00Z")
                },
                WakeSeed {
                    end: Some(("succeeded", None, None, Some("r1"))),
                    finished_at: Some("2026-10-13T08:30:00Z"),
                    ..pending('e', scout, "2026-10-13T08:00:00Z")
                },
                WakeSeed {
                    end: Some(("coalesced", None, None, Some("r1"))),
                    finished_at: Some("2026-10-13T08:30:00Z"),
                    ..pending('f', scout, "2026-10-13T08:00:00Z")
                },
                WakeSeed {
                    end: Some(("cancelled", Some("superseded"), Some("paused"), None)),
                    finished_at: Some("2026-10-13T08:30:00Z"),
                    ..pending('1', scout, "2026-10-13T08:00:00Z")
                },
                // Skipped longer ago than the window: left out.
                WakeSeed {
                    end: Some(("skipped", Some("cycle"), None, None)),
                    finished_at: Some("2026-10-01T07:00:00Z"),
                    ..pending('2', scout, "2026-10-01T06:00:00Z")
                },
            ],
        );
        let listed = wakes(&read(&dir), &vault, None, now()).unwrap();
        let ids: Vec<(char, &str)> = listed
            .iter()
            .map(|w| (w.wake_id.chars().next().unwrap(), w.state.as_str()))
            .collect();
        assert_eq!(
            ids,
            vec![
                ('a', "pending"),
                ('b', "pending"),
                ('c', "skipped"),
                ('d', "expired")
            ],
            "pending oldest first, then skipped and expired newest first"
        );
        assert_eq!(listed[0].words, crate::runtime::wakes::WAITING_WORDS);
        assert_eq!(
            listed[0].cause.as_ref().and_then(|c| c.subject.as_deref()),
            Some("records/risks/a.md")
        );
        assert_eq!(
            listed[2].words,
            "skipped — the change came from its own chain of runs, so it would wake itself"
        );
        assert_eq!(listed[3].words, "expired — waited more than 7 days");
        assert_eq!(
            listed[3].finished_at.as_deref(),
            Some("2026-10-12T07:00:00Z")
        );
        // Another vault's wakes never reach this one.
        assert!(wakes(&read(&dir), "another-vault", None, now())
            .unwrap()
            .is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fleet_wakes_filters_by_agent_and_caps_at_200() {
        let (dir, conn, vault) = fixture("fleet-wakes-cap");
        for n in 0..210u32 {
            conn.execute(
                "INSERT INTO agent_wakes (wake_id, vault_id, agent, wake_key, trigger_digest, \
                 cause, admitted_at) VALUES (?1, ?2, 'process:scout', ?3, '0123456789abcdef', \
                 '{\"kind\":\"event\"}', ?4)",
                rusqlite::params![
                    format!("{n:032x}"),
                    vault,
                    format!("{n:064x}"),
                    format!("2026-10-13T09:{:02}:{:02}Z", n / 60, n % 60),
                ],
            )
            .unwrap();
        }
        seed_wakes(
            &conn,
            &vault,
            &[pending('e', "process:other", "2026-10-13T08:00:00Z")],
        );
        let all = wakes(&read(&dir), &vault, None, now()).unwrap();
        assert_eq!(all.len(), 200, "at most 200, however many wait");
        assert_eq!(all[0].agent, "process:other", "oldest first");
        let other = wakes(&read(&dir), &vault, Some("process:other"), now()).unwrap();
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].agent, "process:other");
        let scout = wakes(&read(&dir), &vault, Some("process:scout"), now()).unwrap();
        assert_eq!(scout.len(), 200);
        assert!(scout.iter().all(|w| w.agent == "process:scout"));
        assert!(wakes(&read(&dir), &vault, Some("process:nobody"), now())
            .unwrap()
            .is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
