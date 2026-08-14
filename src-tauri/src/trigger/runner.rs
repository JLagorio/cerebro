//! The runner (M28.1) — the caller the substrate was waiting for.
//!
//! M28.0 shipped evaluators as pure functions of persisted history that
//! nothing invoked. This module invokes them: one pass over every gate with
//! a measurable leg, one status board over every gate the artifact declares.
//! **The boundary does not move** — the runner records results through
//! `runtime::triggers` into the two governance tables and nothing else, and
//! a fired row still licenses exactly a dated plan document written by a
//! human.
//!
//! **No daemon.** Every measurable gate reads primitives that accumulate
//! whether or not anyone evaluates, so evaluating at look-time loses
//! nothing; rerunning inside one local day replays byte-identically. The
//! runner therefore runs when a surface opens or an owner asks, never on a
//! timer — and, like every file in this module, it reads no clock:
//! `evaluated_at` and the IANA timezone arrive from the caller.
//!
//! **Per-gate error isolation.** One evaluator's failure becomes that gate's
//! row in the report, never a veto on the rest: a broken R1 query must not
//! hide that R13 fired. The report says what happened to every gate it is
//! responsible for, including the ones it deliberately did not run — an
//! absent row and a not-evaluated row are different claims.

use rusqlite::Connection;

use crate::ledger::reduce::EpistemicState;
use crate::runtime::triggers::{self, Put, StoredScope};
use crate::trigger::cost;
use crate::trigger::evaluate::{self, Recorded, VaultScope};
use crate::trigger::observations::VerificationScope;
use crate::trigger::registry::{ParentRule, Registry, ScopeKind, Variant};
use crate::trigger::sources;

/// What one pass did to one gate.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GateOutcome {
    /// The evaluator ran and a row exists — freshly inserted or replayed.
    Recorded {
        result: String,
        evaluation_id: String,
        replayed: bool,
    },
    /// The runner deliberately did not evaluate, and says why.
    NotEvaluated { reason: String },
    /// The evaluator failed. The message is the row; the other gates ran.
    Error { message: String },
}

/// One gate's line in a run report.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GateRun {
    pub gate: String,
    pub outcome: GateOutcome,
}

/// Everything one pass did, in registry order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RunReport {
    pub evaluated_at: String,
    pub timezone: String,
    pub gates: Vec<GateRun>,
}

/// R7's extra inputs: the reduced ledger and the DECLARED scope. The runner
/// never synthesizes a verification scope — a runner that invents the
/// question chooses what it will be measured by.
pub struct R7Input<'a> {
    pub state: &'a EpistemicState,
    pub verification: &'a VerificationScope,
}

fn ran(recorded: Result<Recorded, String>) -> GateOutcome {
    match recorded {
        Ok(recorded) => GateOutcome::Recorded {
            result: recorded.evaluation.result.as_str().to_string(),
            evaluation_id: recorded.evaluation.evaluation_id,
            replayed: recorded.evaluation_put == Put::Replayed,
        },
        Err(message) => GateOutcome::Error { message },
    }
}

