//! R7 — same-store cross-source qualification (M28.0e, extractor M28.0h).
//!
//! Two distinct connector sources, continuously connected and healthy for a
//! full 30-day window, each contributing at least a hundred distinct
//! committed assertion-bearing Observations against ONE declared
//! subject/predicate/scope digest. The registration, connection, and health
//! halves come off the M25 portable cache and live-signal tables here; the
//! observation ids come from `trigger::observations` — the extractor that
//! was M28.0e's named seam, made real in M28.0h — walking reducer state
//! against the declared [`VerificationScope`].

use std::collections::BTreeSet;

use rusqlite::Connection;

use crate::dynamics::freshness;
use crate::ledger::reduce::EpistemicState;
use crate::trigger::evaluate::{MeasurableOutcome, Recorded, VaultScope};
use crate::trigger::evaluation::{MetricSeriesKey, TriggerMetric, TriggerResult};
use crate::trigger::observations::{self, CacheRegistration, VerificationScope};
use crate::trigger::registry::Registry;

/// One registered source, as the M25 cache and live signals describe it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct R7Source {
    pub source_id: String,
    pub kind: String,
    pub registration_event_id: String,
    pub connection_state: Option<String>,
    pub connection_since: Option<String>,
    pub health_state: Option<String>,
    pub health_since: Option<String>,
    /// Distinct qualifying Observation event ids, from the extractor seam.
    pub observation_event_ids: BTreeSet<String>,
}

impl R7Source {
    /// Continuously connected and healthy for the whole window: the current
    /// state is right AND has held since before the window began. A
    /// transition inside the window moved `since`, so it disqualifies.
    fn steady(&self, window_start: &str) -> bool {
        self.connection_state.as_deref() == Some("connected")
            && self.health_state.as_deref() == Some("healthy")
            && self
                .connection_since
                .as_deref()
                .is_some_and(|since| since <= window_start)
            && self
                .health_since
                .as_deref()
                .is_some_and(|since| since <= window_start)
    }
}

/// The pure core. `window_start_utc` is the window's opening instant as a
/// `…Z` string — the same spelling the live-signal tables store, so the
/// comparison is byte order over one calendar.
pub fn r7_outcome(
    sources: &[R7Source],
    store_uuid: &str,
    window_start_utc: &str,
    required_sources: u64,
    min_observations: u64,
) -> (Vec<TriggerMetric>, TriggerResult) {
    let connectors: Vec<&R7Source> = sources.iter().filter(|s| s.kind == "connector").collect();
    let mut metrics = Vec::new();
    let mut qualifying = 0u64;
    for source in &connectors {
        let observations = source.observation_event_ids.len() as u64;
        metrics.push(TriggerMetric::Count {
            name: "qualifying_observations".into(),
            series: MetricSeriesKey::Source {
                store_uuid: store_uuid.to_string(),
                source_id: source.source_id.clone(),
            },
            value: observations,
        });
        if source.steady(window_start_utc) && observations >= min_observations {
            qualifying += 1;
        }
    }
    metrics.push(TriggerMetric::Count {
        name: "qualifying_sources".into(),
        series: MetricSeriesKey::Aggregate,
        value: qualifying,
    });
    // Fewer than the required number of connector registrations is an absent
    // population, not a quiet one: there is nothing the protocol could ever
    // qualify, so the answer is "cannot be evaluated yet".
    let result = if (connectors.len() as u64) < required_sources {
        TriggerResult::NotReady
    } else if qualifying >= required_sources {
        TriggerResult::Fired
    } else {
        TriggerResult::NotFired
    };
    (metrics, result)
}

