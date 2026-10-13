//! Knowledge bundle boundary (M5).
//!
//! `knowledge/` is an Open Knowledge Format bundle maintained by the AI
//! knowledge base. Humans read and VERIFY it; since M23.7 an in-app edit
//! is CAPTURED through the ledger (`ledger::capture`) rather than written
//! directly, and `guard_human_write` refuses what capture cannot take. That
//! boundary is enforced at the IPC layer rather than by disabling buttons
//! in the UI — a disabled button is a suggestion, a rejected command is a
//! rule.
//!
//! Verification is the one exception, and it is deliberately narrow:
//! `verify_concept` may touch the `verified` key and nothing else. Without
//! it the format's `human-reviewed` trust tier would be unreachable and the
//! whole provenance ledger would be decorative.
//!
//! The AGENT has a boundary too, and until M17.1 it had none (this module
//! used to say its tool path "calls `vault::write` directly and is
//! unaffected", which was the whole problem). `write_concept` refuses a
//! `verified` field and stamps `generated` server-side, so the model cannot
//! self-certify — but `create_note`, `update_frontmatter` and `append_to_note`
//! reached the same files with no such check, which made the refusal a
//! formality anyone could route around. `guard_agent_write` closes those
//! three doors, so the agent reaches the bundle through exactly two
//! server-stamped tools: `write_concept` (a whole concept) and, since M49.7,
//! `recheck_concept` (moves `stale_after` and nothing else).

use serde_json::{Map, Value};

pub const KNOWLEDGE_DIR: &str = "knowledge";

/// True for the bundle root and anything beneath it. The trailing slash
/// matters: a sibling `knowledge-archive/` is NOT part of the bundle.
///
/// Judged on the path the filesystem will RESOLVE (M49.4, K17), not the raw
/// argument: `./knowledge/x.md`, `records/../knowledge/x.md` and — on APFS,
/// which folds case — `Knowledge/x.md` all land in the bundle, and each
/// walked past the old prefix check into `update_frontmatter`. Mirrored by
/// `isKnowledgePath` in src/engine/okf.ts.
pub fn is_knowledge_path(path: &str) -> bool {
    canonical_path(path).is_some()
}

/// The one staleness rule, as data (M49.8, K24) — shared with okf.ts's
/// `staleFrom`, and both replay its cases.
const STALENESS: &str = include_str!("../../shared/policy/staleness.v1.json");

#[derive(serde::Deserialize)]
struct Staleness {
    inclusive: bool,
    malformed_is_stale: bool,
}

fn staleness() -> &'static Staleness {
    static RULE: std::sync::OnceLock<Staleness> = std::sync::OnceLock::new();
    RULE.get_or_init(|| serde_json::from_str(STALENESS).expect("staleness.v1.json parses"))
}

/// The one well-formed spelling: exactly `YYYY-MM-DD`, and a real date.
/// chrono alone also accepts `2027-7-1`, ` 2027-07-01` and `+2027-07-01`,
/// which the rule — and okf.ts's `staleFrom` — read as malformed. The
/// validator and the reader share this, so a date an agent was allowed to
/// set is never one a reader calls stale on sight.
fn well_formed(after: &str) -> Option<chrono::NaiveDate> {
    let shape = after.len() == 10
        && after.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    if !shape {
        return None;
    }
    chrono::NaiveDate::parse_from_str(after, "%Y-%m-%d").ok()
}

/// The raw `stale_after` a reader judges: a string as written, and any
/// other PRESENT value in its JSON spelling — a hand-typed `2027` or `true`
/// is a horizon nobody can read, so it is malformed (stale), never "never".
/// `None` only when the key is absent or null. Mirrors okf.ts's
/// `staleAfterOf`.
pub fn stale_after_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// Is a concept with this `stale_after` stale on `today` (YYYY-MM-DD)?
pub fn is_stale(stale_after: Option<&str>, today: &str) -> bool {
    let Some(after) = stale_after else {
        return false;
    };
    let rule = staleness();
    if well_formed(after).is_none() {
        return rule.malformed_is_stale;
    }
    if rule.inclusive {
        today >= after
    } else {
        today > after
    }
}

/// A `stale_after` an agent may set (M49.7, K37): a well-formed
/// `YYYY-MM-DD` date later than `today`. A malformed value reads stale at
/// once (staleness.v1.json) and a past one is due again at once — either
/// way the recheck that set it bought nothing.
pub fn validate_stale_after(value: &str, today: chrono::NaiveDate) -> Result<(), String> {
    let date = well_formed(value)
        .ok_or_else(|| format!("stale_after must be a YYYY-MM-DD date, got {value:?}"))?;
    if date <= today {
        return Err(format!(
            "stale_after {value} is not after today ({today}) — a recheck date in the past makes \
             the concept due again at once"
        ));
    }
    Ok(())
}

