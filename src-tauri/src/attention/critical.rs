//! The `critical_attention` bypass (M27.7) — §8, and deliberately tiny.
//!
//! **This is not a Risk model and must never become one.** There is no score,
//! no severity ladder, no learned threshold: a trigger either matches its
//! typed fields exactly or it does not fire. The whole reason it exists is
//! that "the production signing certificate expires tomorrow" must not wait
//! for M28+'s trigger registry, and the whole reason it is this small is that
//! anything larger becomes a scoring system by accretion.
//!
//! **Adding a trigger is an artifact change plus a vector change, never
//! hidden code.** The evaluator here interprets
//! `shared/policy/critical-attention.v1.json` — required typed fields,
//! comparison operators, durations, and the replacement relation — and knows
//! nothing about certificates. A trigger this build cannot express is a
//! reason to grow the artifact format, exactly as with the policy table.
//!
//! **Both languages interpret the same file.** `src/lib/attention/critical.ts`
//! is the second interpreter, and the parity mechanism is the shared goldens
//! in `shared/policy/goldens-critical/` — replayed by `cargo test` and by
//! `pnpm test:run` from the same bytes. Reviewing two hand-mirrored
//! implementations is exactly what this codebase refuses.
//!
//! **Silence is the default.** A candidate missing a required field, or
//! carrying one that will not parse, does NOT fire — it stays ordinary debt
//! or blindness. A bypass that fired on malformed input would train people to
//! ignore it, which is the one failure a bypass cannot survive.
//!
//! **A replaced credential is not a crisis.** If an active `supersedes`
//! relation points from a replacement TO this candidate, somebody has already
//! done the thing. The direction is in the artifact because getting it
//! backwards would silence exactly the certificates that still need rotating.

use std::collections::{BTreeMap, BTreeSet};

use crate::ledger::sha256_hex;

const CRITICAL_JSON: &str = include_str!("../../../shared/policy/critical-attention.v1.json");
const CRITICAL_DIGEST: &str = include_str!("../../../shared/policy/critical-attention.v1.sha256");

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    format: u64,
    artifact_version: u64,
    rule_version: String,
    replacement: Replacement,
    triggers: Vec<Trigger>,
}

/// Which relation retires a candidate, and in which direction.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Replacement {
    pub relation: String,
    /// The one direction that counts: the REPLACEMENT is `from` and the
    /// candidate being replaced is `to`. Spelled out because a relation read
    /// backwards would silence the certificates that still need rotating.
    pub direction: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    pub id: String,
    pub copy_key: String,
    pub required_fields: Vec<RequiredField>,
    pub conditions: Vec<Condition>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequiredField {
    pub field: String,
    #[serde(rename = "type")]
    pub kind: FieldKind,
    /// The exact value this field must carry, when the trigger pins one.
    #[serde(default)]
    pub equals: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    String,
    Timestamp,
}

/// `<field> <operator> as_of + plus_seconds`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub field: String,
    pub operator: Operator,
    /// Only `as_of` today. A field-to-field comparison is a format change.
    pub of: String,
    pub plus_seconds: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    Lte,
    Gt,
}

/// The loaded triggers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Triggers {
    pub artifact_version: u64,
    pub rule_version: String,
    pub replacement: Replacement,
    triggers: Vec<Trigger>,
}

impl Triggers {
    pub fn all(&self) -> &[Trigger] {
        &self.triggers
    }
}

