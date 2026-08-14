//! Pack-driven recording (M28.2) — the discretionary road and R2's hybrid
//! assembly.
//!
//! M28.0 shipped the evidence-pack VALIDATOR and left recording as a seam:
//! a validated pack had no road into the governance tables. This module is
//! that road, and it moves the boundary nowhere — a recorded discretionary
//! `fired` licenses exactly what a measurable one does, a dated plan
//! document, never code.
//!
//! **The pack is the authority for everything but the result.** Gate,
//! scope, owner, and parent are read from the hash-covered frontmatter; a
//! recording call cannot re-aim a pack at a different gate or credit a
//! different owner. The RESULT is the one field the caller declares —
//! recording a pack as `fired` is the owner's explicit act, not a
//! side-effect of the file existing — and the pack's `evaluation_*`
//! convenience lines, when present, must agree or the call refuses:
//! stale convenience lines are worse than none.
//!
//! **R2's result is measured, never declared.** The hybrid road takes the
//! pack's frozen ceiling (`max_daily_tokens`, `timezone_id`,
//! `settings_version`, `settings_digest` — hash-covered frontmatter),
//! collects the real `budget_days` rows for the pack's own timezone, runs
//! the pure headroom leg, and records ONE record carrying both halves:
//! the evidence ref and the runtime snapshot, hashed together.
//!
//! **No clock.** `evaluated_at` arrives from the caller, and a rerun of an
//! already-recorded pack adopts the stored stamp and replays — the same
//! M28.1a rule the measurable persist path follows.

use std::path::Path;
use std::str::FromStr;

use rusqlite::Connection;

use crate::runtime::triggers::{self, EvaluationRow, Put, SnapshotRow, StoredScope};
use crate::trigger::evaluate::{
    self, derive_runtime_snapshot_id, r2_headroom, R2Pack, R2Row, Recorded,
};
use crate::trigger::evaluation::{
    self, derive_evaluation_id, derive_input_snapshot_hash, EvaluationScope, GateKey,
    InputSnapshotRef, Refusal, TriggerEvaluation, TriggerResult,
};
use crate::trigger::evidence::{self, Pack};
use crate::trigger::registry::{Registry, Variant};

/// What recording one pack did. Discretionary records have no runtime
/// snapshot, so this is smaller than the measurable [`Recorded`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedPack {
    pub evaluation: TriggerEvaluation,
    pub evaluation_put: Put,
}

fn fmt(refusal: Refusal) -> String {
    format!("{}: {}", refusal.code, refusal.detail)
}

fn read_pack(repo_root: &Path, pack_path: &str) -> Result<(String, Pack), String> {
    if !pack_path.starts_with("docs/") || pack_path.contains("..") {
        return Err(format!(
            "{pack_path:?} is not a repository-relative docs path — the record stores this \
             string, and every later validation resolves it from the repository root"
        ));
    }
    let bytes = std::fs::read_to_string(repo_root.join(pack_path))
        .map_err(|e| format!("{pack_path:?} does not resolve from the repository root: {e}"))?;
    let pack = evidence::parse_pack(&bytes).map_err(fmt)?;
    Ok((bytes, pack))
}

fn required<'p>(pack: &'p Pack, key: &str) -> Result<&'p str, String> {
    pack.frontmatter
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| format!("the pack declares no {key:?}"))
}

fn parse_scope(canonical: &str) -> Result<EvaluationScope, String> {
    if canonical == "subscription_global" {
        return Ok(EvaluationScope::SubscriptionGlobal);
    }
    match canonical.splitn(3, ':').collect::<Vec<_>>().as_slice() {
        ["vault_store", vault_id, store_uuid] if !vault_id.is_empty() && !store_uuid.is_empty() => {
            Ok(EvaluationScope::VaultStore {
                vault_id: (*vault_id).to_string(),
                store_uuid: (*store_uuid).to_string(),
            })
        }
        _ => Err(format!(
            "scope {canonical:?} is neither subscription_global nor \
             vault_store:<vault_id>:<store_uuid>"
        )),
    }
}