/// The bundle path in its one canonical spelling (`knowledge/…`), or `None`
/// when `path` does not resolve into the bundle. `.` segments drop, `..`
/// pops (a path that climbs out of the vault is not in the bundle), and the
/// bundle folder matches case-insensitively.
pub fn canonical_path(path: &str) -> Option<String> {
    let mut segments: Vec<&str> = Vec::new();
    if path.starts_with('/') {
        return None;
    }
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            other => segments.push(other),
        }
    }
    let (head, rest) = segments.split_first()?;
    if !head.eq_ignore_ascii_case(KNOWLEDGE_DIR) {
        return None;
    }
    Some(
        std::iter::once(KNOWLEDGE_DIR)
            .chain(rest.iter().copied())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

const READ_ONLY: &str = "knowledge/ is maintained by the AI knowledge base and is read-only here. \
Verify the concept, or ask the agent to revise it.";

/// Concepts already in the bundle that look like the one about to be written.
///
/// The distiller's failure mode is not writing something wrong — it is writing
/// a fourth concept about a thing the bundle already covers three times, after
/// which the reader has no way to tell which one to believe. Detection needs
/// BOTH signals, a shared `about` anchor and overlapping title words, because
/// either alone fires constantly: everything in a small vault is about the same
/// project, and "Pick queue drain time" and "Pick list generation" share a word.
///
/// This REPORTS, it does not refuse. Deciding two statements are one claim is a
/// judgement, and a tool that silently merged them could destroy a source; the
/// agent gets told and consolidates on its next move.
pub fn near_duplicates(
    vault: &std::path::Path,
    skip_rel: &str,
    title: &str,
    about: &[String],
) -> Vec<String> {
    if about.is_empty() || title.trim().is_empty() {
        return Vec::new();
    }
    let anchors: std::collections::HashSet<String> =
        about.iter().map(|a| normalize_anchor(a)).collect();
    let root = vault.join(KNOWLEDGE_DIR);
    let mut hits = Vec::new();

    for item in walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !item.file_type().is_file() {
            continue;
        }
        if item.path().extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(rel) = item.path().strip_prefix(vault) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel == skip_rel || rel.ends_with("/index.md") || rel.ends_with("/log.md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(item.path()) else {
            continue;
        };
        let (Some(block), _) = crate::vault::parse::split_frontmatter(&content) else {
            continue;
        };
        let Ok(map) = crate::vault::parse::parse_frontmatter(block) else {
            continue;
        };

        let other_title = map
            .get(serde_yaml::Value::from("title"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if title_overlap(title, other_title) < 0.5 {
            continue;
        }
        let shares = yaml_strings(map.get(serde_yaml::Value::from("about")))
            .iter()
            .any(|a| anchors.contains(&normalize_anchor(a)));
        if shares {
            hits.push(format!("{rel} (\"{other_title}\")"));
        }
    }
    hits.sort();
    hits
}

/// `[[phoenix-warehouse-rollout]]` and `phoenix-warehouse-rollout` name the
/// same entity; comparing them literally would find no overlap at all.
fn normalize_anchor(raw: &str) -> String {
    raw.trim()
        .trim_start_matches("[[")
        .trim_end_matches("]]")
        .trim()
        .to_lowercase()
}

fn yaml_strings(value: Option<&serde_yaml::Value>) -> Vec<String> {
    match value {
        Some(serde_yaml::Value::Sequence(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        Some(serde_yaml::Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// Jaccard over meaningful title words. Mirrors `titleOverlap` in
/// src/engine/okf.ts — the UI shows the same pairs this warns about, and two
/// different notions of "similar" would mean the warning and the surface
/// disagreed about what is a duplicate.
fn title_overlap(a: &str, b: &str) -> f64 {
    let left = title_tokens(a);
    let right = title_tokens(b);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let shared = left.intersection(&right).count() as f64;
    let union = (left.len() + right.len()) as f64 - shared;
    if union <= 0.0 {
        0.0
    } else {
        shared / union
    }
}

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it", "of",
    "on", "or", "that", "the", "this", "to", "what", "when", "which", "why", "with",
];

fn title_tokens(title: &str) -> std::collections::HashSet<String> {
    title
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| w.len() > 2 && !STOPWORDS.contains(w))
        .map(str::to_string)
        .collect()
}

/// Build a typed refusal for a bundle-boundary guard and record it.
///
/// M24.2: every refusal on the epistemic plane carries a code with a
/// DECLARED DESTINY instead of being an anonymous string. These are all
/// `malformed_arguments` — a caller reaching the bundle through the wrong
/// door is a tool-surface mistake, not a claim about the world, so they
/// belong in the runtime DB and not in the append-only ledger. (When in
/// doubt the answer is operational; promoting a code into the ledger needs
/// a coverage-materiality argument in review.)
///
/// The MESSAGE is unchanged, byte for byte. These strings are agent-facing
/// prompt surface and human-facing UI text; typing the refusal is about
/// where it is recorded, never about rewording it.
fn guard_refusal(
    surface: &str,
    detail: &str,
) -> Result<crate::policy::rejection::OperationalRefusal, String> {
    let table = crate::policy::table::PolicyTable::load()?;
    crate::policy::rejection::OperationalRefusal::new(&table, GUARD_CODE, surface, detail)
}

fn refuse(surface: &str, detail: &'static str) -> String {
    refuse_owned(surface, detail.to_string())
}

fn refuse_owned(surface: &str, detail: String) -> String {
    if let Ok(refusal) = guard_refusal(surface, &detail) {
        crate::runtime::sink::record(&refusal, &crate::runtime::operational::LogEntry::bare());
    }
    detail
}

/// The one code every bundle-boundary guard reports under.
const GUARD_CODE: &str = "malformed_arguments";

/// Reject a write from the human-facing UI into the bundle.
pub fn guard_human_write(path: &str) -> Result<(), String> {
    if is_knowledge_path(path) {
        return Err(refuse("human_write", READ_ONLY));
    }
    Ok(())
}

/// Reject an AGENT write that reaches into the bundle by any door other than
/// the two server-stamped tools, `write_concept` and `recheck_concept`
/// (M17.1; M49.7).
///
/// Those two are the only tools that stamp provenance from the run's actor
/// server-side: `write_concept` refuses a `verified` field and stamps
/// `generated`; `recheck_concept` takes no fields at all and moves only
/// `stale_after`. Every guarantee the trust model makes — that a tier is
/// derived, that provenance is server-side, that the human's stamp is the
/// human's — rests on them being the ONLY writers. They were not:
/// `update_frontmatter` could patch `verified` straight onto a concept,
/// `create_note` could author one pre-stamped, and `append_to_note` could
/// grow a body with no provenance at all.
pub fn guard_agent_write(path: &str) -> Result<(), String> {
    if is_knowledge_path(path) {
        return Err(refuse("agent_write", AGENT_USE_WRITE_CONCEPT));
    }
    Ok(())
}

const AGENT_USE_WRITE_CONCEPT: &str =
    "knowledge/ is written only through write_concept and recheck_concept, which record \
provenance. Use recheck_concept to move only a concept's `stale_after`, and write_concept \
otherwise; `verified` is the user's stamp and is never yours to set.";

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
        return Err(refuse(
            "verify_concept",
            "verify_concept only applies to knowledge/ concepts",
        ));
    }
    for key in patch.keys() {
        if key != "verified" {
            // The interpolated key makes this one message dynamic, so it
            // cannot share the `&'static str` path — the code, surface, and
            // destiny are the same.
            let detail = format!("verify_concept may only write `verified`, not `{key}`");
            return Err(refuse_owned("verify_concept", detail));
        }
    }
    if patch.is_empty() {
        return Err(refuse(
            "verify_concept",
            "verify_concept requires a `verified` value",
        ));
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

// --- The concept-type vocabulary (M33a.1) ----------------------------------

/// The words the agent is allowed to type a concept with.
///
/// Data rather than a Rust array because `okf.ts` resolves `conceptType`
/// against the same idea on the read side, and a rule implemented as twin
/// Rust and TS code is a review-blocking defect (`shared/policy/README.md`).
///
/// It ships as one static list rather than per-vault: a vault that declares
/// its own types can still use them — `conceptType` is free-form by OKF §4.1
/// and consumers must tolerate unknown values — this is what the agent is
/// OFFERED when it has nothing else to go on, which was the measured failure.
const CONCEPT_TYPES_JSON: &str = include_str!("../../shared/policy/concept-types.v1.json");
const CONCEPT_TYPES_DIGEST: &str = include_str!("../../shared/policy/concept-types.v1.sha256");

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // Read by the digest test and by anyone diffing the artifact.
struct ConceptTypeArtifact {
    format: u64,
    artifact_version: u64,
    rule_version: String,
    fallback: String,
    types: Vec<ConceptTypeDef>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ConceptTypeDef {
    id: String,
    hint: String,
}

fn concept_types() -> &'static ConceptTypeArtifact {
    use std::sync::OnceLock;
    static LOADED: OnceLock<ConceptTypeArtifact> = OnceLock::new();
    LOADED.get_or_init(|| {
        let digest = crate::ledger::sha256_hex(CONCEPT_TYPES_JSON.as_bytes());
        assert_eq!(
            digest.trim(),
            CONCEPT_TYPES_DIGEST.trim(),
            "concept-types.v1.json does not match its digest — regenerate it, \
             see shared/policy/README.md"
        );
        let artifact: ConceptTypeArtifact =
            serde_json::from_str(CONCEPT_TYPES_JSON).expect("concept-types.v1.json parses");
        assert_eq!(artifact.format, 1, "unknown concept-types format");
        assert!(
            artifact.types.iter().any(|t| t.id == artifact.fallback),
            "the fallback must be one of the offered types"
        );
        artifact
    })
}

/// Every type name, in artifact order.
pub fn concept_type_names() -> Vec<&'static str> {
    concept_types()
        .types
        .iter()
        .map(|t| t.id.as_str())
        .collect()
}

/// The vocabulary rendered for a tool description: `Name — hint`, one per
/// line, so the model reads what each word is FOR and not just that it exists.
pub fn concept_type_menu() -> String {
    concept_types()
        .types
        .iter()
        .map(|t| format!("{} — {}", t.id, t.hint))
        .collect::<Vec<_>>()
        .join("; ")
}

// --- What the bundle knows about one entity (M33a.5) -----------------------

/// OKF §3.1 — reserved filenames that are structure, not concepts.
const RESERVED_FILENAMES: [&str; 2] = ["index.md", "log.md"];

/// True for notes inside the bundle that are concepts. Mirrors `isConcept` in
/// src/engine/okf.ts.
pub fn is_concept(entry: &crate::vault::entry::Entry) -> bool {
    is_knowledge_path(&entry.path) && !RESERVED_FILENAMES.contains(&entry.filename.as_str())
}

/// What the vault's ledger records about each concept's review (M49.8,
/// K21), by vault-relative path — read once per request from the cached
/// fold. `None` for a vault with no ledger to ask.
#[derive(Default)]
pub struct LedgerReview {
    reviews: std::collections::HashMap<String, Reviewed>,
    governed: Governed,
    /// The files that are not the ledger's — they differ from their
    /// projection, or it never recorded them (`reconcile::quarantined_paths`,
    /// what `LedgerStatus.quarantined` lists). Any stamp can have been typed
    /// into one, so a review it claims reads `disputed`, as `listConcepts`
    /// reads it in the UI.
    quarantined: std::collections::HashSet<String>,
    /// `(replacement, replaced)` supersessions a person approved on a card.
    approved: std::collections::HashSet<(String, String)>,
    /// Paths whose CURRENT review the ledger records as a person's
    /// (`recorded_human`) — who reviewed is the ledger's answer too, never
    /// the file's, or a `process:` → `human:` edit elsewhere would upgrade
    /// a machine confirmation.
    human: std::collections::HashSet<String>,
    /// The vault HAS a ledger and it could not be read (corrupt, forked, a
    /// second writer). Unavailable is never empty: no stamp is trusted
    /// until the ledger can be asked again.
    unreadable: bool,
}

/// Governed state the projection does not render (M49.8, K45): a
/// human-approved supersede, archive or tombstone, and an open contest,
/// by vault-relative path. The markdown never changes for these, so a
/// reader of the file alone saw a retired or contested claim as current.
#[derive(Default)]
struct Governed {
    retired: std::collections::HashMap<String, &'static str>,
    contested: std::collections::HashSet<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Reviewed {
    Current,
    PredatesCurrent,
    Unreviewed,
}

pub fn ledger_review(vault: &std::path::Path) -> Option<LedgerReview> {
    let folded = match crate::ledger::shadow::state_of(vault) {
        Ok(folded) => folded,
        // Only a vault that was never armed answers from its files.
        Err(_) if !crate::ledger::has_store(vault) => return None,
        Err(_) => {
            return Some(LedgerReview {
                unreadable: true,
                ..LedgerReview::default()
            })
        }
    };
    let state = &folded.state;
    let mut governed = Governed::default();
    for (krel, belief_id) in &state.projection_paths {
        let Some(belief) = state.beliefs.get(belief_id) else {
            continue;
        };
        let path = format!("{KNOWLEDGE_DIR}/{krel}");
        let retired = match crate::dynamics::validity::lifecycle_of(belief) {
            crate::dynamics::validity::Lifecycle::Active => None,
            crate::dynamics::validity::Lifecycle::Superseded => Some("superseded"),
            crate::dynamics::validity::Lifecycle::Archived => Some("archived"),
            crate::dynamics::validity::Lifecycle::Tombstoned => Some("retired"),
        };
        if let Some(retired) = retired {
            governed.retired.insert(path.clone(), retired);
        }
        if belief.open_contest_event.is_some() {
            governed.contested.insert(path);
        }
    }
    let reviews = state
        .projection_paths
        .iter()
        .filter_map(|(krel, belief_id)| {
            let belief = state.beliefs.get(belief_id)?;
            let status = crate::dynamics::review::status_for(belief, &belief.current().event_id);
            let reviewed = match status {
                crate::dynamics::review::ReviewStatus::Current { .. } => Reviewed::Current,
                crate::dynamics::review::ReviewStatus::PredatesCurrent { .. } => {
                    Reviewed::PredatesCurrent
                }
                crate::dynamics::review::ReviewStatus::Unreviewed => Reviewed::Unreviewed,
            };
            Some((format!("{KNOWLEDGE_DIR}/{krel}"), reviewed))
        })
        .collect();
    // A bundle that could not be compared is not "nothing quarantined":
    // every stamp is disputed until it can be.
    let (quarantined, unreadable) = match crate::ledger::reconcile::quarantined_paths(vault, state)
    {
        Ok(paths) => (paths.into_iter().collect(), false),
        Err(_) => (Default::default(), true),
    };
    Some(LedgerReview {
        reviews,
        governed,
        quarantined,
        approved: approved_supersessions(state).into_iter().collect(),
        human: recorded_human(state).into_iter().collect(),
        unreadable,
    })
}

/// The concepts whose CURRENT revision the ledger records as reviewed by a
/// person: attested at the current revision, with a `human:` stamp in the
/// ledger's own fields. What `about` gates supersession on, and — through
/// `LedgerStatus.recorded_human` — what `listConcepts` gates it on, so the
/// two answer from the same record.
pub fn recorded_human(state: &crate::ledger::reduce::EpistemicState) -> Vec<String> {
    state
        .projection_paths
        .iter()
        .filter_map(|(krel, belief_id)| {
            let belief = state.beliefs.get(belief_id)?;
            let current = belief.current();
            let reviewed = matches!(
                crate::dynamics::review::status_for(belief, &current.event_id),
                crate::dynamics::review::ReviewStatus::Current { .. }
            );
            let tier = tier_of(current.fields.as_object().and_then(|f| f.get("verified")));
            (reviewed && tier == "human-reviewed").then(|| format!("{KNOWLEDGE_DIR}/{krel}"))
        })
        .collect()
}

/// The `(replacement, replaced)` supersessions a person AGREED to (M49.8,
/// K22), as vault-relative paths: a live `supersedes` relation added either
/// by an application whose proposal carries a human approval, or by the
/// owner's own in-app edit (captured under `capture::OWNER_ACTOR`).
/// Superseding a reviewed concept waits on a card, and approving that card
/// is the agreement `about` and `listConcepts` gate on — before, the
/// approved edge still read as a proposal until someone separately verified
/// the replacement. An add some other hand made later (an out-of-band
/// capture reuses the relation id) is not what the person agreed to.
pub fn approved_supersessions(
    state: &crate::ledger::reduce::EpistemicState,
) -> Vec<(String, String)> {
    use crate::ledger::schema::{
        Decision, ProposalOp, ProposalState, RelationAction, RelationKind, SourceRegistration,
    };
    let path_of: std::collections::HashMap<&str, &str> = state
        .projection_paths
        .iter()
        .map(|(krel, belief)| (belief.as_str(), krel.as_str()))
        .collect();
    // The batch each event committed in: an agreement counts only for the
    // add it made.
    let batch_of: std::collections::HashMap<&str, &str> = state
        .batches
        .iter()
        .flat_map(|batch| {
            batch
                .members
                .iter()
                .map(move |(event, _)| (event.as_str(), batch.batch_id.as_str()))
        })
        .collect();
    let owner_batches: std::collections::HashSet<&str> = state
        .observations
        .values()
        .filter(|observation| {
            state
                .sources
                .get(&observation.source_id)
                .is_some_and(|source| {
                    matches!(
                        &source.registration,
                        SourceRegistration::HumanActor { actor_id, .. }
                            if actor_id == crate::ledger::capture::OWNER_ACTOR
                    )
                })
        })
        .filter_map(|observation| batch_of.get(observation.event_id.as_str()).copied())
        .collect();
    let mut pairs: Vec<(String, String)> = state
        .proposals
        .values()
        .filter(|row| {
            row.state == ProposalState::Applied
                && matches!(row.decision, Some((_, Decision::Approve)))
        })
        .filter_map(|row| match &row.proposal.op {
            ProposalOp::EditRelation {
                relation_id,
                action: RelationAction::Add,
                relation: RelationKind::Supersedes,
                ..
            } => Some((row, state.relations.get(relation_id)?)),
            _ => None,
        })
        .filter(|(row, relation)| {
            let applied_in = row
                .applied_event_id
                .as_deref()
                .and_then(|event| batch_of.get(event));
            relation.live
                && applied_in.is_some()
                && applied_in == batch_of.get(relation.last_add_event_id.as_str())
        })
        .map(|(_, relation)| relation)
        .chain(state.relations.values().filter(|relation| {
            // The owner's own capture batch: its observation is filed under
            // the owner's registration.
            relation.live
                && relation.relation == RelationKind::Supersedes
                && batch_of
                    .get(relation.last_add_event_id.as_str())
                    .is_some_and(|batch| owner_batches.contains(batch))
        }))
        .filter_map(|relation| {
            Some((
                format!("{KNOWLEDGE_DIR}/{}", path_of.get(relation.from.as_str())?),
                format!("{KNOWLEDGE_DIR}/{}", path_of.get(relation.to.as_str())?),
            ))
        })
        .collect();
    pairs.sort();
    pairs.dedup();
    pairs
}

/// One concept a run's proposals named, and what became of the proposal.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RunWrite {
    /// Vault-relative: `knowledge/…`.
    pub path: String,
    /// The proposal's ledger state: `submitted`, `queued`, `rejected`,
    /// `applied` or `reverted`.
    pub state: String,
}

/// What one run changed in Knowledge (M50.3), read back from the ledger.
///
/// A run's detail said "2 applied" and named nothing: the fleet counted what
/// the ledger recorded, and the ledger held every proposal with its
/// `run_id` all along. This is that join — each proposal the run submitted,
/// the beliefs it named (by its op and by its targets), and the projection
/// file each belief is. A belief with no file (a relation's end that was
/// never projected) names nothing and is left out; one path named twice
/// keeps the furthest state its proposals reached.
pub fn run_writes(state: &crate::ledger::reduce::EpistemicState, run_id: &str) -> Vec<RunWrite> {
    use crate::ledger::schema::{ProposalOp, ProposalState, TargetClass};
    let path_of: std::collections::HashMap<&str, &str> = state
        .projection_paths
        .iter()
        .map(|(krel, belief)| (belief.as_str(), krel.as_str()))
        .collect();
    let rank = |s: ProposalState| match s {
        ProposalState::Applied => 4,
        ProposalState::Queued => 3,
        ProposalState::Submitted => 2,
        ProposalState::Reverted => 1,
        ProposalState::Rejected => 0,
    };
    let mut named: std::collections::BTreeMap<String, ProposalState> = Default::default();
    for row in state.proposals.values() {
        if row.proposal.run_id != run_id {
            continue;
        }
        let mut beliefs: Vec<&str> = row
            .proposal
            .targets
            .iter()
            .filter(|target| target.target_class == TargetClass::Belief)
            .map(|target| target.target_id.as_str())
            .collect();
        match &row.proposal.op {
            ProposalOp::CreateBelief { belief_id, .. }
            | ProposalOp::UpdateBelief { belief_id, .. }
            | ProposalOp::PromoteDraft { belief_id, .. }
            | ProposalOp::ContestBelief { belief_id, .. } => beliefs.push(belief_id),
            ProposalOp::SupersedeBelief {
                belief_id,
                successor_id,
            } => beliefs.extend([belief_id.as_str(), successor_id.as_str()]),
            ProposalOp::EditRelation { from, to, .. } => {
                beliefs.extend([from.as_str(), to.as_str()])
            }
            _ => {}
        }
        for belief in beliefs {
            let Some(krel) = path_of.get(belief) else {
                continue;
            };
            let path = format!("{KNOWLEDGE_DIR}/{krel}");
            let keep = named
                .get(&path)
                .is_some_and(|had| rank(*had) >= rank(row.state));
            if !keep {
                named.insert(path, row.state);
            }
        }
    }
    named
        .into_iter()
        .map(|(path, state)| RunWrite {
            path,
            state: serde_json::to_value(state)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default(),
        })
        .collect()
}

/// The trust label an agent reads (M49.8, K21).
///
/// With a ledger, the review is the LEDGER'S — an attestation pinned to the
/// current revision — and a `verified` stamp in the file that the ledger
/// never recorded reads `disputed`: typed into a file, it grants nothing.
/// Before, every reader trusted the file, so a refused forged stamp still
/// read as human-reviewed to the UI and to every agent. So does any review
/// claimed by a file that is not the ledger's (quarantined) — its content
/// is not what was reviewed — and every stamp while a ledger that exists
/// cannot be read. Without a ledger (a vault never armed) the file's stamp
/// is the only answer there is.
pub fn trust_label(
    entry: &crate::vault::entry::Entry,
    ledger: Option<&LedgerReview>,
) -> &'static str {
    let recorded = review_label(entry, ledger);
    let Some(ledger) = ledger else {
        return recorded;
    };
    let disputable = ledger.unreadable || ledger.quarantined.contains(&entry.path);
    if disputable && recorded != "unverified" {
        return "disputed";
    }
    recorded
}

/// The review as RECORDED — the ledger's, before a quarantine disputes the
/// file claiming it. Supersession is gated on this, as `listConcepts` gates
/// on `recordedHuman`: an edit elsewhere to a reviewed concept must not
/// let an unreviewed one retire it.
fn review_label(entry: &crate::vault::entry::Entry, ledger: Option<&LedgerReview>) -> &'static str {
    let file = trust_tier(entry);
    let Some(ledger) = ledger.filter(|l| !l.unreadable) else {
        return file;
    };
    match ledger.reviews.get(&entry.path) {
        Some(Reviewed::Current) if ledger.human.contains(&entry.path) => "human-reviewed",
        Some(Reviewed::Current) => "machine-confirmed",
        Some(Reviewed::PredatesCurrent) => "reviewed-earlier-revision",
        _ if file != "unverified" => "disputed",
        _ => "unverified",
    }
}

/// The trust tier a FILE claims — its `verified` stamps, read as written.
/// What a reader should apply is `trust_label`, which asks the ledger first.
pub fn trust_tier(entry: &crate::vault::entry::Entry) -> &'static str {
    tier_of(entry.properties.get("verified"))
}

/// The tier a `verified` value claims, wherever it was read from — a file's
/// own stamps, or the ledger's recorded fields.
pub(crate) fn tier_of(verified: Option<&Value>) -> &'static str {
    let Some(verified) = verified else {
        return "unverified";
    };
    let stamps: Vec<&Value> = match verified {
        Value::Array(list) => list.iter().collect(),
        other => vec![other],
    };
    let mut any = false;
    for stamp in stamps {
        let Some(by) = stamp.get("by").and_then(Value::as_str) else {
            continue;
        };
        any = true;
        if by.starts_with("human:") {
            return "human-reviewed";
        }
    }
    if any {
        "machine-confirmed"
    } else {
        "unverified"
    }
}