/// Load the shipped triggers, bytes checked against the committed digest.
pub fn load() -> Result<Triggers, String> {
    let expected = CRITICAL_DIGEST.trim();
    let actual = sha256_hex(CRITICAL_JSON.as_bytes());
    if actual != expected {
        return Err(format!(
            "shared/policy/critical-attention.v1.json hashes to {actual}, and the committed \
             digest says {expected} — regenerate the digest deliberately, or find out who \
             changed what this app interrupts a person for"
        ));
    }
    let artifact: Artifact = serde_json::from_str(CRITICAL_JSON)
        .map_err(|e| format!("critical-attention.v1.json: {e}"))?;
    if artifact.format != 1 {
        return Err(format!(
            "critical-attention format {} is not one this build speaks",
            artifact.format
        ));
    }
    if artifact.rule_version.is_empty() {
        return Err("rule_version must be non-empty".into());
    }
    if artifact.replacement.direction != "replacement_from_candidate_to" {
        return Err(format!(
            "replacement direction {:?} is not one this build speaks — reading a supersedes \
             backwards would silence exactly the candidates that still need attention",
            artifact.replacement.direction
        ));
    }
    if artifact.triggers.is_empty() {
        return Err(
            "critical-attention.v1.json declares no triggers — an empty bypass and a failed load \
             are indistinguishable, and both are silence"
                .into(),
        );
    }
    let mut ids: BTreeSet<&str> = BTreeSet::new();
    for trigger in &artifact.triggers {
        if !ids.insert(trigger.id.as_str()) {
            return Err(format!("trigger {:?} is declared twice", trigger.id));
        }
        if trigger.copy_key.is_empty() {
            return Err(format!("trigger {:?} has no copy key", trigger.id));
        }
        if trigger.required_fields.is_empty() {
            return Err(format!(
                "trigger {:?} requires no fields — a trigger that matches anything is not \
                 conservative, it is an alarm",
                trigger.id
            ));
        }
        if trigger.conditions.is_empty() {
            return Err(format!(
                "trigger {:?} declares no conditions — it would fire on every candidate whose \
                 fields parse",
                trigger.id
            ));
        }
        let declared: BTreeSet<&str> = trigger
            .required_fields
            .iter()
            .map(|f| f.field.as_str())
            .collect();
        for condition in &trigger.conditions {
            if condition.of != "as_of" {
                return Err(format!(
                    "trigger {:?} compares against {:?}; this build only compares against as_of",
                    trigger.id, condition.of
                ));
            }
            // A condition on a field nothing requires would compare against a
            // value that may not be there, and "absent" is not a comparison
            // result — it is a reason not to fire, decided elsewhere.
            if !declared.contains(condition.field.as_str()) {
                return Err(format!(
                    "trigger {:?} compares {:?}, which it does not require",
                    trigger.id, condition.field
                ));
            }
        }
    }

    Ok(Triggers {
        artifact_version: artifact.artifact_version,
        rule_version: artifact.rule_version,
        replacement: artifact.replacement,
        triggers: artifact.triggers,
    })
}

/// One thing a trigger might be about: its typed fields, as recorded.
///
/// Values arrive as strings because that is what a record's frontmatter and a
/// typed assertion both reduce to at this boundary; the artifact says how to
/// read each one, and a value that will not read is a reason not to fire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub fields: BTreeMap<String, String>,
    /// Whether this candidate is still active at all. An archived credential
    /// is not a live obligation.
    pub active: bool,
}

/// One active replacement edge: `from` replaces `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplacementEdge {
    pub from: String,
    pub to: String,
    pub relation: String,
    pub active: bool,
}

/// One firing.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Firing {
    pub trigger_id: String,
    pub candidate_id: String,
    pub copy_key: String,
    pub rule_version: String,
}

/// Evaluate every trigger against every candidate, as of an explicit instant.
///
/// Deterministic and total: triggers in artifact order, candidates sorted by
/// id, and a candidate that fires two triggers reports both — the artifact
/// decides which comes first, not this function.
pub fn evaluate(
    triggers: &Triggers,
    candidates: &[Candidate],
    replacements: &[ReplacementEdge],
    as_of: chrono::DateTime<chrono::Utc>,
) -> Vec<Firing> {
    let replaced: BTreeSet<&str> = replacements
        .iter()
        .filter(|edge| edge.active && edge.relation == triggers.replacement.relation)
        .map(|edge| edge.to.as_str())
        .collect();

    let mut sorted: Vec<&Candidate> = candidates.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));

    let mut out = Vec::new();
    for trigger in &triggers.triggers {
        for candidate in &sorted {
            if !candidate.active || replaced.contains(candidate.id.as_str()) {
                continue;
            }
            if fires(trigger, candidate, as_of) {
                out.push(Firing {
                    trigger_id: trigger.id.clone(),
                    candidate_id: candidate.id.clone(),
                    copy_key: trigger.copy_key.clone(),
                    rule_version: triggers.rule_version.clone(),
                });
            }
        }
    }
    out
}

