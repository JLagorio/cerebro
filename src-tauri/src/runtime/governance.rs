//! The governance rows (M26.7e) — what a later promotion will be argued from.
//!
//! **Nothing reads these yet, and that is the point.** A decision about
//! whether the resolver is good enough to run unattended, or whether a pass
//! costs what it claims, has to be answerable from rows that were already
//! being written when nobody was looking. M28's windows are supposed to be
//! reproducible from persisted rows alone; that is only true if the rows
//! exist before anybody asks.
//!
//! **Zero is a quantity; absence is not.** A successful belief-affecting
//! synthesis writes all ten cost components, and a component it did not use
//! is written as zero. The difference matters: "no cache reads" and "we do
//! not know whether there were cache reads" support opposite conclusions
//! about whether caching is working.

use rusqlite::{params, Connection};

use crate::ingest::resolver::Attempt;

/// The ten closed cost components. The unit belongs to the component — a
/// caller cannot choose it, here or in the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Component {
    UncachedInputTokens,
    CacheReadTokens,
    CacheWriteTokens,
    OutputTokens,
    RetrievalCalls,
    ToolCalls,
    SelectedContextBytes,
    SelectedContextTokens,
    PromptTemplateBytes,
    PromptTemplateTokens,
}

impl Component {
    pub const ALL: [Component; 10] = [
        Component::UncachedInputTokens,
        Component::CacheReadTokens,
        Component::CacheWriteTokens,
        Component::OutputTokens,
        Component::RetrievalCalls,
        Component::ToolCalls,
        Component::SelectedContextBytes,
        Component::SelectedContextTokens,
        Component::PromptTemplateBytes,
        Component::PromptTemplateTokens,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Component::UncachedInputTokens => "uncached_input_tokens",
            Component::CacheReadTokens => "cache_read_tokens",
            Component::CacheWriteTokens => "cache_write_tokens",
            Component::OutputTokens => "output_tokens",
            Component::RetrievalCalls => "retrieval_calls",
            Component::ToolCalls => "tool_calls",
            Component::SelectedContextBytes => "selected_context_bytes",
            Component::SelectedContextTokens => "selected_context_tokens",
            Component::PromptTemplateBytes => "prompt_template_bytes",
            Component::PromptTemplateTokens => "prompt_template_tokens",
        }
    }

    pub fn parse(raw: &str) -> Option<Component> {
        Component::ALL.into_iter().find(|c| c.as_str() == raw)
    }

    /// The unit this component is measured in. One definition, matched by the
    /// table's own CHECK.
    pub fn unit(self) -> &'static str {
        match self {
            Component::UncachedInputTokens
            | Component::CacheReadTokens
            | Component::CacheWriteTokens
            | Component::OutputTokens
            | Component::SelectedContextTokens
            | Component::PromptTemplateTokens => "tokens",
            Component::RetrievalCalls | Component::ToolCalls => "calls",
            Component::SelectedContextBytes | Component::PromptTemplateBytes => "bytes",
        }
    }

    /// Do we need a model id for this component? The four model-accounting
    /// rows do; the calls, context, and template rows are measurements of
    /// what WE did, not of what a model charged for.
    pub fn needs_model(self) -> bool {
        matches!(
            self,
            Component::UncachedInputTokens
                | Component::CacheReadTokens
                | Component::CacheWriteTokens
                | Component::OutputTokens
        )
    }
}

/// One measured component.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Measured {
    pub component: Component,
    pub quantity: u64,
    pub observed_cost_micros: Option<u64>,
    pub pricing_snapshot_id: Option<String>,
}

impl Measured {
    /// A component with nothing to report. Zero, never absent.
    pub fn zero(component: Component) -> Measured {
        Measured {
            component,
            quantity: 0,
            observed_cost_micros: None,
            pricing_snapshot_id: None,
        }
    }
}

