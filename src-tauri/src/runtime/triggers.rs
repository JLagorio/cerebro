//! Where trigger snapshots and evaluations are written (M28.0).
//!
//! **The two governance tables are the WHOLE write surface of the trigger
//! registry.** An evaluator that could touch anything else — a ledger, a
//! vault file, a flag, a scheduler row — would be a promotion path wearing a
//! measurement's name. This module exposes exactly four operations: record a
//! snapshot, read it back, record an evaluation, read it back.
//!
//! **Immutability is refusal, not absence of an UPDATE.** A snapshot id is
//! the domain-separated hash of its canonical payload and an evaluation id is
//! a function of gate, scope, rule version, and snapshot hash — so a rerun
//! over the same inputs lands on the same id, and the writer answers
//! `Replayed` with the row unchanged. The same id arriving with DIFFERENT
//! bytes is refused out loud: it means a hash rule moved without its version
//! moving, and overwriting would make every derived evaluation
//! unreproducible, which is the one property these tables exist to provide.
//!
//! Rows are stored and read as STRINGS, the `runtime::taint` posture: a row
//! written by a later build survives being read by an older one, and the
//! closed vocabularies are enforced by the schema's CHECKs plus the typed
//! layer in `trigger::evaluation`, not by this store.

use rusqlite::{params, Connection, OptionalExtension};

/// The scope a stored row carries — columns, not prose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoredScope {
    /// R1/R2: the whole subscription, deliberately unscoped to any vault.
    SubscriptionGlobal,
    /// R3–R14: one vault store.
    VaultStore {
        vault_id: String,
        store_uuid: String,
    },
}

impl StoredScope {
    fn columns(&self) -> (&'static str, Option<&str>, Option<&str>) {
        match self {
            StoredScope::SubscriptionGlobal => ("subscription_global", None, None),
            StoredScope::VaultStore {
                vault_id,
                store_uuid,
            } => ("vault_store", Some(vault_id), Some(store_uuid)),
        }
    }

    fn from_columns(
        kind: &str,
        vault_id: Option<String>,
        store_uuid: Option<String>,
    ) -> Result<StoredScope, String> {
        match (kind, vault_id, store_uuid) {
            ("subscription_global", None, None) => Ok(StoredScope::SubscriptionGlobal),
            ("vault_store", Some(vault_id), Some(store_uuid)) => Ok(StoredScope::VaultStore {
                vault_id,
                store_uuid,
            }),
            (kind, vault_id, store_uuid) => Err(format!(
                "scope columns disagree: kind {kind:?}, vault {vault_id:?}, store {store_uuid:?}"
            )),
        }
    }
}

/// One immutable input snapshot: the canonical source rows an evaluation is
/// reproducible from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRow {
    pub snapshot_id: String,
    pub registry_id: String,
    pub subkey: String,
    pub scope: StoredScope,
    pub rule_version: String,
    pub payload_json: String,
    pub collected_at: String,
}

/// One recorded evaluation — the design's closed union flattened, with the
/// variant deciding which halves are present (and the schema's CHECKs
/// agreeing).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluationRow {
    pub evaluation_id: String,
    pub registry_id: String,
    pub subkey: String,
    pub variant: String,
    pub scope: StoredScope,
    pub evaluated_at: String,
    pub window: Option<Window>,
    pub input_snapshot_refs_json: String,
    pub input_snapshot_hash: String,
    pub metrics_json: Option<String>,
    pub evidence_pack_path: Option<String>,
    pub result: String,
    pub rule_version: String,
    pub approving_owner: Option<String>,
    pub parent_evaluation_id: Option<String>,
    pub record_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub start: String,
    pub end: String,
    pub timezone: String,
}

/// What a put did. `Replayed` is the idempotent success: the row was already
/// there, byte for byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Put {
    Inserted,
    Replayed,
}

