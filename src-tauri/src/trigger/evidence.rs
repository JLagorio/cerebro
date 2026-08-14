//! The evidence-pack validator (M28.0f).
//!
//! A discretionary gate's record points at a dated markdown pack under
//! `docs/superpowers/evidence/triggers/<registry-id>/`; this module is what
//! makes that pointer LOAD-BEARING. It parses the pack's frontmatter,
//! recomputes the canonical evidence hash, and checks that the pack and the
//! record agree about gate, scope, owner, and parent — so a record cannot
//! wear a pack that says something else, and a pack cannot be edited after
//! the fact without every derived hash refusing.
//!
//! **The hash excludes the record's own half, structurally.** Frontmatter
//! lines beginning `evaluation_` carry the RECORD's side (its id, its
//! result) for a reader's convenience; they are stripped before hashing,
//! line by line, so the hash is a function of the EVIDENCE alone and never
//! of itself. The exclusion rule is textual on purpose: byte-identical in
//! any language, no YAML parser to disagree over.
//!
//! **Pack format** — flat frontmatter between `---` fences, then prose:
//!
//! ```markdown
//! ---
//! gate: R4:issue
//! scope: vault_store:<vault_id>:<store_uuid>
//! owner: josef
//! decided_at: 2026-08-14
//! parent_evaluation: <sha256>        # exactly when the gate has a parent
//! evaluation_id: <sha256>            # the record half — excluded from the hash
//! evaluation_result: not_fired       # excluded from the hash
//! ---
//! The consumer, the workflow, the three persisted examples, the failure of
//! the current primitive, the boundary, and the goldens — prose, hashed.
//! ```

use std::collections::BTreeMap;

use crate::trigger::evaluation::{
    derive_input_snapshot_hash, EvaluationScope, Refusal, TriggerEvaluation,
};
use crate::trigger::registry::Registry;

fn refuse(code: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        code,
        detail: detail.into(),
    }
}

/// A parsed pack: its flat frontmatter and the canonical payload the hash
/// is over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pack {
    pub frontmatter: BTreeMap<String, String>,
    /// Every byte of the pack EXCEPT the `evaluation_*` frontmatter lines.
    pub canonical_payload: String,
}

/// Parse pack bytes. The frontmatter must open the file, `---` fenced, one
/// flat `key: value` per line — a pack is a record for review, not a place
/// for structure the hash rule would then have to canonicalize.
pub fn parse_pack(bytes: &str) -> Result<Pack, Refusal> {
    let mut lines = bytes.lines();
    if lines.next() != Some("---") {
        return Err(refuse(
            "evidence_pack_invalid",
            "a pack opens with --- frontmatter",
        ));
    }
    let mut frontmatter = BTreeMap::new();
    let mut canonical: Vec<&str> = vec!["---"];
    let mut closed = false;
    for line in lines.by_ref() {
        if line == "---" {
            closed = true;
            canonical.push(line);
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            return Err(refuse(
                "evidence_pack_invalid",
                format!("frontmatter line {line:?} is not `key: value`"),
            ));
        };
        let key = key.trim().to_string();
        let value = value.trim().to_string();
        if !key.starts_with("evaluation_") {
            canonical.push(line);
        }
        if frontmatter.insert(key.clone(), value).is_some() {
            return Err(refuse(
                "evidence_pack_invalid",
                format!("frontmatter key {key:?} is declared twice"),
            ));
        }
    }
    if !closed {
        return Err(refuse(
            "evidence_pack_invalid",
            "the frontmatter fence never closes",
        ));
    }
    let mut body = false;
    for line in lines {
        canonical.push(line);
        body |= !line.trim().is_empty();
    }
    if !body {
        return Err(refuse(
            "evidence_pack_invalid",
            "a pack with no prose is a pointer to nothing — the consumer, examples, and \
             boundary are the whole point",
        ));
    }
    Ok(Pack {
        frontmatter,
        canonical_payload: canonical.join("\n"),
    })
}