/// Write one run's cost components.
///
/// Refuses a partial set: the required-row matrix IS the definition of
/// component completeness, and a run that recorded six of ten is a run M28
/// cannot reason about. Refusing here is what makes the absence impossible
/// rather than merely discouraged.
pub fn record_costs(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    run_id: &str,
    model_id: &str,
    measured: &[Measured],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    let mut seen: Vec<Component> = measured.iter().map(|m| m.component).collect();
    seen.sort_unstable();
    seen.dedup();
    if seen.len() != measured.len() {
        return Err("a component was measured twice — one row per component".to_string());
    }
    let missing: Vec<&str> = Component::ALL
        .iter()
        .filter(|c| !seen.contains(c))
        .map(|c| c.as_str())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "cost accounting for run {run_id} is missing {} — zero is a quantity, absence is \
             not, and a partial set is one M28 cannot reason about",
            missing.join(", ")
        ));
    }
    if model_id.is_empty() {
        return Err("the four model-accounting rows need a model id".to_string());
    }

    let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for row in measured {
        tx.execute(
            "INSERT INTO run_cost_components (
                 vault_id, store_uuid, run_id, component, unit, model_id, quantity,
                 observed_cost_micros, pricing_snapshot_id, recorded_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                vault_id,
                store_uuid,
                run_id,
                row.component.as_str(),
                row.component.unit(),
                row.component.needs_model().then_some(model_id),
                row.quantity as i64,
                row.observed_cost_micros.map(|v| v as i64),
                row.pricing_snapshot_id,
                stamp,
            ],
        )
        .map_err(|e| format!("run_cost_components {}: {e}", row.component.as_str()))?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Read one run's components, component order.
pub fn costs(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    run_id: &str,
) -> Result<Vec<(Component, u64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT component, quantity FROM run_cost_components
             WHERE vault_id = ?1 AND store_uuid = ?2 AND run_id = ?3
             ORDER BY component",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![vault_id, store_uuid, run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|(name, quantity)| {
            Component::parse(&name)
                .map(|c| (c, quantity as u64))
                .ok_or_else(|| format!("unknown cost component {name}"))
        })
        .collect()
}

/// One assembly's shape, as it was actually served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssemblyMetrics {
    pub run_id: String,
    pub manifest_id: String,
    pub intended_stakes: String,
    pub source_count: u64,
    pub evidence_item_count: u64,
    pub context_bytes: u64,
    pub retrieval_query_count: u64,
    pub blocked_intent_count: u64,
}

pub fn record_assembly(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    metrics: &AssemblyMetrics,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO assembly_metrics (
             vault_id, store_uuid, run_id, manifest_id, intended_stakes,
             source_count, evidence_item_count, context_bytes,
             retrieval_query_count, blocked_intent_count, recorded_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            vault_id,
            store_uuid,
            metrics.run_id,
            metrics.manifest_id,
            metrics.intended_stakes,
            metrics.source_count as i64,
            metrics.evidence_item_count as i64,
            metrics.context_bytes as i64,
            metrics.retrieval_query_count as i64,
            metrics.blocked_intent_count as i64,
            now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ],
    )
    .map_err(|e| format!("assembly_metrics: {e}"))?;
    Ok(())
}

/// Everything one resolver attempt needs beside its tagged outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptContext {
    pub attempt_id: String,
    pub run_id: String,
    pub ingest_item_id: String,
    pub artifact_id: String,
    pub assertion_event_id: Option<String>,
    pub assertion_candidate_hash: String,
}