/// Wikilink targets under one frontmatter key. The scanner hands wikilink
/// fields back in `relationships`, already bracket-stripped; a plain string
/// is accepted too, because a concept that names its subject imprecisely
/// still beats one that never names it. Mirrors `parseAbout`/`parseRelations`.
pub(crate) fn link_field(entry: &crate::vault::entry::Entry, key: &str) -> Vec<String> {
    if let Some(linked) = entry.relationships.get(key) {
        if !linked.is_empty() {
            return linked.clone();
        }
    }
    plain_targets(entry.properties.get(key))
}

/// The targets a RAW frontmatter value names, read exactly as a scanned
/// file's would be (`link_field`): every `[[…]]` in any string or nested
/// array, else the trimmed plain strings. A guard on a value an agent
/// SENDS must read it this way, or it checks a spelling the readers never
/// see.
pub fn link_targets(value: &Value) -> Vec<String> {
    match crate::vault::entry::relationship_targets(value) {
        Some(linked) => linked,
        None => plain_targets(Some(value)),
    }
}

/// The concept each target names among `entries`, as the readers resolve it
/// (`about`, and `resolveConcept` in okf.ts); unresolved targets drop.
pub fn resolve_concepts(entries: &[crate::vault::entry::Entry], targets: &[String]) -> Vec<String> {
    let index = crate::vault::link::TargetIndex::build(entries);
    let concept_paths: std::collections::HashSet<&str> = entries
        .iter()
        .filter(|e| is_concept(e))
        .map(|e| e.path.as_str())
        .collect();
    targets
        .iter()
        .filter_map(|target| resolve_concept(target, &concept_paths, &index))
        .collect()
}