/// Check one record against its pack's bytes, recomputing the hash. For a
/// hybrid record the runtime half rides beside the evidence in the hash, so
/// `runtime_part` carries `(snapshot_id, payload_json)` exactly when the
/// record's variant does.
pub fn check(
    record: &TriggerEvaluation,
    pack_bytes: &str,
    runtime_part: Option<(&str, &str)>,
    registry: &Registry,
) -> Result<(), Refusal> {
    let Some(path) = record.evidence_pack_path.as_deref() else {
        return Err(refuse(
            "evidence_pack_invalid",
            "the record names no evidence pack — nothing to check",
        ));
    };
    let pack = parse_pack(pack_bytes)?;

    let expect = |key: &str| -> Result<&str, Refusal> {
        pack.frontmatter
            .get(key)
            .map(String::as_str)
            .ok_or_else(|| {
                refuse(
                    "evidence_pack_invalid",
                    format!("the pack declares no {key:?}"),
                )
            })
    };
    if expect("gate")? != record.gate_key.canonical() {
        return Err(refuse(
            "evidence_pack_invalid",
            format!(
                "the pack is about {:?} and the record about {:?}",
                pack.frontmatter.get("gate"),
                record.gate_key.canonical()
            ),
        ));
    }
    let scope = match &record.scope {
        EvaluationScope::SubscriptionGlobal => "subscription_global".to_string(),
        scope => scope.canonical(),
    };
    if expect("scope")? != scope {
        return Err(refuse(
            "evidence_pack_invalid",
            "the pack and record disagree about scope",
        ));
    }
    if Some(expect("owner")?) != record.approving_owner.as_deref() {
        return Err(refuse(
            "evidence_pack_invalid",
            "the pack's deciding owner and the record's approving owner disagree",
        ));
    }
    let dated = expect("decided_at")?;
    if chrono::NaiveDate::parse_from_str(dated, "%Y-%m-%d").is_err() {
        return Err(refuse(
            "evidence_pack_invalid",
            format!("decided_at {dated:?} is not a date"),
        ));
    }
    match (
        pack.frontmatter.get("parent_evaluation"),
        &record.parent_evaluation_id,
    ) {
        (None, None) => {}
        (Some(pack_parent), Some(record_parent)) if pack_parent == record_parent => {}
        (pack_parent, record_parent) => {
            return Err(refuse(
                "evidence_pack_invalid",
                format!(
                    "the pack names parent {pack_parent:?} and the record {record_parent:?} — \
                     a tail's evidence must be about the parent it actually waited for"
                ),
            ));
        }
    }

    let mut parts = vec![(
        "evidence".to_string(),
        path.to_string(),
        pack.canonical_payload.clone(),
    )];
    if let Some((snapshot_id, payload_json)) = runtime_part {
        parts.push((
            "runtime".to_string(),
            snapshot_id.to_string(),
            payload_json.to_string(),
        ));
    }
    let recomputed = derive_input_snapshot_hash(&registry.snapshot_hash_domain, &parts);
    if recomputed != record.input_snapshot_hash {
        return Err(refuse(
            "evidence_pack_invalid",
            format!(
                "the evidence hash does not recompute: record {}, pack {recomputed} — the pack \
                 moved after the record was minted, or the record was minted over a different pack",
                record.input_snapshot_hash
            ),
        ));
    }
    Ok(())
}

