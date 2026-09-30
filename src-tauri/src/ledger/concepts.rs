//! The `write_concept` compatibility adapter (M23.3): the flip from
//! file-first to ledger-first for the knowledge bundle.
//!
//! A concept write is a committed Belief
//! transition — `belief.created` or `belief.revised` plus exact
//! relation/alias events, batched when the transition has more than one
//! event — and the file on disk is the byte-stable PROJECTION of reducer
//! state, written through the M23.2 manifest-first protocol. Reduce,
//! project, write, then acknowledge. Without an active ledger writer every
//! entry point refuses with `ledger_writer_unavailable` and writes nothing
//! (M49.1): the file-first fallback this adapter once kept was the direct
//! cause of the 2026-09 divergence incident.
//!
//! M24.4 DELETED the hard-coded low-risk auto-apply decision this adapter
//! shipped with. What remains here is SERVER ENRICHMENT — resolving
//! wikilinks, diffing fields into patches, carrying aliases forward — and
//! the enriched result is submitted as typed proposals whose risk the
//! policy table computes. The MCP tool surface (arguments, response prose)
//! is unchanged; mcp.rs still calls the same `vault::write` entry points.
//!
//! The visible consequence is deliberate: rewriting a concept a human has
//! VERIFIED no longer applies silently. `target_has_attestation` floors that
//! transition at HIGH, so it becomes a queued proposal — which is the whole
//! reason `knowledge/` is agent-written and human-verified. Everything else
//! still auto-applies, because create is LOW and revise/relation/alias are
//! MEDIUM and the table says both rungs apply.
//!
//! `verify_concept` deliberately does NOT route through policy: it is the
//! human's own act, and asking a person to approve their own review would
//! be governance theatre. `append_log` likewise — the knowledge log is a
//! system-appended index of what already happened, not a claim about the
//! world.
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
//! - relation wikilinks resolve against projection paths through
//!   `migrate::resolve_link`, which migration uses too; a stem two concepts
//!   share is refused (`ambiguous_link`), and an unresolvable target stays
//!   in fields with no event, never guessed.

use std::collections::BTreeSet;
use std::path::Path;

use super::manifest;
use super::migrate::wikilinks;
use super::reduce::{project_belief, reduce, typed_from_value, EpistemicState, ProjectionResult};
use super::schema::{
    self, Actor, BeliefBasis, PatchOp, ProposalOp, RelationAction, RelationKind, SubjectRef,
};
use super::writer::LedgerWriter;
use super::{ledger_dir, read_ledger, shadow};

/// The explicit basis a fresh agent-written concept declares.
pub const AGENT_BASIS_REASON: &str = "agent write without captured observations";

/// The typed alias-removal refusal (spec: `unsupported_alias_removal`).
pub const UNSUPPORTED_ALIAS_REMOVAL: &str =
    "unsupported_alias_removal: alias removal has no v1 event — keep the alias or wait for the \
     maintenance channel";

/// The refusal every knowledge write returns when no ledger writer is
/// active for the vault (M49.1, K1). There is deliberately no file-first
/// fallback: a concept written beside the ledger is bytes the projection
/// manifest never recorded, so the next scan reads it as divergence and
/// pauses capture — the 2026-09 "Knowledge history diverged" incident.
pub const LEDGER_WRITER_UNAVAILABLE: &str = "ledger_writer_unavailable";

fn writer_unavailable(vault: &Path) -> String {
    format!(
        "{LEDGER_WRITER_UNAVAILABLE}: no ledger writer is active for {} — nothing was \
         written (ledger_status says why)",
        vault.display()
    )
}

/// Refused outright rather than written: only `knowledge/` is ledger-backed.
fn outside_bundle(rel: &str) -> String {
    format!("only knowledge/ concepts are ledger-backed; {rel} is outside the bundle")
}

/// `write_concept` for the run that asked for it (M49.9, K25): its
/// proposals and commit set carry that run's id, and the run's row books
/// what was submitted, applied and rejected.
pub fn write_concept_in_run(
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
    run: &str,
) -> Result<(), String> {
    if !rel.starts_with("knowledge/") {
        return Err(outside_bundle(rel));
    }
    shadow::with_writer(vault, |writer| {
        write_concept_in_run_with(writer, vault, rel, frontmatter, body, Some(run))
    })
    .unwrap_or_else(|| Err(writer_unavailable(vault)))
}

/// Ledger-first `write_concept`: a committed Belief transition whose file
/// is the projection. Refuses with `ledger_writer_unavailable` when no
/// writer is active for the vault.
pub fn write_concept(
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<(), String> {
    if !rel.starts_with("knowledge/") {
        return Err(outside_bundle(rel));
    }
    shadow::with_writer(vault, |writer| {
        write_concept_with(writer, vault, rel, frontmatter, body)
    })
    .unwrap_or_else(|| Err(writer_unavailable(vault)))
}

/// Ledger-first knowledge-log append. Refuses without an active writer.
pub fn append_log(
    vault: &Path,
    concept_rel: &str,
    title: &str,
    existed: bool,
) -> Result<(), String> {
    shadow::with_writer(vault, |writer| {
        append_log_with(writer, vault, concept_rel, title, existed)
    })
    .unwrap_or_else(|| Err(writer_unavailable(vault)))
}

/// Ledger-first `verify_concept` (M23.4): the human stamp lands in fields
/// through a normal `belief.revised`, then `belief.attested` pins the
/// reviewed — now current — revision event and its projection hash, and
/// the projection regenerates. Refuses without an active writer.
///
/// `viewed_body_hash` is the SHA-256 of the body the person read (M49.3,
/// K6): the stamp attests THAT text, so a body that changed underneath the
/// page refuses with `stale_view`, and a file that differs from recorded
/// history refuses with `projection_disk_changed` — before, Verify attested
/// the ledger's text and silently wrote it over what was on screen.
pub fn verify_concept(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
    viewed_body_hash: &str,
) -> Result<(), String> {
    if !rel.starts_with("knowledge/") {
        return Err(outside_bundle(rel));
    }
    shadow::with_writer(vault, |writer| {
        verify_with(writer, vault, rel, patch, viewed_body_hash)
    })
    .unwrap_or_else(|| Err(writer_unavailable(vault)))
}

/// What a recheck did (M49.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rechecked {
    /// The concept already carried this `stale_after`: nothing was written.
    Unchanged,
    /// Only `stale_after` moved.
    Stamped,
}

/// "Still true — recheck again on `stale_after`" (M49.7, K19): a
/// stamp-only revision of `stale_after` and nothing else.
///
/// The recheck lanes used to answer through `write_concept` — a FULL
/// replace that restamped `generated.at`, added a log line, and floored at
/// a HIGH review card on every verified concept, for a verdict that changed
/// nothing. Here a no-op is a no-op (no event, no stamp, no log line), and a
/// VERIFIED concept is refused: moving its recheck date is the person's, and
/// an agent revision would also leave the review predating the concept. The
/// stamp is an `update_belief` proposal like any revision, so the policy
/// table decides it — it auto-applies on an ordinary concept and queues
/// where an escalator (a hub's `lineage_fan_in`) says a person should see
/// it; a hand-coded check here was policy written twice. It is not a claim,
/// so it writes no log line.
pub fn recheck_concept(
    vault: &Path,
    rel: &str,
    stale_after: &str,
    actor: &str,
    run: Option<&str>,
) -> Result<Rechecked, String> {
    if !rel.starts_with("knowledge/") {
        return Err(outside_bundle(rel));
    }
    shadow::with_writer(vault, |writer| {
        recheck_with(writer, vault, rel, stale_after, actor, run)
    })
    .unwrap_or_else(|| Err(writer_unavailable(vault)))
}