fn fires(trigger: &Trigger, candidate: &Candidate, as_of: chrono::DateTime<chrono::Utc>) -> bool {
    let mut times: BTreeMap<&str, chrono::DateTime<chrono::Utc>> = BTreeMap::new();
    for required in &trigger.required_fields {
        let Some(value) = candidate.fields.get(&required.field) else {
            return false;
        };
        match required.kind {
            FieldKind::String => {
                if let Some(expected) = &required.equals {
                    if value != expected {
                        return false;
                    }
                }
            }
            FieldKind::Timestamp => {
                // Unparseable is missing. Guessing here would let one
                // malformed string decide an interruption.
                let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value) else {
                    return false;
                };
                times.insert(required.field.as_str(), parsed.with_timezone(&chrono::Utc));
                if let Some(expected) = &required.equals {
                    if value != expected {
                        return false;
                    }
                }
            }
        }
    }

    for condition in &trigger.conditions {
        let Some(actual) = times.get(condition.field.as_str()) else {
            return false;
        };
        let Some(boundary) =
            as_of.checked_add_signed(chrono::Duration::seconds(condition.plus_seconds))
        else {
            return false;
        };
        let holds = match condition.operator {
            Operator::Lte => *actual <= boundary,
            Operator::Gt => *actual > boundary,
        };
        if !holds {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One golden, as both suites read it.
    #[derive(Debug, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Golden {
        name: String,
        description: String,
        as_of: String,
        candidates: Vec<GoldenCandidate>,
        #[serde(default)]
        replacements: Vec<GoldenReplacement>,
        /// Trigger ids expected to fire, with the candidate each fired on.
        expected: Vec<GoldenFiring>,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct GoldenCandidate {
        id: String,
        active: bool,
        fields: BTreeMap<String, String>,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct GoldenReplacement {
        from: String,
        to: String,
        relation: String,
        active: bool,
    }

    #[derive(Debug, PartialEq, Eq, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct GoldenFiring {
        trigger_id: String,
        candidate_id: String,
    }

    fn goldens_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/policy/goldens-critical")
    }

    fn goldens() -> Vec<(String, Golden)> {
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(goldens_dir())
            .expect("the goldens directory")
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| path.extension().is_some_and(|e| e == "json"))
            .collect();
        files.sort();
        files
            .into_iter()
            .map(|path| {
                let raw = std::fs::read_to_string(&path).expect("readable");
                let golden: Golden = serde_json::from_str(&raw)
                    .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
                (
                    path.file_name().unwrap().to_string_lossy().to_string(),
                    golden,
                )
            })
            .collect()
    }

    #[test]
    fn the_shipped_artifact_loads_and_its_digest_is_over_the_bytes_that_ship() {
        let triggers = load().expect("the shipped triggers");
        assert_eq!(triggers.rule_version, "critical-attention-v1");
        assert_eq!(
            triggers
                .all()
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            [
                "production_signing_certificate_expired",
                "production_signing_certificate_expiring"
            ],
            "the initial inventory is deliberately small and complete"
        );
        assert_eq!(
            sha256_hex(CRITICAL_JSON.as_bytes()),
            CRITICAL_DIGEST.trim(),
            "regenerate shared/policy/critical-attention.v1.sha256"
        );
    }

    #[test]
    fn every_shipped_trigger_has_its_five_goldens() {
        // Positive, boundary, replaced, wrong-environment, malformed — for
        // each trigger, in the shared directory both suites read. A trigger
        // with no vectors is a rule nobody has to keep.
        let triggers = load().unwrap();
        let names: Vec<String> = goldens().into_iter().map(|(name, _)| name).collect();
        for trigger in triggers.all() {
            for shape in [
                "positive",
                "boundary",
                "replaced",
                "wrong-environment",
                "malformed",
            ] {
                let wanted = format!("{}-{shape}.json", trigger.id.replace('_', "-"));
                assert!(
                    names.contains(&wanted),
                    "missing golden {wanted} — {names:?}"
                );
            }
        }
    }

    #[test]
    fn the_goldens_replay() {
        let triggers = load().unwrap();
        for (name, golden) in goldens() {
            let as_of = chrono::DateTime::parse_from_rfc3339(&golden.as_of)
                .unwrap_or_else(|e| panic!("{name}: as_of {e}"))
                .with_timezone(&chrono::Utc);
            let candidates: Vec<Candidate> = golden
                .candidates
                .iter()
                .map(|c| Candidate {
                    id: c.id.clone(),
                    fields: c.fields.clone(),
                    active: c.active,
                })
                .collect();
            let replacements: Vec<ReplacementEdge> = golden
                .replacements
                .iter()
                .map(|r| ReplacementEdge {
                    from: r.from.clone(),
                    to: r.to.clone(),
                    relation: r.relation.clone(),
                    active: r.active,
                })
                .collect();
            let fired: Vec<GoldenFiring> = evaluate(&triggers, &candidates, &replacements, as_of)
                .into_iter()
                .map(|f| GoldenFiring {
                    trigger_id: f.trigger_id,
                    candidate_id: f.candidate_id,
                })
                .collect();
            assert_eq!(
                fired, golden.expected,
                "{name} ({}): {}",
                golden.name, golden.description
            );
        }
    }

    #[test]
    fn nothing_here_reads_a_clock() {
        // The bypass answers "is this expired AS OF a moment you name". A
        // reducer that read the wall clock would answer differently about a
        // ledger that had not moved, and the replay would be unrepeatable.
        let source = include_str!("critical.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in ["Utc::now", "SystemTime", "Local::now"] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the bypass"
            );
        }
    }

    /// Regenerate `shared/policy/critical-attention.v1.sha256` after a
    /// DELIBERATE edit.
    #[test]
    #[ignore = "regeneration is a deliberate act — run with --ignored after editing the artifact"]
    fn write_critical_digest() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/policy/critical-attention.v1.sha256");
        std::fs::write(&path, format!("{}\n", sha256_hex(CRITICAL_JSON.as_bytes()))).unwrap();
    }
}