/// Read and check a pack from disk, resolving the record's path against the
/// repository root. "The path must resolve" is this function's half; the
/// byte checks are [`check`]'s.
pub fn check_on_disk(
    record: &TriggerEvaluation,
    repo_root: &std::path::Path,
    runtime_part: Option<(&str, &str)>,
    registry: &Registry,
) -> Result<(), Refusal> {
    let Some(path) = record.evidence_pack_path.as_deref() else {
        return Err(refuse(
            "evidence_pack_invalid",
            "the record names no evidence pack",
        ));
    };
    let bytes = std::fs::read_to_string(repo_root.join(path)).map_err(|e| {
        refuse(
            "evidence_pack_invalid",
            format!("{path:?} does not resolve from the repository root: {e}"),
        )
    })?;
    check(record, &bytes, runtime_part, registry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trigger::evaluation::{
        derive_evaluation_id, GateKey, InputSnapshotRef, TriggerResult,
    };
    use crate::trigger::registry::{self, Variant};

    const PATH: &str = "docs/superpowers/evidence/triggers/R4/2026-08-14-issue-consumer.md";

    fn pack_bytes() -> String {
        [
            "---",
            "gate: R4:issue",
            "scope: vault_store:0123456789abcdef0123456789abcdef:feedfacefeedfacefeedfacefeedface",
            "owner: josef",
            "decided_at: 2026-08-14",
            "evaluation_id: to-be-filled",
            "evaluation_result: not_fired",
            "---",
            "",
            "## Consumer",
            "The weekly review workflow, which currently re-derives issue state by hand.",
            "",
            "## Persisted examples",
            "records/issues/a.md · records/issues/b.md · records/issues/c.md",
        ]
        .join("\n")
    }

    fn record_for(bytes: &str) -> TriggerEvaluation {
        let registry = registry::load().unwrap();
        let pack = parse_pack(bytes).unwrap();
        let hash = derive_input_snapshot_hash(
            &registry.snapshot_hash_domain,
            &[(
                "evidence".to_string(),
                PATH.to_string(),
                pack.canonical_payload,
            )],
        );
        let gate_key = GateKey {
            registry_id: "R4".into(),
            subcapability: "issue".into(),
        };
        let scope = crate::trigger::evaluation::EvaluationScope::VaultStore {
            vault_id: "0123456789abcdef0123456789abcdef".into(),
            store_uuid: "feedfacefeedfacefeedfacefeedface".into(),
        };
        TriggerEvaluation {
            variant: Variant::Discretionary,
            evaluation_id: derive_evaluation_id(
                &registry.evaluation_id_domain,
                &gate_key,
                &scope,
                &registry.rule_version,
                &hash,
            ),
            gate_key,
            scope,
            evaluated_at: "2026-08-14T09:00:00Z".into(),
            window: None,
            input_snapshot_refs: vec![InputSnapshotRef::Evidence { path: PATH.into() }],
            input_snapshot_hash: hash,
            metrics: vec![],
            evidence_pack_path: Some(PATH.into()),
            result: TriggerResult::NotFired,
            rule_version: registry.rule_version.clone(),
            approving_owner: Some("josef".into()),
            parent_evaluation_id: None,
        }
    }

    #[test]
    fn a_matching_pack_checks_and_the_record_itself_validates() {
        let registry = registry::load().unwrap();
        let bytes = pack_bytes();
        let record = record_for(&bytes);
        crate::trigger::evaluation::validate(&record, &registry).unwrap();
        check(&record, &bytes, None, &registry).unwrap();
    }

    #[test]
    fn the_hash_is_not_a_function_of_the_records_own_half() {
        // Editing the excluded `evaluation_*` lines changes NOTHING the hash
        // sees; editing one prose byte refuses. That asymmetry is the whole
        // anti-self-reference design.
        let registry = registry::load().unwrap();
        let bytes = pack_bytes();
        let record = record_for(&bytes);
        let restamped = bytes.replace("evaluation_result: not_fired", "evaluation_result: fired");
        check(&record, &restamped, None, &registry).unwrap();

        let tampered = bytes.replace("by hand", "by hand twice");
        let err = check(&record, &tampered, None, &registry).unwrap_err();
        assert_eq!(err.code, "evidence_pack_invalid");
        assert!(err.detail.contains("does not recompute"), "{}", err.detail);
    }

    #[test]
    fn every_frontmatter_disagreement_refuses_by_name() {
        let registry = registry::load().unwrap();
        let bytes = pack_bytes();
        for (from, to) in [
            ("gate: R4:issue", "gate: R4:risk"),
            ("owner: josef", "owner: somebody"),
            (
                "scope: vault_store:0123456789abcdef0123456789abcdef:feedfacefeedfacefeedfacefeedface",
                "scope: subscription_global",
            ),
            ("decided_at: 2026-08-14", "decided_at: soon"),
        ] {
            let mutated = bytes.replace(from, to);
            // Recompute the hash over the mutated pack so ONLY the checked
            // field disagrees — otherwise every case would fail on the hash
            // and prove nothing about the field checks.
            let mut record = record_for(&mutated);
            record.evidence_pack_path = Some(PATH.into());
            let err = check(&record, &mutated, None, &registry).unwrap_err();
            assert_eq!(err.code, "evidence_pack_invalid", "{from} -> {to}: {}", err.detail);
        }
    }

    #[test]
    fn a_parent_must_be_named_by_both_or_neither() {
        let registry = registry::load().unwrap();
        let bytes = pack_bytes();
        let mut record = record_for(&bytes);
        record.parent_evaluation_id = Some("f".repeat(64));
        let err = check(&record, &bytes, None, &registry).unwrap_err();
        assert!(err.detail.contains("parent"), "{}", err.detail);
    }

    #[test]
    fn a_pack_with_no_prose_is_refused() {
        let empty = "---\ngate: R8:root\nowner: josef\n---\n\n".to_string();
        let err = parse_pack(&empty).unwrap_err();
        assert!(err.detail.contains("pointer to nothing"), "{}", err.detail);
    }

    #[test]
    fn a_hybrid_hash_carries_both_parts_in_tag_order() {
        // The runtime part rides beside the evidence; leaving it out of the
        // recomputation must refuse, which is what makes "hybrid requires
        // exactly both homes" checkable in bytes.
        let registry = registry::load().unwrap();
        let bytes = pack_bytes();
        let pack = parse_pack(&bytes).unwrap();
        let with_runtime = derive_input_snapshot_hash(
            &registry.snapshot_hash_domain,
            &[
                (
                    "evidence".to_string(),
                    PATH.to_string(),
                    pack.canonical_payload.clone(),
                ),
                ("runtime".to_string(), "a".repeat(64), "{}".to_string()),
            ],
        );
        let mut record = record_for(&bytes);
        record.input_snapshot_hash = with_runtime;
        let err = check(&record, &bytes, None, &registry).unwrap_err();
        assert!(err.detail.contains("does not recompute"));
        check(&record, &bytes, Some((&"a".repeat(64), "{}")), &registry).unwrap();
    }
}