/// Record one resolver attempt.
///
/// The tagged union is flattened here because SQL has no sum type; the
/// table's CHECKs re-impose what the union guaranteed, so a row written by
/// any future caller still cannot claim to have attached without saying to
/// what.
pub fn record_attempt(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    context: &AttemptContext,
    attempt: &Attempt,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    attempt.validate()?;
    let (eligible, ineligible_reason, mentions, targets, candidates, resolution) = match attempt {
        Attempt::Ineligible { reason } => (0, Some(reason.as_str()), None, None, None, None),
        Attempt::Eligible {
            normalized_mention_hashes,
            target_count,
            candidate_entity_ids,
            resolution,
        } => (
            1,
            None,
            Some(normalized_mention_hashes.join(",")),
            Some(*target_count as i64),
            Some(candidate_entity_ids.clone()),
            Some(resolution),
        ),
    };
    let (prior_entity_id, prior_resolution_event_id) = match resolution {
        Some(crate::ingest::resolver::Resolution::ParkedConflict {
            prior_entity_id,
            prior_resolution_event_id,
            ..
        }) => (
            Some(prior_entity_id.clone()),
            Some(prior_resolution_event_id.clone()),
        ),
        _ => (None, None),
    };
    let reason_codes = resolution
        .map(|r| {
            r.reason_codes()
                .iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();

    conn.execute(
        "INSERT OR REPLACE INTO resolver_outcomes (
             vault_id, store_uuid, attempt_id, run_id, ingest_item_id, artifact_id,
             assertion_event_id, assertion_candidate_hash, eligible, ineligible_reason,
             outcome, attachment_state, chosen_entity_id, prior_entity_id,
             prior_resolution_event_id, target_count, candidate_count,
             normalized_mention_hashes, candidate_entity_ids, reason_codes, attempted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                   ?16, ?17, ?18, ?19, ?20, ?21)",
        params![
            vault_id,
            store_uuid,
            context.attempt_id,
            context.run_id,
            context.ingest_item_id,
            context.artifact_id,
            context.assertion_event_id,
            context.assertion_candidate_hash,
            eligible,
            ineligible_reason,
            attempt.outcome_str(),
            resolution.map(|r| r.attachment_state()),
            resolution.and_then(|r| r.chosen_entity_id().map(str::to_string)),
            prior_entity_id,
            prior_resolution_event_id,
            targets,
            candidates.as_ref().map(|c| c.len() as i64),
            mentions,
            candidates.map(|c| c.join(",")),
            reason_codes,
            now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ],
    )
    .map_err(|e| format!("resolver_outcomes: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::resolver::{Ineligible, Outcome, Resolution};

    const VAULT: &str = "vault-1";
    const STORE: &str = "cafebabecafebabecafebabecafebabe";
    const RUN: &str = "run-1";
    const ENTITY: &str = "e0000000000000000000000000000001";
    const PRIOR: &str = "e0000000000000000000000000000002";
    const EVENT: &str = "90000000000000000000000000000001";

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-08-12T12:00:00.000Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE vault_registry (vault_id TEXT PRIMARY KEY, path TEXT NOT NULL);
             CREATE TABLE source_taint_assessments (
                 vault_id TEXT, store_uuid TEXT, observation_event_id TEXT,
                 classifier_version TEXT, signals TEXT, assessed_at TEXT);",
        )
        .expect("registry");
        conn.execute(
            "INSERT INTO vault_registry (vault_id, path) VALUES (?1, '/tmp/v')",
            params![VAULT],
        )
        .expect("register");
        conn.execute_batch(crate::runtime::schema::SCHEMA_V9)
            .expect("v9");
        conn
    }

    fn full() -> Vec<Measured> {
        Component::ALL.into_iter().map(Measured::zero).collect()
    }

    fn context() -> AttemptContext {
        AttemptContext {
            attempt_id: "attempt-1".into(),
            run_id: RUN.into(),
            ingest_item_id: "item-1".into(),
            artifact_id: "artifact-1".into(),
            assertion_event_id: Some("a".repeat(32)),
            assertion_candidate_hash: "b".repeat(64),
        }
    }

    #[test]
    fn a_partial_cost_set_is_refused_by_name() {
        let conn = conn();
        let mut short = full();
        short.retain(|m| m.component != Component::CacheReadTokens);
        let detail = record_costs(&conn, VAULT, STORE, RUN, "m", &short, now()).unwrap_err();
        assert!(detail.contains("cache_read_tokens"), "{detail}");
        assert!(detail.contains("zero is a quantity"), "{detail}");
        assert!(
            costs(&conn, VAULT, STORE, RUN).unwrap().is_empty(),
            "a refused set writes nothing at all"
        );
    }

    #[test]
    fn all_ten_land_once_and_a_second_write_conflicts() {
        let conn = conn();
        record_costs(&conn, VAULT, STORE, RUN, "m", &full(), now()).unwrap();
        assert_eq!(costs(&conn, VAULT, STORE, RUN).unwrap().len(), 10);
        let detail = record_costs(&conn, VAULT, STORE, RUN, "m", &full(), now()).unwrap_err();
        assert!(detail.to_lowercase().contains("unique"), "{detail}");
    }

    #[test]
    fn the_unit_comes_from_the_component_and_the_table_agrees() {
        // Two definitions of the same mapping — the enum's and the CHECK's —
        // and this is what keeps them one.
        let conn = conn();
        record_costs(&conn, VAULT, STORE, RUN, "m", &full(), now()).unwrap();
        let mut stmt = conn
            .prepare("SELECT component, unit FROM run_cost_components ORDER BY component")
            .unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rows.len(), 10);
        for (name, unit) in rows {
            assert_eq!(Component::parse(&name).unwrap().unit(), unit);
        }
    }

    #[test]
    fn only_the_model_accounting_rows_carry_a_model() {
        let conn = conn();
        record_costs(&conn, VAULT, STORE, RUN, "claude-x", &full(), now()).unwrap();
        let named: i64 = conn
            .query_row(
                "SELECT count(*) FROM run_cost_components WHERE model_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(named, 4);
    }

    #[test]
    fn an_attached_attempt_names_what_it_attached_to() {
        let conn = conn();
        record_attempt(
            &conn,
            VAULT,
            STORE,
            &context(),
            &Attempt::Eligible {
                normalized_mention_hashes: vec!["c".repeat(64)],
                target_count: 1,
                candidate_entity_ids: vec![ENTITY.into()],
                resolution: Resolution::Attached {
                    outcome: Outcome::KnownAlias,
                    chosen_entity_id: ENTITY.into(),
                },
            },
            now(),
        )
        .unwrap();
        let (outcome, state, chosen): (String, String, String) = conn
            .query_row(
                "SELECT outcome, attachment_state, chosen_entity_id FROM resolver_outcomes",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (outcome.as_str(), state.as_str()),
            ("known_alias", "attached")
        );
        assert_eq!(chosen, ENTITY);
    }

    #[test]
    fn an_ineligible_attempt_borrows_no_outcome() {
        let conn = conn();
        record_attempt(
            &conn,
            VAULT,
            STORE,
            &context(),
            &Attempt::Ineligible {
                reason: Ineligible::AlreadyAttached,
            },
            now(),
        )
        .unwrap();
        let (outcome, state, reason): (String, Option<String>, String) = conn
            .query_row(
                "SELECT outcome, attachment_state, ineligible_reason FROM resolver_outcomes",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(outcome, "ineligible");
        assert_eq!(state, None, "nothing attached and nothing parked");
        assert_eq!(reason, "already_attached");
    }

    #[test]
    fn a_conflicting_attachment_records_what_it_conflicted_with() {
        let conn = conn();
        record_attempt(
            &conn,
            VAULT,
            STORE,
            &context(),
            &Attempt::Eligible {
                normalized_mention_hashes: vec!["c".repeat(64)],
                target_count: 1,
                // `Attempt::validate` requires exactly the chosen entity: a
                // conflicting attachment is not an ambiguity, it is one
                // answer that disagrees with a prior one.
                candidate_entity_ids: vec![ENTITY.into()],
                resolution: Resolution::ParkedConflict {
                    chosen_entity_id: ENTITY.into(),
                    prior_entity_id: PRIOR.into(),
                    prior_resolution_event_id: EVENT.into(),
                },
            },
            now(),
        )
        .unwrap();
        let (prior, event, reasons): (String, String, String) = conn
            .query_row(
                "SELECT prior_entity_id, prior_resolution_event_id, reason_codes \
                 FROM resolver_outcomes",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((prior.as_str(), event.as_str()), (PRIOR, EVENT));
        assert_eq!(reasons, "conflicting_attachment");
    }

    #[test]
    fn a_wrong_unit_is_refused_by_the_table_even_when_the_writer_is_bypassed() {
        // `record_costs` derives the unit, so this is the case where somebody
        // later writes SQL by hand. The table is the last line, and it holds.
        let conn = conn();
        let detail = conn
            .execute(
                "INSERT INTO run_cost_components (
                     vault_id, store_uuid, run_id, component, unit, model_id, quantity,
                     recorded_at
                 ) VALUES (?1, ?2, ?3, 'output_tokens', 'bytes', 'm', 1,
                           '2026-08-12T12:00:00.000Z')",
                params![VAULT, STORE, RUN],
            )
            .unwrap_err()
            .to_string();
        assert!(detail.contains("CHECK"), "{detail}");
    }

    #[test]
    fn a_model_accounting_row_without_a_model_is_refused_by_the_table() {
        let conn = conn();
        let detail = conn
            .execute(
                "INSERT INTO run_cost_components (
                     vault_id, store_uuid, run_id, component, unit, model_id, quantity,
                     recorded_at
                 ) VALUES (?1, ?2, ?3, 'output_tokens', 'tokens', NULL, 1,
                           '2026-08-12T12:00:00.000Z')",
                params![VAULT, STORE, RUN],
            )
            .unwrap_err()
            .to_string();
        assert!(detail.contains("CHECK"), "{detail}");
    }

    #[test]
    fn two_vaults_spending_under_one_run_id_do_not_share_rows() {
        // M28's windows are per-vault. A `run_id` collision across vaults —
        // which a caller minting ids per-vault can absolutely produce — must
        // not merge two vaults' accounting into one.
        let conn = conn();
        conn.execute(
            "INSERT INTO vault_registry (vault_id, path) VALUES ('vault-2', '/tmp/w')",
            [],
        )
        .unwrap();
        record_costs(&conn, VAULT, STORE, RUN, "m", &full(), now()).unwrap();
        let detail = record_costs(&conn, "vault-2", STORE, RUN, "m", &full(), now()).unwrap_err();
        assert!(
            detail.to_lowercase().contains("unique"),
            "the design's unique (run_id, component) is GLOBAL, so a shared run id across \
             vaults is refused rather than silently merged: {detail}"
        );
        assert_eq!(costs(&conn, VAULT, STORE, RUN).unwrap().len(), 10);
        assert!(costs(&conn, "vault-2", STORE, RUN).unwrap().is_empty());
    }

    #[test]
    fn the_rows_survive_closing_and_reopening_the_database() {
        // "Reproducible from persisted rows alone" is a claim about a file,
        // not about a connection.
        // The REAL schema, not the permissive stub the other tests use: a
        // restart claim is about a file, and the file has the live
        // constraints on it (`vault_id` is 32 hex here, not "vault-1").
        let real_vault = "a".repeat(32);
        let dir = crate::vault::testutil::temp_vault("governance-restart");
        {
            let conn = crate::runtime::open(&dir).expect("a runtime db");
            conn.execute(
                "INSERT INTO vault_registry (vault_id, vault_path, first_seen_at) \
                 VALUES (?1, '/tmp/governance-restart', '2026-08-12T12:00:00.000Z')",
                params![real_vault],
            )
            .expect("register");
            record_costs(&conn, &real_vault, STORE, RUN, "m", &full(), now()).unwrap();
            record_attempt(
                &conn,
                &real_vault,
                STORE,
                &context(),
                &Attempt::Ineligible {
                    reason: Ineligible::SubjectNone,
                },
                now(),
            )
            .unwrap();
        }
        let conn = crate::runtime::open_existing(&dir).expect("reopened");
        assert_eq!(costs(&conn, &real_vault, STORE, RUN).unwrap().len(), 10);
        let attempts: i64 = conn
            .query_row("SELECT count(*) FROM resolver_outcomes", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(attempts, 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_assembly_row_round_trips() {
        let conn = conn();
        let metrics = AssemblyMetrics {
            run_id: RUN.into(),
            manifest_id: "d".repeat(32),
            intended_stakes: "MEDIUM".into(),
            source_count: 3,
            evidence_item_count: 7,
            context_bytes: 4096,
            retrieval_query_count: 2,
            blocked_intent_count: 1,
        };
        record_assembly(&conn, VAULT, STORE, &metrics, now()).unwrap();
        let blocked: i64 = conn
            .query_row(
                "SELECT blocked_intent_count FROM assembly_metrics",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(blocked, 1);
    }
}
