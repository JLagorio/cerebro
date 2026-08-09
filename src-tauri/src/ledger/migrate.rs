//! The deterministic, restart-idempotent OKF migrator (M22.6).
//!
//! Built and PROVEN here; armed only at M23.0 — nothing in production
//! calls this module, so no uncaptured-write window exists. Zero LLM calls,
//! zero file writes: it reads `knowledge/*.md` and appends events.
//!
//! Determinism, spelled out:
//! - every stable id inside a body comes from `migrate_id`/`derive_*`
//!   formulas over the normalized knowledge-relative path — no restart path
//!   ever generates a fresh canonical-body id;
//! - every output goes through `append_once` under a deterministic key, so
//!   after kill -9 the rerun returns existing outputs and appends only the
//!   remainder; a key reused with different canonical content is a hard
//!   refusal, never a silent dedupe;
//! - dependent outputs resolve the PRIOR append-once receipt before
//!   embedding an event id (snapshots pin their registration's receipt,
//!   attestations pin the creation's receipt);
//! - `migration.started` pins the corpus digest; a changed corpus before
//!   completion surfaces as the started-key content conflict —
//!   reconciliation, never a second epoch;
//! - outputs are emitted in two phases so no relation precedes an endpoint
//!   Belief: registrations (source-id order), then per path (sorted)
//!   creation → snapshots → aliases → attestation, then per path (sorted)
//!   relations by canonical tuple.
//!
//! Timestamps: `occurred_at` is a source stamp only when it is honest
//! RFC3339; a date-only `last_modified` yields null, never a fabricated
//! instant. `ingested_at` is core-stamped migration time.

use std::collections::BTreeMap;
use std::path::Path;

use super::project::{parse_okf, project};
use super::schema::{self, Actor, BeliefBasis, SourceRegistration, SubjectRef};
use super::writer::LedgerWriter;

/// The unsupported-basis reason every migrated Belief carries — OKF files
/// record no Observations, and the ledger never pretends otherwise.
pub const MIGRATED_BASIS_REASON: &str = "migrated from OKF markdown without captured observations";

/// Why migration cannot proceed. The two conflict variants are the CLOSED
/// migration reconciliation signals (M23): a changed corpus under the open
/// epoch and a deterministic key holding different canonical content. They
/// refuse into reconciliation — never a second epoch, never a duplicate
/// output. `Failed` is an operational error (IO, parse), not a
/// reconciliation state.
#[derive(Debug, Clone, PartialEq)]
pub enum MigrateError {
    /// The started-key content conflict: the corpus digest changed under an
    /// epoch that opened over different bytes.
    SourceChanged {
        detail: String,
    },
    /// A deterministic per-output (or completed) key is already committed
    /// with different canonical content.
    IdempotencyConflict {
        key: String,
        detail: String,
    },
    Failed(String),
}

impl std::fmt::Display for MigrateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrateError::SourceChanged { detail } => write!(
                f,
                "migration source changed — reconcile, never duplicate: {detail}"
            ),
            MigrateError::IdempotencyConflict { key, detail } => write!(
                f,
                "migration idempotency conflict on {key} — reconcile, never duplicate: {detail}"
            ),
            MigrateError::Failed(detail) => write!(f, "{detail}"),
        }
    }
}

impl MigrateError {
    /// The closed divergence-signal name this refusal will carry when the
    /// M23 circuit breaker records it; None for operational failures.
    pub fn signal(&self) -> Option<&'static str> {
        match self {
            MigrateError::SourceChanged { .. } => Some("migration_source_changed"),
            MigrateError::IdempotencyConflict { .. } => Some("migration_idempotency_conflict"),
            MigrateError::Failed(_) => None,
        }
    }
}