fn recheck_with(
    writer: &mut LedgerWriter,
    vault: &Path,
    rel: &str,
    stale_after: &str,
    actor: &str,
    run: Option<&str>,
) -> Result<Rechecked, String> {
    let krel = rel
        .strip_prefix("knowledge/")
        .expect("checked by the caller");
    let state = current_state(writer, vault)?;
    let belief_id = state
        .projection_paths
        .get(krel)
        .ok_or_else(|| format!("{rel} is not a recorded concept — nothing to recheck"))?
        .clone();
    let belief = state.beliefs.get(&belief_id).expect("path index");
    let current = belief.current();
    // A PERSON's verification is refused outright — moving its recheck date
    // is theirs. A machine's goes to the table like any revision of an
    // attested belief, which floors it at a card: a person sees the stamp
    // that would leave the confirmation predating the concept.
    let recorded =
        crate::knowledge::tier_of(current.fields.as_object().and_then(|f| f.get("verified")));
    if belief.attested.is_some() && recorded != "machine-confirmed" {
        return Err(format!(
            "{rel} is verified by a person: moving its recheck date is theirs, not an agent's — \
             say what you found in your reply instead"
        ));
    }
    let before = current
        .fields
        .as_object()
        .and_then(|m| m.get("stale_after"))
        .map(typed_from_value)
        .unwrap_or(schema::TypedValue::Missing);
    let after = schema::TypedValue::string(stale_after);
    if before == after {
        return Ok(Rechecked::Unchanged);
    }
    let before_label = current
        .fields
        .as_object()
        .and_then(|m| m.get("stale_after"))
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .to_string();
    manifest::ensure_writable(vault, rel, &state)?;
    let stamp = ProposalOp::UpdateBelief {
        belief_id: belief_id.clone(),
        patch: vec![PatchOp {
            field_path: "/fields/stale_after".to_string(),
            before,
            after,
        }],
        basis: current.basis.clone(),
    };
    let targets = vec![target(
        &state,
        schema::TargetClass::Belief,
        &belief_id,
        false,
    )];
    let actor = Actor {
        id: actor.to_string(),
    };
    let door = Door {
        tool: "recheck_concept",
        reason: format!(
            "recheck_concept {rel}: still holds — stale_after {} → {stale_after}, nothing else \
             (actor {})",
            before_label, actor.id
        ),
    };
    route(
        writer,
        vault,
        &state,
        krel,
        &actor,
        vec![(stamp, targets)],
        run,
        door,
    )?;
    Ok(Rechecked::Stamped)
}

/// The refusal when the body a person verified is not the body on disk.
pub const STALE_VIEW: &str = "stale_view";

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
    viewed_body_hash: &str,
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
    let on_disk = crate::vault::write::read_note(vault, rel)?;
    if crate::ledger::sha256_hex(on_disk.as_bytes()) != viewed_body_hash {
        return Err(format!(
            "{STALE_VIEW}: {rel} changed since you opened it — reopen it and verify again"
        ));
    }
    manifest::ensure_writable(vault, rel, &state)?;
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

/// The reduced state at this writer's current head.
///
/// `pub(crate)` since M26.3c: the live proposal tools mint their candidate
/// receipt against exactly this, and a second reducer call spelled slightly
/// differently would let the receipt be minted against a world the validator
/// does not re-derive.
pub(crate) fn current_state(writer: &LedgerWriter, vault: &Path) -> Result<EpistemicState, String> {
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
) -> Result<Vec<(String, RelationKind)>, String> {
    use super::migrate::{ambiguous_link, resolve_link, LinkTarget};
    let mut out = Vec::new();
    for (field, kind) in [
        ("supersedes", RelationKind::Supersedes),
        ("refines", RelationKind::Refines),
        ("contradicts", RelationKind::Contradicts),
    ] {
        for link in wikilinks(fields.get(field)) {
            match resolve_link(&state.projection_paths, &link) {
                LinkTarget::One(target) if target != from_belief => out.push((target, kind)),
                LinkTarget::Ambiguous(paths) => return Err(ambiguous_link(&link, &paths)),
                _ => {}
            }
        }
    }
    Ok(out)
}

fn relation_op(from: &str, to: &str, kind: RelationKind, action: RelationAction) -> ProposalOp {
    ProposalOp::EditRelation {
        relation_id: schema::derive_relation_id(from, to, kind),
        action,
        from: from.to_string(),
        to: to.to_string(),
        relation: kind,
    }
}

fn alias_op(entity_id: &str, alias: &str) -> ProposalOp {
    ProposalOp::AddEntityAlias {
        entity_id: entity_id.to_string(),
        alias: alias.to_string(),
    }
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
    write_concept_in_run_with(writer, vault, rel, frontmatter, body, None)
}

/// `write_concept_with`, booked under the run that made the write (M49.9).
fn write_concept_in_run_with(
    writer: &mut LedgerWriter,
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
    run: Option<&str>,
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

    let ops = match state.projection_paths.get(krel) {
        None => creation_ops(&state, &store, krel, &fields, body)?,
        Some(belief_id) => revision_ops(&state, belief_id, &mut fields, body)?,
    };

    // M49.3: a file changed outside the ledger is never written over — and
    // the refusal comes BEFORE the transition commits, not after.
    manifest::ensure_writable(vault, rel, &state)?;

    if ops.is_empty() {
        // A byte-level no-op: nothing is committed, and the projection is
        // refreshed.
        if let Some(belief_id) = state.projection_paths.get(krel) {
            let projection = project_belief(&state, belief_id)?;
            write_projection(vault, rel, &projection)?;
        }
        return Ok(());
    }

    // THE DECISION IS THE TABLE'S NOW. Everything above this line is server
    // enrichment; everything below is the M24 commit-set protocol, which
    // owns the batch, the projection, and the acknowledgement.
    let door = Door {
        tool: "write_concept",
        reason: format!("write_concept {rel} (actor {})", actor.id),
    };
    route(writer, vault, &state, krel, &actor, ops, run, door)?;

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
    Ok(())
}

/// Submit the enriched ops as one atomic commit set and interpret its
/// outcome.
///
/// A concept write is all-or-nothing by nature: the Belief, its relation
/// edits, and its new aliases describe one edit a person made in one file.
/// Applying the Belief while a relation waited would leave the file saying
/// something the graph does not.
#[allow(clippy::too_many_arguments)] // each is a distinct fact of one write
/// Which server-stamped door a routed write came through, and what the card
/// a person may be asked about it should say — `write_concept`'s full
/// replace and `recheck_concept`'s one-field stamp must never read alike.
struct Door<'a> {
    tool: &'a str,
    reason: String,
}

