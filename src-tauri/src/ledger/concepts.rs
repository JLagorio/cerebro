//! The `write_concept` compatibility adapter (M23.3): the flip from
//! file-first to ledger-first for the knowledge bundle.
//!
//! With an active ledger writer, a concept write is a committed Belief
//! transition — `belief.created` or `belief.revised` plus exact
//! relation/alias events, batched when the transition has more than one
//! event — and the file on disk is the byte-stable PROJECTION of reducer
//! state, written through the M23.2 manifest-first protocol. Reduce,
//! project, write, then acknowledge.
//!
//! This is a HARD-CODED low-risk auto-apply adapter, deliberately not a
//! policy engine: the M24 declarative table replaces it. The MCP tool
//! surface (validation, response prose) is unchanged — mcp.rs still calls
//! the same `vault::write` entry points.
//!
//! Rules carried from M22/M23:
//! - a new Belief's ids are the SAME deterministic `migrate_id` formulas
//!   migration uses, so a concept at a path has one identity forever;
//! - every revision declares an explicit basis — the prior basis carried
//!   forward (this adapter captures no observations; `unsupported` at
//!   creation);
//! - alias ADDITIONS emit `entity.alias_added`; alias REMOVAL has no v1
//!   event and returns the typed `unsupported_alias_removal` refusal —
//!   never hidden in a Belief patch. A rewrite that simply omits the
//!   `aliases` key carries the registered aliases forward instead (the
//!   agent tool cannot even express them);
//! - relation wikilinks resolve against projection paths exactly as
//!   migration resolved them; unresolvable targets stay in fields with no
//!   event, never guessed.

use std::collections::BTreeSet;
use std::path::Path;

use super::manifest;
use super::migrate::{stem_of, wikilinks};
use super::reduce::{project_belief, reduce, typed_from_value, EpistemicState, ProjectionResult};
use super::schema::{self, Actor, BeliefBasis, PatchOp, RelationAction, RelationKind, SubjectRef};
use super::writer::LedgerWriter;
use super::{ledger_dir, read_ledger, shadow};

/// The explicit basis a fresh agent-written concept declares.
pub const AGENT_BASIS_REASON: &str = "agent write without captured observations";

/// The typed alias-removal refusal (spec: `unsupported_alias_removal`).
pub const UNSUPPORTED_ALIAS_REMOVAL: &str =
    "unsupported_alias_removal: alias removal has no v1 event — keep the alias or wait for the \
     maintenance channel";