/// Run every gate with a measurable root over this vault store. R1 is
/// subscription-global and runs regardless of which vault asked; R2's
/// measurable leg runs only inside an owner evidence pack, so the runner
/// reports it rather than running it; R7 runs only under a declared scope.
pub fn run_measurable(
    conn: &Connection,
    registry: &Registry,
    scope: &VaultScope,
    r7: Option<R7Input<'_>>,
    evaluated_at: chrono::DateTime<chrono::Utc>,
    timezone: &str,
) -> RunReport {
    let mut gates = Vec::new();
    gates.push(GateRun {
        gate: "R1:root".to_string(),
        outcome: ran(cost::evaluate_r1(conn, registry, evaluated_at, timezone)),
    });
    gates.push(GateRun {
        gate: "R2:root".to_string(),
        outcome: GateOutcome::NotEvaluated {
            reason: "hybrid — assembled from an owner evidence pack through the recording \
                     road, never by this pass"
                .to_string(),
        },
    });
    for (gate, run) in [
        ("R3:root", evaluate::evaluate_r3 as EvaluateFn),
        ("R6:root", evaluate::evaluate_r6 as EvaluateFn),
    ] {
        gates.push(GateRun {
            gate: gate.to_string(),
            outcome: ran(run(conn, registry, scope, evaluated_at, timezone)),
        });
    }
    gates.push(GateRun {
        gate: "R7:root".to_string(),
        outcome: match &r7 {
            Some(input) => ran(sources::evaluate_r7(
                conn,
                registry,
                scope,
                evaluated_at,
                timezone,
                input.state,
                input.verification,
            )),
            None => GateOutcome::NotEvaluated {
                reason: "no verification scope is declared for this vault — declare one to \
                         say what R7 should count"
                    .to_string(),
            },
        },
    });
    for (gate, run) in [
        ("R10:root", evaluate::evaluate_r10 as EvaluateFn),
        ("R13:root", evaluate::evaluate_r13 as EvaluateFn),
    ] {
        gates.push(GateRun {
            gate: gate.to_string(),
            outcome: ran(run(conn, registry, scope, evaluated_at, timezone)),
        });
    }
    RunReport {
        evaluated_at: evaluated_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        timezone: timezone.to_string(),
        gates,
    }
}

type EvaluateFn = fn(
    &Connection,
    &Registry,
    &VaultScope,
    chrono::DateTime<chrono::Utc>,
    &str,
) -> Result<Recorded, String>;

/// The newest recorded evaluation of one gate, as the board shows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LatestEvaluation {
    pub evaluation_id: String,
    pub result: String,
    pub evaluated_at: String,
    pub window_end: Option<String>,
}

/// One gate on the board. `latest: None` is a claim — "never evaluated
/// here" — that the surface must render, not elide.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GateStatus {
    pub gate: String,
    pub variant: String,
    pub note: Option<String>,
    pub latest: Option<LatestEvaluation>,
}

/// One registry entry on the board, with every gate the artifact declares
/// under it. R14's list is honestly empty until a connector is registered,
/// and the note says so instead of leaving a hole.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EntryStatus {
    pub registry_id: String,
    pub capability: String,
    pub scope: String,
    pub note: Option<String>,
    pub gates: Vec<GateStatus>,
}

fn gate_note(variant: Variant, parent: Option<&ParentRule>) -> Option<String> {
    match (variant, parent) {
        (Variant::Measurable, Some(ParentRule::MeasurableAlias { allowed, .. })) => Some(format!(
            "fires only as a byte-equal alias of a fired {}",
            allowed.join(" or ")
        )),
        (Variant::Measurable, _) => None,
        (Variant::Hybrid, _) => {
            Some("hybrid — a measurable leg plus a dated owner evidence pack".to_string())
        }
        (Variant::Discretionary, Some(ParentRule::FiredParent { allowed })) => Some(format!(
            "awaiting a dated owner evidence pack, and its parent {} must have fired",
            allowed.join(" or ")
        )),
        (Variant::Discretionary, _) => Some("awaiting a dated owner evidence pack".to_string()),
    }
}