#[allow(clippy::too_many_arguments)]
fn route(
    writer: &mut LedgerWriter,
    vault: &Path,
    state: &EpistemicState,
    krel: &str,
    actor: &Actor,
    ops: Vec<(schema::ProposalOp, Vec<schema::ProposalTarget>)>,
    run: Option<&str>,
    door: Door<'_>,
) -> Result<(), String> {
    let table = crate::policy::table::PolicyTable::load()?;
    // `write_concept` → `cerebro-write-concept`: the spelling every id below
    // was derived under before `recheck_concept` came through here too.
    let tag = format!("cerebro-{}", door.tool.replace('_', "-"));
    // Derived, not minted: a retry at the same head produces the same
    // proposal ids and the same commit-set id, so a lost acknowledgement
    // replays instead of duplicating.
    let head = writer.head();
    let head_hash = head
        .as_ref()
        .map(|head| head.hash.clone())
        .unwrap_or_else(|| "genesis".to_string());
    // M49.9 (K25): the RUN the write belongs to, when one is known — so
    // the proposals, the commit set and the Fleet's counters all name the
    // run that made them. Before, every write was booked under an id
    // derived from its path and the head, and no run could be traced to
    // what it wrote. Proposal ids still derive from path and head too, so a
    // retry at the same head replays rather than duplicating.
    let run_id = match run {
        Some(run) => run.to_string(),
        None => schema::sha256_first128(format!("{tag}-run-v1\0{krel}\0{head_hash}").as_bytes()),
    };
    // The head the search is minted against — derived from the chain head,
    // so the receipt's claim about WHERE it looked is recomputable by anyone
    // holding the ledger.
    let index_head = crate::policy::candidates::index_head_of(head.as_ref());

    let mut ordered = Vec::with_capacity(ops.len());
    for (index, (op, targets)) in ops.into_iter().enumerate() {
        // The SERVER builds these, so declared risk is the table's base for
        // the op it built. `declared_risk` exists to catch an AGENT
        // understating what it is doing; the enrichment path has nothing to
        // understate, and declaring anything lower would simply be
        // `risk_lowered` against our own table.
        let declared_risk = table
            .op(op.kind())
            .ok_or_else(|| format!("{} is not in the policy table", op.kind()))?
            .base_risk;
        let proposal_id = match run {
            Some(_) => schema::sha256_first128(
                format!("{tag}-op-v2\0{run_id}\0{krel}\0{head_hash}\0{index}").as_bytes(),
            ),
            None => schema::sha256_first128(format!("{tag}-op-v1\0{run_id}\0{index}").as_bytes()),
        };
        let receipt = match &op {
            schema::ProposalOp::CreateBelief {
                subject,
                fields,
                content,
                ..
            } => {
                let (subject_id, mut queries) = match subject {
                    schema::SubjectRef::Resolved { entity_id, aliases } => {
                        (entity_id.clone(), aliases.clone())
                    }
                    _ => return Err("a created concept's subject must be resolved".to_string()),
                };
                // The alias leg searches every spelling this concept claims,
                // not just its path: an `aliases:` entry that already belongs
                // to something else is precisely the duplicate §15 is for.
                queries.extend(alias_list(fields.get("aliases")));
                queries.sort();
                queries.dedup();
                Some(crate::policy::candidates::mint(
                    state,
                    &index_head,
                    &subject_id,
                    krel,
                    &queries,
                    content,
                )?)
            }
            _ => None,
        };
        let proposal = schema::ProposalV1 {
            schema: schema::PROPOSAL_SCHEMA,
            proposal_id: proposal_id.clone(),
            run_id: run_id.clone(),
            targets,
            op,
            intended_use: schema::IntendedUse {
                kind: schema::IntendedUseKind::ReversibleWork,
                stakes: crate::policy::table::Risk::Low,
                predicate_class: None,
            },
            basis: schema::ProposalBasis {
                // The agent captured no observations (the M23 rule carried
                // forward); the concept text is the new evidence.
                transition_cause: schema::TransitionCause::NewEvidence,
                evidence_refs: vec![],
                coverage_refs: vec![],
                authority_refs: vec![],
                authority_route_refs: vec![],
                addressed_contradictions: vec![],
                absence_claim: false,
            },
            declared_risk,
            reason: door.reason.clone(),
            candidate_search_receipt: receipt,
        };
        crate::policy::commit::submit_proposal(&table, writer, actor, &proposal)
            .map_err(|e| format!("{}: {}", e.code, e.detail))?;
        ordered.push(proposal_id);
    }

    let outcome = crate::policy::commit::commit_proposals(&table, writer, vault, &run_id, &ordered)
        .map_err(|e| format!("{}: {}", e.code, e.detail))?;
    if run.is_some() {
        outcome.book(&run_id);
    }
    match outcome.transition {
        crate::policy::commit::TransitionCode::Apply => Ok(()),
        crate::policy::commit::TransitionCode::InitialQueue => Err(queued_detail(&outcome)),
        _ => Err(rejected_detail(&outcome, door.tool)),
    }
}

/// The message a queued concept write returns. It is a REFUSAL of the write,
/// not of the proposal: the proposal is durable and waiting, and saying so
/// beats reporting success for a file that did not change.
fn queued_detail(outcome: &crate::policy::commit::CommitOutcome) -> String {
    // The MAXIMUM, not the last: a mixed set queues because of its most
    // dangerous member, and naming a MEDIUM peer would explain the wrong
    // thing to whoever reads the message.
    let risk = outcome
        .results
        .iter()
        .filter_map(|result| match result {
            crate::policy::submit::SubmitResult::Queued { effective_risk, .. } => {
                Some(*effective_risk)
            }
            _ => None,
        })
        .max()
        .map(|risk| risk.as_str())
        .unwrap_or("HIGH");
    format!(
        "queued_for_review: this change is {risk} risk and is waiting for a human decision \
         (commit set {})",
        outcome.commit_set_id
    )
}

