//! Knowledge bundle boundary (M5).
//!
//! `knowledge/` is an Open Knowledge Format bundle maintained by the AI
//! knowledge base. Humans read and VERIFY it; they do not edit it. That
//! boundary is enforced here, at the IPC layer, rather than by disabling
//! buttons in the UI — a disabled button is a suggestion, a rejected
//! command is a rule. The agent's own tool path calls `vault::write`
//! directly and is unaffected.
//!
//! Verification is the one exception, and it is deliberately narrow:
//! `verify_concept` may touch the `verified` key and nothing else. Without
//! it the format's `human-reviewed` trust tier would be unreachable and the
//! whole provenance ledger would be decorative.

use serde_json::{Map, Value};

pub const KNOWLEDGE_DIR: &str = "knowledge";

/// True for the bundle root and anything beneath it. The trailing slash
/// matters: a sibling `knowledge-archive/` is NOT part of the bundle.
pub fn is_knowledge_path(path: &str) -> bool {
    path == KNOWLEDGE_DIR || path.starts_with(&format!("{KNOWLEDGE_DIR}/"))
}

const READ_ONLY: &str = "knowledge/ is maintained by the AI knowledge base and is read-only here. \
Verify the concept, or ask the agent to revise it.";

/// Reject a write from the human-facing UI into the bundle.
pub fn guard_human_write(path: &str) -> Result<(), String> {
    if is_knowledge_path(path) {
        return Err(READ_ONLY.to_string());
    }
    Ok(())
}

/// A move must be refused from BOTH sides: dragging a concept out would
/// strip it of the boundary, dragging a note in would smuggle human content
/// into the agent's corpus.
pub fn guard_human_move(from: &str, to: &str) -> Result<(), String> {
    guard_human_write(from)?;
    guard_human_write(to)
}

/// `verify_concept` is scoped to concepts, and to the `verified` key alone —
/// it must not become a general-purpose way around `guard_human_write`.
pub fn guard_verify(path: &str, patch: &Map<String, Value>) -> Result<(), String> {
    if !is_knowledge_path(path) {
        return Err("verify_concept only applies to knowledge/ concepts".to_string());
    }
    for key in patch.keys() {
        if key != "verified" {
            return Err(format!("verify_concept may only write `verified`, not `{key}`"));
        }
    }
    if patch.is_empty() {
        return Err("verify_concept requires a `verified` value".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect()
    }

    #[test]
    fn recognizes_the_bundle_but_not_a_lookalike_sibling() {
        assert!(is_knowledge_path("knowledge"));
        assert!(is_knowledge_path("knowledge/metrics/revenue.md"));
        assert!(!is_knowledge_path("knowledge-archive/old.md"));
        assert!(!is_knowledge_path("records/risks/r.md"));
        assert!(!is_knowledge_path("my-knowledge/x.md"));
    }

    #[test]
    fn human_writes_into_the_bundle_are_refused() {
        assert!(guard_human_write("knowledge/metrics/revenue.md").is_err());
        assert!(guard_human_write("docs/notes.md").is_ok());
    }

    #[test]
    fn moves_are_refused_from_both_directions() {
        // Out of the bundle: would strip the concept of its boundary.
        assert!(guard_human_move("knowledge/a.md", "docs/a.md").is_err());
        // Into the bundle: would smuggle human content into the agent corpus.
        assert!(guard_human_move("docs/a.md", "knowledge/a.md").is_err());
        assert!(guard_human_move("docs/a.md", "docs/b.md").is_ok());
    }

    #[test]
    fn verify_is_scoped_to_concepts_and_to_the_verified_key() {
        let ok = patch(&[("verified", Value::Array(vec![]))]);
        assert!(guard_verify("knowledge/a.md", &ok).is_ok());

        // Not a concept.
        assert!(guard_verify("docs/a.md", &ok).is_err());

        // Must not become a general-purpose bypass of guard_human_write.
        let sneaky = patch(&[
            ("verified", Value::Array(vec![])),
            ("description", Value::String("rewritten".into())),
        ]);
        assert!(guard_verify("knowledge/a.md", &sneaky).is_err());

        assert!(guard_verify("knowledge/a.md", &patch(&[])).is_err());
    }
}