/// Record a snapshot, or replay it. The same id with different bytes is
/// refused — see the module doc for why that is the whole point.
pub fn put_snapshot(conn: &Connection, row: &SnapshotRow) -> Result<Put, String> {
    if let Some(existing) = snapshot(conn, &row.snapshot_id)? {
        if existing == *row {
            return Ok(Put::Replayed);
        }
        return Err(format!(
            "snapshot {} already exists with different content — a snapshot id is a hash of its \
             payload, so this means a hash rule moved without its version moving",
            row.snapshot_id
        ));
    }
    let (scope_kind, vault_id, store_uuid) = row.scope.columns();
    conn.execute(
        "INSERT INTO trigger_input_snapshots \
         (snapshot_id, registry_id, subkey, scope_kind, vault_id, store_uuid, rule_version, \
          payload_json, collected_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            row.snapshot_id,
            row.registry_id,
            row.subkey,
            scope_kind,
            vault_id,
            store_uuid,
            row.rule_version,
            row.payload_json,
            row.collected_at,
        ],
    )
    .map_err(|e| format!("recording snapshot {}: {e}", row.snapshot_id))?;
    Ok(Put::Inserted)
}

/// Read one snapshot back.
pub fn snapshot(conn: &Connection, snapshot_id: &str) -> Result<Option<SnapshotRow>, String> {
    conn.query_row(
        "SELECT registry_id, subkey, scope_kind, vault_id, store_uuid, rule_version, \
                payload_json, collected_at \
         FROM trigger_input_snapshots WHERE snapshot_id = ?1",
        params![snapshot_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        },
    )
    .optional()
    .map_err(|e| format!("reading snapshot {snapshot_id}: {e}"))?
    .map(
        |(registry_id, subkey, scope_kind, vault_id, store_uuid, rule_version, payload, at)| {
            Ok(SnapshotRow {
                snapshot_id: snapshot_id.to_string(),
                registry_id,
                subkey,
                scope: StoredScope::from_columns(&scope_kind, vault_id, store_uuid)?,
                rule_version,
                payload_json: payload,
                collected_at: at,
            })
        },
    )
    .transpose()
}

/// Record an evaluation, or replay it. Identical logic to snapshots: reruns
/// are the design's stated contract, silent overwrites are its stated enemy.
pub fn put_evaluation(conn: &Connection, row: &EvaluationRow) -> Result<Put, String> {
    if let Some(existing) = evaluation(conn, &row.evaluation_id)? {
        if existing == *row {
            return Ok(Put::Replayed);
        }
        return Err(format!(
            "evaluation {} already exists with different content — the id is a function of gate, \
             scope, rule version, and snapshot hash, so this means an evaluation stopped being a \
             function of its inputs",
            row.evaluation_id
        ));
    }
    let (scope_kind, vault_id, store_uuid) = row.scope.columns();
    conn.execute(
        "INSERT INTO trigger_evaluations \
         (evaluation_id, registry_id, subkey, variant, scope_kind, vault_id, store_uuid, \
          evaluated_at, window_start, window_end, window_timezone, input_snapshot_refs_json, \
          input_snapshot_hash, metrics_json, evidence_pack_path, result, rule_version, \
          approving_owner, parent_evaluation_id, record_json) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, \
                 ?18, ?19, ?20)",
        params![
            row.evaluation_id,
            row.registry_id,
            row.subkey,
            row.variant,
            scope_kind,
            vault_id,
            store_uuid,
            row.evaluated_at,
            row.window.as_ref().map(|w| w.start.as_str()),
            row.window.as_ref().map(|w| w.end.as_str()),
            row.window.as_ref().map(|w| w.timezone.as_str()),
            row.input_snapshot_refs_json,
            row.input_snapshot_hash,
            row.metrics_json,
            row.evidence_pack_path,
            row.result,
            row.rule_version,
            row.approving_owner,
            row.parent_evaluation_id,
            row.record_json,
        ],
    )
    .map_err(|e| format!("recording evaluation {}: {e}", row.evaluation_id))?;
    Ok(Put::Inserted)
}

