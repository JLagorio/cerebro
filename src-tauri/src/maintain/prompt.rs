//! The maintenance pass's prompt (M26.6b).
//!
//! **Nothing is fenced here, and that is a fact about the input rather than a
//! relaxation.** Every line below is computed by `maintain::candidates` from
//! reducer state: belief ids, entity ids, source ids, and a closed signal
//! vocabulary. No source bytes reach this prompt — the beliefs' own prose is
//! deliberately not printed, because the pass's job is to notice SHAPES (a
//! duplicate, a retired link, a single source behind everything) and the
//! shapes are all structural. A pass that read the prose would be a pass
//! deciding what claims mean, which is ingest's job and needs ingest's
//! containment.
//!
//! **It is told what it may not conclude.** The findings are facts about the
//! base's shape; none of them is a reason on its own. "These two say the same
//! thing" is not "one of them is wrong", and "this rests on one source" is not
//! "this is doubtful". Saying so in the prompt is cheaper than discovering it
//! in a proposal stream.

use super::pass::Finding;

/// The prompt contract's version, so a stored transcript can be read against
/// the rules that produced it.
pub const PROMPT_VERSION: &str = "m26-maintenance-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub prompt_version: &'static str,
    pub text: String,
}

const RULES: &str = "\
You are cerebro's maintenance pass. You are looking at the SHAPE of what the
base holds — not at what any of it means.

Everything below was computed from the base's own structure. It is a list of
facts, and every one of them is a question rather than a verdict.

Rules that are not negotiable:

- Propose; do not assert. Every change goes through a proposal tool, and the
  policy table decides what it costs and who has to agree. A refusal is an
  answer — read it and adjust, do not retry it unchanged.

- TIME IS NOT A REASON. Nothing here may be justified by how long something
  has sat, how quiet it has been, or the absence of recent activity. A belief
  is not stale because nobody touched it, and silence has never resolved
  anything. If the only argument you can make for a change is elapsed time,
  the answer is to make no proposal.

- A shape is not a verdict:
  - Two beliefs saying the same thing may both be right. An exact merge is
    for a DUPLICATE — the same source recorded twice — and this pass only
    surfaces groups that rest on a single source for exactly that reason.
  - A belief resting on one source is not doubtful. A great deal of true
    knowledge has one source. It is worth knowing, not worth demoting.
  - A retired belief nothing points at is not worthless. Compressing it is a
    choice about what history to keep, which is why it is a person's.

- Same words about a DIFFERENT entity is never a merge. Deciding two entities
  are one is `merge_entities`, it is CRITICAL, and it reaches a person.

- Say what you did not do. A finding you looked at and decided against is a
  real outcome worth stating; a silent skip is not.";

/// Render one pass's findings.
pub fn render(findings: &[Finding]) -> Rendered {
    let mut out = String::new();
    out.push_str(RULES);
    out.push_str("\n\n## WHAT THE BASE LOOKS LIKE\n\n");
    out.push_str(&format!(
        "{} finding(s), none of which has been raised before.\n",
        findings.len()
    ));

    for (kind, heading, empty) in [
        (
            "exact_merge",
            "### Duplicates — the same words, one source, one subject",
            "No group of live beliefs about one subject says the same thing from one source.",
        ),
        (
            "compress",
            "### Retired, and nothing live points at it",
            "Every retired belief still has something referring to it.",
        ),
        (
            "attention",
            "### Worth a look",
            "No live belief tripped a signal.",
        ),
    ] {
        out.push_str(&format!("\n{heading}\n\n"));
        let mut any = false;
        for finding in findings.iter().filter(|f| f.kind == kind) {
            any = true;
            out.push_str(&format!(
                "- `{}` {}\n",
                finding.subject_id,
                serde_json::to_string(&finding.detail)
                    .unwrap_or_else(|_| "(unrenderable)".to_string())
            ));
        }
        if !any {
            // Said rather than omitted, for the reason every other section in
            // this codebase says it: an empty section and a missing section
            // read identically and mean different things.
            out.push_str(&format!("{empty}\n"));
        }
    }

    Rendered {
        prompt_version: PROMPT_VERSION,
        text: out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture;
    use crate::maintain::{candidates, pass};

    fn findings() -> Vec<Finding> {
        pass::keyed(
            "cafebabecafebabecafebabecafebabe",
            &candidates::find(&fixture::state()),
        )
    }

    #[test]
    fn the_pass_is_told_that_time_is_not_a_reason() {
        // The rule this whole pass is constrained by, said in the prompt as
        // well as enforced in the table.
        let text = render(&findings()).text;
        assert!(text.contains("TIME IS NOT A REASON"));
        assert!(text.contains("silence has never resolved"));
        assert!(text.contains("the answer is to make no proposal"));
    }

    #[test]
    fn every_section_renders_including_the_empty_ones() {
        // An empty section and a missing one read identically to a model.
        let text = render(&findings()).text;
        for heading in ["### Duplicates", "### Retired,", "### Worth a look"] {
            assert!(text.contains(heading), "{heading} is missing");
        }
        assert!(
            text.contains("No group of live beliefs"),
            "the fixture has no duplicate, and the section says so"
        );
    }

    #[test]
    fn no_belief_prose_reaches_the_prompt() {
        // The pass reads shapes, not claims. Reading the prose would make it a
        // pass that decides what claims mean, which needs ingest's
        // containment and does not have it here.
        let text = render(&findings()).text;
        for prose in [
            "the cutover is on track",
            "the cutover slipped a week",
            "Kestrel ships after Falcon",
        ] {
            assert!(!text.contains(prose), "{prose:?} leaked into the prompt");
        }
    }

    #[test]
    fn a_shape_is_offered_as_a_question_rather_than_a_verdict() {
        let text = render(&findings()).text;
        assert!(text.contains("A belief resting on one source is not doubtful"));
        assert!(text.contains("Two beliefs saying the same thing may both be right"));
    }

    #[test]
    fn the_same_findings_render_the_same_prompt() {
        assert_eq!(render(&findings()), render(&findings()));
    }
}