fn plain_targets(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
        _ => Vec::new(),
    }
}

/// One end of a concept-to-concept relation.
#[derive(Debug, Clone)]
pub struct RelationTarget {
    /// The concept it names, when it names one this bundle holds. `None` is
    /// not a defect — OKF §6.1 tolerates a link to something that is not
    /// there — but the caller must be able to tell the two apart.
    pub path: Option<String>,
    /// The link as written, for the end that declared it. An edge found by
    /// reading the graph backwards was never written on this concept at all,
    /// so it carries the other concept's path — which is the only thing
    /// anybody wrote down about it.
    pub target: String,
}

/// One concept, as `knowledge_about` reports it.
///
/// Every optional field means NOT RECORDED and is rendered as words by the
/// caller. A concept with no `description` is not a concept with an empty
/// description, and a concept with no `stale_after` has not been declared
/// fresh — it has had no recheck date set.
#[derive(Debug, Clone)]
pub struct AboutConcept {
    pub path: String,
    pub title: String,
    pub description: Option<String>,
    pub concept_type: Option<String>,
    pub lifecycle: String,
    pub trust: &'static str,
    pub stale_after: Option<String>,
    pub stale: bool,
    /// Concepts that declared they REPLACE this one. Read backwards on
    /// purpose: a replaced concept is never rewritten to say so, so without
    /// the reverse pass a retired claim looks exactly like a current one.
    pub superseded_by: Vec<String>,
    /// An open, governed contest on this concept (M49.8, K45) — a person
    /// or run challenged it and nothing has resolved it.
    pub contested: bool,
    /// Concepts that CLAIM to replace this one without being able to retire
    /// it (M49.8, K22): an unreviewed claim against a reviewed one, or two
    /// claims that each replace the other. This one stays current.
    pub replacement_proposed_by: Vec<String>,
    /// Disagreements touching this concept, in both directions —
    /// `contradicts` is symmetric (`RELATION_LABELS` in okf.ts says so), and
    /// the end that did not declare it has no way to know from its own file.
    pub contradicts: Vec<RelationTarget>,
}