/// Read one evaluation back.
pub fn evaluation(conn: &Connection, evaluation_id: &str) -> Result<Option<EvaluationRow>, String> {
    conn.query_row(
        "SELECT registry_id, subkey, variant, scope_kind, vault_id, store_uuid, evaluated_at, \
                window_start, window_end, window_timezone, input_snapshot_refs_json, \
                input_snapshot_hash, metrics_json, evidence_pack_path, result, rule_version, \
                approving_owner, parent_evaluation_id, record_json \
         FROM trigger_evaluations WHERE evaluation_id = ?1",
        params![evaluation_id],
        |r| {
            Ok((
                (
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                ),
                (
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, String>(10)?,
                    r.get::<_, String>(11)?,
                    r.get::<_, Option<String>>(12)?,
                    r.get::<_, Option<String>>(13)?,
                ),
                (
                    r.get::<_, String>(14)?,
                    r.get::<_, String>(15)?,
                    r.get::<_, Option<String>>(16)?,
                    r.get::<_, Option<String>>(17)?,
                    r.get::<_, String>(18)?,
                ),
            ))
        },
    )
    .optional()
    .map_err(|e| format!("reading evaluation {evaluation_id}: {e}"))?
    .map(|(head, mid, tail)| {
        let (registry_id, subkey, variant, scope_kind, vault_id, store_uuid, evaluated_at) = head;
        let (window_start, window_end, window_timezone, refs, hash, metrics, evidence) = mid;
        let (result, rule_version, owner, parent, record_json) = tail;
        let window = match (window_start, window_end, window_timezone) {
            (None, None, None) => None,
            (Some(start), Some(end), Some(timezone)) => Some(Window {
                start,
                end,
                timezone,
            }),
            other => {
                return Err(format!(
                    "evaluation {evaluation_id} has a half-present window: {other:?}"
                ))
            }
        };
        Ok(EvaluationRow {
            evaluation_id: evaluation_id.to_string(),
            registry_id,
            subkey,
            variant,
            scope: StoredScope::from_columns(&scope_kind, vault_id, store_uuid)?,
            evaluated_at,
            window,
            input_snapshot_refs_json: refs,
            input_snapshot_hash: hash,
            metrics_json: metrics,
            evidence_pack_path: evidence,
            result,
            rule_version,
            approving_owner: owner,
            parent_evaluation_id: parent,
            record_json,
        })
    })
    .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const NOW: &str = "2026-08-14T09:00:00.000Z";

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    fn snapshot_row(vault: &str) -> SnapshotRow {
        SnapshotRow {
            snapshot_id: HASH_A.to_string(),
            registry_id: "R13".to_string(),
            subkey: "root".to_string(),
            scope: StoredScope::VaultStore {
                vault_id: vault.to_string(),
                store_uuid: "feedfacefeedfacefeedfacefeedface".to_string(),
            },
            rule_version: "trigger-registry-v1".to_string(),
            payload_json: r#"{"plans":[]}"#.to_string(),
            collected_at: NOW.to_string(),
        }
    }

    fn measurable_row(vault: &str) -> EvaluationRow {
        EvaluationRow {
            evaluation_id: HASH_B.to_string(),
            registry_id: "R13".to_string(),
            subkey: "root".to_string(),
            variant: "measurable".to_string(),
            scope: StoredScope::VaultStore {
                vault_id: vault.to_string(),
                store_uuid: "feedfacefeedfacefeedfacefeedface".to_string(),
            },
            evaluated_at: NOW.to_string(),
            window: Some(Window {
                start: "2026-07-15T00:00:00+02:00".to_string(),
                end: "2026-08-14T00:00:00+02:00".to_string(),
                timezone: "Europe/Berlin".to_string(),
            }),
            input_snapshot_refs_json: format!(r#"[{{"runtime":{{"snapshot_id":"{HASH_A}"}}}}]"#),
            input_snapshot_hash: HASH_A.to_string(),
            metrics_json: Some(r#"[{"count":{"name":"emitted_plans","value":0}}]"#.to_string()),
            evidence_pack_path: None,
            result: "not_ready".to_string(),
            rule_version: "trigger-registry-v1".to_string(),
            approving_owner: None,
            parent_evaluation_id: None,
            record_json: r#"{"canonical":true}"#.to_string(),
        }
    }

    #[test]
    fn the_runtime_db_lands_at_version_eleven() {
        let (dir, conn, _) = fixture("triggers-version");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 11);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_snapshot_replays_identically_and_refuses_to_be_amended() {
        let (dir, conn, vault) = fixture("triggers-snapshot");
        let row = snapshot_row(&vault);
        assert_eq!(put_snapshot(&conn, &row), Ok(Put::Inserted));
        assert_eq!(put_snapshot(&conn, &row), Ok(Put::Replayed));
        assert_eq!(snapshot(&conn, HASH_A).unwrap().unwrap(), row);

        let mut amended = row.clone();
        amended.payload_json = r#"{"plans":["p1"]}"#.to_string();
        let err = put_snapshot(&conn, &amended).unwrap_err();
        assert!(err.contains("different content"), "{err}");
        // The original is intact — refusal, never overwrite.
        assert_eq!(snapshot(&conn, HASH_A).unwrap().unwrap(), row);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_evaluation_replays_identically_and_refuses_to_be_amended() {
        let (dir, conn, vault) = fixture("triggers-evaluation");
        let row = measurable_row(&vault);
        assert_eq!(put_evaluation(&conn, &row), Ok(Put::Inserted));
        assert_eq!(put_evaluation(&conn, &row), Ok(Put::Replayed));
        assert_eq!(evaluation(&conn, HASH_B).unwrap().unwrap(), row);

        let mut amended = row.clone();
        amended.result = "fired".to_string();
        let err = put_evaluation(&conn, &amended).unwrap_err();
        assert!(err.contains("different content"), "{err}");
        assert_eq!(evaluation(&conn, HASH_B).unwrap().unwrap(), row);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_subscription_global_row_carries_no_vault_and_reads_back() {
        let (dir, conn, _) = fixture("triggers-global");
        let mut row = measurable_row("unused");
        row.registry_id = "R2".to_string();
        row.variant = "hybrid".to_string();
        row.scope = StoredScope::SubscriptionGlobal;
        row.evidence_pack_path =
            Some("docs/superpowers/evidence/triggers/R2/2026-08-14-pack.md".to_string());
        row.approving_owner = Some("josef".to_string());
        assert_eq!(put_evaluation(&conn, &row), Ok(Put::Inserted));
        assert_eq!(evaluation(&conn, HASH_B).unwrap().unwrap(), row);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The union arms as DDL, proven by raw INSERTs the store never builds —
    /// the M26.5d pattern. Every row here is a shape a looser build might
    /// produce, and the SCHEMA refuses it with no Rust in the loop.
    #[test]
    fn the_ddl_itself_refuses_every_mixed_variant_shape() {
        let (dir, conn, vault) = fixture("triggers-ddl");
        let insert = |columns: &str| -> Result<usize, rusqlite::Error> {
            conn.execute(
                &format!(
                    "INSERT INTO trigger_evaluations \
                     (evaluation_id, registry_id, subkey, variant, scope_kind, vault_id, \
                      store_uuid, evaluated_at, window_start, window_end, window_timezone, \
                      input_snapshot_refs_json, input_snapshot_hash, metrics_json, \
                      evidence_pack_path, result, rule_version, approving_owner, \
                      parent_evaluation_id, record_json) VALUES ({columns})"
                ),
                [],
            )
        };
        let cases: [(&str, String); 7] = [
            (
                "a measurable record carrying an evidence pack",
                format!(
                    "'{HASH_B}', 'R13', 'root', 'measurable', 'vault_store', '{vault}', 's', \
                     '{NOW}', '{NOW}', '{NOW}', 'UTC', '[]x', '{HASH_A}', '[]m', 'pack.md', \
                     'not_fired', 'v1', NULL, NULL, 'r'"
                ),
            ),
            (
                "a measurable record with an approving owner",
                format!(
                    "'{HASH_B}', 'R13', 'root', 'measurable', 'vault_store', '{vault}', 's', \
                     '{NOW}', '{NOW}', '{NOW}', 'UTC', '[]x', '{HASH_A}', '[]m', NULL, \
                     'not_fired', 'v1', 'josef', NULL, 'r'"
                ),
            ),
            (
                "a discretionary record carrying a window",
                format!(
                    "'{HASH_B}', 'R8', 'root', 'discretionary', 'vault_store', '{vault}', 's', \
                     '{NOW}', '{NOW}', '{NOW}', 'UTC', '[]x', '{HASH_A}', NULL, 'pack.md', \
                     'not_fired', 'v1', 'josef', NULL, 'r'"
                ),
            ),
            (
                "a discretionary record carrying metrics",
                format!(
                    "'{HASH_B}', 'R8', 'root', 'discretionary', 'vault_store', '{vault}', 's', \
                     '{NOW}', NULL, NULL, NULL, '[]x', '{HASH_A}', '[]m', 'pack.md', \
                     'not_fired', 'v1', 'josef', NULL, 'r'"
                ),
            ),
            (
                "a vault_store record with no vault",
                format!(
                    "'{HASH_B}', 'R13', 'root', 'measurable', 'vault_store', NULL, NULL, \
                     '{NOW}', '{NOW}', '{NOW}', 'UTC', '[]x', '{HASH_A}', '[]m', NULL, \
                     'not_fired', 'v1', NULL, NULL, 'r'"
                ),
            ),
            (
                "a subscription_global record naming a store",
                format!(
                    "'{HASH_B}', 'R2', 'root', 'hybrid', 'subscription_global', NULL, 's', \
                     '{NOW}', '{NOW}', '{NOW}', 'UTC', '[]x', '{HASH_A}', '[]m', 'pack.md', \
                     'not_fired', 'v1', 'josef', NULL, 'r'"
                ),
            ),
            (
                "a result outside the closed three",
                format!(
                    "'{HASH_B}', 'R13', 'root', 'measurable', 'vault_store', '{vault}', 's', \
                     '{NOW}', '{NOW}', '{NOW}', 'UTC', '[]x', '{HASH_A}', '[]m', NULL, \
                     'maybe', 'v1', NULL, NULL, 'r'"
                ),
            ),
        ];
        for (what, columns) in &cases {
            let err = insert(columns).unwrap_err().to_string();
            assert!(err.contains("CHECK constraint failed"), "{what}: {err}");
        }
        // A parent naming itself is the one self-reference the table forbids.
        let err = insert(&format!(
            "'{HASH_B}', 'R5', 'discovery', 'measurable', 'vault_store', '{vault}', 's', \
             '{NOW}', '{NOW}', '{NOW}', 'UTC', '[]x', '{HASH_A}', '[]m', NULL, 'fired', 'v1', \
             NULL, '{HASH_B}', 'r'"
        ))
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("CHECK constraint failed"),
            "self-parent: {err}"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_parent_must_already_be_recorded() {
        // The FK is the design answer: an alias or a tail cannot reference an
        // evaluation nobody recorded.
        let (dir, conn, vault) = fixture("triggers-parent");
        let mut row = measurable_row(&vault);
        row.parent_evaluation_id = Some(HASH_A.to_string());
        let err = put_evaluation(&conn, &row).unwrap_err();
        assert!(err.contains("FOREIGN KEY constraint failed"), "{err}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