/// Ledger-first `write_concept`. `None` when no ledger writer is active
/// for the vault (the caller keeps its legacy file-first path).
pub fn write_concept(
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Option<Result<(), String>> {
    if !rel.starts_with("knowledge/") {
        return None; // only the flipped subtree runs ledger-first
    }
    shadow::with_writer(vault, |writer| {
        write_concept_with(writer, vault, rel, frontmatter, body)
    })
}

/// Ledger-first knowledge-log append. `None` without an active writer.
pub fn append_log(
    vault: &Path,
    concept_rel: &str,
    title: &str,
    existed: bool,
) -> Option<Result<(), String>> {
    shadow::with_writer(vault, |writer| {
        append_log_with(writer, vault, concept_rel, title, existed)
    })
}

/// Ledger-first `verify_concept` (M23.4): the human stamp lands in fields
/// through a normal `belief.revised`, then `belief.attested` pins the
/// reviewed — now current — revision event and its projection hash, and
/// the projection regenerates. `None` without an active writer.
pub fn verify_concept(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Option<Result<(), String>> {
    if !rel.starts_with("knowledge/") {
        return None;
    }
    shadow::with_writer(vault, |writer| verify_with(writer, vault, rel, patch))
}

/// Honest event time only: a date-only stamp yields None, never a
/// fabricated instant (the migration convention).
fn rfc3339_or_null(stamp: Option<&str>) -> Option<String> {
    let stamp = stamp?;
    chrono::DateTime::parse_from_rfc3339(stamp)
        .ok()
        .map(|_| stamp.to_string())
}

fn verify_with(
    writer: &mut LedgerWriter,
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let krel = rel
        .strip_prefix("knowledge/")
        .ok_or("verify_concept only applies to knowledge/ concepts")?;
    let stamp = patch
        .get("verified")
        .cloned()
        .ok_or("verify_concept requires a `verified` value")?;
    let actor = Actor {
        id: stamp
            .get("by")
            .and_then(|v| v.as_str())
            .unwrap_or("human")
            .to_string(),
    };
    let occurred_at = rfc3339_or_null(stamp.get("at").and_then(|v| v.as_str()));

    let state = current_state(writer, vault)?;
    let belief_id = state
        .projection_paths
        .get(krel)
        .ok_or_else(|| format!("{rel} is not a committed projection — nothing to verify"))?
        .clone();
    let belief = state.beliefs.get(&belief_id).expect("path index");
    let current = belief.current();

    // 1. The stamp is DATA: a normal field revision, byte-compatible with
    //    the legacy patch (an existing key keeps its position, a new one
    //    appends). The basis carries forward — review is never evidence.
    let before = current
        .fields
        .as_object()
        .and_then(|m| m.get("verified"))
        .map(typed_from_value)
        .unwrap_or(schema::TypedValue::Missing);
    let after = typed_from_value(&stamp);
    let revising = before != after;
    if revising {
        let revised = schema::BeliefRevised {
            schema: schema::BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: actor.clone(),
            occurred_at: occurred_at.clone(),
            valid_from: None,
            valid_to: None,
            belief_id: belief_id.clone(),
            patch: vec![PatchOp {
                field_path: "/fields/verified".to_string(),
                before,
                after,
            }],
            basis: current.basis.clone(),
        };
        writer.append(
            schema::KIND_BELIEF_REVISED,
            serde_json::to_value(&revised).map_err(|e| e.to_string())?,
        )?;
    }

    // 2. Attest the reviewed, now-current revision: the event ID / content
    //    hash PAIR, never basis or lineage.
    let state = current_state(writer, vault)?;
    let belief = state.beliefs.get(&belief_id).expect("still present");
    let current = belief.current();
    let already_pinned = belief
        .attested
        .as_ref()
        .is_some_and(|(_, pinned)| pinned == &current.event_id);
    if revising || !already_pinned {
        let projected = super::project::project(&current.content, &current.fields);
        let attested = schema::BeliefAttested {
            schema: schema::BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at,
            valid_from: None,
            valid_to: None,
            belief_id: belief_id.clone(),
            attested_belief_revision_event_id: current.event_id.clone(),
            attested_content_hash: schema::belief::attested_content_hash(projected.as_bytes()),
        };
        writer.append(
            schema::KIND_BELIEF_ATTESTED,
            serde_json::to_value(&attested).map_err(|e| e.to_string())?,
        )?;
    }
    crate::crash::crash_point("verify-committed");

    // 3. Regenerate through the manifest-first protocol.
    let state = current_state(writer, vault)?;
    let projection = project_belief(&state, &belief_id)?;
    write_projection(vault, rel, &projection)
}

fn current_state(writer: &LedgerWriter, vault: &Path) -> Result<EpistemicState, String> {
    let read = read_ledger(&ledger_dir(vault)).map_err(|e| e.to_string())?;
    Ok(reduce(&read.frames, writer.store_id()))
}

/// RFC 6901 token escape for a frontmatter key.
fn pointer(key: &str) -> String {
    format!("/fields/{}", key.replace('~', "~0").replace('/', "~1"))
}

/// The content convention: exact bytes after the closing frontmatter
/// delimiter (leading blank line included) — or the whole file when no
/// frontmatter renders.
fn concept_content(fields_empty: bool, body: &str) -> String {
    let body = body.trim_end();
    if fields_empty {
        format!("{body}\n")
    } else {
        format!("\n{body}\n")
    }
}

/// The actor a concept write commits under: the server-stamped
/// `generated.by` (mcp.rs stamps it; nothing an agent separately claims).
fn write_actor(fields: &serde_json::Map<String, serde_json::Value>) -> Actor {
    Actor {
        id: fields
            .get("generated")
            .and_then(|g| g.get("by"))
            .and_then(|by| by.as_str())
            .unwrap_or("agent:cerebro")
            .to_string(),
    }
}

fn common_body(actor: Actor) -> (u64, Option<String>, Option<String>, Actor) {
    (schema::BODY_SCHEMA, None, None, actor)
}

/// The intended live relation tuples a concept's frontmatter declares,
/// resolved exactly as migration resolves them; unresolvable links are
/// skipped, never guessed.
fn intended_relations(
    state: &EpistemicState,
    from_belief: &str,
    fields: &serde_json::Map<String, serde_json::Value>,
) -> Vec<(String, RelationKind)> {
    let stems: std::collections::BTreeMap<String, String> = state
        .projection_paths
        .iter()
        .map(|(path, belief)| (stem_of(path).to_string(), belief.clone()))
        .collect();
    let mut out = Vec::new();
    for (field, kind) in [
        ("supersedes", RelationKind::Supersedes),
        ("refines", RelationKind::Refines),
        ("contradicts", RelationKind::Contradicts),
    ] {
        for link in wikilinks(fields.get(field)) {
            if let Some(target) = stems.get(&link) {
                if target != from_belief {
                    out.push((target.clone(), kind));
                }
            }
        }
    }
    out
}

fn relation_event(
    actor: &Actor,
    from: &str,
    to: &str,
    kind: RelationKind,
    action: RelationAction,
) -> (String, serde_json::Value) {
    let (schema_v, batch_id, idempotency_key, actor) = common_body(actor.clone());
    let body = schema::BeliefRelation {
        schema: schema_v,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        relation_id: schema::derive_relation_id(from, to, kind),
        action,
        from: from.to_string(),
        to: to.to_string(),
        relation: kind,
    };
    (
        schema::KIND_BELIEF_RELATION.to_string(),
        serde_json::to_value(&body).expect("relation bodies serialize"),
    )
}

fn alias_event(actor: &Actor, entity_id: &str, alias: &str) -> (String, serde_json::Value) {
    let (schema_v, batch_id, idempotency_key, actor) = common_body(actor.clone());
    let body = schema::EntityAliasAdded {
        schema: schema_v,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        entity_id: entity_id.to_string(),
        alias: alias.to_string(),
        normalized_alias: schema::normalize_alias_v1(alias),
    };
    (
        schema::KIND_ENTITY_ALIAS_ADDED.to_string(),
        serde_json::to_value(&body).expect("alias bodies serialize"),
    )
}

/// String items of an `aliases:` field value.
fn alias_list(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn write_concept_with(
    writer: &mut LedgerWriter,
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<(), String> {
    let krel = rel
        .strip_prefix("knowledge/")
        .ok_or("the adapter writes only knowledge/ projections")?;
    // Nulls never reach canonical fields (the legacy composer dropped them).
    let mut fields = serde_json::Map::new();
    for (key, value) in frontmatter {
        if !value.is_null() {
            fields.insert(key.clone(), value.clone());
        }
    }
    let store = writer.store_id().to_string();
    let state = current_state(writer, vault)?;
    let actor = write_actor(&fields);

    let events = match state.projection_paths.get(krel) {
        None => creation_events(&state, &store, krel, &actor, &fields, body)?,
        Some(belief_id) => revision_events(&state, belief_id, &actor, &mut fields, body)?,
    };

    if events.is_empty() {
        // A byte-level no-op — the legacy path succeeded silently here, and
        // so do we; the projection is refreshed, nothing is committed.
        if let Some(belief_id) = state.projection_paths.get(krel) {
            let projection = project_belief(&state, belief_id)?;
            write_projection(vault, rel, &projection)?;
        }
        return Ok(());
    }

    commit(writer, events)?;
    crate::crash::crash_point("concept-committed");

    // Reduce, project, execute the manifest-first write, THEN acknowledge.
    let state = current_state(writer, vault)?;
    let belief_id = state
        .projection_paths
        .get(krel)
        .ok_or_else(|| refusal_detail(&state, rel))?
        .clone();
    let projection = project_belief(&state, &belief_id)?;
    // The commit is durable; a reducer-level refusal means the transition
    // did not apply — surface it instead of acknowledging stale state.
    if projection_is_stale(&state, &projection, &fields, body) {
        return Err(refusal_detail(&state, rel));
    }
    write_projection(vault, rel, &projection)
}

/// Did the committed transition actually apply? The projected content must
/// equal the intended content (fields comparisons are already covered by
/// content — the projection renders both).
fn projection_is_stale(
    _state: &EpistemicState,
    projection: &ProjectionResult,
    fields: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> bool {
    // The intended body must be present in the projection; carried-forward
    // fields (aliases) make full byte-prediction here needless — the
    // reducer's own refusal list is the authority, checked via content.
    let intended_tail = concept_content(fields.is_empty(), body);
    !projection
        .bytes
        .ends_with(intended_tail.trim_start_matches('\n'))
}

fn refusal_detail(state: &EpistemicState, rel: &str) -> String {
    state
        .anomalies
        .last()
        .map(|a| format!("write_concept refused for {rel}: {}", a.detail))
        .unwrap_or_else(|| format!("write_concept did not apply for {rel}"))
}

fn creation_events(
    state: &EpistemicState,
    store: &str,
    krel: &str,
    actor: &Actor,
    fields: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<Vec<(String, serde_json::Value)>, String> {
    let belief_id = schema::migrate_id(store, "belief", krel);
    let entity_id = schema::migrate_id(store, "entity", krel);
    let (schema_v, batch_id, idempotency_key, actor_owned) = common_body(actor.clone());
    let created = schema::BeliefCreated {
        schema: schema_v,
        batch_id,
        idempotency_key,
        actor: actor_owned,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: belief_id.clone(),
        subject: SubjectRef::Resolved {
            entity_id: entity_id.clone(),
            aliases: vec![krel.to_string()],
        },
        content: concept_content(fields.is_empty(), body),
        fields: serde_json::Value::Object(fields.clone()),
        basis: BeliefBasis::Unsupported {
            reason: AGENT_BASIS_REASON.to_string(),
        },
    };
    let mut events = vec![(
        schema::KIND_BELIEF_CREATED.to_string(),
        serde_json::to_value(&created).map_err(|e| e.to_string())?,
    )];
    for (to, kind) in intended_relations(state, &belief_id, fields) {
        events.push(relation_event(
            actor,
            &belief_id,
            &to,
            kind,
            RelationAction::Add,
        ));
    }
    for alias in alias_list(fields.get("aliases")) {
        let normalized = schema::normalize_alias_v1(&alias);
        if !normalized.is_empty() && !state.alias_registry.contains_key(&normalized) {
            events.push(alias_event(actor, &entity_id, &alias));
        }
    }
    Ok(events)
}

fn revision_events(
    state: &EpistemicState,
    belief_id: &str,
    actor: &Actor,
    fields: &mut serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<Vec<(String, serde_json::Value)>, String> {
    let belief = state
        .beliefs
        .get(belief_id)
        .expect("path index is consistent");
    let current = belief.current();
    let current_fields = current.fields.as_object().cloned().unwrap_or_default();

    // Alias policy: an omitted `aliases` key carries the stored value
    // forward; a PRESENT key that drops a live registered alias is the
    // typed unsupported-removal refusal.
    let mut alias_events: Vec<(String, serde_json::Value)> = Vec::new();
    match fields.get("aliases") {
        None => {
            if let Some(stored) = current_fields.get("aliases") {
                fields.insert("aliases".to_string(), stored.clone());
            }
        }
        Some(value) => {
            let intended: BTreeSet<String> = alias_list(Some(value))
                .iter()
                .map(|a| schema::normalize_alias_v1(a))
                .filter(|n| !n.is_empty())
                .collect();
            for alias in state.alias_registry.values() {
                if alias.entity_id == belief.entity_id && !intended.contains(&alias.normalized) {
                    return Err(format!(
                        "{UNSUPPORTED_ALIAS_REMOVAL} (dropped {:?})",
                        alias.alias
                    ));
                }
            }
            for alias in alias_list(Some(value)) {
                let normalized = schema::normalize_alias_v1(&alias);
                if !normalized.is_empty() && !state.alias_registry.contains_key(&normalized) {
                    alias_events.push(alias_event(actor, &belief.entity_id, &alias));
                }
            }
        }
    }

    // Relation diff against the live relation state.
    let intended: BTreeSet<(String, RelationKind)> = intended_relations(state, belief_id, fields)
        .into_iter()
        .collect();
    let live: BTreeSet<(String, RelationKind)> = state
        .relations
        .values()
        .filter(|r| r.live && r.from == belief_id)
        .map(|r| (r.to.clone(), r.relation))
        .collect();
    let mut relation_events: Vec<(String, serde_json::Value)> = Vec::new();
    for (to, kind) in intended.difference(&live) {
        relation_events.push(relation_event(
            actor,
            belief_id,
            to,
            *kind,
            RelationAction::Add,
        ));
    }
    for (to, kind) in live.difference(&intended) {
        relation_events.push(relation_event(
            actor,
            belief_id,
            to,
            *kind,
            RelationAction::Remove,
        ));
    }

    // The field/body patch: value-level diff; stored key order is the
    // projection's (the canonical spelling is reducer-owned).
    let mut patch: Vec<PatchOp> = Vec::new();
    for (key, before_value) in &current_fields {
        let before = typed_from_value(before_value);
        match fields.get(key) {
            Some(after_value) => {
                let after = typed_from_value(after_value);
                if before != after {
                    patch.push(PatchOp {
                        field_path: pointer(key),
                        before,
                        after,
                    });
                }
            }
            None => patch.push(PatchOp {
                field_path: pointer(key),
                before,
                after: schema::TypedValue::Missing,
            }),
        }
    }
    for (key, after_value) in fields.iter() {
        if !current_fields.contains_key(key) {
            patch.push(PatchOp {
                field_path: pointer(key),
                before: schema::TypedValue::Missing,
                after: typed_from_value(after_value),
            });
        }
    }
    let intended_content = concept_content(fields.is_empty(), body);
    if intended_content != current.content {
        patch.push(PatchOp {
            field_path: "/body".to_string(),
            before: schema::TypedValue::string(&current.content),
            after: schema::TypedValue::string(&intended_content),
        });
    }

    if patch.is_empty() && relation_events.is_empty() && alias_events.is_empty() {
        return Ok(Vec::new());
    }

    let (schema_v, batch_id, idempotency_key, actor_owned) = common_body(actor.clone());
    let revised = schema::BeliefRevised {
        schema: schema_v,
        batch_id,
        idempotency_key,
        actor: actor_owned,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: belief_id.to_string(),
        patch,
        basis: current.basis.clone(),
    };
    let mut events = vec![(
        schema::KIND_BELIEF_REVISED.to_string(),
        serde_json::to_value(&revised).map_err(|e| e.to_string())?,
    )];
    events.extend(relation_events);
    events.extend(alias_events);
    Ok(events)
}

/// One event goes through plain `append`; a multi-event transition is one
/// logical batch — assertion-free here, but atomic all the same.
fn commit(
    writer: &mut LedgerWriter,
    mut events: Vec<(String, serde_json::Value)>,
) -> Result<(), String> {
    if events.len() == 1 {
        let (kind, body) = events.remove(0);
        writer.append(&kind, body)?;
    } else {
        writer.append_batch(events, None)?;
    }
    Ok(())
}

fn write_projection(vault: &Path, rel: &str, projection: &ProjectionResult) -> Result<(), String> {
    manifest::write_projection(vault, rel, projection)?;
    // UI-refresh optimization only — the manifest is the self-write marker.
    crate::vault::watcher::note_own_write(&vault.join(rel));
    Ok(())
}

fn append_log_with(
    writer: &mut LedgerWriter,
    vault: &Path,
    concept_rel: &str,
    title: &str,
    existed: bool,
) -> Result<(), String> {
    let store = writer.store_id().to_string();
    let state = current_state(writer, vault)?;
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let kind = crate::knowledge::log_kind(existed);
    let actor = Actor {
        id: "system:knowledge-log".to_string(),
    };

    match state.projection_paths.get("log.md") {
        Some(belief_id) => {
            let belief = state.beliefs.get(belief_id).expect("path index");
            let current = belief.current();
            let next = crate::knowledge::insert_log_entry(
                &current.content,
                &date,
                kind,
                title,
                concept_rel,
            );
            if next == current.content {
                return Ok(());
            }
            let (schema_v, batch_id, idempotency_key, actor) = common_body(actor);
            let revised = schema::BeliefRevised {
                schema: schema_v,
                batch_id,
                idempotency_key,
                actor,
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                belief_id: belief_id.clone(),
                patch: vec![PatchOp {
                    field_path: "/body".to_string(),
                    before: schema::TypedValue::string(&current.content),
                    after: schema::TypedValue::string(&next),
                }],
                basis: current.basis.clone(),
            };
            writer.append(
                schema::KIND_BELIEF_REVISED,
                serde_json::to_value(&revised).map_err(|e| e.to_string())?,
            )?;
        }
        None => {
            let next = crate::knowledge::insert_log_entry("", &date, kind, title, concept_rel);
            let (schema_v, batch_id, idempotency_key, actor) = common_body(actor);
            let created = schema::BeliefCreated {
                schema: schema_v,
                batch_id,
                idempotency_key,
                actor,
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                belief_id: schema::migrate_id(&store, "belief", "log.md"),
                subject: SubjectRef::Resolved {
                    entity_id: schema::migrate_id(&store, "entity", "log.md"),
                    aliases: vec!["log.md".to_string()],
                },
                content: next,
                fields: serde_json::json!({}),
                basis: BeliefBasis::Unsupported {
                    reason: AGENT_BASIS_REASON.to_string(),
                },
            };
            writer.append(
                schema::KIND_BELIEF_CREATED,
                serde_json::to_value(&created).map_err(|e| e.to_string())?,
            )?;
        }
    }
    crate::crash::crash_point("concept-committed");

    let state = current_state(writer, vault)?;
    let belief_id = state
        .projection_paths
        .get("log.md")
        .ok_or_else(|| refusal_detail(&state, crate::knowledge::LOG_PATH))?
        .clone();
    let projection = project_belief(&state, &belief_id)?;
    write_projection(vault, crate::knowledge::LOG_PATH, &projection)
}

#[cfg(test)]
mod tests {
    use super::super::migrate::tests::{corpus_copy, WRITER};
    use super::super::reconcile::{classify_path, verified_ancestor, FileFact, PathClass};
    use super::super::{manifest as manifest_mod, LedgerHead};
    use super::*;
    use crate::vault::testutil;

    fn fm(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    }

    fn concept_frontmatter() -> serde_json::Map<String, serde_json::Value> {
        fm(&[
            ("type", serde_json::json!("Reference")),
            ("title", serde_json::json!("Churn definition")),
            ("about", serde_json::json!(["churn"])),
            (
                "generated",
                serde_json::json!({ "by": "agent:run-1", "at": "2026-08-09" }),
            ),
        ])
    }

    #[test]
    fn a_new_concept_is_a_committed_belief_whose_file_is_its_projection() {
        let vault = testutil::temp_vault("concepts-create");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        write_concept_with(
            &mut writer,
            &vault,
            "knowledge/concepts/churn.md",
            &concept_frontmatter(),
            "# Churn\n\nThe definition.",
        )
        .unwrap();

        let state = current_state(&writer, &vault).unwrap();
        let belief_id = schema::migrate_id(&store, "belief", "concepts/churn.md");
        assert_eq!(
            state.projection_paths.get("concepts/churn.md"),
            Some(&belief_id),
            "deterministic migration-formula identity"
        );
        let projection = project_belief(&state, &belief_id).unwrap();
        let disk = std::fs::read_to_string(vault.join("knowledge/concepts/churn.md")).unwrap();
        assert_eq!(disk, projection.bytes, "the file IS the projection");
        assert!(disk.contains("generated: { by: agent:run-1, at: 2026-08-09 }"));
        // The manifest entry is complete and exact.
        let entry = manifest_mod::load(&vault).unwrap().unwrap().entries
            ["knowledge/concepts/churn.md"]
            .clone();
        assert_eq!(entry.content_hash, projection.content_hash);
        assert_eq!(entry.write_state, manifest_mod::WriteState::Complete);
        // Basis is explicit-unsupported; actor rode generated.by.
        let belief = state.beliefs.get(&belief_id).unwrap();
        assert!(matches!(
            belief.current().basis,
            BeliefBasis::Unsupported { .. }
        ));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_rewrite_revises_with_patches_relations_and_carried_aliases() {
        let vault = corpus_copy("concepts-revise");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();

        // status-model.md is migrated; rewrite it with a new body, a new
        // relation to the pilot, and no aliases key.
        let rel = "knowledge/systems/status-model.md";
        let frontmatter = fm(&[
            ("type", serde_json::json!("Reference")),
            ("title", serde_json::json!("Status model")),
            ("refines", serde_json::json!(["[[offline-window-pilot]]"])),
            (
                "generated",
                serde_json::json!({ "by": "agent:run-2", "at": "2026-08-09" }),
            ),
        ]);
        write_concept_with(
            &mut writer,
            &vault,
            rel,
            &frontmatter,
            "# Status model\n\nRewritten.",
        )
        .unwrap();

        let state = current_state(&writer, &vault).unwrap();
        let belief_id = schema::migrate_id(&store, "belief", "systems/status-model.md");
        let belief = state.beliefs.get(&belief_id).unwrap();
        assert_eq!(belief.current().revision, 2);
        // The relation exists and is live.
        let pilot = schema::migrate_id(&store, "belief", "systems/offline-window-pilot.md");
        assert!(state
            .relations
            .values()
            .any(|r| r.live && r.from == belief_id && r.to == pilot));
        // The projection landed on disk in canonical spelling.
        let disk = std::fs::read_to_string(vault.join(rel)).unwrap();
        assert_eq!(disk, project_belief(&state, &belief_id).unwrap().bytes);
        assert!(disk.contains("Rewritten."));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn dropping_a_live_alias_is_the_typed_refusal_and_omission_carries_forward() {
        let vault = testutil::temp_vault("concepts-alias");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let rel = "knowledge/concepts/acme.md";
        let mut with_alias = concept_frontmatter();
        with_alias.insert("aliases".into(), serde_json::json!(["Acme Corp"]));
        write_concept_with(&mut writer, &vault, rel, &with_alias, "# Acme\n").unwrap();
        let state = current_state(&writer, &vault).unwrap();
        assert!(state.alias_registry.contains_key("acme corp"));

        // Omitting the key carries the alias forward — no refusal, and the
        // projected file still lists it.
        write_concept_with(
            &mut writer,
            &vault,
            rel,
            &concept_frontmatter(),
            "# Acme\n\nRewritten.",
        )
        .unwrap();
        let disk = std::fs::read_to_string(vault.join(rel)).unwrap();
        assert!(disk.contains("aliases: [Acme Corp]"), "{disk}");

        // Naming the key while dropping the live alias is the typed refusal.
        let mut dropping = concept_frontmatter();
        dropping.insert("aliases".into(), serde_json::json!(["Different Name"]));
        let err = write_concept_with(&mut writer, &vault, rel, &dropping, "# Acme\n").unwrap_err();
        assert!(err.contains("unsupported_alias_removal"), "{err}");
        // ...and nothing changed on disk.
        assert_eq!(std::fs::read_to_string(vault.join(rel)).unwrap(), disk);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_byte_identical_rewrite_commits_nothing() {
        let vault = testutil::temp_vault("concepts-noop");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let rel = "knowledge/concepts/churn.md";
        write_concept_with(
            &mut writer,
            &vault,
            rel,
            &concept_frontmatter(),
            "# Churn\n",
        )
        .unwrap();
        let head_before = writer.head();
        write_concept_with(
            &mut writer,
            &vault,
            rel,
            &concept_frontmatter(),
            "# Churn\n",
        )
        .unwrap();
        assert_eq!(writer.head(), head_before, "no event for a no-op rewrite");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_log_append_is_a_belief_revision_of_the_log_projection() {
        let vault = corpus_copy("concepts-log");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        append_log_with(&mut writer, &vault, "knowledge/concepts/x.md", "X", false).unwrap();
        let state = current_state(&writer, &vault).unwrap();
        let log_belief = schema::migrate_id(&store, "belief", "log.md");
        let belief = state.beliefs.get(&log_belief).unwrap();
        assert!(
            belief.current().revision >= 2,
            "the log revised, not rewritten"
        );
        assert!(belief.current().content.contains("[X](/concepts/x.md)"));
        let disk = std::fs::read_to_string(vault.join("knowledge/log.md")).unwrap();
        assert_eq!(disk, project_belief(&state, &log_belief).unwrap().bytes);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn verify_revises_the_stamp_and_attests_the_reviewed_revision() {
        let vault = corpus_copy("concepts-verify");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();

        let rel = "knowledge/metrics/sync-error-rate.md";
        let patch = fm(&[(
            "verified",
            serde_json::json!({ "by": "human:me", "at": "2026-08-09T10:00:00Z" }),
        )]);
        verify_with(&mut writer, &vault, rel, &patch).unwrap();

        let state = current_state(&writer, &vault).unwrap();
        let belief_id = schema::migrate_id(&store, "belief", "metrics/sync-error-rate.md");
        let belief = state.beliefs.get(&belief_id).unwrap();
        // The stamp is a field revision; the attestation pins THAT revision
        // event — the reviewed revision is the current one.
        assert_eq!(belief.current().revision, 2);
        let (_, pinned) = belief.attested.as_ref().unwrap();
        assert_eq!(pinned, &belief.current().event_id);
        let disk = std::fs::read_to_string(vault.join(rel)).unwrap();
        assert_eq!(disk, project_belief(&state, &belief_id).unwrap().bytes);
        assert!(
            disk.contains("verified: { by: human:me, at: 2026-08-09T10:00:00Z }"),
            "{disk}"
        );

        // The identical stamp is a no-op: no revision, no re-attestation.
        let head = writer.head();
        verify_with(&mut writer, &vault, rel, &patch).unwrap();
        assert_eq!(writer.head(), head, "an identical verify appends nothing");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_later_revision_renders_the_predating_notice_and_keeps_the_attestation() {
        let vault = corpus_copy("concepts-predate");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();

        let rel = "knowledge/metrics/sync-error-rate.md";
        verify_with(
            &mut writer,
            &vault,
            rel,
            &fm(&[(
                "verified",
                serde_json::json!({ "by": "human:me", "at": "2026-08-09T10:00:00Z" }),
            )]),
        )
        .unwrap();

        // The agent rewrites the verified concept: today's tool drops the
        // stamp from fields, but the projection SAYS what happened instead
        // of silently reverting to unverified — and the attestation stays.
        let frontmatter = fm(&[
            ("type", serde_json::json!("Metric")),
            ("title", serde_json::json!("Sync error rate")),
            (
                "generated",
                serde_json::json!({ "by": "agent:run-3", "at": "2026-08-09" }),
            ),
        ]);
        write_concept_with(
            &mut writer,
            &vault,
            rel,
            &frontmatter,
            "# Sync error rate\n\nRewritten.",
        )
        .unwrap();

        let state = current_state(&writer, &vault).unwrap();
        let belief_id = schema::migrate_id(&store, "belief", "metrics/sync-error-rate.md");
        let belief = state.beliefs.get(&belief_id).unwrap();
        assert_eq!(belief.current().revision, 3);
        assert!(belief.attested.is_some(), "the attestation persists");
        let disk = std::fs::read_to_string(vault.join(rel)).unwrap();
        assert!(
            disk.contains(
                "verified: verified at r2; current is r3 — attestation predates revision"
            ),
            "{disk}"
        );
        assert_eq!(disk, project_belief(&state, &belief_id).unwrap().bytes);
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// Child: create a concept, dying right after the ledger commit.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the crash tests"]
    fn crash_scenario_write_concept() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let vault = std::path::PathBuf::from(vault);
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let _ = write_concept_with(
            &mut writer,
            &vault,
            "knowledge/concepts/churn.md",
            &concept_frontmatter(),
            "# Churn\n",
        );
    }

    #[test]
    fn a_crash_after_commit_is_ledger_ahead_with_zero_recapture() {
        let vault = testutil::temp_vault("concepts-crash");
        // Seed the manifest so the scan has an M side (empty is fine).
        manifest_mod::save(
            &vault,
            &manifest_mod::Manifest {
                format: manifest_mod::MANIFEST_FORMAT,
                entries: Default::default(),
            },
        )
        .unwrap();
        let status = testutil::run_crash_scenario(
            "ledger::concepts::tests::crash_scenario_write_concept",
            "concept-committed",
            &vault,
        );
        assert!(!status.success(), "the child dies after the commit");

        // The commit is durable; no file, no manifest entry — the exact
        // ledger-ahead-create shape, recovered by regenerating with ZERO
        // human assertions.
        let read = super::super::read_ledger(&ledger_dir(&vault)).unwrap();
        let head_before = LedgerHead {
            seq: read.head_seq,
            hash: read.head_hash.clone(),
        };
        let state = reduce(&read.frames, &read.store.store_id);
        let belief_id = schema::migrate_id(&read.store.store_id, "belief", "concepts/churn.md");
        let projection = project_belief(&state, &belief_id).unwrap();
        let manifest = manifest_mod::load(&vault).unwrap().unwrap();
        let entry = manifest.entries.get("knowledge/concepts/churn.md");
        assert!(entry.is_none());
        assert!(!vault.join("knowledge/concepts/churn.md").exists());
        assert_eq!(
            classify_path(&FileFact::missing(), None, Some(&projection), false),
            PathClass::LedgerAheadCreate
        );
        assert!(verified_ancestor(
            &read.frames,
            &read.store.store_id,
            &manifest_mod::entry_for(&projection, manifest_mod::WriteState::Complete, None)
        ));

        // Regeneration: exact reducer bytes, no new events of any kind.
        manifest_mod::write_projection(&vault, "knowledge/concepts/churn.md", &projection).unwrap();
        assert_eq!(
            std::fs::read_to_string(vault.join("knowledge/concepts/churn.md")).unwrap(),
            projection.bytes
        );
        let read = super::super::read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(
            LedgerHead {
                seq: read.head_seq,
                hash: read.head_hash.clone()
            },
            head_before,
            "zero events — regeneration is not an epistemic act"
        );
        assert!(
            !read
                .frames
                .iter()
                .any(|f| f.kind == schema::KIND_OBSERVATION_RECORDED),
            "zero human assertions fabricated from the crash"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }
}