/// What the bundle holds about one entity.
#[derive(Debug, Clone)]
pub struct About {
    /// The workspace note the target named, as `(path, title)`. `None` means
    /// nothing in the workspace carries that name — a legitimate state, not
    /// an error: the base tracks open threads about things nobody has written
    /// up yet (M33a design, D7).
    pub subject: Option<(String, String)>,
    /// The grouping key the anchors were matched on — the resolved path, else
    /// the lowercased target. Same key `listSubjects` groups by.
    pub key: String,
    pub concepts: Vec<AboutConcept>,
    /// How many matches the limit cut. A total that skipped rows says how
    /// many it skipped rather than absorbing them.
    pub omitted: usize,
}

/// Resolve one relation target to a concept in this bundle.
///
/// Two spellings, for the reason `about:` accepts two: the agent writes
/// `[[pick-queue-drain]]` because that is what it writes everywhere else, and
/// `/systems/pick-queue-drain.md` is what OKF §6.1 recommends. Refusing
/// either would lose a real edge over punctuation. Mirrors `resolveConcept`
/// in src/engine/okf.ts.
fn resolve_concept(
    target: &str,
    concept_paths: &std::collections::HashSet<&str>,
    index: &crate::vault::link::TargetIndex<'_>,
) -> Option<String> {
    let by_path = |path: &str| concept_paths.get(path).map(|p| (*p).to_string());
    let trimmed = target.trim();
    if trimmed.starts_with('/') {
        if let Some(hit) = by_path(&format!("{KNOWLEDGE_DIR}{trimmed}")) {
            return Some(hit);
        }
    } else if trimmed.ends_with(".md") {
        let relative = trimmed.strip_prefix("./").unwrap_or(trimmed);
        if let Some(hit) =
            by_path(relative).or_else(|| by_path(&format!("{KNOWLEDGE_DIR}/{relative}")))
        {
            return Some(hit);
        }
    }
    by_path(&index.resolve(trimmed)?.path)
}