/// The full board: every entry, every declared gate, newest evaluation per
/// gate under the scope the entry declares. Closed over the artifact — a
/// gate missing from this board is a gate missing from the registry.
pub fn status(
    conn: &Connection,
    registry: &Registry,
    scope: &VaultScope,
) -> Result<Vec<EntryStatus>, String> {
    let mut board = Vec::new();
    for entry in registry.entries() {
        let stored = match entry.scope {
            ScopeKind::SubscriptionGlobal => StoredScope::SubscriptionGlobal,
            ScopeKind::VaultStore => StoredScope::VaultStore {
                vault_id: scope.vault_id.clone(),
                store_uuid: scope.store_uuid.clone(),
            },
        };
        let mut gates = Vec::new();
        let mut keys: Vec<(String, Variant, Option<&ParentRule>)> = entry
            .subcapabilities
            .iter()
            .map(|s| (s.key.clone(), s.variant, s.parent.as_ref()))
            .collect();
        if let Some(pattern) = &entry.subcapability_pattern {
            for connector in &pattern.registered_connectors {
                keys.push((
                    format!("{}{connector}", pattern.prefix),
                    pattern.variant,
                    pattern.parent.as_ref(),
                ));
            }
        }
        for (subkey, variant, parent) in keys {
            let latest =
                triggers::latest_evaluation(conn, &entry.id, &subkey, &stored)?.map(|row| {
                    LatestEvaluation {
                        evaluation_id: row.evaluation_id,
                        result: row.result,
                        evaluated_at: row.evaluated_at,
                        window_end: row.window.map(|w| w.end),
                    }
                });
            gates.push(GateStatus {
                gate: format!("{}:{subkey}", entry.id),
                variant: variant.as_str().to_string(),
                note: gate_note(variant, parent),
                latest,
            });
        }
        let note = match &entry.subcapability_pattern {
            Some(pattern) if pattern.registered_connectors.is_empty() => Some(format!(
                "no connector is registered yet — {}<id> gates appear as connectors register",
                pattern.prefix
            )),
            _ => None,
        };
        board.push(EntryStatus {
            registry_id: entry.id.clone(),
            capability: entry.capability.clone(),
            scope: entry.scope.as_str().to_string(),
            note,
            gates,
        });
    }
    Ok(board)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trigger::registry;
    use crate::vault::testutil;

    const NOW: &str = "2026-08-14T10:00:00Z";

    fn utc(stamp: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, VaultScope) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        let scope = VaultScope {
            vault_id: vault,
            store_uuid: "feedfacefeedfacefeedfacefeedface".to_string(),
        };
        (dir, conn, scope)
    }

    #[test]
    fn the_board_names_every_declared_gate_before_anything_ran() {
        let (dir, conn, scope) = fixture("runner-board");
        let registry = registry::load().unwrap();
        let board = status(&conn, &registry, &scope).unwrap();

        let ids: Vec<&str> = board.iter().map(|e| e.registry_id.as_str()).collect();
        assert_eq!(ids, registry::REGISTRY_IDS);
        // Every declared pair is a row; the artifact declares 34.
        let total: usize = board.iter().map(|e| e.gates.len()).sum();
        assert_eq!(total, 34);
        // Nothing has run, and the board says so gate by gate rather than
        // hiding the column.
        assert!(board
            .iter()
            .all(|e| e.gates.iter().all(|g| g.latest.is_none())));

        // R14 is the honestly-empty entry: no gates, a note explaining why.
        let r14 = board.iter().find(|e| e.registry_id == "R14").unwrap();
        assert!(r14.gates.is_empty());
        assert!(r14
            .note
            .as_ref()
            .unwrap()
            .contains("no connector is registered"));
        // Discretionary gates say what they are waiting for.
        let r8 = board.iter().find(|e| e.registry_id == "R8").unwrap();
        assert!(r8.gates[0].note.as_ref().unwrap().contains("evidence pack"));
        // The alias says whose firing it borrows.
        let r5 = board.iter().find(|e| e.registry_id == "R5").unwrap();
        let discovery = r5.gates.iter().find(|g| g.gate == "R5:discovery").unwrap();
        assert!(
            discovery.note.as_ref().unwrap().contains("R13:root"),
            "{discovery:?}"
        );
        // A tail names its parent as well as its pack.
        let r12 = board.iter().find(|e| e.registry_id == "R12").unwrap();
        assert!(r12.gates.iter().all(|g| {
            let note = g.note.as_ref().unwrap();
            note.contains("evidence pack") && note.contains("must have fired")
        }));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_records_five_gates_reports_two_and_reruns_replay() {
        let (dir, conn, scope) = fixture("runner-run");
        let registry = registry::load().unwrap();

        let report = run_measurable(&conn, &registry, &scope, None, utc(NOW), "Europe/Berlin");
        let keys: Vec<&str> = report.gates.iter().map(|g| g.gate.as_str()).collect();
        assert_eq!(
            keys,
            ["R1:root", "R2:root", "R3:root", "R6:root", "R7:root", "R10:root", "R13:root"]
        );
        for gate in &report.gates {
            match gate.gate.as_str() {
                "R2:root" | "R7:root" => {
                    assert!(
                        matches!(&gate.outcome, GateOutcome::NotEvaluated { .. }),
                        "{gate:?}"
                    );
                }
                _ => match &gate.outcome {
                    // An empty store answers `not_ready` everywhere — floors
                    // gate readiness, and nothing here meets a floor.
                    GateOutcome::Recorded {
                        result, replayed, ..
                    } => {
                        assert_eq!(result, "not_ready", "{gate:?}");
                        assert!(!replayed, "{gate:?}");
                    }
                    other => panic!("{}: {other:?}", gate.gate),
                },
            }
        }

        // The rerun replays every recorded gate byte-identically.
        let rerun = run_measurable(&conn, &registry, &scope, None, utc(NOW), "Europe/Berlin");
        for gate in &rerun.gates {
            if let GateOutcome::Recorded { replayed, .. } = &gate.outcome {
                assert!(replayed, "{gate:?}");
            }
        }

        // And the board now shows the newest row for each measurable root.
        let board = status(&conn, &registry, &scope).unwrap();
        for id in ["R1", "R3", "R6", "R10", "R13"] {
            let entry = board.iter().find(|e| e.registry_id == id).unwrap();
            let latest = entry.gates[0].latest.as_ref().expect(id);
            assert_eq!(latest.result, "not_ready");
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_poisoned_gate_fails_alone() {
        let (dir, conn, scope) = fixture("runner-poison");
        let registry = registry::load().unwrap();
        // Break exactly one gate's substrate. The runner must report the
        // wound and still evaluate everything else.
        conn.execute_batch("DROP TABLE discovery_plan_runs")
            .unwrap();

        let report = run_measurable(&conn, &registry, &scope, None, utc(NOW), "Europe/Berlin");
        let r13 = report.gates.iter().find(|g| g.gate == "R13:root").unwrap();
        assert!(
            matches!(&r13.outcome, GateOutcome::Error { message } if message.contains("discovery_plan_runs")),
            "{r13:?}"
        );
        for id in ["R1:root", "R3:root", "R6:root", "R10:root"] {
            let gate = report.gates.iter().find(|g| g.gate == id).unwrap();
            assert!(
                matches!(&gate.outcome, GateOutcome::Recorded { .. }),
                "{gate:?}"
            );
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_declared_scope_makes_r7_run() {
        let (dir, conn, scope) = fixture("runner-r7");
        let registry = registry::load().unwrap();
        let state = EpistemicState::default();
        let verification = VerificationScope {
            subjects: vec!["e0000000000000000000000000000001".to_string()],
            predicate_classes: vec!["operational_status".to_string()],
            stage: None,
            environment: None,
            geography: None,
        };
        verification.validate().unwrap();

        let report = run_measurable(
            &conn,
            &registry,
            &scope,
            Some(R7Input {
                state: &state,
                verification: &verification,
            }),
            utc(NOW),
            "Europe/Berlin",
        );
        let r7 = report.gates.iter().find(|g| g.gate == "R7:root").unwrap();
        // An empty store has no connector population: recorded, not_ready —
        // which is a different claim from "not evaluated".
        match &r7.outcome {
            GateOutcome::Recorded { result, .. } => assert_eq!(result, "not_ready"),
            other => panic!("{other:?}"),
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_here_reads_a_clock() {
        // The runner is the LAST place a wall clock could sneak into the
        // trigger module — it is the caller-facing edge. `evaluated_at`
        // still arrives as an argument, from the Tauri shell.
        let source = include_str!("runner.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in ["Utc::now", "SystemTime", "Local::now"] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the runner"
            );
        }
    }
}