fn stored(scope: &EvaluationScope) -> StoredScope {
    match scope {
        EvaluationScope::SubscriptionGlobal => StoredScope::SubscriptionGlobal,
        EvaluationScope::VaultStore {
            vault_id,
            store_uuid,
        } => StoredScope::VaultStore {
            vault_id: vault_id.clone(),
            store_uuid: store_uuid.clone(),
        },
    }
}

/// The pack's `evaluation_*` lines are the RECORD's half, excluded from the
/// hash for exactly that reason — so when they are present they must agree
/// with the record being minted, or somebody edited the evidence after the
/// convenience lines were written.
fn convenience_lines_agree(
    pack: &Pack,
    evaluation_id: &str,
    result: TriggerResult,
) -> Result<(), String> {
    if let Some(claimed) = pack.frontmatter.get("evaluation_id") {
        if claimed != evaluation_id {
            return Err(format!(
                "the pack's evaluation_id line says {claimed} and this recording derives \
                 {evaluation_id} — the evidence moved after that line was written; update or \
                 remove the convenience lines"
            ));
        }
    }
    if let Some(claimed) = pack.frontmatter.get("evaluation_result") {
        if claimed != result.as_str() {
            return Err(format!(
                "the pack's evaluation_result line says {claimed:?} and this recording says \
                 {:?} — one of them is wrong, and recording the disagreement would hide it",
                result.as_str()
            ));
        }
    }
    Ok(())
}

/// Record a discretionary gate from its dated owner pack.
///
/// The parent, when the pack names one, must already be RECORDED and must
/// satisfy the registry's parent rule (an R12 tail waits for its fired
/// parent) — checked here against the stored parent record, and again by
/// the schema's foreign key.
pub fn record_discretionary(
    conn: &Connection,
    registry: &Registry,
    repo_root: &Path,
    pack_path: &str,
    result: TriggerResult,
    evaluated_at: &str,
) -> Result<RecordedPack, String> {
    let (bytes, pack) = read_pack(repo_root, pack_path)?;
    let gate_canonical = required(&pack, "gate")?;
    let (registry_id, subcapability) = gate_canonical
        .split_once(':')
        .ok_or_else(|| format!("gate {gate_canonical:?} is not <registry-id>:<subkey>"))?;
    let gate = registry
        .resolve(registry_id, subcapability)
        .ok_or_else(|| {
            format!("{gate_canonical} is not a gate the registry declares — nothing to record")
        })?;
    match gate.variant {
        Variant::Discretionary => {}
        Variant::Hybrid => {
            return Err(format!(
                "{gate_canonical} is hybrid — its record needs the measured half too, so it is \
                 assembled by the R2 evaluator, not recorded from the pack alone"
            ));
        }
        Variant::Measurable => {
            return Err(format!(
                "{gate_canonical} is measurable — it is evaluated from persisted history, and \
                 an evidence pack cannot stand in for the measurement"
            ));
        }
    }
    let scope = parse_scope(required(&pack, "scope")?)?;
    let owner = required(&pack, "owner")?.to_string();
    let parent = pack.frontmatter.get("parent_evaluation").cloned();

    let input_snapshot_hash = derive_input_snapshot_hash(
        &registry.snapshot_hash_domain,
        &[(
            "evidence".to_string(),
            pack_path.to_string(),
            pack.canonical_payload.clone(),
        )],
    );
    let gate_key = GateKey {
        registry_id: registry_id.to_string(),
        subcapability: subcapability.to_string(),
    };
    let evaluation_id = derive_evaluation_id(
        &registry.evaluation_id_domain,
        &gate_key,
        &scope,
        &registry.rule_version,
        &input_snapshot_hash,
    );
    convenience_lines_agree(&pack, &evaluation_id, result)?;
    let stamp = match triggers::evaluation(conn, &evaluation_id)? {
        Some(existing) => existing.evaluated_at,
        None => evaluated_at.to_string(),
    };

    let evaluation = TriggerEvaluation {
        variant: Variant::Discretionary,
        evaluation_id: evaluation_id.clone(),
        gate_key,
        scope: scope.clone(),
        evaluated_at: stamp.clone(),
        window: None,
        input_snapshot_refs: vec![InputSnapshotRef::Evidence {
            path: pack_path.to_string(),
        }],
        input_snapshot_hash,
        metrics: vec![],
        evidence_pack_path: Some(pack_path.to_string()),
        result,
        rule_version: registry.rule_version.clone(),
        approving_owner: Some(owner.clone()),
        parent_evaluation_id: parent.clone(),
    };
    // The record must satisfy the shared validator AND round-trip through
    // the evidence check before a byte lands — a recorder that drifted from
    // either refuses its own output.
    evaluation::validate(&evaluation, registry)
        .map_err(|r| format!("the pack yields an invalid record — {}", fmt(r)))?;
    evidence::check(&evaluation, &bytes, None, registry).map_err(fmt)?;
    if let Some(parent_id) = &parent {
        let row = triggers::evaluation(conn, parent_id)?.ok_or_else(|| {
            format!(
                "parent evaluation {parent_id} is not recorded — a tail cannot wait for a \
                 firing nobody recorded"
            )
        })?;
        let parent_record: TriggerEvaluation = serde_json::from_str(&row.record_json)
            .map_err(|e| format!("parent record {parent_id} no longer parses: {e}"))?;
        evaluation::validate_parent(&evaluation, &parent_record, registry).map_err(fmt)?;
    }

    let record_json =
        serde_json::to_string(&evaluation).map_err(|e| format!("canonicalizing record: {e}"))?;
    let evaluation_put = triggers::put_evaluation(
        conn,
        &EvaluationRow {
            evaluation_id,
            registry_id: registry_id.to_string(),
            subkey: subcapability.to_string(),
            variant: "discretionary".to_string(),
            scope: stored(&scope),
            evaluated_at: stamp,
            window: None,
            input_snapshot_refs_json: serde_json::to_string(&evaluation.input_snapshot_refs)
                .map_err(|e| e.to_string())?,
            input_snapshot_hash: evaluation.input_snapshot_hash.clone(),
            metrics_json: None,
            evidence_pack_path: Some(pack_path.to_string()),
            result: result.as_str().to_string(),
            rule_version: registry.rule_version.clone(),
            approving_owner: Some(owner),
            parent_evaluation_id: parent,
            record_json,
        },
    )?;
    Ok(RecordedPack {
        evaluation,
        evaluation_put,
    })
}