fn rejected_detail(outcome: &crate::policy::commit::CommitOutcome, tool: &str) -> String {
    let code = outcome
        .results
        .iter()
        .find_map(|result| match result {
            crate::policy::submit::SubmitResult::Rejected { rejection, .. } => {
                Some(rejection.code.as_str().to_string())
            }
            _ => None,
        })
        .unwrap_or_else(|| "atomic_set_refused".to_string());
    format!("{code}: {tool} was refused by policy")
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

/// One op and the exact targets it names, at their current versions.
type Staged = Vec<(ProposalOp, Vec<schema::ProposalTarget>)>;

fn target(
    state: &EpistemicState,
    class: schema::TargetClass,
    id: &str,
    created_here: bool,
) -> schema::ProposalTarget {
    schema::ProposalTarget {
        target_id: id.to_string(),
        target_class: class,
        // Null ONLY for what this proposal creates; anything else names the
        // version it expects to find.
        expected_version: if created_here {
            None
        } else {
            state.version(class.as_str(), id)
        },
    }
}

fn creation_ops(
    state: &EpistemicState,
    store: &str,
    krel: &str,
    fields: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<Staged, String> {
    let belief_id = schema::migrate_id(store, "belief", krel);
    let entity_id = schema::migrate_id(store, "entity", krel);
    let mut staged: Staged = vec![(
        ProposalOp::CreateBelief {
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
            // The sentence a reviewer reads next to the receipt. It names
            // what was searched rather than asserting novelty: the legs are
            // the proof, and this says which question they answered.
            distinctness_reason: format!(
                "no committed belief holds the projection path {krel}, its declared aliases, or \
                 this subject"
            ),
        },
        vec![target(state, schema::TargetClass::Belief, &belief_id, true)],
    )];
    for (to, kind) in intended_relations(state, &belief_id, fields)? {
        let op = relation_op(&belief_id, &to, kind, RelationAction::Add);
        let relation_id = schema::derive_relation_id(&belief_id, &to, kind);
        staged.push((
            op,
            vec![target(
                state,
                schema::TargetClass::Relation,
                &relation_id,
                true,
            )],
        ));
    }
    for alias in alias_list(fields.get("aliases")) {
        let normalized = schema::normalize_alias_v1(&alias);
        if !normalized.is_empty() && !state.alias_registry.contains_key(&normalized) {
            staged.push((
                alias_op(&entity_id, &alias),
                vec![target(state, schema::TargetClass::Entity, &entity_id, true)],
            ));
        }
    }
    Ok(staged)
}

fn revision_ops(
    state: &EpistemicState,
    belief_id: &str,
    fields: &mut serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<Staged, String> {
    let belief = state
        .beliefs
        .get(belief_id)
        .expect("path index is consistent");
    let current = belief.current();
    let current_fields = current.fields.as_object().cloned().unwrap_or_default();

    // Alias policy: an omitted `aliases` key carries the stored value
    // forward; a PRESENT key that drops a live registered alias is the
    // typed unsupported-removal refusal.
    let mut alias_ops: Staged = Vec::new();
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
                    alias_ops.push((
                        alias_op(&belief.entity_id, &alias),
                        vec![target(
                            state,
                            schema::TargetClass::Entity,
                            &belief.entity_id,
                            false,
                        )],
                    ));
                }
            }
        }
    }

    // Relation diff against the live relation state.
    let intended: BTreeSet<(String, RelationKind)> = intended_relations(state, belief_id, fields)?
        .into_iter()
        .collect();
    let live: BTreeSet<(String, RelationKind)> = state
        .relations
        .values()
        .filter(|r| r.live && r.from == belief_id)
        .map(|r| (r.to.clone(), r.relation))
        .collect();
    let mut relation_ops: Staged = Vec::new();
    for (to, kind, action) in intended
        .difference(&live)
        .map(|(to, kind)| (to, kind, RelationAction::Add))
        .chain(
            live.difference(&intended)
                .map(|(to, kind)| (to, kind, RelationAction::Remove)),
        )
    {
        let relation_id = schema::derive_relation_id(belief_id, to, *kind);
        let created_here =
            action == RelationAction::Add && !state.relations.contains_key(&relation_id);
        relation_ops.push((
            relation_op(belief_id, to, *kind, action),
            vec![target(
                state,
                schema::TargetClass::Relation,
                &relation_id,
                created_here,
            )],
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

    if patch.is_empty() && relation_ops.is_empty() && alias_ops.is_empty() {
        return Ok(Vec::new());
    }

    // An empty patch with unchanged relations/aliases would be the
    // support-only revision shape, which this adapter never produces: it
    // captures no observations, so the basis carries forward untouched.
    let mut staged: Staged = Vec::new();
    if !patch.is_empty() {
        staged.push((
            ProposalOp::UpdateBelief {
                belief_id: belief_id.to_string(),
                patch,
                basis: current.basis.clone(),
            },
            vec![target(state, schema::TargetClass::Belief, belief_id, false)],
        ));
    }
    staged.extend(relation_ops);
    staged.extend(alias_ops);
    Ok(staged)
}

fn write_projection(vault: &Path, rel: &str, projection: &ProjectionResult) -> Result<(), String> {
    manifest::write_projection(vault, rel, projection)?;
    // UI-refresh optimization only — the manifest is the self-write marker.
    crate::vault::watcher::note_own_write(&vault.join(rel));
    Ok(())
}

/// Retire every override on the knowledge log (M49.5, K11). The log is a
/// derived, system-owned view (the 2026-09 owner decision): an override —
/// a hand edit captured before that decision (live vault, seq 179) — pins
/// the body, so every later entry was committed to the ledger and never
/// appeared in log.md. Nothing emitted `OverrideChange::Clear` until this.
/// `Ok(false)` when there was nothing to clear.
pub(crate) fn clear_log_overrides_with(
    writer: &mut LedgerWriter,
    vault: &Path,
) -> Result<bool, String> {
    let state = current_state(writer, vault)?;
    let Some(belief_id) = state.projection_paths.get("log.md") else {
        return Ok(false);
    };
    let belief = state.beliefs.get(belief_id).expect("path index");
    if belief.overrides.is_empty() {
        return Ok(false);
    }
    let current = belief.current();
    let before = super::reduce::projected_bytes(&state, belief);
    let mut cleared = belief.clone();
    cleared.overrides.clear();
    let after = super::reduce::projected_bytes(&state, &cleared);
    let (schema_v, batch_id, idempotency_key, actor) = common_body(Actor {
        id: "system:knowledge-log".to_string(),
    });
    let body = schema::ProjectionOverridden {
        schema: schema_v,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: belief_id.clone(),
        path: "log.md".to_string(),
        base_belief_revision: current.revision,
        base_belief_revision_event: current.event_id.clone(),
        base_generating_event: belief.projection_head_event.clone(),
        before_projection_hash: crate::ledger::sha256_hex(before.as_bytes()),
        after_projection_hash: crate::ledger::sha256_hex(after.as_bytes()),
        origin: schema::OverrideOrigin::InApp,
        change: schema::OverrideChange::Clear {
            override_event_ids: belief
                .overrides
                .iter()
                .map(|o| o.event_id.clone())
                .collect(),
            reason: "the knowledge log is a derived view — overrides retired".to_string(),
        },
    };
    writer.append(
        schema::KIND_PROJECTION_OVERRIDDEN,
        serde_json::to_value(&body).map_err(|e| e.to_string())?,
    )?;
    Ok(true)
}

/// Test seam for other ledger modules' tests.
#[cfg(test)]
pub(crate) fn tests_append_log(writer: &mut LedgerWriter, vault: &Path, rel: &str, title: &str) {
    append_log_with(writer, vault, rel, title, false).unwrap();
}

fn append_log_with(
    writer: &mut LedgerWriter,
    vault: &Path,
    concept_rel: &str,
    title: &str,
    existed: bool,
) -> Result<(), String> {
    clear_log_overrides_with(writer, vault)?;
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

    /// The pin the Verify button sends (M49.3): the hash of the body the
    /// person read — here, what is on disk.
    fn viewed(vault: &Path, rel: &str) -> String {
        crate::ledger::sha256_hex(
            crate::vault::write::read_note(vault, rel)
                .unwrap()
                .as_bytes(),
        )
    }

    fn fm(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    }

    /// Approve every queued set and resolve it — the human half of the
    /// governed path, driven from the ledger exactly as the M24.9 review
    /// surface will drive it (nothing here consults the runtime DB).
    fn approve_and_resolve(writer: &mut LedgerWriter, vault: &Path) {
        use crate::policy::commit;
        let table = crate::policy::table::PolicyTable::load().unwrap();
        let state = current_state(writer, vault).unwrap();
        for set in commit::pending_sets(&state) {
            for proposal_id in &set.ordered_proposal_ids {
                commit::record_decision(
                    writer,
                    vault,
                    proposal_id,
                    schema::Decision::Approve,
                    "human:me",
                    None,
                    "2026-08-09T11:00:00Z",
                )
                .unwrap();
            }
            commit::resolve_commit_set(
                &table,
                writer,
                vault,
                &set.run_id,
                &set.ordered_proposal_ids,
            )
            .unwrap();
        }
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
    fn a_rough_note_is_never_blocked_by_a_qualification_gate() {
        // M24.6's other half. The type declares two roles and the note fills
        // neither — and it is written anyway, because half-finished thoughts
        // are the normal state of a vault. Only PROMOTION is gated; capture
        // never is, or the app would be arguing with someone who is still
        // thinking.
        let vault = testutil::temp_vault("concepts-rough-note");
        std::fs::create_dir_all(vault.join("types")).unwrap();
        std::fs::write(
            vault.join("types/metric.md"),
            "---\ntype: Type\nfields:\n  steward: { kind: text, role: owner }\n  \
             breaks_when: { kind: text, role: failure_condition }\n---\n\n# Metric\n",
        )
        .unwrap();
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();

        write_concept_with(
            &mut writer,
            &vault,
            "knowledge/concepts/half-a-thought.md",
            &fm(&[
                ("type", serde_json::json!("Metric")),
                ("title", serde_json::json!("Half a thought")),
            ]),
            "# Half a thought\n\nSomething about retention, maybe.",
        )
        .unwrap();

        let state = current_state(&writer, &vault).unwrap();
        let belief_id = state.projection_paths["concepts/half-a-thought.md"].clone();
        assert_eq!(
            state.beliefs[&belief_id].qualification,
            schema::Qualification::Draft,
            "it lands as a draft — unqualified is a state, not a refusal"
        );
        assert!(vault.join("knowledge/concepts/half-a-thought.md").exists());
        let _ = std::fs::remove_dir_all(&vault);
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

        // pick-queue-drain.md is migrated and UNVERIFIED, so the revise and
        // relation-add rungs both auto-apply; rewrite it with a new body, a
        // new relation to the pilot, and no aliases key.
        let rel = "knowledge/systems/pick-queue-drain.md";
        let frontmatter = fm(&[
            ("type", serde_json::json!("Reference")),
            ("title", serde_json::json!("Pick queue drain")),
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
            "# Pick queue drain\n\nRewritten.",
        )
        .unwrap();

        let state = current_state(&writer, &vault).unwrap();
        let belief_id = schema::migrate_id(&store, "belief", "systems/pick-queue-drain.md");
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
    fn approving_a_supersession_card_is_read_as_the_persons_agreement() {
        // A verified concept, then an agent's replacement: the supersede
        // queues (M49.8, K22). Approving the card is the agreement — the
        // readers must retire the old claim then, not only once someone
        // separately verifies the replacement.
        let vault = corpus_copy("concepts-approved-supersession");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        let old = "knowledge/systems/status-model.md";
        let new = "knowledge/systems/status-model-v2.md";
        let mut frontmatter = concept_frontmatter();
        frontmatter.insert("supersedes".into(), serde_json::json!(["[[status-model]]"]));
        let queued = write_concept_with(
            &mut writer,
            &vault,
            new,
            &frontmatter,
            "# Status model v2\n",
        )
        .unwrap_err();
        assert!(queued.starts_with("queued_for_review"), "{queued}");
        let pair = (new.to_string(), old.to_string());
        let state = current_state(&writer, &vault).unwrap();
        assert!(
            !crate::knowledge::approved_supersessions(&state).contains(&pair),
            "a queued card is not an agreement"
        );

        approve_and_resolve(&mut writer, &vault);
        let state = current_state(&writer, &vault).unwrap();
        assert!(crate::knowledge::approved_supersessions(&state).contains(&pair));

        // The person later drops the edge, and some other hand puts it back
        // in the file: the approval was for the add IT made, not this one.
        let approved_file = std::fs::read_to_string(vault.join(new)).unwrap();
        let link = "supersedes:\n  - \"[[status-model]]\"\n";
        assert!(approved_file.contains(link), "{approved_file}");
        std::fs::write(vault.join(new), approved_file.replace(link, "")).unwrap();
        crate::ledger::capture::capture_out_of_band_with(&mut writer, &vault, new).unwrap();
        std::fs::write(vault.join(new), &approved_file).unwrap();
        crate::ledger::capture::capture_out_of_band_with(&mut writer, &vault, new).unwrap();
        let state = current_state(&writer, &vault).unwrap();
        assert!(!crate::knowledge::approved_supersessions(&state).contains(&pair));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_concept_deleted_outside_cerebro_is_not_brought_back_by_a_write() {
        let vault = testutil::temp_vault("concepts-deleted-stays-deleted");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let rel = "knowledge/concepts/acme.md";
        write_concept_with(&mut writer, &vault, rel, &concept_frontmatter(), "# Acme\n").unwrap();
        std::fs::remove_file(vault.join(rel)).unwrap();

        let head = writer.head();
        let err = write_concept_with(
            &mut writer,
            &vault,
            rel,
            &concept_frontmatter(),
            "# Again\n",
        )
        .unwrap_err();
        assert!(err.contains("was deleted outside Cerebro"), "{err}");
        assert_eq!(writer.head(), head, "refused before anything committed");
        assert!(!vault.join(rel).exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_link_that_became_ambiguous_later_does_not_lock_its_concept() {
        // X links [[churn]] while one concept has that stem; a second one
        // arrives later. X's own edits must still be keepable — only a link
        // an edit ADDS has to name exactly one concept.
        let vault = testutil::temp_vault("concepts-late-ambiguity");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        write_concept_with(
            &mut writer,
            &vault,
            "knowledge/systems/churn.md",
            &concept_frontmatter(),
            "# Churn\n",
        )
        .unwrap();
        let x = "knowledge/concepts/x.md";
        let mut linking = concept_frontmatter();
        linking.insert("supersedes".into(), serde_json::json!(["[[churn]]"]));
        write_concept_with(&mut writer, &vault, x, &linking, "# X\n").unwrap();
        write_concept_with(
            &mut writer,
            &vault,
            "knowledge/metrics/churn.md",
            &concept_frontmatter(),
            "# Churn, the metric\n",
        )
        .unwrap();
        let live = |writer: &LedgerWriter| {
            let state = current_state(writer, &vault).unwrap();
            state.relations.values().filter(|r| r.live).count()
        };
        let relations = live(&writer);

        // A body-only edit in another editor is captured.
        let file = std::fs::read_to_string(vault.join(x)).unwrap();
        std::fs::write(vault.join(x), format!("{file}\nA person's line.\n")).unwrap();
        crate::ledger::capture::capture_out_of_band_with(&mut writer, &vault, x).unwrap();
        // Adding a path link beside the kept ambiguous one relates it; its
        // later removal cannot be told apart from what `[[churn]]` keeps,
        // so it refuses rather than keep the relation live silently.
        let file = std::fs::read_to_string(vault.join(x)).unwrap();
        let both = file.replace("[[churn]]\"", "[[churn]]\"\n  - \"[[metrics/churn]]\"");
        std::fs::write(vault.join(x), &both).unwrap();
        crate::ledger::capture::capture_out_of_band_with(&mut writer, &vault, x).unwrap();
        assert_eq!(live(&writer), relations + 1);
        std::fs::write(vault.join(x), &file).unwrap();
        let err =
            crate::ledger::capture::capture_out_of_band_with(&mut writer, &vault, x).unwrap_err();
        assert!(err.contains("names more than one concept"), "{err}");
        assert_eq!(live(&writer), relations + 1, "nothing recorded");
        std::fs::write(vault.join(x), &both).unwrap();
        crate::ledger::capture::capture_out_of_band_with(&mut writer, &vault, x).unwrap();

        // Respelling the kept link by path names the same concept: no change.
        let file = std::fs::read_to_string(vault.join(x)).unwrap();
        std::fs::write(
            vault.join(x),
            file.replace("[[churn]]", "[[systems/churn]]"),
        )
        .unwrap();
        crate::ledger::capture::capture_out_of_band_with(&mut writer, &vault, x).unwrap();
        assert_eq!(live(&writer), relations + 1);

        // ADDING the ambiguous link still refuses.
        let file = std::fs::read_to_string(vault.join(x)).unwrap();
        let added = file.replacen("---\n", "---\nrefines:\n  - \"[[churn]]\"\n", 1);
        std::fs::write(vault.join(x), added).unwrap();
        let err =
            crate::ledger::capture::capture_out_of_band_with(&mut writer, &vault, x).unwrap_err();
        assert!(err.contains("names more than one concept"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_approved_set_keeps_a_file_made_by_hand_meanwhile_and_is_still_applied() {
        // The post-commit half of the guard: a queued creation is approved
        // after a person hand-made a file at its path. The set is applied
        // (the ledger records it), the file is kept, and the outcome names
        // it — it is not reported as refused.
        use crate::policy::commit;
        let vault = corpus_copy("concepts-approved-over-hand-made");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        let verified = "knowledge/metrics/sync-error-rate.md";
        verify_with(
            &mut writer,
            &vault,
            verified,
            &fm(&[(
                "verified",
                serde_json::json!({ "by": "human:me", "at": "2026-09-27T10:00:00Z" }),
            )]),
            &viewed(&vault, verified),
        )
        .unwrap();
        let new = "knowledge/metrics/sync-error-rate-v2.md";
        let mut frontmatter = concept_frontmatter();
        frontmatter.insert(
            "supersedes".into(),
            serde_json::json!(["[[sync-error-rate]]"]),
        );
        let queued =
            write_concept_with(&mut writer, &vault, new, &frontmatter, "# v2\n").unwrap_err();
        assert!(queued.starts_with("queued_for_review"), "{queued}");
        std::fs::write(vault.join(new), "# Mine\n").unwrap();

        let table = crate::policy::table::PolicyTable::load().unwrap();
        let state = current_state(&writer, &vault).unwrap();
        let set = commit::pending_sets(&state).into_iter().next().unwrap();
        for proposal_id in &set.ordered_proposal_ids {
            commit::record_decision(
                &mut writer,
                &vault,
                proposal_id,
                schema::Decision::Approve,
                "human:me",
                None,
                "2026-09-28T11:00:00Z",
            )
            .unwrap();
        }
        let outcome = commit::resolve_commit_set(
            &table,
            &mut writer,
            &vault,
            &set.run_id,
            &set.ordered_proposal_ids,
        )
        .unwrap();
        assert_eq!(outcome.transition, commit::TransitionCode::Apply);
        assert_eq!(outcome.kept, vec![new.to_string()]);
        assert_eq!(
            std::fs::read_to_string(vault.join(new)).unwrap(),
            "# Mine\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_deleted_concept_is_not_rewritten_in_a_vault_that_never_armed() {
        // No manifest, so no entry proves a write: the writer still refuses
        // a RECORDED concept whose file is gone.
        let vault = corpus_copy("concepts-deleted-no-manifest");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        assert!(manifest_mod::load(&vault).unwrap().is_none());
        let rel = "knowledge/systems/pick-queue-drain.md";
        std::fs::remove_file(vault.join(rel)).unwrap();
        let head = writer.head();
        let err = write_concept_with(&mut writer, &vault, rel, &concept_frontmatter(), "# Back\n")
            .unwrap_err();
        assert!(err.contains("was deleted outside Cerebro"), "{err}");
        assert_eq!(writer.head(), head);
        assert!(!vault.join(rel).exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_governed_apply_never_replaces_a_file_the_manifest_never_recorded() {
        // The no-manifest state (migrated, never armed — what a refused
        // `build_initial` leaves): every path is entry-less, so the write-time
        // guard has nothing recorded to judge by.
        let vault = corpus_copy("concepts-no-manifest-apply");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        assert!(manifest_mod::load(&vault).unwrap().is_none());

        // A person edits one concept in another editor...
        let edited = "knowledge/systems/pick-queue-drain.md";
        let mut bytes = std::fs::read_to_string(vault.join(edited)).unwrap();
        bytes.push_str("\nA line only the person wrote.\n");
        std::fs::write(vault.join(edited), &bytes).unwrap();
        // ...and hand-makes a file at the path an agent is about to claim.
        let claimed = "knowledge/concepts/acme.md";
        std::fs::create_dir_all(vault.join("knowledge/concepts")).unwrap();
        std::fs::write(vault.join(claimed), "# Acme\n\nMine.\n").unwrap();

        // An unrelated agent write commits, and leaves the edited file alone.
        write_concept_with(
            &mut writer,
            &vault,
            "knowledge/concepts/churn.md",
            &concept_frontmatter(),
            "# Churn\n",
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(vault.join(edited)).unwrap(), bytes);

        // Claiming the hand-made path refuses before anything commits.
        let head = writer.head();
        let err = write_concept_with(
            &mut writer,
            &vault,
            claimed,
            &concept_frontmatter(),
            "# Acme\n",
        )
        .unwrap_err();
        assert!(err.contains(manifest_mod::PROJECTION_DISK_CHANGED), "{err}");
        assert_eq!(writer.head(), head);
        assert_eq!(
            std::fs::read_to_string(vault.join(claimed)).unwrap(),
            "# Acme\n\nMine.\n"
        );
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
        verify_with(&mut writer, &vault, rel, &patch, &viewed(&vault, rel)).unwrap();

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
        verify_with(&mut writer, &vault, rel, &patch, &viewed(&vault, rel)).unwrap();
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
            &viewed(&vault, rel),
        )
        .unwrap();

        // The agent rewrites the VERIFIED concept. Under M24 that is a HIGH
        // transition (`target_has_attestation`), so it queues rather than
        // applying — and the message says so instead of reporting a success
        // the file did not get.
        let frontmatter = fm(&[
            ("type", serde_json::json!("Metric")),
            ("title", serde_json::json!("Sync error rate")),
            (
                "generated",
                serde_json::json!({ "by": "agent:run-3", "at": "2026-08-09" }),
            ),
        ]);
        let queued = write_concept_with(
            &mut writer,
            &vault,
            rel,
            &frontmatter,
            "# Sync error rate\n\nRewritten.",
        )
        .unwrap_err();
        assert!(queued.starts_with("queued_for_review:"), "{queued}");
        assert!(queued.contains("HIGH"), "{queued}");
        // ...and nothing changed on disk while it waits.
        assert!(std::fs::read_to_string(vault.join(rel))
            .unwrap()
            .contains("verified: { by: human:me"));

        // A human approves, and the same set applies. Everything below this
        // line is the M23 rendering contract, unchanged — reached through
        // the governed path instead of around it.
        approve_and_resolve(&mut writer, &vault);

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
            "commit-set-apply-committed",
            &vault,
        );
        assert!(
            !status.success(),
            "the child dies after the marker is durable, before projection"
        );

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

    // M49.3 (K6): files win. A concept changed outside the ledger is never
    // written over — an agent rewrite and a Verify both refuse BEFORE
    // anything commits, and the hand edit survives byte for byte.
    #[test]
    fn a_hand_edited_concept_refuses_rewrite_and_verify_and_keeps_the_edit() {
        let vault = corpus_copy("concepts-hand-edited");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        // An armed vault's state: the manifest records every projection.
        let armed = current_state(&writer, &vault).unwrap();
        let recorded = manifest::build_initial(&vault, writer.store_id(), &armed)
            .unwrap()
            .expect("the corpus byte-matches its projections");
        manifest::save(&vault, &recorded).unwrap();
        let rel = "knowledge/metrics/sync-error-rate.md";
        let edited = format!(
            "{}\nA line someone added in another editor.\n",
            std::fs::read_to_string(vault.join(rel)).unwrap()
        );
        std::fs::write(vault.join(rel), &edited).unwrap();
        let head = writer.head();

        let rewrite = write_concept_with(
            &mut writer,
            &vault,
            rel,
            &fm(&[
                ("type", serde_json::json!("Metric")),
                ("title", serde_json::json!("Sync error rate")),
                ("description", serde_json::json!("Rewritten by an agent.")),
            ]),
            "The agent's version.",
        )
        .unwrap_err();
        assert!(
            rewrite.starts_with(manifest::PROJECTION_DISK_CHANGED),
            "{rewrite}"
        );

        let stamp = fm(&[(
            "verified",
            serde_json::json!({ "by": "human:me", "at": "2026-09-26T10:00:00Z" }),
        )]);
        // Verifying the edited body the person is looking at: it is not the
        // recorded text, so the ledger's version is not attested over it.
        let verify = verify_with(&mut writer, &vault, rel, &stamp, &viewed(&vault, rel));
        assert!(
            verify
                .unwrap_err()
                .starts_with(manifest::PROJECTION_DISK_CHANGED),
            "verify refuses a file that differs from recorded history"
        );

        assert_eq!(writer.head(), head, "nothing committed");
        assert_eq!(std::fs::read_to_string(vault.join(rel)).unwrap(), edited);

        // The Restore exit is the one deliberate overwrite.
        let state = current_state(&writer, &vault).unwrap();
        let belief = state.projection_paths["metrics/sync-error-rate.md"].clone();
        let projection = project_belief(&state, &belief).unwrap();
        assert!(manifest::write_projection(&vault, rel, &projection)
            .unwrap_err()
            .starts_with(manifest::PROJECTION_DISK_CHANGED));
        manifest::restore_projection(&vault, rel, &projection).unwrap();
        assert_eq!(
            std::fs::read_to_string(vault.join(rel)).unwrap(),
            projection.bytes
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M49.3 (K6): the stamp attests the body the person READ.
    #[test]
    fn verify_refuses_a_body_that_changed_since_it_was_read() {
        let vault = corpus_copy("concepts-stale-view");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        let rel = "knowledge/metrics/sync-error-rate.md";
        let read_before = viewed(&vault, rel);
        let head = writer.head();
        let stamp = fm(&[(
            "verified",
            serde_json::json!({ "by": "human:me", "at": "2026-09-26T10:00:00Z" }),
        )]);
        let err =
            verify_with(&mut writer, &vault, rel, &stamp, "not-the-body-on-disk").unwrap_err();
        assert!(err.starts_with(STALE_VIEW), "{err}");
        assert_eq!(writer.head(), head);
        // The body that IS on disk verifies.
        verify_with(&mut writer, &vault, rel, &stamp, &read_before).unwrap();
        assert_ne!(writer.head(), head);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The log is a derived, system-owned view (the 2026-09 owner decision):
    // regenerated over a hand edit rather than guarded.
    #[test]
    fn the_knowledge_log_is_regenerated_over_a_hand_edit() {
        let vault = corpus_copy("concepts-log-derived");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        let log = vault.join(crate::knowledge::LOG_PATH);
        if log.exists() {
            let hand = format!("{}\nhand edit\n", std::fs::read_to_string(&log).unwrap());
            std::fs::write(&log, hand).unwrap();
        }
        append_log_with(
            &mut writer,
            &vault,
            "knowledge/metrics/sync-error-rate.md",
            "Sync",
            true,
        )
        .unwrap();
        assert!(!std::fs::read_to_string(&log).unwrap().contains("hand edit"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M49.7 (K19): "still true" is a stamp, not a rewrite. A no-op writes
    // nothing; a new date moves stale_after and nothing else — no log line,
    // no restamped `generated`; a verified concept is the person's.
    #[test]
    fn a_recheck_moves_only_stale_after_and_a_no_op_writes_nothing() {
        let vault = corpus_copy("concepts-recheck");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        let rel = "knowledge/systems/pick-queue-drain.md";
        let log = vault.join(crate::knowledge::LOG_PATH);
        let log_before = std::fs::read_to_string(&log).ok();
        let before = std::fs::read_to_string(vault.join(rel)).unwrap();

        let head = writer.head();
        assert_eq!(
            recheck_with(
                &mut writer,
                &vault,
                rel,
                "2027-01-15",
                "agent:recheck",
                None
            )
            .unwrap(),
            Rechecked::Stamped
        );
        assert_ne!(writer.head(), head);
        let after = std::fs::read_to_string(vault.join(rel)).unwrap();
        assert!(after.contains("stale_after: 2027-01-15"), "{after}");
        // Only that line moved.
        let changed: Vec<(&str, &str)> = before
            .lines()
            .zip(after.lines())
            .filter(|(a, b)| a != b)
            .collect();
        assert!(
            changed.iter().all(|(_, b)| b.starts_with("stale_after:")),
            "{changed:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&log).ok(),
            log_before,
            "no log line"
        );

        let head = writer.head();
        assert_eq!(
            recheck_with(
                &mut writer,
                &vault,
                rel,
                "2027-01-15",
                "agent:recheck",
                None
            )
            .unwrap(),
            Rechecked::Unchanged
        );
        assert_eq!(writer.head(), head, "a no-op appends nothing");

        // A verified concept refuses, and nothing is appended.
        let verified = "knowledge/metrics/sync-error-rate.md";
        verify_with(
            &mut writer,
            &vault,
            verified,
            &fm(&[(
                "verified",
                serde_json::json!({ "by": "human:me", "at": "2026-09-27T10:00:00Z" }),
            )]),
            &viewed(&vault, verified),
        )
        .unwrap();
        let head = writer.head();
        let err = recheck_with(
            &mut writer,
            &vault,
            verified,
            "2027-01-15",
            "agent:recheck",
            None,
        )
        .unwrap_err();
        assert!(err.contains("is verified"), "{err}");
        assert_eq!(writer.head(), head);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // A machine's confirmation is not a person's: the recheck goes to the
    // table, which floors an attested belief at a card, instead of being
    // refused and leaving the concept stale for good.
    #[test]
    fn a_recheck_of_a_machine_confirmed_concept_waits_for_a_person() {
        let vault = testutil::temp_vault("concepts-recheck-machine");
        let dir = vault.join("knowledge");
        std::fs::create_dir_all(dir.join("metrics")).unwrap();
        std::fs::write(
            dir.join("metrics/nightly.md"),
            concat!(
                "---\n",
                "type: Metric\n",
                "title: Nightly\n",
                "verified: { by: \"process:metrics-nightly\", at: 2026-08-01 }\n",
                "---\n",
                "\n# Nightly\n"
            ),
        )
        .unwrap();
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &dir).unwrap();
        // The file as the ledger renders it, so the disk is the ledger's.
        let state = current_state(&writer, &vault).unwrap();
        let belief = &state.projection_paths["metrics/nightly.md"];
        let bytes = project_belief(&state, belief).unwrap().bytes;
        std::fs::write(dir.join("metrics/nightly.md"), bytes).unwrap();
        let err = recheck_with(
            &mut writer,
            &vault,
            "knowledge/metrics/nightly.md",
            "2099-01-01",
            "agent:recheck",
            None,
        )
        .unwrap_err();
        assert!(err.starts_with("queued_for_review"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The stamp is a proposal like any revision: on a hub the table's
    // `lineage_fan_in` escalator queues it for a person, where a hand-coded
    // "unattested, so auto-apply" check let it straight through.
    #[test]
    fn a_recheck_of_a_hub_waits_for_a_person() {
        let vault = testutil::temp_vault("concepts-recheck-hub");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let hub = "knowledge/concepts/hub.md";
        write_concept_with(&mut writer, &vault, hub, &concept_frontmatter(), "# Hub\n").unwrap();
        for n in 0..6 {
            let mut refining = concept_frontmatter();
            refining.insert("refines".into(), serde_json::json!(["[[hub]]"]));
            write_concept_with(
                &mut writer,
                &vault,
                &format!("knowledge/concepts/spoke-{n}.md"),
                &refining,
                "# Spoke\n",
            )
            .unwrap();
        }
        let before = std::fs::read_to_string(vault.join(hub)).unwrap();
        let err = recheck_with(
            &mut writer,
            &vault,
            hub,
            "2099-01-01",
            "agent:recheck",
            None,
        )
        .unwrap_err();
        assert!(err.starts_with("queued_for_review"), "{err}");
        assert_eq!(std::fs::read_to_string(vault.join(hub)).unwrap(), before);
        // M50.3: the card names the concept it would change, so it can open.
        let state = current_state(&writer, &vault).unwrap();
        let table = crate::policy::table::PolicyTable::load().unwrap();
        let cards = crate::policy::review::needs_review(&table, &state);
        assert!(
            cards
                .iter()
                .flat_map(|card| &card.targets)
                .any(|target| target.path.as_deref() == Some(hub)),
            "{cards:#?}"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M49.8 (K22): `supersedes` against a human-verified concept is a change
    // TO that concept, so it floors at HIGH and waits for a person — it used
    // to auto-apply at MEDIUM and retire the verified claim with no card.
    #[test]
    fn superseding_a_verified_concept_waits_for_a_person() {
        let vault = corpus_copy("concepts-supersede-verified");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        let verified = "knowledge/metrics/sync-error-rate.md";
        verify_with(
            &mut writer,
            &vault,
            verified,
            &fm(&[(
                "verified",
                serde_json::json!({ "by": "human:me", "at": "2026-09-27T10:00:00Z" }),
            )]),
            &viewed(&vault, verified),
        )
        .unwrap();

        let queued = write_concept_with(
            &mut writer,
            &vault,
            "knowledge/metrics/sync-error-rate-v2.md",
            &fm(&[
                ("type", serde_json::json!("Metric")),
                ("title", serde_json::json!("Sync error rate, v2")),
                ("supersedes", serde_json::json!(["[[sync-error-rate]]"])),
                (
                    "generated",
                    serde_json::json!({ "by": "agent:run-9", "at": "2026-09-27" }),
                ),
            ]),
            "# Sync error rate, v2\n\nA newer claim.",
        )
        .unwrap_err();
        assert!(queued.starts_with("queued_for_review:"), "{queued}");
        assert!(queued.contains("HIGH"), "{queued}");
        let state = current_state(&writer, &vault).unwrap();
        let old = schema::migrate_id(&store, "belief", "metrics/sync-error-rate.md");
        assert!(
            !state
                .relations
                .values()
                .any(|r| r.live && r.to == old && r.relation == RelationKind::Supersedes),
            "nothing retires the verified claim while it waits"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M50.3: a run's detail names what it changed, read back from the
    // ledger's own proposals — it used to say "1 applied" and name nothing.
    #[test]
    fn a_run_names_the_concepts_it_changed() {
        const RUN: &str = "98888888888888888888888888888888";
        let vault = corpus_copy("concepts-run-writes");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        write_concept_in_run_with(
            &mut writer,
            &vault,
            "knowledge/metrics/named.md",
            &fm(&[
                ("type", serde_json::json!("Metric")),
                ("title", serde_json::json!("Named")),
                ("description", serde_json::json!("A concept a run wrote.")),
            ]),
            "# Named\n\nWritten inside a run.",
            Some(RUN),
        )
        .unwrap();

        let state = current_state(&writer, &vault).unwrap();
        assert_eq!(
            crate::knowledge::run_writes(&state, RUN),
            vec![crate::knowledge::RunWrite {
                path: "knowledge/metrics/named.md".into(),
                state: "applied".into(),
            }],
        );
        // Another run changed nothing here — measured, and said as empty.
        assert!(
            crate::knowledge::run_writes(&state, "97777777777777777777777777777777").is_empty()
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M49.9 (K25): a write made inside a run is booked on that run — its
    // proposals carry the run's id and its row counts what was applied.
    // The counters were inserted as 0 and never written.
    #[test]
    fn a_write_in_a_run_is_booked_on_that_runs_row() {
        let _sink = crate::runtime::sink::test_lock();
        let vault = corpus_copy("concepts-booked");
        crate::runtime::sink::arm(&vault).unwrap();
        // Opened the way production opens an attended run's row: before the
        // CLI starts, so the writes it makes are booked on it.
        crate::runtime::sink::with_sink(|conn| {
            crate::runtime::dispatch::begin_attended(
                conn,
                "99999999999999999999999999999999",
                None,
                None,
                None,
                None,
                chrono::Utc::now(),
            )
        })
        .unwrap()
        .unwrap();
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();

        write_concept_in_run_with(
            &mut writer,
            &vault,
            "knowledge/metrics/booked.md",
            &fm(&[
                ("type", serde_json::json!("Metric")),
                ("title", serde_json::json!("Booked")),
                ("description", serde_json::json!("A concept a run wrote.")),
            ]),
            "# Booked\n\nWritten inside a run.",
            Some("99999999999999999999999999999999"),
        )
        .unwrap();

        let (submitted, applied, rejected): (i64, i64, i64) =
            crate::runtime::sink::with_sink(|conn| {
                conn.query_row(
                    "SELECT proposals_submitted, applied, rejected FROM runs WHERE run_id = '99999999999999999999999999999999'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .unwrap()
            .unwrap();
        assert!(submitted >= 1, "submitted {submitted}");
        assert_eq!((applied, rejected), (submitted, 0));

        // A recheck in the same run is a proposal too, and counts on the
        // same row — it used to be filed under an id derived from the path.
        assert_eq!(
            recheck_with(
                &mut writer,
                &vault,
                "knowledge/metrics/booked.md",
                "2099-01-01",
                "agent:recheck",
                Some("99999999999999999999999999999999"),
            )
            .unwrap(),
            Rechecked::Stamped
        );
        let after: (i64, i64) = crate::runtime::sink::with_sink(|conn| {
            conn.query_row(
                "SELECT proposals_submitted, applied FROM runs WHERE run_id = '99999999999999999999999999999999'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap()
        .unwrap();
        assert_eq!(after, (submitted + 1, applied + 1));
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert!(read
            .frames
            .iter()
            .filter(|f| f.kind.starts_with("proposal."))
            .any(|f| f
                .body
                .to_string()
                .contains("\"99999999999999999999999999999999\"")));
        crate::runtime::sink::disarm();
        let _ = std::fs::remove_dir_all(&vault);
    }
}