/// True when an `append_once` error is a key-content conflict (the writer's
/// hard-conflict refusal), as opposed to an operational failure.
fn is_key_conflict(detail: &str) -> bool {
    detail.contains("hard conflict") || detail.contains("already names a committed batch operation")
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MigrationOutcome {
    /// Deterministic output keys, in emission order (brackets excluded).
    pub output_keys: Vec<String>,
    /// How many outputs already existed (0 on a first run; all on a rerun).
    pub replayed: usize,
    /// `sources[]` entries without a parseable resource: (path, ordinal).
    pub skipped_sources: Vec<(String, usize)>,
    /// Relation wikilinks that name no migrated concept: (path, target).
    pub unresolved_relations: Vec<(String, String)>,
    pub source_digest: String,
    pub output_keys_digest: String,
}

struct Concept {
    path: String,
    original: String,
    content: String,
    fields: serde_json::Value,
    belief_id: String,
    entity_id: String,
}

/// Migrate every `knowledge/*.md` file into the ledger. Restart-idempotent
/// at every prefix; never modifies any file. A missing knowledge directory
/// is an EMPTY corpus, not an error — a fresh vault closes its epoch over
/// zero outputs and never migrates again.
pub fn migrate_vault(
    writer: &mut LedgerWriter,
    knowledge_dir: &Path,
) -> Result<MigrationOutcome, MigrateError> {
    let fail = |detail: String| MigrateError::Failed(detail);
    let store = writer.store_id().to_string();
    let mut outcome = MigrationOutcome::default();

    // --- Scan and parse the corpus, path-sorted. ---------------------------
    let mut concepts: Vec<Concept> = Vec::new();
    if knowledge_dir.exists() {
        for entry in walkdir::WalkDir::new(knowledge_dir).sort_by_file_name() {
            let entry = entry.map_err(|e| fail(e.to_string()))?;
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|e| e.to_str()) != Some("md")
            {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(knowledge_dir)
                .map_err(|e| fail(e.to_string()))?
                .to_str()
                .ok_or_else(|| fail("non-UTF-8 knowledge path".into()))?
                .replace('\\', "/");
            let original = std::fs::read_to_string(entry.path())
                .map_err(|e| fail(format!("{}: {e}", entry.path().display())))?;
            let (content, fields) =
                parse_okf(&original).map_err(|e| fail(format!("{rel}: {e}")))?;
            concepts.push(Concept {
                belief_id: schema::migrate_id(&store, "belief", &rel),
                entity_id: schema::migrate_id(&store, "entity", &rel),
                path: rel,
                original,
                content,
                fields,
            });
        }
    }
    concepts.sort_by(|a, b| a.path.cmp(&b.path));

    // Corpus digest: SHA-256 over canonical JSON of the path-sorted
    // [{ path, content_hash }] array.
    let corpus: Vec<serde_json::Value> = concepts
        .iter()
        .map(|c| {
            serde_json::json!({
                "path": c.path,
                "content_hash": crate::ledger::sha256_hex(c.original.as_bytes()),
            })
        })
        .collect();
    let source_digest = crate::ledger::sha256_hex(
        serde_json::to_string(&corpus)
            .map_err(|e| fail(e.to_string()))?
            .as_bytes(),
    );
    outcome.source_digest = source_digest.clone();

    // --- Plan: registrations, per-path outputs, relations. -----------------
    // Legacy registrations dedupe on the case-sensitive trimmed resource.
    let mut resources: BTreeMap<String, String> = BTreeMap::new(); // source_id → resource
    for concept in &concepts {
        for entry in source_entries(&concept.fields) {
            if let Some(resource) = parseable_resource(&entry) {
                let registration = legacy_registration(&resource);
                let source_id = schema::derive_source_id(&store, registration.source_key());
                resources.insert(source_id, resource);
            }
        }
    }

    let planned_output_count = planned_outputs(&concepts, &store, &resources).map_err(fail)?;

    // --- The epoch opener. A changed corpus digest under the same key is
    // an append_once content conflict = the reconciliation refusal. --------
    let started_key = format!("migrate-v1:{store}:started");
    let started = schema::MigrationStarted {
        schema: schema::BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: migrator_actor(),
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        store_uuid: store.clone(),
        migration_schema: schema::migration::MIGRATION_SCHEMA,
        source_digest: source_digest.clone(),
        planned_output_count,
    };
    writer
        .append_once(
            &started_key,
            schema::KIND_MIGRATION_STARTED,
            serde_json::to_value(&started).map_err(|e| fail(e.to_string()))?,
        )
        .map_err(|e| {
            if is_key_conflict(&e) {
                // The epoch opened over different corpus bytes: the closed
                // migration_source_changed reconciliation signal.
                MigrateError::SourceChanged { detail: e }
            } else {
                fail(format!("migration epoch opener: {e}"))
            }
        })?;

    // --- Registrations, in source-id order. --------------------------------
    let mut registration_receipts: BTreeMap<String, String> = BTreeMap::new();
    for (source_id, resource) in &resources {
        let registration = legacy_registration(resource);
        let body = schema::SourceRegistered {
            schema: schema::BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: schema::ACTOR_SOURCE_REGISTRY.to_string(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            source_id: source_id.clone(),
            registration,
        };
        let key = format!("source-register-v1:{store}:{source_id}");
        let receipt = append_output(
            writer,
            &mut outcome,
            &key,
            schema::KIND_SOURCE_REGISTERED,
            &body,
        )?;
        registration_receipts.insert(source_id.clone(), receipt);
    }

    // --- Phase one: per path, creation → snapshots → aliases → attestation.
    let mut creation_receipts: BTreeMap<String, String> = BTreeMap::new();
    for concept in &concepts {
        let created = schema::BeliefCreated {
            schema: schema::BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: migrator_actor(),
            occurred_at: rfc3339_or_null(
                concept
                    .fields
                    .get("generated")
                    .and_then(|g| g.get("at"))
                    .and_then(|v| v.as_str()),
            ),
            valid_from: None,
            valid_to: None,
            belief_id: concept.belief_id.clone(),
            subject: SubjectRef::Resolved {
                entity_id: concept.entity_id.clone(),
                aliases: vec![concept.path.clone()],
            },
            content: concept.content.clone(),
            fields: concept.fields.clone(),
            basis: BeliefBasis::Unsupported {
                reason: MIGRATED_BASIS_REASON.to_string(),
            },
        };
        let key = format!("migrate-v1:{store}:{}:belief:0", concept.path);
        let creation = append_output(
            writer,
            &mut outcome,
            &key,
            schema::KIND_BELIEF_CREATED,
            &created,
        )?;
        creation_receipts.insert(concept.path.clone(), creation.clone());

        // One snapshot per parseable sources[] entry, in entry order.
        let mut ordinal = 0usize;
        for (index, entry) in source_entries(&concept.fields).iter().enumerate() {
            let Some(resource) = parseable_resource(entry) else {
                outcome.skipped_sources.push((concept.path.clone(), index));
                continue;
            };
            let registration = legacy_registration(&resource);
            let source_id = schema::derive_source_id(&store, registration.source_key());
            let registration_event = registration_receipts
                .get(&source_id)
                .expect("every parseable resource was registered")
                .clone();
            let snapshot = schema::ObservationRecorded {
                schema: schema::BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: migrator_actor(),
                occurred_at: rfc3339_or_null(entry.get("last_modified").and_then(|v| v.as_str())),
                valid_from: None,
                valid_to: None,
                observation_kind: schema::ObservationKind::SourceSnapshot,
                source_id,
                source_registration_event_id: registration_event,
                subject: SubjectRef::None,
                lineage: vec![],
                provenance: schema::Provenance {
                    source_system: Some("legacy_okf".to_string()),
                    source_location: Some(resource.clone()),
                    source_record_id: entry.get("id").and_then(|v| v.as_str()).map(str::to_string),
                    source_revision: None,
                    source_author: entry
                        .get("author")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    source_workflow_state: None,
                },
                payload: serde_json::to_value(schema::SourceSnapshotPayload {
                    source_artifact_hash: None,
                    raw_pointer: resource.clone(),
                })
                .map_err(|e| fail(e.to_string()))?,
            };
            let key = format!("migrate-v1:{store}:{}:source:{ordinal}", concept.path);
            append_output(
                writer,
                &mut outcome,
                &key,
                schema::KIND_OBSERVATION_RECORDED,
                &snapshot,
            )?;
            ordinal += 1;
        }

        // Explicit aliases (an `aliases:` list of strings), by normalized key.
        for (ordinal, alias) in explicit_aliases(&concept.fields).iter().enumerate() {
            let body = schema::EntityAliasAdded {
                schema: schema::BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: migrator_actor(),
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                entity_id: concept.entity_id.clone(),
                alias: alias.clone(),
                normalized_alias: schema::normalize_alias_v1(alias),
            };
            let key = format!("migrate-v1:{store}:{}:alias:{ordinal}", concept.path);
            append_output(
                writer,
                &mut outcome,
                &key,
                schema::KIND_ENTITY_ALIAS_ADDED,
                &body,
            )?;
        }

        // Verified stamps → attestations pinned to the creation receipt and
        // the projection's content hash.
        let projected = project(&concept.content, &concept.fields);
        let content_hash = schema::belief::attested_content_hash(projected.as_bytes());
        for (ordinal, stamp) in verified_stamps(&concept.fields).iter().enumerate() {
            let body = schema::BeliefAttested {
                schema: schema::BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: migrator_actor(),
                occurred_at: rfc3339_or_null(stamp.get("at").and_then(|v| v.as_str())),
                valid_from: None,
                valid_to: None,
                belief_id: concept.belief_id.clone(),
                attested_belief_revision_event_id: creation.clone(),
                attested_content_hash: content_hash.clone(),
            };
            let key = format!("migrate-v1:{store}:{}:attest:{ordinal}", concept.path);
            append_output(
                writer,
                &mut outcome,
                &key,
                schema::KIND_BELIEF_ATTESTED,
                &body,
            )?;
        }
    }

    // --- Phase two: relations, per path, by canonical tuple. ---------------
    let stems: BTreeMap<String, &Concept> = concepts
        .iter()
        .map(|c| (stem_of(&c.path).to_string(), c))
        .collect();
    for concept in &concepts {
        let mut relations: Vec<(String, String, schema::RelationKind)> = Vec::new();
        for (field, kind) in [
            ("supersedes", schema::RelationKind::Supersedes),
            ("refines", schema::RelationKind::Refines),
            ("contradicts", schema::RelationKind::Contradicts),
        ] {
            for link in wikilinks(concept.fields.get(field)) {
                match stems.get(&link) {
                    Some(target) => {
                        relations.push((concept.belief_id.clone(), target.belief_id.clone(), kind))
                    }
                    None => outcome
                        .unresolved_relations
                        .push((concept.path.clone(), link)),
                }
            }
        }
        relations.sort_by_key(|(from, to, kind)| {
            serde_json::to_string(&serde_json::json!([from, to, kind.as_str()])).unwrap()
        });
        for (ordinal, (from, to, kind)) in relations.iter().enumerate() {
            let body = schema::BeliefRelation {
                schema: schema::BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: migrator_actor(),
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                relation_id: schema::derive_relation_id(from, to, *kind),
                action: schema::RelationAction::Add,
                from: from.clone(),
                to: to.clone(),
                relation: *kind,
            };
            let key = format!("migrate-v1:{store}:{}:relation:{ordinal}", concept.path);
            append_output(
                writer,
                &mut outcome,
                &key,
                schema::KIND_BELIEF_RELATION,
                &body,
            )?;
        }
    }

    // --- The epoch closer. -------------------------------------------------
    if outcome.output_keys.len() as u64 != planned_output_count {
        return Err(fail(format!(
            "planned {planned_output_count} outputs, emitted {} — plan/emission drift",
            outcome.output_keys.len()
        )));
    }
    let mut sorted_keys = outcome.output_keys.clone();
    sorted_keys.sort();
    let output_keys_digest = crate::ledger::sha256_hex(
        serde_json::to_string(&sorted_keys)
            .map_err(|e| fail(e.to_string()))?
            .as_bytes(),
    );
    outcome.output_keys_digest = output_keys_digest.clone();
    let completed = schema::MigrationCompleted {
        schema: schema::BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: migrator_actor(),
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        store_uuid: store.clone(),
        migration_schema: schema::migration::MIGRATION_SCHEMA,
        source_digest,
        output_count: outcome.output_keys.len() as u64,
        output_keys_digest,
    };
    let completed_key = format!("migrate-v1:{store}:completed");
    writer
        .append_once(
            &completed_key,
            schema::KIND_MIGRATION_COMPLETED,
            serde_json::to_value(&completed).map_err(|e| fail(e.to_string()))?,
        )
        .map_err(|e| {
            if is_key_conflict(&e) {
                MigrateError::IdempotencyConflict {
                    key: completed_key.clone(),
                    detail: e,
                }
            } else {
                fail(format!("{completed_key}: {e}"))
            }
        })?;
    // The M23.0 kill matrix's last boundary: died right after the epoch
    // closer fsynced but before any manifest work — the reopen must take
    // the fast completed path and build the missing manifest.
    crate::crash::crash_point("migrate-completed");
    Ok(outcome)
}

/// Count the outputs the key plan will produce — the `planned_output_count`
/// the started bracket pins (brackets excluded).
fn planned_outputs(
    concepts: &[Concept],
    _store: &str,
    resources: &BTreeMap<String, String>,
) -> Result<u64, String> {
    let mut count = resources.len() as u64;
    for concept in concepts {
        count += 1; // creation
        count += source_entries(&concept.fields)
            .iter()
            .filter(|e| parseable_resource(e).is_some())
            .count() as u64;
        count += explicit_aliases(&concept.fields).len() as u64;
        count += verified_stamps(&concept.fields).len() as u64;
    }
    // Relations: only resolvable targets emit events.
    let stems: std::collections::BTreeSet<String> = concepts
        .iter()
        .map(|c| stem_of(&c.path).to_string())
        .collect();
    for concept in concepts {
        for field in ["supersedes", "refines", "contradicts"] {
            count += wikilinks(concept.fields.get(field))
                .into_iter()
                .filter(|link| stems.contains(link))
                .count() as u64;
        }
    }
    Ok(count)
}

fn append_output<T: serde::Serialize>(
    writer: &mut LedgerWriter,
    outcome: &mut MigrationOutcome,
    key: &str,
    kind: &str,
    body: &T,
) -> Result<String, MigrateError> {
    let value = serde_json::to_value(body).map_err(|e| MigrateError::Failed(e.to_string()))?;
    let result = writer.append_once(key, kind, value).map_err(|e| {
        if is_key_conflict(&e) {
            MigrateError::IdempotencyConflict {
                key: key.to_string(),
                detail: e,
            }
        } else {
            MigrateError::Failed(format!("{key}: {e}"))
        }
    })?;
    if result.was_existing() {
        outcome.replayed += 1;
    }
    outcome.output_keys.push(key.to_string());
    // The M22.7 kill matrix: a soak child dies right AFTER the nth output
    // commits, and the rerun must replay the prefix and append the rest.
    crate::crash::crash_point(&format!("migrate-output-{}", outcome.output_keys.len()));
    Ok(result.committed().event_id.clone())
}

fn migrator_actor() -> Actor {
    Actor {
        id: schema::ACTOR_MIGRATOR.to_string(),
    }
}

fn legacy_registration(resource: &str) -> SourceRegistration {
    let mut registration = SourceRegistration::LegacyReference {
        source_key: String::new(),
        resource: resource.to_string(),
        authority_capability: schema::AuthorityCapability::ContentOnly,
        independence_domain_id: None,
    };
    let key = registration
        .derived_source_key()
        .expect("strings serialize");
    if let SourceRegistration::LegacyReference { source_key, .. } = &mut registration {
        *source_key = key;
    }
    registration
}

fn source_entries(fields: &serde_json::Value) -> Vec<serde_json::Value> {
    fields
        .get("sources")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default()
}

/// The case-sensitive trimmed non-empty resource, or None — there is no
/// id/title fallback and no guessed source identity.
fn parseable_resource(entry: &serde_json::Value) -> Option<String> {
    let resource = entry.get("resource")?.as_str()?.trim();
    if resource.is_empty() {
        None
    } else {
        Some(resource.to_string())
    }
}

fn explicit_aliases(fields: &serde_json::Value) -> Vec<String> {
    let mut aliases: Vec<String> = fields
        .get("aliases")
        .and_then(|a| a.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_str())
                .filter(|s| !schema::normalize_alias_v1(s).is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    aliases.sort_by_key(|a| schema::normalize_alias_v1(a));
    aliases
}

fn verified_stamps(fields: &serde_json::Value) -> Vec<serde_json::Value> {
    match fields.get("verified") {
        Some(serde_json::Value::Array(items)) => items.clone(),
        Some(single) if single.is_object() => vec![single.clone()],
        _ => Vec::new(),
    }
}

fn wikilinks(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_str())
                .filter_map(|s| {
                    s.strip_prefix("[[")
                        .and_then(|s| s.strip_suffix("]]"))
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn stem_of(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}

/// A stamp is event time only when it is honest RFC3339; a date-only value
/// yields null, never a fabricated instant.
fn rfc3339_or_null(stamp: Option<&str>) -> Option<String> {
    let stamp = stamp?;
    chrono::DateTime::parse_from_rfc3339(stamp)
        .ok()
        .map(|_| stamp.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::{ledger_dir, read_ledger, reduce::reduce};
    use super::*;
    use crate::vault::testutil;

    pub(crate) const WRITER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";

    /// Copy the repository demo-vault knowledge bundle into a temp vault —
    /// the repository corpus is NEVER migrated in place.
    pub(crate) fn corpus_copy(label: &str) -> std::path::PathBuf {
        let source =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../demo-vault/knowledge");
        let vault = testutil::temp_vault(label);
        let target = vault.join("knowledge");
        for entry in walkdir::WalkDir::new(&source) {
            let entry = entry.unwrap();
            let rel = entry.path().strip_prefix(&source).unwrap();
            let to = target.join(rel);
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(&to).unwrap();
            } else {
                std::fs::create_dir_all(to.parent().unwrap()).unwrap();
                std::fs::copy(entry.path(), &to).unwrap();
            }
        }
        vault
    }

    #[test]
    fn migrating_the_demo_vault_is_deterministic_and_replayable() {
        let vault = corpus_copy("migrate-demo");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let first = migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        assert_eq!(first.replayed, 0);
        assert!(
            first.skipped_sources.is_empty(),
            "{:?}",
            first.skipped_sources
        );
        assert!(
            first.unresolved_relations.is_empty(),
            "{:?}",
            first.unresolved_relations
        );
        let records_after_first = read_ledger(&ledger_dir(&vault)).unwrap().records;
        assert_eq!(
            records_after_first,
            first.output_keys.len() as u64 + 2,
            "outputs plus the two brackets"
        );

        // The rerun returns existing outputs and appends NOTHING.
        let second = migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        assert_eq!(second.replayed, second.output_keys.len());
        assert_eq!(second.output_keys, first.output_keys);
        assert_eq!(second.source_digest, first.source_digest);
        assert_eq!(second.output_keys_digest, first.output_keys_digest);
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, records_after_first, "no duplicate output");

        // ...and a fresh writer (index-loss shape) replays identically too.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let third = migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        assert_eq!(third.replayed, third.output_keys.len());
        drop(writer);
        assert_eq!(
            read_ledger(&ledger_dir(&vault)).unwrap().records,
            records_after_first
        );
    }

    #[test]
    fn migrated_state_reduces_and_projects_byte_identically() {
        let vault = corpus_copy("migrate-project");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);
        assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
        assert_eq!(state.beliefs.len(), 10, "the whole golden corpus migrated");

        let mut verified_beliefs = 0;
        for entry in walkdir::WalkDir::new(vault.join("knowledge")) {
            let entry = entry.unwrap();
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|e| e.to_str()) != Some("md")
            {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(vault.join("knowledge"))
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            let belief_id = schema::migrate_id(&store, "belief", &rel);
            let belief = state
                .beliefs
                .get(&belief_id)
                .unwrap_or_else(|| panic!("{rel}"));
            let revision = belief.current();
            let original = std::fs::read_to_string(entry.path()).unwrap();
            assert_eq!(
                project(&revision.content, &revision.fields),
                original,
                "{rel}: projection must be byte-identical"
            );
            // Verified stamps became attestations pinned to the creation.
            if revision.fields.get("verified").is_some() {
                let (_, pinned_revision) = belief
                    .attested
                    .as_ref()
                    .unwrap_or_else(|| panic!("{rel}: attested"));
                assert_eq!(pinned_revision, &belief.created_event_id);
                verified_beliefs += 1;
            } else {
                assert!(belief.attested.is_none(), "{rel}");
            }
        }
        assert_eq!(
            verified_beliefs, 4,
            "four corpus concepts carry verified stamps"
        );

        // The one corpus relation: offline-guarantee supersedes the pilot.
        assert_eq!(state.relations.len(), 1);
        let relation = state.relations.values().next().unwrap();
        assert_eq!(
            relation.from,
            schema::migrate_id(&store, "belief", "systems/offline-guarantee.md")
        );
        assert_eq!(
            relation.to,
            schema::migrate_id(&store, "belief", "systems/offline-window-pilot.md")
        );
        assert!(relation.live);

        // Legacy registrations exist, deduplicated per trimmed resource,
        // and every snapshot pins one.
        assert!(!state.sources.is_empty());
        for source in state.sources.values() {
            assert_eq!(source.registration.kind_str(), "legacy_reference");
        }
        // The two-entry sync-error concept shares the project resource with
        // the pilot concept — dedupe means fewer sources than snapshots.
        let snapshots = state
            .observations
            .values()
            .filter(|o| o.kind == schema::ObservationKind::SourceSnapshot)
            .count();
        assert!(
            snapshots > state.sources.len(),
            "{snapshots} snapshots share sources"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn honest_timestamps_only_a_date_never_becomes_an_instant() {
        let vault = corpus_copy("migrate-stamps");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let mut creation_stamps = 0;
        for frame in &read.frames {
            let occurred = frame.body.get("occurred_at").and_then(|v| v.as_str());
            match frame.kind.as_str() {
                // Snapshots carry only date-only last_modified stamps in the
                // corpus: every occurred_at must be null, never fabricated.
                k if k == schema::KIND_OBSERVATION_RECORDED => {
                    assert_eq!(occurred, None, "date-only stamps stay null");
                }
                k if k == schema::KIND_BELIEF_CREATED && occurred.is_some() => {
                    creation_stamps += 1;
                }
                _ => {}
            }
        }
        assert!(
            creation_stamps >= 7,
            "generated.at is honest RFC3339 on the concepts ({creation_stamps})"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_changed_corpus_under_the_same_epoch_is_a_reconciliation_error() {
        let vault = corpus_copy("migrate-reconcile");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        // The corpus changes; the epoch identity no longer matches.
        let target = vault.join("knowledge/systems/status-model.md");
        let mut text = std::fs::read_to_string(&target).unwrap();
        text.push_str("\nEdited after migration.\n");
        std::fs::write(&target, text).unwrap();
        let err = migrate_vault(&mut writer, &vault.join("knowledge")).unwrap_err();
        assert!(
            matches!(err, MigrateError::SourceChanged { .. }),
            "the typed migration_source_changed signal, got {err:?}"
        );
        assert_eq!(err.signal(), Some("migration_source_changed"));
        assert!(err.to_string().contains("reconcile"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn unparseable_sources_and_unresolved_links_are_skipped_never_guessed() {
        let vault = testutil::temp_vault("migrate-skips");
        let dir = vault.join("knowledge");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("odd.md"),
            // Written in CANONICAL spelling (two-key source entries are
            // flow-style; plain aliases stay unquoted) so the round trip
            // is byte-exact.
            concat!(
                "---\n",
                "type: Reference\n",
                "title: Odd concept\n",
                "supersedes:\n",
                "  - \"[[nowhere-to-be-found]]\"\n",
                "aliases: [Odd One, the odd concept]\n",
                "sources:\n",
                "  - { id: no-resource, title: An entry the parser cannot treat as a source }\n",
                "  - { id: real, resource: /records/real.md }\n",
                "---\n",
                "\n# Odd\n\nBody.\n"
            ),
        )
        .unwrap();
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        let outcome = migrate_vault(&mut writer, &dir).unwrap();
        assert_eq!(outcome.skipped_sources, vec![("odd.md".to_string(), 0)]);
        assert_eq!(
            outcome.unresolved_relations,
            vec![("odd.md".to_string(), "nowhere-to-be-found".to_string())]
        );
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let state = reduce(&read.frames, &store);
        assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
        assert_eq!(
            state.sources.len(),
            1,
            "one registration for the one real resource"
        );
        assert!(state.relations.is_empty(), "no guessed relation targets");
        assert_eq!(state.alias_registry.len(), 2, "explicit aliases registered");
        // The belief still projects the ORIGINAL bytes, unparseable entry
        // and unresolved link included.
        let belief = state
            .beliefs
            .get(&schema::migrate_id(&store, "belief", "odd.md"))
            .unwrap();
        let original = std::fs::read_to_string(dir.join("odd.md")).unwrap();
        assert_eq!(
            project(&belief.current().content, &belief.current().fields),
            original
        );
        let _ = std::fs::remove_dir_all(&vault);
    }
}