/// R2's hybrid assembly: the pack's frozen ceiling plus the real
/// `budget_days` rows, one record carrying both halves.
pub fn evaluate_r2(
    conn: &Connection,
    registry: &Registry,
    repo_root: &Path,
    pack_path: &str,
    evaluated_at: chrono::DateTime<chrono::Utc>,
) -> Result<Recorded, String> {
    let (bytes, pack) = read_pack(repo_root, pack_path)?;
    let gate_canonical = required(&pack, "gate")?;
    if gate_canonical != "R2:root" {
        return Err(format!(
            "this road assembles R2's hybrid record, and the pack is about {gate_canonical}"
        ));
    }
    if required(&pack, "scope")? != "subscription_global" {
        return Err("R2 is subscription-global — one account, one ceiling, one scope".to_string());
    }
    let owner = required(&pack, "owner")?.to_string();
    let int = |key: &str| -> Result<u64, String> {
        required(&pack, key)?
            .parse::<u64>()
            .map_err(|e| format!("the pack's {key} is not an integer: {e}"))
    };
    let frozen = R2Pack {
        max_daily_tokens: int("max_daily_tokens")?,
        timezone_id: required(&pack, "timezone_id")?.to_string(),
        settings_version: int("settings_version")?,
        settings_digest: required(&pack, "settings_digest")?.to_string(),
    };
    let tz = chrono_tz::Tz::from_str(&frozen.timezone_id)
        .map_err(|e| format!("the pack's timezone_id {:?}: {e}", frozen.timezone_id))?;
    let window_days = evaluate::constant(registry, "R2:root", "window_days")?;
    let min_unused_ppm = evaluate::constant(registry, "R2:root", "min_unused_ppm")?;
    let min_qualifying_days = evaluate::constant(registry, "R2:root", "min_qualifying_days")?;
    // The window is computed in the PACK's frozen timezone: the ceiling's
    // local days are what the headroom question is about, and the caller's
    // timezone has no standing here.
    let (window, start, end) = evaluate::complete_window(tz, evaluated_at, window_days)?;

    let mut statement = conn
        .prepare(
            "SELECT window_start_utc, timezone_id, settings_version, settings_digest, \
                    max_daily_tokens, accounting_state, ambient_tokens_used \
             FROM budget_days ORDER BY window_start_utc",
        )
        .map_err(|e| e.to_string())?;
    let fetched = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    for row in fetched {
        let (window_start_utc, timezone_id, version, digest, ceiling, accounting, used) =
            row.map_err(|e| e.to_string())?;
        let instant = evaluate::parse_z(&window_start_utc)?;
        if instant < start || instant >= end {
            continue;
        }
        rows.push(R2Row {
            local_date: instant.with_timezone(&tz).date_naive().to_string(),
            window_start_utc,
            timezone_id,
            settings_version: version as u64,
            settings_digest: digest,
            max_daily_tokens: ceiling as u64,
            accounting_state: accounting,
            ambient_tokens_used: used as u64,
        });
    }
    let (metrics, result) = r2_headroom(
        &rows,
        &frozen,
        window_days,
        min_unused_ppm,
        min_qualifying_days,
    );

    let payload = serde_json::json!({ "rows": rows, "pack": {
        "max_daily_tokens": frozen.max_daily_tokens,
        "timezone_id": frozen.timezone_id,
        "settings_version": frozen.settings_version,
        "settings_digest": frozen.settings_digest,
    }});
    let payload_json =
        serde_json::to_string(&payload).map_err(|e| format!("canonicalizing payload: {e}"))?;
    let gate_key = GateKey {
        registry_id: "R2".to_string(),
        subcapability: "root".to_string(),
    };
    let snapshot_id = derive_runtime_snapshot_id(
        registry,
        &gate_key,
        &StoredScope::SubscriptionGlobal,
        &window,
        &payload_json,
    );
    let input_snapshot_hash = derive_input_snapshot_hash(
        &registry.snapshot_hash_domain,
        &[
            (
                "evidence".to_string(),
                pack_path.to_string(),
                pack.canonical_payload.clone(),
            ),
            (
                "runtime".to_string(),
                snapshot_id.clone(),
                payload_json.clone(),
            ),
        ],
    );
    let evaluation_id = derive_evaluation_id(
        &registry.evaluation_id_domain,
        &gate_key,
        &EvaluationScope::SubscriptionGlobal,
        &registry.rule_version,
        &input_snapshot_hash,
    );
    convenience_lines_agree(&pack, &evaluation_id, result)?;
    let stamp = match triggers::evaluation(conn, &evaluation_id)? {
        Some(existing) => existing.evaluated_at,
        None => evaluated_at
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            .to_string(),
    };
    let collected_at = match triggers::snapshot(conn, &snapshot_id)? {
        Some(existing) => existing.collected_at,
        None => stamp.clone(),
    };

    let evaluation = TriggerEvaluation {
        variant: Variant::Hybrid,
        evaluation_id: evaluation_id.clone(),
        gate_key,
        scope: EvaluationScope::SubscriptionGlobal,
        evaluated_at: stamp.clone(),
        window: Some(evaluation::Window {
            start: window.start.clone(),
            end: window.end.clone(),
            timezone: window.timezone.clone(),
        }),
        input_snapshot_refs: vec![
            InputSnapshotRef::Evidence {
                path: pack_path.to_string(),
            },
            InputSnapshotRef::Runtime {
                snapshot_id: snapshot_id.clone(),
            },
        ],
        input_snapshot_hash,
        metrics,
        evidence_pack_path: Some(pack_path.to_string()),
        result,
        rule_version: registry.rule_version.clone(),
        approving_owner: Some(owner.clone()),
        parent_evaluation_id: None,
    };
    evaluation::validate(&evaluation, registry)
        .map_err(|r| format!("the assembly yields an invalid record — {}", fmt(r)))?;
    evidence::check(
        &evaluation,
        &bytes,
        Some((&snapshot_id, &payload_json)),
        registry,
    )
    .map_err(fmt)?;

    let snapshot_put = triggers::put_snapshot(
        conn,
        &SnapshotRow {
            snapshot_id: snapshot_id.clone(),
            registry_id: "R2".to_string(),
            subkey: "root".to_string(),
            scope: StoredScope::SubscriptionGlobal,
            rule_version: registry.rule_version.clone(),
            payload_json,
            collected_at,
        },
    )?;
    let record_json =
        serde_json::to_string(&evaluation).map_err(|e| format!("canonicalizing record: {e}"))?;
    let evaluation_put = triggers::put_evaluation(
        conn,
        &EvaluationRow {
            evaluation_id,
            registry_id: "R2".to_string(),
            subkey: "root".to_string(),
            variant: "hybrid".to_string(),
            scope: StoredScope::SubscriptionGlobal,
            evaluated_at: stamp,
            window: Some(triggers::Window {
                start: window.start,
                end: window.end,
                timezone: window.timezone,
            }),
            input_snapshot_refs_json: serde_json::to_string(&evaluation.input_snapshot_refs)
                .map_err(|e| e.to_string())?,
            input_snapshot_hash: evaluation.input_snapshot_hash.clone(),
            metrics_json: Some(
                serde_json::to_string(&evaluation.metrics).map_err(|e| e.to_string())?,
            ),
            evidence_pack_path: Some(pack_path.to_string()),
            result: result.as_str().to_string(),
            rule_version: registry.rule_version.clone(),
            approving_owner: Some(owner),
            parent_evaluation_id: None,
            record_json,
        },
    )?;
    Ok(Recorded {
        evaluation,
        snapshot_id,
        snapshot_put,
        evaluation_put,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trigger::registry;
    use crate::vault::testutil;
    use chrono::TimeZone;

    const NOW: &str = "2026-08-14T09:30:00Z";
    const STORE: &str = "feedfacefeedfacefeedfacefeedface";

    fn utc(stamp: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    struct Fixture {
        dir: std::path::PathBuf,
        repo: std::path::PathBuf,
        conn: Connection,
        vault: String,
    }

    fn fixture(label: &str) -> Fixture {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        let repo = dir.join("repo");
        Fixture {
            dir,
            repo,
            conn,
            vault,
        }
    }

    impl Fixture {
        fn write_pack(&self, path: &str, frontmatter: &[(&str, &str)]) -> String {
            let mut lines = vec!["---".to_string()];
            for (key, value) in frontmatter {
                lines.push(format!("{key}: {value}"));
            }
            lines.push("---".to_string());
            lines.push(String::new());
            lines.push(
                "The consumer, the observed failure, the persisted examples, the boundary, \
                 and the goldens."
                    .to_string(),
            );
            let full = self.repo.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(&full, lines.join("\n")).unwrap();
            path.to_string()
        }

        fn vault_scope(&self) -> String {
            format!("vault_store:{}:{STORE}", self.vault)
        }

        fn done(self) {
            drop(self.conn);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn a_discretionary_pack_records_replays_and_survives_the_validators() {
        let f = fixture("record-discretionary");
        let registry = registry::load().unwrap();
        let path = f.write_pack(
            "docs/superpowers/evidence/triggers/R8/2026-08-14-curiosity-consumer.md",
            &[
                ("gate", "R8:root"),
                ("scope", &f.vault_scope()),
                ("owner", "josef"),
                ("decided_at", "2026-08-14"),
            ],
        );
        let recorded = record_discretionary(
            &f.conn,
            &registry,
            &f.repo,
            &path,
            TriggerResult::NotFired,
            NOW,
        )
        .unwrap();
        assert_eq!(recorded.evaluation_put, Put::Inserted);
        assert_eq!(
            recorded.evaluation.approving_owner.as_deref(),
            Some("josef")
        );

        // The stored row reparses and passes both validators from disk.
        let row = triggers::evaluation(&f.conn, &recorded.evaluation.evaluation_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.variant, "discretionary");
        assert_eq!(row.metrics_json, None);
        let reparsed: TriggerEvaluation = serde_json::from_str(&row.record_json).unwrap();
        evaluation::validate(&reparsed, &registry).unwrap();
        evidence::check_on_disk(&reparsed, &f.repo, None, &registry).unwrap();

        // A later ask records nothing new and keeps the first stamp.
        let rerun = record_discretionary(
            &f.conn,
            &registry,
            &f.repo,
            &path,
            TriggerResult::NotFired,
            "2026-08-14T17:30:00Z",
        )
        .unwrap();
        assert_eq!(rerun.evaluation_put, Put::Replayed);
        assert_eq!(rerun.evaluation.evaluated_at, NOW);
        f.done();
    }

    #[test]
    fn the_pack_is_the_authority_and_the_wrong_variant_refuses() {
        let f = fixture("record-variant");
        let registry = registry::load().unwrap();
        // A measurable gate cannot be recorded from prose.
        let measurable = f.write_pack(
            "docs/superpowers/evidence/triggers/R13/2026-08-14-wrong.md",
            &[
                ("gate", "R13:root"),
                ("scope", &f.vault_scope()),
                ("owner", "josef"),
                ("decided_at", "2026-08-14"),
            ],
        );
        let err = record_discretionary(
            &f.conn,
            &registry,
            &f.repo,
            &measurable,
            TriggerResult::Fired,
            NOW,
        )
        .unwrap_err();
        assert!(err.contains("measurable"), "{err}");
        // Hybrid points at the R2 road instead.
        let hybrid = f.write_pack(
            "docs/superpowers/evidence/triggers/R2/2026-08-14-wrong.md",
            &[
                ("gate", "R2:root"),
                ("scope", "subscription_global"),
                ("owner", "josef"),
                ("decided_at", "2026-08-14"),
            ],
        );
        let err = record_discretionary(
            &f.conn,
            &registry,
            &f.repo,
            &hybrid,
            TriggerResult::Fired,
            NOW,
        )
        .unwrap_err();
        assert!(err.contains("hybrid"), "{err}");
        f.done();
    }

    #[test]
    fn stale_convenience_lines_refuse_rather_than_record_a_disagreement() {
        let f = fixture("record-convenience");
        let registry = registry::load().unwrap();
        let path = f.write_pack(
            "docs/superpowers/evidence/triggers/R9/2026-08-14-scout.md",
            &[
                ("gate", "R9:root"),
                ("scope", &f.vault_scope()),
                ("owner", "josef"),
                ("decided_at", "2026-08-14"),
                ("evaluation_result", "fired"),
            ],
        );
        let err = record_discretionary(
            &f.conn,
            &registry,
            &f.repo,
            &path,
            TriggerResult::NotFired,
            NOW,
        )
        .unwrap_err();
        assert!(err.contains("evaluation_result"), "{err}");
        // Nothing landed.
        assert_eq!(
            f.conn
                .query_row("SELECT count(*) FROM trigger_evaluations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        f.done();
    }

    #[test]
    fn a_tail_records_only_over_its_fired_parent() {
        let f = fixture("record-tail");
        let registry = registry::load().unwrap();

        // A tail naming a parent nobody recorded.
        let orphan = f.write_pack(
            "docs/superpowers/evidence/triggers/R12/2026-08-14-orphan.md",
            &[
                ("gate", "R12:per_type_temporal_decay"),
                ("scope", &f.vault_scope()),
                ("owner", "josef"),
                ("decided_at", "2026-08-14"),
                ("parent_evaluation", &"9".repeat(64)),
            ],
        );
        let err = record_discretionary(
            &f.conn,
            &registry,
            &f.repo,
            &orphan,
            TriggerResult::Fired,
            NOW,
        )
        .unwrap_err();
        assert!(err.contains("not recorded"), "{err}");

        // A parent that exists but did NOT fire proves nothing for a tail.
        let quiet_parent = f.write_pack(
            "docs/superpowers/evidence/triggers/R4/2026-08-14-risk.md",
            &[
                ("gate", "R4:risk"),
                ("scope", &f.vault_scope()),
                ("owner", "josef"),
                ("decided_at", "2026-08-14"),
            ],
        );
        let quiet = record_discretionary(
            &f.conn,
            &registry,
            &f.repo,
            &quiet_parent,
            TriggerResult::NotFired,
            NOW,
        )
        .unwrap();
        let against_quiet = f.write_pack(
            "docs/superpowers/evidence/triggers/R12/2026-08-14-early.md",
            &[
                ("gate", "R12:per_type_temporal_decay"),
                ("scope", &f.vault_scope()),
                ("owner", "josef"),
                ("decided_at", "2026-08-14"),
                ("parent_evaluation", &quiet.evaluation.evaluation_id),
            ],
        );
        let err = record_discretionary(
            &f.conn,
            &registry,
            &f.repo,
            &against_quiet,
            TriggerResult::Fired,
            NOW,
        )
        .unwrap_err();
        assert!(err.contains("only a FIRED parent"), "{err}");

        // The road that works: a fired R4:issue, then the tail over it.
        let fired_parent = f.write_pack(
            "docs/superpowers/evidence/triggers/R4/2026-08-14-issue.md",
            &[
                ("gate", "R4:issue"),
                ("scope", &f.vault_scope()),
                ("owner", "josef"),
                ("decided_at", "2026-08-14"),
            ],
        );
        let parent = record_discretionary(
            &f.conn,
            &registry,
            &f.repo,
            &fired_parent,
            TriggerResult::Fired,
            NOW,
        )
        .unwrap();
        let tail = f.write_pack(
            "docs/superpowers/evidence/triggers/R12/2026-08-14-decay.md",
            &[
                ("gate", "R12:per_type_temporal_decay"),
                ("scope", &f.vault_scope()),
                ("owner", "josef"),
                ("decided_at", "2026-08-14"),
                ("parent_evaluation", &parent.evaluation.evaluation_id),
            ],
        );
        let recorded = record_discretionary(
            &f.conn,
            &registry,
            &f.repo,
            &tail,
            TriggerResult::Fired,
            NOW,
        )
        .unwrap();
        assert_eq!(recorded.evaluation_put, Put::Inserted);
        assert_eq!(
            recorded.evaluation.parent_evaluation_id.as_deref(),
            Some(parent.evaluation.evaluation_id.as_str())
        );
        f.done();
    }

    fn seed_budget(conn: &Connection, tz: chrono_tz::Tz, used: u64, wrong_digest_on: Option<u32>) {
        conn.execute(
            "INSERT INTO budget_settings_versions (settings_version, settings_digest, \
             recorded_at, effective_window_start_utc, timezone_id, max_daily_runs, \
             max_daily_tokens, max_daily_output_tokens, max_ambient_run_tokens, \
             max_ambient_run_output_tokens, max_consecutive_failures, max_run_elapsed_seconds, \
             warning_ppm) VALUES (3, ?1, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', \
             'Europe/Berlin', 20, 1000000, 200000, 100000, 20000, 3, 600, 800000)",
            rusqlite::params!["d".repeat(64)],
        )
        .unwrap();
        // The 28 complete local days before NOW: 2026-07-17 .. 2026-08-13.
        for n in 0..28u32 {
            let date = chrono::NaiveDate::from_ymd_opt(2026, 7, 17)
                .unwrap()
                .checked_add_days(chrono::Days::new(n as u64))
                .unwrap();
            let start = tz
                .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
                .unwrap()
                .with_timezone(&chrono::Utc);
            let end = start + chrono::Duration::days(1);
            let digest = if wrong_digest_on == Some(n) {
                "e".repeat(64)
            } else {
                "d".repeat(64)
            };
            conn.execute(
                "INSERT INTO budget_days (window_start_utc, window_end_utc, timezone_id, \
                 settings_version, settings_digest, max_daily_runs, max_daily_tokens, \
                 max_daily_output_tokens, max_ambient_run_tokens, max_ambient_run_output_tokens, \
                 max_consecutive_failures, max_run_elapsed_seconds, warning_ppm, \
                 accounting_state, ambient_tokens_used, ambient_output_tokens, \
                 reserved_total_tokens, reserved_output_tokens, ambient_runs_started, \
                 ceiling_state, ceiling_reasons) \
                 VALUES (?1, ?2, 'Europe/Berlin', 3, ?3, 20, 1000000, 200000, 100000, 20000, \
                         3, 600, 800000, 'exact', ?4, 0, 0, 0, 0, 'under_budget', '[]')",
                rusqlite::params![
                    start.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    end.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    digest,
                    used as i64,
                ],
            )
            .unwrap();
        }
    }

    fn r2_pack(f: &Fixture) -> String {
        f.write_pack(
            "docs/superpowers/evidence/triggers/R2/2026-07-16-fixed-ceiling.md",
            &[
                ("gate", "R2:root"),
                ("scope", "subscription_global"),
                ("owner", "josef"),
                ("decided_at", "2026-07-16"),
                ("max_daily_tokens", "1000000"),
                ("timezone_id", "Europe/Berlin"),
                ("settings_version", "3"),
                ("settings_digest", &"d".repeat(64)),
            ],
        )
    }

    #[test]
    fn r2_assembles_the_hybrid_record_fires_on_headroom_and_replays() {
        let f = fixture("record-r2");
        let registry = registry::load().unwrap();
        let tz = chrono_tz::Tz::from_str("Europe/Berlin").unwrap();
        // 200k of a 1M ceiling used: 800k headroom every day, 28 ≥ 21.
        seed_budget(&f.conn, tz, 200_000, None);
        let path = r2_pack(&f);

        let recorded = evaluate_r2(&f.conn, &registry, &f.repo, &path, utc(NOW)).unwrap();
        assert_eq!(recorded.evaluation.result, TriggerResult::Fired);
        assert_eq!(recorded.snapshot_put, Put::Inserted);
        assert_eq!(recorded.evaluation.variant, Variant::Hybrid);
        assert_eq!(recorded.evaluation.input_snapshot_refs.len(), 2);

        // The stored row round-trips through BOTH validators, runtime half
        // included.
        let row = triggers::evaluation(&f.conn, &recorded.evaluation.evaluation_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.variant, "hybrid");
        let reparsed: TriggerEvaluation = serde_json::from_str(&row.record_json).unwrap();
        evaluation::validate(&reparsed, &registry).unwrap();
        let snapshot = triggers::snapshot(&f.conn, &recorded.snapshot_id)
            .unwrap()
            .unwrap();
        evidence::check_on_disk(
            &reparsed,
            &f.repo,
            Some((&recorded.snapshot_id, &snapshot.payload_json)),
            &registry,
        )
        .unwrap();

        // A later ask the same day replays byte-identically.
        let rerun = evaluate_r2(
            &f.conn,
            &registry,
            &f.repo,
            &path,
            utc("2026-08-14T17:30:00Z"),
        )
        .unwrap();
        assert_eq!(rerun.evaluation_put, Put::Replayed);
        assert_eq!(rerun.evaluation, recorded.evaluation);
        f.done();
    }

    #[test]
    fn a_day_that_disagrees_with_the_frozen_ceiling_is_not_ready() {
        // One day whose settings digest moved mid-window: the history was
        // not lived under the pack's frozen ceiling, and the honest answer
        // is that the question cannot be answered — never a quiet not_fired.
        let f = fixture("record-r2-drift");
        let registry = registry::load().unwrap();
        let tz = chrono_tz::Tz::from_str("Europe/Berlin").unwrap();
        seed_budget(&f.conn, tz, 200_000, Some(13));
        let path = r2_pack(&f);

        let recorded = evaluate_r2(&f.conn, &registry, &f.repo, &path, utc(NOW)).unwrap();
        assert_eq!(recorded.evaluation.result, TriggerResult::NotReady);
        f.done();
    }

    #[test]
    fn missing_days_are_not_ready_and_a_busy_month_does_not_fire() {
        let f = fixture("record-r2-floors");
        let registry = registry::load().unwrap();
        let path = r2_pack(&f);
        // No budget_days at all: the sample is absent, not zero.
        let empty = evaluate_r2(&f.conn, &registry, &f.repo, &path, utc(NOW)).unwrap();
        assert_eq!(empty.evaluation.result, TriggerResult::NotReady);
        f.done();

        // Every day busy (950k of 1M used → 50k headroom < 200k ppm floor):
        // a complete window that honestly says no.
        let f = fixture("record-r2-busy");
        let tz = chrono_tz::Tz::from_str("Europe/Berlin").unwrap();
        seed_budget(&f.conn, tz, 950_000, None);
        let path = r2_pack(&f);
        let busy = evaluate_r2(&f.conn, &registry, &f.repo, &path, utc(NOW)).unwrap();
        assert_eq!(busy.evaluation.result, TriggerResult::NotFired);
        f.done();
    }

    #[test]
    fn nothing_here_reads_a_clock() {
        // Recording is dated by its caller; a recorder that read the wall
        // clock would stamp the same pack differently on two machines.
        let source = include_str!("record.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in ["Utc::now", "SystemTime", "Local::now"] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the recorder"
            );
        }
    }
}