/// Everything the bundle knows about the entity `target` names.
///
/// `target` may be a vault path (`records/risks/r-1.md`) or a bare wikilink
/// target (`rq-84b-kestrel`). The path pass comes first because a path is
/// unambiguous; everything after it is the app's own wikilink rule, so this
/// answers the same question `conceptsAbout` answers in the UI.
///
/// An empty `concepts` is a MEASUREMENT — the base has written nothing about
/// this — and is never how a failed read is reported. A read that cannot
/// happen never reaches here at all: the caller's scan returns `Err` first.
pub fn about(
    entries: &[crate::vault::entry::Entry],
    target: &str,
    today: &str,
    limit: usize,
    ledger: Option<&LedgerReview>,
) -> About {
    let index = crate::vault::link::TargetIndex::build(entries);
    let subject = entries
        .iter()
        .find(|e| e.path == target.trim())
        .or_else(|| index.resolve(target));
    let key = match subject {
        Some(entry) => entry.path.clone(),
        None => target.trim().to_lowercase(),
    };

    let concepts: Vec<&crate::vault::entry::Entry> =
        entries.iter().filter(|e| is_concept(e)).collect();
    let concept_paths: std::collections::HashSet<&str> =
        concepts.iter().map(|c| c.path.as_str()).collect();

    // The graph is walked ONCE, forwards, and read backwards out of these two
    // maps. Both relations have to be answerable from the end that did not
    // declare them: a replaced concept is never rewritten to say so, and
    // `contradicts` is symmetric — so a concept asked about itself would look
    // current and uncontested however retired it was.
    let mut replaced_by: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    let mut replacement_proposed: std::collections::BTreeMap<String, Vec<String>> =
        Default::default();
    let mut contradicted_by: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    for other in &concepts {
        for (field, into) in [
            ("supersedes", &mut replaced_by),
            ("contradicts", &mut contradicted_by),
        ] {
            for declared in link_field(other, field) {
                let Some(hit) = resolve_concept(&declared, &concept_paths, &index) else {
                    continue;
                };
                if hit != other.path {
                    into.entry(hit).or_default().push(other.path.clone());
                }
            }
        }
    }

    // M49.8 (K22): a `supersedes` edge RETIRES only when it could have
    // passed review. An unreviewed concept claiming to replace a
    // human-reviewed one is a PROPOSAL — the verified claim stays current
    // until a person agrees — and two concepts that each claim to replace
    // the other retire neither. Before, one unreviewed write retired a
    // verified claim in the UI and in every agent's context, with no card.
    let trust_of = |path: &str| {
        concepts
            .iter()
            .find(|c| c.path == path)
            .map(|c| review_label(c, ledger))
            .unwrap_or("unverified")
    };
    let approved = |new: &str, old: &str| {
        ledger.is_some_and(|l| l.approved.contains(&(new.to_string(), old.to_string())))
    };
    // Judged against the edges as DECLARED — a snapshot, so removing one
    // end of a mutual pair cannot hide the other end's mutuality.
    let declared = replaced_by.clone();
    let pairs: Vec<(String, String)> = declared
        .iter()
        .flat_map(|(old, news)| news.iter().map(move |new| (old.clone(), new.clone())))
        .collect();
    for (old, new) in pairs {
        let mutual = declared
            .get(&new)
            .is_some_and(|replacers| replacers.contains(&old));
        // A person who approved the replacement on its card has agreed.
        let outranked = trust_of(&old) == "human-reviewed"
            && trust_of(&new) != "human-reviewed"
            && !approved(&new, &old);
        if mutual || outranked {
            if let Some(replacers) = replaced_by.get_mut(&old) {
                replacers.retain(|r| r != &new);
            }
            replacement_proposed.entry(old).or_default().push(new);
        }
    }
    replaced_by.retain(|_, replacers| !replacers.is_empty());

    // The same key `listSubjects` groups by: an anchor that resolves is keyed
    // by the note it found, and one that does not is keyed by what it said.
    let anchor_key = |anchor: &str| match index.resolve(anchor) {
        Some(entry) => entry.path.clone(),
        None => anchor.trim().to_lowercase(),
    };

    let mut matched: Vec<&crate::vault::entry::Entry> = concepts
        .iter()
        .copied()
        .filter(|c| link_field(c, "about").iter().any(|a| anchor_key(a) == key))
        .collect();
    matched.sort_by(|a, b| a.path.cmp(&b.path));

    let omitted = matched.len().saturating_sub(limit);
    matched.truncate(limit);

    let out = matched
        .iter()
        .map(|entry| {
            let stale_after = stale_after_of(entry.properties.get("stale_after"));
            let mut contradicts: Vec<RelationTarget> = link_field(entry, "contradicts")
                .into_iter()
                .map(|target| RelationTarget {
                    path: resolve_concept(&target, &concept_paths, &index),
                    target,
                })
                .filter(|edge| edge.path.as_deref() != Some(entry.path.as_str()))
                .collect();
            for other in contradicted_by.get(&entry.path).into_iter().flatten() {
                // Declared by both ends: one edge, not two.
                if contradicts
                    .iter()
                    .any(|e| e.path.as_deref() == Some(other.as_str()))
                {
                    continue;
                }
                contradicts.push(RelationTarget {
                    path: Some(other.clone()),
                    target: other.clone(),
                });
            }

            AboutConcept {
                path: entry.path.clone(),
                title: entry
                    .properties
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| entry.title.clone()),
                description: entry
                    .properties
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                concept_type: entry.entry_type.clone(),
                // A governed retirement outranks what the file says (K45):
                // the projection never renders it.
                lifecycle: match ledger.and_then(|l| l.governed.retired.get(&entry.path)) {
                    Some(governed) => (*governed).to_string(),
                    None => match entry.properties.get("lifecycle").and_then(Value::as_str) {
                        Some(raw @ ("draft" | "deprecated")) => raw.to_string(),
                        _ => "stable".to_string(),
                    },
                },
                contested: ledger.is_some_and(|l| l.governed.contested.contains(&entry.path)),
                trust: trust_label(entry, ledger),
                // `stale_after` is an ABSOLUTE date, so staleness is a plain
                // comparison with no reference to when it was read (OKF §5.5).
                stale: is_stale(stale_after.as_deref(), today),
                stale_after,
                superseded_by: replaced_by.get(&entry.path).cloned().unwrap_or_default(),
                replacement_proposed_by: replacement_proposed
                    .get(&entry.path)
                    .cloned()
                    .unwrap_or_default(),
                contradicts,
            }
        })
        .collect();

    About {
        subject: subject.map(|e| (e.path.clone(), e.title.clone())),
        key,
        concepts: out,
        omitted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    const REL: &str = "knowledge/playbooks/cutover.md";

    #[test]
    fn the_agent_reaches_the_bundle_through_its_two_stamped_tools_only() {
        // write_concept refuses `verified` and stamps `generated` itself, and
        // recheck_concept moves `stale_after` alone (M49.7). That is only a
        // guarantee while those two are the ONLY writers (M17.1).
        assert!(guard_agent_write(REL).is_err());
        assert!(guard_agent_write("knowledge").is_err());
        assert!(guard_agent_write("knowledge/index.md").is_err());
        // Everything outside the bundle stays the agent's to write.
        assert!(guard_agent_write("records/decisions/d-1.md").is_ok());
        // The trailing-slash rule holds here too: a sibling is not the bundle.
        assert!(guard_agent_write("knowledge-archive/old.md").is_ok());
    }

    /// The guard messages are agent-facing prompt surface and human-facing
    /// UI text. M24.2 typed WHERE they are recorded; it must not have
    /// reworded a single one of them.
    #[test]
    fn typing_the_refusals_did_not_change_one_word_the_caller_sees() {
        assert_eq!(guard_human_write(REL).unwrap_err(), READ_ONLY);
        assert_eq!(guard_agent_write(REL).unwrap_err(), AGENT_USE_WRITE_CONCEPT);
        assert_eq!(
            guard_verify("records/d.md", &patch(&[("verified", Value::Null)])).unwrap_err(),
            "verify_concept only applies to knowledge/ concepts"
        );
        assert_eq!(
            guard_verify(REL, &patch(&[("title", Value::Null)])).unwrap_err(),
            "verify_concept may only write `verified`, not `title`"
        );
        assert_eq!(
            guard_verify(REL, &patch(&[])).unwrap_err(),
            "verify_concept requires a `verified` value"
        );
    }

    #[test]
    fn a_refused_bundle_write_is_typed_and_operational_destined() {
        // D5: reaching the bundle through the wrong door is a tool-surface
        // mistake, not a claim about the world. It belongs in the runtime DB
        // — otherwise the vault's permanent epistemic record fills with
        // "Claude used the wrong tool" and the Skeptic drowns.
        //
        // The destiny is read off the shared table, never decided here. That
        // is the whole point: the routing rule has one home, and a future
        // decision to promote this code into the ledger is a table edit with
        // a coverage-materiality argument, not a call-site change.
        let table = crate::policy::table::PolicyTable::load().unwrap();
        for (surface, detail) in [
            ("agent_write", AGENT_USE_WRITE_CONCEPT),
            ("human_write", READ_ONLY),
        ] {
            let refusal = guard_refusal(surface, detail).unwrap();
            assert_eq!(refusal.surface, surface);
            assert_eq!(refusal.message(), detail, "the caller's words, untouched");
            assert_eq!(
                refusal.code.destiny(&table),
                crate::policy::table::Destiny::Operational
            );
        }
    }

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
        assert_eq!(
            bullets[0],
            "* **Update**: [Cutover](/playbooks/cutover.md)."
        );
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
        let out = insert_log_entry(
            "# Knowledge Update Log\n",
            "2026-07-28",
            "Creation",
            "C",
            REL,
        );
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

    fn concept(title: &str, about: &str) -> String {
        format!("---\ntype: Reference\ntitle: {title}\nabout:\n  - \"{about}\"\n---\n\nBody.\n")
    }

    #[test]
    fn near_duplicates_needs_both_a_shared_anchor_and_a_similar_title() {
        let vault = crate::vault::testutil::temp_vault("near-dup");
        crate::vault::testutil::write(
            &vault,
            "knowledge/systems/drain.md",
            &concept("Pick queue drain time", "[[phoenix]]"),
        );
        // Same project, unrelated subject — one shared word is not a duplicate.
        crate::vault::testutil::write(
            &vault,
            "knowledge/systems/picking.md",
            &concept("Pick list generation", "[[phoenix]]"),
        );
        // Same subject, different project.
        crate::vault::testutil::write(
            &vault,
            "knowledge/systems/other.md",
            &concept("Pick queue drain time", "[[atlas]]"),
        );

        let hits = near_duplicates(
            &vault,
            "knowledge/systems/new.md",
            "Pick queue drain time",
            &["phoenix".to_string()],
        );
        assert_eq!(hits.len(), 1, "got {hits:?}");
        assert!(hits[0].contains("knowledge/systems/drain.md"));
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn near_duplicates_never_reports_the_concept_being_written() {
        let vault = crate::vault::testutil::temp_vault("near-dup-self");
        crate::vault::testutil::write(
            &vault,
            "knowledge/systems/drain.md",
            &concept("Pick queue drain time", "[[phoenix]]"),
        );
        // Revising a concept in place is the behaviour this warning exists to
        // encourage; flagging it as its own duplicate would punish it.
        let hits = near_duplicates(
            &vault,
            "knowledge/systems/drain.md",
            "Pick queue drain time",
            &["[[phoenix]]".to_string()],
        );
        assert!(hits.is_empty(), "got {hits:?}");
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn an_unanchored_concept_is_never_called_a_duplicate() {
        let vault = crate::vault::testutil::temp_vault("near-dup-anchorless");
        crate::vault::testutil::write(
            &vault,
            "knowledge/systems/drain.md",
            &concept("Pick queue drain time", "[[phoenix]]"),
        );
        // Title alone is not enough: without an anchor there is no evidence
        // the two are about the same thing.
        assert!(near_duplicates(&vault, "knowledge/x.md", "Pick queue drain time", &[]).is_empty());
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn recognizes_the_bundle_but_not_a_lookalike_sibling() {
        assert!(is_knowledge_path("knowledge"));
        assert!(is_knowledge_path("knowledge/metrics/revenue.md"));
        assert!(!is_knowledge_path("knowledge-archive/old.md"));
        assert!(!is_knowledge_path("records/risks/r.md"));
        assert!(!is_knowledge_path("my-knowledge/x.md"));
        // M49.4 (K17): the path the filesystem resolves, not the raw string.
        // The same table is asserted against okf.ts's isKnowledgePath.
        for (raw, canonical) in [
            ("./knowledge/x.md", Some("knowledge/x.md")),
            ("Knowledge/x.md", Some("knowledge/x.md")),
            ("KNOWLEDGE/log.md", Some("knowledge/log.md")),
            ("knowledge//a/./b.md", Some("knowledge/a/b.md")),
            ("records/../knowledge/x.md", Some("knowledge/x.md")),
            ("knowledge/../knowledge/x.md", Some("knowledge/x.md")),
            ("knowledge/../records/x.md", None),
            ("../knowledge/x.md", None),
            ("/knowledge/x.md", None),
            ("knowledge-archive/x.md", None),
            ("", None),
        ] {
            assert_eq!(canonical_path(raw).as_deref(), canonical, "{raw}");
            assert_eq!(is_knowledge_path(raw), canonical.is_some(), "{raw}");
        }
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

    #[test]
    fn the_vocabulary_matches_its_digest_and_names_the_words_the_vault_needed() {
        // Two processes in two languages asserting the SAME bytes, not each
        // asserting self-consistency (shared/policy/README.md).
        let names = concept_type_names();
        // The measured gap: 3 programs and 13 systems all landed on Reference
        // because those two words were never in the tool's description.
        assert!(names.contains(&"Program"));
        assert!(names.contains(&"System"));
        // And the fallback must still be offerable, or a concept that is honestly
        // background has nowhere to go.
        assert!(names.contains(&"Reference"));
    }

    // --- What the bundle knows about one entity (M33a.5) -------------------

    use crate::vault::entry::Entry;

    #[test]
    fn trust_tier_reads_the_files_own_stamps() {
        let mut entry = Entry::empty_for_test("knowledge/a.md");
        assert_eq!(trust_tier(&entry), "unverified");

        entry.properties.insert(
            "verified".into(),
            serde_json::json!([{ "by": "process:nightly", "at": "2026-07-01" }]),
        );
        assert_eq!(trust_tier(&entry), "machine-confirmed");

        entry.properties.insert(
            "verified".into(),
            serde_json::json!([
                { "by": "process:nightly", "at": "2026-07-01" },
                { "by": "human:josef", "at": "2026-07-02" }
            ]),
        );
        assert_eq!(trust_tier(&entry), "human-reviewed");

        // A bare mapping must read as a one-element list (OKF §5.2).
        entry.properties.insert(
            "verified".into(),
            serde_json::json!({ "by": "human:josef", "at": "x" }),
        );
        assert_eq!(trust_tier(&entry), "human-reviewed");
    }

    // M49.8 (K24): the shared staleness cases — okf.test.ts replays the same
    // file, so the two sides cannot drift.
    #[test]
    fn staleness_replays_the_shared_cases() {
        let artifact: serde_json::Value = serde_json::from_str(STALENESS).unwrap();
        for case in artifact["cases"].as_array().unwrap() {
            let after = stale_after_of(Some(&case["stale_after"]));
            let today = case["today"].as_str().unwrap();
            assert_eq!(
                is_stale(after.as_deref(), today),
                case["stale"].as_bool().unwrap(),
                "{case}"
            );
            // Every value the rule reads as malformed is one an agent may
            // not set: before, chrono let `2027-7-1` through validation and
            // the concept read stale the moment it was rechecked.
            if let Some(after) = after.as_deref() {
                if is_stale(Some(after), "0001-01-01") {
                    let today = chrono::NaiveDate::from_ymd_opt(2026, 8, 16).unwrap();
                    assert!(validate_stale_after(after, today).is_err(), "{case}");
                }
            }
        }
    }

    #[test]
    fn structure_files_are_not_concepts() {
        assert!(is_concept(&Entry::empty_for_test("knowledge/risks/r.md")));
        assert!(!is_concept(&Entry::empty_for_test("knowledge/index.md")));
        assert!(!is_concept(&Entry::empty_for_test("knowledge/log.md")));
        assert!(!is_concept(&Entry::empty_for_test("records/risks/r.md")));
    }

    const TODAY: &str = "2026-08-16";

    fn note(path: &str, title: &str) -> Entry {
        let mut e = Entry::empty_for_test(path);
        e.title = title.to_string();
        e
    }

    fn concept_entry(path: &str, title: &str, anchors: &[&str]) -> Entry {
        let mut e = note(path, title);
        e.entry_type = Some("Risk".into());
        e.relationships.insert(
            "about".into(),
            anchors.iter().map(|a| (*a).to_string()).collect(),
        );
        e
    }

    /// One vault: a project reachable only by its folder, a record reachable
    /// by stem and by title, and four concepts anchored across them.
    fn corpus() -> Vec<Entry> {
        let mut kestrel = concept_entry(
            "knowledge/risks/thermal-margin.md",
            "Thermal margin unproven",
            &["rq-84b-kestrel"],
        );
        kestrel.properties.insert(
            "description".into(),
            Value::String("The 60C case has never been run.".into()),
        );
        kestrel
            .properties
            .insert("stale_after".into(), Value::String("2026-08-01".into()));

        let mut replacement = concept_entry(
            "knowledge/risks/thermal-margin-rev-b.md",
            "Thermal margin, rev B",
            &["rq-84b-kestrel"],
        );
        replacement
            .relationships
            .insert("supersedes".into(), vec!["thermal-margin".to_string()]);
        replacement
            .relationships
            .insert("contradicts".into(), vec!["thermal-margin".to_string()]);
        replacement
            .properties
            .insert("lifecycle".into(), Value::String("draft".into()));

        vec![
            note("projects/atlas/project.md", "Atlas rollout"),
            note("records/reqs/rq-84b-kestrel.md", "RQ-84B Kestrel"),
            kestrel,
            replacement,
            concept_entry(
                "knowledge/systems/atlas-gateway.md",
                "Atlas gateway",
                &["atlas"],
            ),
            // An anchor to something nobody has written up — an open thread,
            // not a broken link (M33a D7). Its own filename must NOT be the
            // anchor, or the concept would resolve as its own subject.
            concept_entry(
                "knowledge/systems/duty-cycle.md",
                "MPM-410 duty cycle",
                &["mpm-410"],
            ),
            // Bundle structure: never a concept, never an answer.
            note("knowledge/index.md", "Index"),
        ]
    }

    #[test]
    fn a_target_resolves_by_path_stem_folder_and_title_alike() {
        let entries = corpus();
        for target in [
            "records/reqs/rq-84b-kestrel.md",
            "rq-84b-kestrel",
            "RQ-84B-KESTREL",
            "RQ-84B Kestrel",
        ] {
            let answer = about(&entries, target, TODAY, 20, None);
            assert_eq!(
                answer.subject.as_ref().map(|(p, _)| p.as_str()),
                Some("records/reqs/rq-84b-kestrel.md"),
                "{target}"
            );
            assert_eq!(answer.concepts.len(), 2, "{target}");
        }
        // A project is reached by its FOLDER — every project file is
        // project.md, so a stem match can never name one.
        let answer = about(&entries, "atlas", TODAY, 20, None);
        assert_eq!(
            answer.subject.as_ref().map(|(p, _)| p.as_str()),
            Some("projects/atlas/project.md")
        );
        assert_eq!(answer.concepts.len(), 1);
    }

    #[test]
    fn an_entity_nobody_wrote_about_is_empty_and_a_name_nothing_carries_is_an_open_thread() {
        let entries = corpus();

        // Written up, nothing distilled: a real subject, measured at zero.
        let quiet = about(&entries, "projects/atlas/project.md", TODAY, 20, None);
        assert!(quiet.subject.is_some());
        assert_eq!(quiet.concepts.len(), 1);

        // A record the base has never touched.
        let untouched = about(&entries, "knowledge/index.md", TODAY, 20, None);
        assert!(untouched.subject.is_some(), "the file exists");
        assert!(
            untouched.concepts.is_empty(),
            "and nothing is anchored to it"
        );

        // An OPEN THREAD: no note carries the name, and the base is tracking
        // it anyway. Absent subject, present concepts — the two are separate
        // answers and neither is an error.
        let thread = about(&entries, "mpm-410", TODAY, 20, None);
        assert!(thread.subject.is_none());
        assert_eq!(thread.key, "mpm-410");
        assert_eq!(thread.concepts.len(), 1);

        // And a name that is neither: empty, with no subject.
        let nothing = about(&entries, "kos-3.2", TODAY, 20, None);
        assert!(nothing.subject.is_none());
        assert!(nothing.concepts.is_empty());
    }

    fn at<'a>(answer: &'a About, path: &str) -> &'a AboutConcept {
        answer
            .concepts
            .iter()
            .find(|c| c.path == path)
            .unwrap_or_else(|| panic!("{path} is missing from {:?}", answer.concepts))
    }

    #[test]
    fn a_concept_reports_what_was_recorded_and_says_nothing_about_what_was_not() {
        let entries = corpus();
        let answer = about(&entries, "rq-84b-kestrel", TODAY, 20, None);
        let old = at(&answer, "knowledge/risks/thermal-margin.md");
        assert_eq!(
            old.description.as_deref(),
            Some("The 60C case has never been run.")
        );
        assert_eq!(old.concept_type.as_deref(), Some("Risk"));
        assert_eq!(old.lifecycle, "stable", "unset lifecycle reads as stable");
        assert_eq!(old.trust, "unverified");
        assert!(old.stale, "2026-08-01 has passed");

        let new = at(&answer, "knowledge/risks/thermal-margin-rev-b.md");
        assert_eq!(new.lifecycle, "draft");
        // NOT RECORDED, never zero or empty-string: nobody wrote a
        // description or a recheck date on this one.
        assert_eq!(new.description, None);
        assert_eq!(new.stale_after, None);
        assert!(!new.stale, "no recheck date is not the same as fresh");
    }

    #[test]
    fn the_graph_is_read_backwards_so_a_retired_claim_does_not_look_current() {
        let entries = corpus();
        let answer = about(&entries, "rq-84b-kestrel", TODAY, 20, None);
        let old = at(&answer, "knowledge/risks/thermal-margin.md");
        // The replaced concept's own frontmatter says nothing about being
        // replaced — the replacement is what knows.
        assert_eq!(
            old.superseded_by,
            vec!["knowledge/risks/thermal-margin-rev-b.md".to_string()]
        );
        // Contradiction is symmetric, so the end that did not declare it
        // still reports the edge.
        assert_eq!(
            old.contradicts
                .iter()
                .filter_map(|e| e.path.clone())
                .collect::<Vec<_>>(),
            vec!["knowledge/risks/thermal-margin-rev-b.md".to_string()]
        );

        let new = at(&answer, "knowledge/risks/thermal-margin-rev-b.md");
        assert!(new.superseded_by.is_empty());
        assert_eq!(
            new.contradicts
                .iter()
                .filter_map(|e| e.path.clone())
                .collect::<Vec<_>>(),
            vec!["knowledge/risks/thermal-margin.md".to_string()],
            "declared once, reported once"
        );
    }

    // M49.8 (K22): an unreviewed concept cannot retire a human-reviewed
    // one — it PROPOSES; and two concepts that each claim to replace the
    // other retire neither.
    #[test]
    fn an_unreviewed_replacement_of_a_reviewed_claim_is_only_proposed() {
        let mut entries = corpus();
        let old = entries
            .iter_mut()
            .find(|e| e.path == "knowledge/risks/thermal-margin.md")
            .unwrap();
        old.properties.insert(
            "verified".into(),
            serde_json::json!({ "by": "human:josef", "at": "2026-08-01" }),
        );
        let answer = about(&entries, "rq-84b-kestrel", TODAY, 20, None);
        let old = at(&answer, "knowledge/risks/thermal-margin.md");
        assert!(
            old.superseded_by.is_empty(),
            "the verified claim stays current"
        );
        assert_eq!(
            old.replacement_proposed_by,
            vec!["knowledge/risks/thermal-margin-rev-b.md".to_string()]
        );

        // Mutual replacement: each claims to replace the other.
        let mut mutual = corpus();
        let rev_b = mutual
            .iter_mut()
            .find(|e| e.path == "knowledge/risks/thermal-margin-rev-b.md")
            .unwrap()
            .clone();
        let first = mutual
            .iter_mut()
            .find(|e| e.path == "knowledge/risks/thermal-margin.md")
            .unwrap();
        first
            .relationships
            .insert("supersedes".into(), vec!["thermal-margin-rev-b".into()]);
        let answer = about(&mutual, "rq-84b-kestrel", TODAY, 20, None);
        for path in [rev_b.path.as_str(), "knowledge/risks/thermal-margin.md"] {
            let c = at(&answer, path);
            assert!(c.superseded_by.is_empty(), "{path} is not retired");
            assert_eq!(c.replacement_proposed_by.len(), 1, "{path}");
        }
    }

    // A person who approved the replacement on its card has agreed: the
    // reviewed claim retires, though the replacement is still unreviewed.
    // An edit elsewhere to the reviewed claim does not let it retire either
    // — the gate reads the review as RECORDED, not the disputed file.
    #[test]
    fn an_approved_replacement_retires_the_reviewed_claim() {
        let mut entries = corpus();
        let old_path = "knowledge/risks/thermal-margin.md".to_string();
        let new_path = "knowledge/risks/thermal-margin-rev-b.md".to_string();
        entries
            .iter_mut()
            .find(|e| e.path == old_path)
            .unwrap()
            .properties
            .insert(
                "verified".into(),
                serde_json::json!({ "by": "human:josef", "at": "2026-08-01" }),
            );
        let mut ledger = LedgerReview {
            reviews: [(old_path.clone(), Reviewed::Current)]
                .into_iter()
                .collect(),
            human: [old_path.clone()].into_iter().collect(),
            ..LedgerReview::default()
        };
        ledger.quarantined.insert(old_path.clone());
        let proposed = about(&entries, "rq-84b-kestrel", TODAY, 20, Some(&ledger));
        assert!(at(&proposed, &old_path).superseded_by.is_empty());

        ledger.approved.insert((new_path.clone(), old_path.clone()));
        let approved = about(&entries, "rq-84b-kestrel", TODAY, 20, Some(&ledger));
        let old = at(&approved, &old_path);
        assert_eq!(old.superseded_by, vec![new_path]);
        assert!(old.replacement_proposed_by.is_empty());
    }

    // M49.8 (K21): with a ledger, the ledger decides the review. A file
    // stamp the ledger never recorded is disputed; without a ledger, the
    // file is all there is.
    #[test]
    fn trust_is_the_ledgers_review_and_a_stamp_it_never_recorded_is_disputed() {
        let mut stamped = note("knowledge/risks/r.md", "R");
        stamped.properties.insert(
            "verified".into(),
            serde_json::json!({ "by": "human:josef", "at": "2026-08-01" }),
        );
        let plain = note("knowledge/risks/p.md", "P");
        assert_eq!(trust_label(&stamped, None), "human-reviewed");
        let ledger = |r: Reviewed| LedgerReview {
            reviews: [
                ("knowledge/risks/r.md".to_string(), r),
                ("knowledge/risks/p.md".to_string(), r),
            ]
            .into_iter()
            .collect(),
            human: ["knowledge/risks/r.md".to_string()].into_iter().collect(),
            ..LedgerReview::default()
        };
        assert_eq!(
            trust_label(&stamped, Some(&ledger(Reviewed::Unreviewed))),
            "disputed"
        );
        assert_eq!(
            trust_label(&plain, Some(&ledger(Reviewed::Unreviewed))),
            "unverified"
        );
        assert_eq!(
            trust_label(&stamped, Some(&ledger(Reviewed::Current))),
            "human-reviewed"
        );
        assert_eq!(
            trust_label(&stamped, Some(&ledger(Reviewed::PredatesCurrent))),
            "reviewed-earlier-revision"
        );
        // A file the ledger does not record at all grants nothing either.
        let empty = LedgerReview::default();
        assert_eq!(trust_label(&stamped, Some(&empty)), "disputed");

        // A reviewed concept whose FILE is not the ledger's reads disputed —
        // its content is not what was reviewed (the TS twin reads
        // `LedgerStatus.quarantined` the same way).
        let mut edited = ledger(Reviewed::Current);
        edited
            .quarantined
            .insert("knowledge/risks/r.md".to_string());
        assert_eq!(trust_label(&stamped, Some(&edited)), "disputed");
        // Who reviewed is the LEDGER's answer: p's current review is
        // recorded as a machine's, whatever its file says.
        assert_eq!(trust_label(&plain, Some(&edited)), "machine-confirmed");

        // A ledger that exists and cannot be read trusts no stamp — it is
        // never read as "no ledger".
        let unreadable = LedgerReview {
            unreadable: true,
            ..LedgerReview::default()
        };
        assert_eq!(trust_label(&stamped, Some(&unreadable)), "disputed");
        assert_eq!(trust_label(&plain, Some(&unreadable)), "unverified");
    }

    // M49.8 (K45): a governed retirement or an open contest reaches the
    // agent even though the projected markdown never changes for it.
    #[test]
    fn governed_retirement_and_contest_reach_the_reader() {
        let entries = corpus();
        let path = "knowledge/risks/thermal-margin.md".to_string();
        let mut governed = Governed::default();
        governed.retired.insert(path.clone(), "archived");
        governed.contested.insert(path.clone());
        let ledger = LedgerReview {
            governed,
            ..LedgerReview::default()
        };
        let answer = about(&entries, "rq-84b-kestrel", TODAY, 20, Some(&ledger));
        let c = at(&answer, &path);
        assert_eq!(c.lifecycle, "archived");
        assert!(c.contested);
        let untouched = about(&entries, "rq-84b-kestrel", TODAY, 20, None);
        assert_eq!(at(&untouched, &path).lifecycle, "stable");
    }

    #[test]
    fn a_relation_naming_nothing_is_reported_as_unresolved_rather_than_dropped() {
        let mut entries = corpus();
        let mut orphan = concept_entry("knowledge/risks/loose.md", "Loose end", &["mpm-410"]);
        orphan
            .relationships
            .insert("contradicts".into(), vec!["never-written".to_string()]);
        entries.push(orphan);

        let answer = about(&entries, "mpm-410", TODAY, 20, None);
        let loose = answer
            .concepts
            .iter()
            .find(|c| c.path == "knowledge/risks/loose.md")
            .expect("the concept is anchored to the thread");
        assert_eq!(loose.contradicts.len(), 1);
        assert_eq!(loose.contradicts[0].target, "never-written");
        assert_eq!(loose.contradicts[0].path, None);
    }

    #[test]
    fn a_limit_counts_what_it_cut_instead_of_absorbing_it() {
        let entries = corpus();
        let answer = about(&entries, "rq-84b-kestrel", TODAY, 1, None);
        assert_eq!(answer.concepts.len(), 1);
        assert_eq!(answer.omitted, 1);
        // And nothing is omitted when everything fits.
        assert_eq!(
            about(&entries, "rq-84b-kestrel", TODAY, 20, None).omitted,
            0
        );
    }

    /// Regenerating the digest is a deliberate act, so it is a test you run by
    /// name rather than something the suite does on its own.
    ///
    /// `cargo test --lib knowledge::tests::write_concept_types_digest -- --ignored`
    #[test]
    #[ignore]
    fn write_concept_types_digest() {
        let digest = crate::ledger::sha256_hex(CONCEPT_TYPES_JSON.as_bytes());
        std::fs::write(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../shared/policy/concept-types.v1.sha256"
            ),
            format!("{digest}\n"),
        )
        .unwrap();
    }
}