/// Evaluate R7 over one vault store.
///
/// `state` is the reduced ledger the observations are counted from;
/// `verification` is the declared scope, whose canonical digest rides in the
/// payload so the evaluation names what it was scoped to.
pub fn evaluate_r7(
    conn: &Connection,
    registry: &Registry,
    scope: &VaultScope,
    evaluated_at: chrono::DateTime<chrono::Utc>,
    timezone: &str,
    state: &EpistemicState,
    verification: &VerificationScope,
) -> Result<Recorded, String> {
    let outcome = MeasurableOutcome::vault(registry, "R7:root", scope, evaluated_at, timezone)?;

    let mut statement = conn
        .prepare(
            "SELECT r.source_id, r.kind, r.registration_event_id, \
                    c.state, c.since, h.state, h.since \
             FROM source_registration r \
             LEFT JOIN source_connection c \
               ON c.store_uuid = r.store_uuid AND c.source_id = r.source_id \
             LEFT JOIN source_health h \
               ON h.store_uuid = r.store_uuid AND h.source_id = r.source_id \
             WHERE r.store_uuid = ?1 ORDER BY r.source_id",
        )
        .map_err(|e| e.to_string())?;
    let fetched = statement
        .query_map(rusqlite::params![scope.store_uuid], |r| {
            Ok(R7Source {
                source_id: r.get(0)?,
                kind: r.get(1)?,
                registration_event_id: r.get(2)?,
                connection_state: r.get(3)?,
                connection_since: r.get(4)?,
                health_state: r.get(5)?,
                health_since: r.get(6)?,
                observation_event_ids: BTreeSet::new(),
            })
        })
        .map_err(|e| e.to_string())?;
    let mut sources = Vec::new();
    for source in fetched {
        sources.push(source.map_err(|e| e.to_string())?);
    }

    // The M25 cache rows ARE the join the extractor checks against.
    let cache: std::collections::BTreeMap<String, CacheRegistration> = sources
        .iter()
        .map(|s| {
            (
                s.source_id.clone(),
                CacheRegistration {
                    registration_event_id: s.registration_event_id.clone(),
                    kind: s.kind.clone(),
                },
            )
        })
        .collect();
    let (window_start, window_end) = outcome.bounds();
    let counted = observations::qualifying_observations(
        state,
        verification,
        &freshness::load()?,
        &cache,
        window_start,
        window_end,
    )?;
    for source in &mut sources {
        if let Some(ids) = counted.get(&source.source_id) {
            source.observation_event_ids = ids.clone();
        }
    }

    let window_start_utc = outcome.window_start_utc();
    let (metrics, result) = r7_outcome(
        &sources,
        &scope.store_uuid,
        &window_start_utc,
        outcome.constant("required_sources")?,
        outcome.constant("min_observations_per_source")?,
    );
    outcome.persist(
        conn,
        &serde_json::json!({
            "verification_scope": verification,
            "verification_scope_digest": verification.digest()?,
            "sources": sources,
        }),
        metrics,
        result,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW_START: &str = "2026-07-15T00:00:00.000Z";

    fn source(id: &str, kind: &str, since: &str, observations: usize) -> R7Source {
        R7Source {
            source_id: id.to_string(),
            kind: kind.to_string(),
            registration_event_id: "e".repeat(32),
            connection_state: Some("connected".into()),
            connection_since: Some(since.to_string()),
            health_state: Some("healthy".into()),
            health_since: Some(since.to_string()),
            observation_event_ids: (0..observations).map(|n| format!("obs-{n:04}")).collect(),
        }
    }

    #[test]
    fn r7_fires_on_two_steady_connectors_with_a_hundred_each() {
        let sources = vec![
            source("s1", "connector", "2026-07-01T00:00:00.000Z", 100),
            source("s2", "connector", "2026-06-01T00:00:00.000Z", 250),
        ];
        let (_, result) = r7_outcome(&sources, "store", WINDOW_START, 2, 100);
        assert_eq!(result, TriggerResult::Fired);
    }

    #[test]
    fn r7_each_disqualifier_closes_the_gate_on_its_own() {
        let steady = source("s1", "connector", "2026-07-01T00:00:00.000Z", 100);
        for spoiled in [
            source("s2", "connector", "2026-07-01T00:00:00.000Z", 99),
            // A connection transition INSIDE the window: `since` moved.
            source("s2", "connector", "2026-07-20T00:00:00.000Z", 100),
            {
                let mut s = source("s2", "connector", "2026-07-01T00:00:00.000Z", 100);
                s.health_state = Some("unhealthy".into());
                s
            },
            {
                let mut s = source("s2", "connector", "2026-07-01T00:00:00.000Z", 100);
                s.connection_state = None;
                s
            },
        ] {
            let sources = vec![steady.clone(), spoiled];
            let (_, result) = r7_outcome(&sources, "store", WINDOW_START, 2, 100);
            assert_eq!(result, TriggerResult::NotFired);
        }
    }

    #[test]
    fn r7_non_connector_kinds_are_not_a_population() {
        // The owner's own notes and the builtin knowledge bundle can never
        // qualify, however steady: cross-source verification is about
        // CONNECTORS, and today none are registered anywhere.
        let sources = vec![
            source("s1", "human_actor", "2026-07-01T00:00:00.000Z", 500),
            source("s2", "builtin", "2026-07-01T00:00:00.000Z", 500),
        ];
        let (_, result) = r7_outcome(&sources, "store", WINDOW_START, 2, 100);
        assert_eq!(
            result,
            TriggerResult::NotReady,
            "no connector population exists"
        );
    }

    #[test]
    fn r7_end_to_end_counts_reduced_observations_against_the_cache_and_replays() {
        use crate::ledger::reduce::{
            AssertionFacet, EpistemicState, ObservationState, SourceState,
        };
        use crate::ledger::schema::{
            AssertionBasis, AuthorityCapability, ObservationKind, Scope, SourceRegistration,
            SubjectRef, TypedValue, ValidInterval,
        };
        use crate::trigger::evaluate::VaultScope;
        use crate::trigger::observations::VerificationScope;
        use crate::vault::testutil;

        let dir = testutil::temp_vault("trigger-evaluate-r7");
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        let store = "feedfacefeedfacefeedfacefeedface";
        let scope = VaultScope {
            vault_id: vault.clone(),
            store_uuid: store.to_string(),
        };
        let falcon = "e0000000000000000000000000000001";

        let mut state = EpistemicState::default();
        for (n, (source_id, registration)) in [
            (
                "50000000000000000000000000000001",
                "60000000000000000000000000000001",
            ),
            (
                "50000000000000000000000000000002",
                "60000000000000000000000000000002",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            conn.execute(
                "INSERT INTO source_registration (store_uuid, source_id, \
                 registration_event_id, kind, source_key, authority_capability) \
                 VALUES (?1, ?2, ?3, 'connector', ?4, 'direct_system_artifact')",
                rusqlite::params![store, source_id, registration, format!("connector:{n}")],
            )
            .unwrap();
            for (table, good) in [
                ("source_connection", "connected"),
                ("source_health", "healthy"),
            ] {
                conn.execute(
                    &format!(
                        "INSERT INTO {table} (store_uuid, source_id, state, since) \
                         VALUES (?1, ?2, ?3, '2026-07-01T00:00:00.000Z')"
                    ),
                    rusqlite::params![store, source_id, good],
                )
                .unwrap();
            }
            state.sources.insert(
                source_id.to_string(),
                SourceState {
                    source_id: source_id.to_string(),
                    registration_event_id: registration.to_string(),
                    registration: SourceRegistration::Connector {
                        source_key: format!("connector:{n}"),
                        connector_instance_id: "ci".into(),
                        logical_scope_id: "repo".into(),
                        authority_capability: AuthorityCapability::DirectSystemArtifact,
                        independence_domain_id: None,
                    },
                    canonical: "{}".into(),
                },
            );
            for i in 0..100 {
                let event_id = format!("{n}{i:031}");
                state.observations.insert(
                    event_id.clone(),
                    ObservationState {
                        event_id: event_id.clone(),
                        seq: i,
                        kind: ObservationKind::ExtractedAssertion,
                        source_id: source_id.to_string(),
                        source_registration_event_id: registration.to_string(),
                        subject: SubjectRef::Resolved {
                            entity_id: falcon.into(),
                            aliases: vec![],
                        },
                        effective_entity: Some(falcon.into()),
                        effective_resolution_event: None,
                        authority: None,
                        assertion_basis: Some(AssertionBasis::Firsthand),
                        absence: None,
                        actor: "system:connector".into(),
                        lineage_parents: vec![],
                    },
                );
                state.assertion_facets.insert(
                    event_id,
                    AssertionFacet {
                        predicate: "ci_status".into(),
                        value_hash: "f".repeat(64),
                        value: TypedValue::string("green"),
                        scope: Scope::empty(),
                        valid_time: ValidInterval {
                            from: None,
                            to: None,
                        },
                        recorded_at: "2026-08-01T10:00:00.000Z".into(),
                        observed_at: None,
                        relationship_role: crate::ledger::schema::SubjectRole::Unknown,
                        source_artifact_hash: Some("a".repeat(64)),
                        raw_pointer: Some("repo/ci.json#L1".into()),
                    },
                );
            }
        }

        let verification = VerificationScope {
            subjects: vec![falcon.to_string()],
            predicate_classes: vec!["ci_status".to_string()],
            stage: None,
            environment: None,
            geography: None,
        };
        let registry = crate::trigger::registry::load().unwrap();
        let evaluated_at = chrono::DateTime::parse_from_rfc3339("2026-08-14T09:30:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let recorded = evaluate_r7(
            &conn,
            &registry,
            &scope,
            evaluated_at,
            "UTC",
            &state,
            &verification,
        )
        .unwrap();
        assert_eq!(recorded.evaluation.result, TriggerResult::Fired);

        // The rerun replays byte-identically, and the stored record still
        // validates against the shared registry.
        let rerun = evaluate_r7(
            &conn,
            &registry,
            &scope,
            evaluated_at,
            "UTC",
            &state,
            &verification,
        )
        .unwrap();
        assert_eq!(rerun.evaluation, recorded.evaluation);
        assert_eq!(
            rerun.evaluation_put,
            crate::runtime::triggers::Put::Replayed
        );
        crate::trigger::evaluation::validate(&recorded.evaluation, &registry).unwrap();

        // One observation short on ONE source and the gate closes — the
        // floor is per source, never pooled across the pair. A different
        // sample is a different snapshot, so this records as its own
        // evaluation rather than disturbing the one above.
        let mut short = state.clone();
        let victim = format!("0{:031}", 99);
        assert!(
            short.observations.remove(&victim).is_some(),
            "the victim exists"
        );
        let recorded = evaluate_r7(
            &conn,
            &registry,
            &scope,
            evaluated_at,
            "UTC",
            &short,
            &verification,
        )
        .unwrap();
        assert_eq!(recorded.evaluation.result, TriggerResult::NotFired);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
