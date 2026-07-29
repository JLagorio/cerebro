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

// --- The update log (M8.2) -------------------------------------------------

pub const LOG_PATH: &str = "knowledge/log.md";
const LOG_HEADING: &str = "# Knowledge Update Log";

/// Bundle-relative link target for a concept: `knowledge/a/b.md` → `/a/b.md`.
fn bundle_link(rel: &str) -> String {
    rel.strip_prefix(KNOWLEDGE_DIR).unwrap_or(rel).to_string()
}

/// Whether writing this path creates a concept or revises one.
pub fn log_kind(existed: bool) -> &'static str {
    if existed {
        "Update"
    } else {
        "Creation"
    }
}

/// Insert one entry into `knowledge/log.md`, newest first.
///
/// The log is appended by US, on every `write_concept`, rather than left to
/// the agent to remember. An agent that can choose whether to record what it
/// changed will eventually not, and a knowledge base whose changelog is
/// optional cannot answer the only question that matters about a
/// machine-written corpus: is this thing actually learning anything.
pub fn insert_log_entry(existing: &str, date: &str, kind: &str, title: &str, rel: &str) -> String {
    let bullet = format!("* **{kind}**: [{title}]({}).", bundle_link(rel));

    if existing.trim().is_empty() {
        return format!("{LOG_HEADING}\n\n## {date}\n{bullet}\n");
    }

    let day_heading = format!("## {date}");
    let mut out: Vec<String> = Vec::new();
    let mut inserted = false;

    for line in existing.lines() {
        // Today already has a section: the new entry goes at its top, so the
        // most recent change is the first thing read.
        if !inserted && line.trim_end() == day_heading {
            out.push(line.to_string());
            out.push(bullet.clone());
            inserted = true;
            continue;
        }
        // A different date's section is the first thing this one must precede.
        if !inserted && line.starts_with("## ") {
            out.push(day_heading.clone());
            out.push(bullet.clone());
            out.push(String::new());
            out.push(line.to_string());
            inserted = true;
            continue;
        }
        out.push(line.to_string());
    }

    if !inserted {
        // No dated sections at all — a log with only a heading, or none.
        if !out.iter().any(|l| l.trim_end() == LOG_HEADING) {
            out.insert(0, String::new());
            out.insert(0, LOG_HEADING.to_string());
        }
        if out.last().map(|l| !l.trim().is_empty()).unwrap_or(false) {
            out.push(String::new());
        }
        out.push(day_heading);
        out.push(bullet);
    }

    let mut text = out.join("\n");
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect()
    }

    const REL: &str = "knowledge/playbooks/cutover.md";

    #[test]
    fn writes_a_whole_log_when_none_exists() {
        let out = insert_log_entry("", "2026-07-28", "Creation", "Cutover", REL);
        assert_eq!(
            out,
            "# Knowledge Update Log\n\n## 2026-07-28\n* **Creation**: [Cutover](/playbooks/cutover.md).\n"
        );
    }

    #[test]
    fn adds_to_todays_section_newest_first() {
        let existing = "# Knowledge Update Log\n\n## 2026-07-28\n* **Creation**: [A](/a.md).\n";
        let out = insert_log_entry(existing, "2026-07-28", "Update", "Cutover", REL);
        let bullets: Vec<&str> = out.lines().filter(|l| l.starts_with("* ")).collect();
        assert_eq!(bullets[0], "* **Update**: [Cutover](/playbooks/cutover.md).");
        assert_eq!(bullets[1], "* **Creation**: [A](/a.md).");
        // One section for the day, not two.
        assert_eq!(out.matches("## 2026-07-28").count(), 1);
    }

    #[test]
    fn a_new_day_goes_above_every_older_one() {
        let existing = "# Knowledge Update Log\n\n## 2026-07-27\n* **Creation**: [A](/a.md).\n";
        let out = insert_log_entry(existing, "2026-07-28", "Creation", "Cutover", REL);
        let days: Vec<&str> = out.lines().filter(|l| l.starts_with("## ")).collect();
        assert_eq!(days, vec!["## 2026-07-28", "## 2026-07-27"]);
    }

    #[test]
    fn a_log_with_only_a_heading_gains_its_first_section() {
        let out = insert_log_entry("# Knowledge Update Log\n", "2026-07-28", "Creation", "C", REL);
        assert!(out.starts_with("# Knowledge Update Log\n"));
        assert!(out.contains("## 2026-07-28"));
        assert_eq!(out.matches("# Knowledge Update Log").count(), 1);
    }

    #[test]
    fn prose_above_the_first_section_is_preserved() {
        let existing = "# Knowledge Update Log\n\nWhat I have learned.\n\n## 2026-07-27\n* **Creation**: [A](/a.md).\n";
        let out = insert_log_entry(existing, "2026-07-28", "Creation", "C", REL);
        assert!(out.contains("What I have learned."));
        // The new day still precedes the old one.
        let new_at = out.find("## 2026-07-28").unwrap();
        let old_at = out.find("## 2026-07-27").unwrap();
        assert!(new_at < old_at);
    }

    #[test]
    fn log_kind_names_what_actually_happened() {
        assert_eq!(log_kind(false), "Creation");
        assert_eq!(log_kind(true), "Update");
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
