//! The lane feed the Epistemic Status surface opens (M27.8a).
//!
//! M26 shipped the primitives with no lanes over them, M27.6 shipped the lanes
//! with no door, and this is the door. The ordering was never decided by
//! whoever wrote the query first, which was the whole point of holding it back.
//!
//! **Everything crosses the wire already read aloud.** Lane names, the sentence
//! under each lane, its empty line, and the reason on every item are composed
//! here — the same call M27.5 made for `support_text` and for the same reason.
//! A `Record<LaneId, string>` on the TypeScript side would render a lane added
//! to the artifact as `undefined`, and the `match` below cannot compile
//! without a word for it. Drift is a build failure rather than a blank label.
//!
//! **Nothing reaches a surface without passing the firewall.** [`view`] runs
//! [`preferences::present`] on its way out, so §33's protected lanes are
//! enforced on the one path that has a reader rather than by asking every
//! future caller to remember. Preferences are not persisted yet; when they are,
//! this is the single place that loads them.
//!
//! **Empty and unreadable are different answers, per lane and per feed.** A
//! lane with nothing in it says so in its own words; a feed this process could
//! not read is named in [`LanesView::incomplete`], because a debt lane quietly
//! missing every parked promotion looks exactly like a base that owes nothing.

use std::collections::BTreeMap;
use std::path::Path;

use super::lanes::{self, Definitions, Item, Lane, Lanes, ParkedPromotion, Reason, Reliance};
use super::preferences::{self, Preferences};
use crate::dynamics::bundle;

/// One item, with its words attached.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ItemView {
    pub lane: Lane,
    pub belief_id: String,
    pub entity_id: String,
    /// The knowledge-relative projection path, when a file projects this
    /// belief. The surface prefers it as a title and falls back to the entity.
    pub path: Option<String>,
    pub predicate: Option<String>,
    pub state_stage: Option<String>,
    /// "CI status, at the implemented stage" — which of its claims this row
    /// is about, when the reason is per-facet and the belief has more than
    /// one. `None` for a belief's only facet (its scope is the belief's), and
    /// for the contradiction lane, whose subject is a pair.
    pub scope_text: Option<String>,
    pub reasons: Vec<Reason>,
    /// The reasons, joined. Never empty: a lane item that could not say why
    /// would be a badge, which is the thing this milestone refuses to ship.
    pub reason_text: String,
    pub reliance: Vec<Reliance>,
    /// Why the base is taken to rely on this, or `None` when nothing recorded
    /// says it does. In the blindness lane that is ordinary and not a defect.
    pub reliance_text: Option<String>,
    pub edge_id: Option<String>,
    pub relation_id: Option<String>,
}

/// One lane, in the artifact's order, present whether or not it holds anything.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LaneView {
    pub id: String,
    pub label: String,
    /// One sentence on what belongs in this lane, so a reader can tell an
    /// empty lane from a lane they have misunderstood.
    pub blurb: String,
    /// What this lane says when it holds nothing.
    pub empty_text: String,
    /// §33: whether any preference could have hidden this. Carried so a
    /// surface can show the guarantee rather than assert it in a comment.
    pub protected: bool,
    pub items: Vec<ItemView>,
    /// How many of THIS lane's items a preference held back. Always `0` for a
    /// protected lane, and the sum across lanes equals [`LanesView::withheld`].
    pub withheld: usize,
}

/// Every lane, after preferences.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LanesView {
    pub rule_version: String,
    pub lanes: Vec<LaneView>,
    /// The authoritative total from the firewall. A cap nobody can see reads
    /// as "there is nothing else".
    pub withheld: usize,
    /// What this answer could not see, in sentences. Empty is the ordinary
    /// case and means the lanes are complete — which is only sayable because
    /// the incomplete case has somewhere to go.
    pub incomplete: Vec<String>,
}

struct Words {
    label: &'static str,
    blurb: &'static str,
    empty: &'static str,
}

/// What each lane is called, what belongs in it, and what it says when empty.
///
/// Exhaustive by construction: a fifth lane cannot be added to [`Lane`] — and
/// the loader will not accept one in the artifact without it — until somebody
/// has decided what to call it in front of a person.
///
/// In the words the rest of the app uses (M52.3): the thing that holds claims
/// is "Knowledge", never "the base", and each lane is named for what a reader
/// would do about it — "Due a recheck", the same words a concept's review bar
/// and the review queue use — rather than for the epistemology behind it.
/// The browser mock's `demoLanes` repeats these verbatim; a lane that read
/// differently there than here is the drift this comment exists to prevent.
fn lane_words(lane: Lane) -> Words {
    match lane {
        Lane::Contradiction => Words {
            label: "Contradictions",
            blurb: "Two things Knowledge holds that cannot both be true.",
            empty: "No open contradictions.",
        },
        Lane::Blindness => Words {
            label: "Gaps",
            blurb: "Where Knowledge looked for evidence and found none, and how much \
                    nobody has checked yet.",
            // Only when coverage was assessed for everything (M49.10): see
            // `unassessed_text`, which replaces it otherwise.
            empty: "No gaps.",
        },
        Lane::Staleness => Words {
            label: "Due a recheck",
            blurb: "Past the date it was due to be rechecked. Not wrong — unchecked.",
            empty: "Nothing is due a recheck.",
        },
        Lane::EpistemicDebt => Words {
            label: "Taken on trust",
            blurb: "What Knowledge is relied on for but cannot yet back with evidence.",
            empty: "Nothing is taken on trust.",
        },
    }
}

/// Every reason, in the words the spec insists on: "stage lag", "not yet
/// assessed", "no admissible evidence". Honest words are spec compliance, so
/// they live beside the derivation that produced the code and not in a UI
/// file.
fn reason_words(reason: Reason) -> &'static str {
    match reason {
        Reason::OpenEdgeGenuineDirect => "genuine direct conflict",
        Reason::OpenEdgePartial => "partial conflict",
        Reason::OpenEdgeConditional => "conditional conflict",
        Reason::LegacyUnclassified => "declared contradiction, not yet classified",
        // The chips' words for the same folds (M52.5): of the sources, not
        // of an axis called coverage.
        Reason::CoverageBlindAssessed => "its sources were assessed and not observed",
        Reason::CoverageUnassessed => "its sources are not yet assessed",
        // The review bar's and the queue's words for the same fact (M52.5).
        Reason::FreshnessStale => "past its recheck date",
        Reason::UnresolvedContradiction => "unresolved contradiction",
        // Never "false", and never "wrong". D9's unsupported means nobody has
        // offered admissible evidence, which says nothing about the claim.
        Reason::UnsupportedInference => "no admissible evidence",
        Reason::AuthorityRouteUnmatched => "no evidence met the authority route",
        Reason::NoAuthorityRouteDeclared => "no authority route declared",
        Reason::PromotionBlocked => "promotion parked, waiting on missing fields",
        Reason::StaleEvidence => "its evidence is stale",
        Reason::CoverageNotObserved => "its sources are not all observed",
        // §78/§80. Never "reasoning in circles" — the finding is a graph fact
        // about which evidence traces back to this belief's own output, and
        // it says which walk it took rather than what it thinks of it.
        Reason::CircularSupport => "some of its support traces back to itself",
        Reason::DuplicatedLineageFamily => "two of its supports are the same message twice",
        Reason::DescendantOnlyReinforcement => "all of its support traces back to itself",
    }
}

/// Why something relies on the item, as the end of "Relied on — …" (M52.5:
/// "relied on: promoted past draft" was the ledger talking, and "it was
/// promoted out of draft" still was).
fn reliance_words(reliance: Reliance) -> &'static str {
    match reliance {
        Reliance::Qualified => "it is no longer a draft",
        Reliance::PromotionAttempted => "someone asked to take it out of draft",
        Reliance::RefinedBy => "another concept builds on it",
    }
}

/// Words that are initials, said as initials: "CI status", never "Ci
/// status" or "ci status".
const INITIALISMS: [&str; 22] = [
    "api", "arr", "cd", "ci", "cpu", "crm", "db", "eta", "id", "kpi", "mrr", "nps", "qa", "sdk",
    "sku", "sla", "slo", "sql", "sso", "ui", "url", "ux",
];

/// A predicate as the field it names (M52.5): "ci_status" is "CI status" —
/// its words, initials upper-cased, the first capitalised.
fn field_words(predicate: &str) -> String {
    predicate
        .split('_')
        .filter(|word| !word.is_empty())
        .enumerate()
        .map(|(n, word)| {
            let lower = word.to_ascii_lowercase();
            if INITIALISMS.contains(&lower.as_str()) {
                word.to_ascii_uppercase()
            } else if n == 0 {
                let mut chars = word.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().chain(chars).collect())
                    .unwrap_or_default()
            } else {
                word.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A facet in words (M52.5): the field, and the stage as a stage — "CI
/// status, at the implemented stage", where "ci_status at implemented" was a
/// key and a value run together and "ci status when implemented" was its
/// underscores swapped for spaces. An `unknown` stage is no stage.
/// `knowledge/FacetChips.tsx`'s `scopeWords` says the same for the chips'
/// rows; change the two together.
fn scope_words(predicate: &str, stage: Option<&str>) -> String {
    let field = field_words(predicate);
    match stage {
        Some("unknown") | None => field,
        Some(stage) => format!("{field}, at the {} stage", stage.replace('_', " ")),
    }
}

/// What a facet with no recorded predicate is about — the chips' words for
/// the `unknown/unknown` facet too. It is a row and not an absence, and
/// calling it nothing would hide it.
const UNRECORDED_SCOPE: &str = "what it is about isn't recorded";

fn scope_text(item: &Item) -> Option<String> {
    let predicate = item.predicate.as_deref()?;
    Some(scope_words(predicate, item.state_stage.as_deref()))
}

/// `sole` is whether this is its belief's only facet: then the row names no
/// scope, because the belief's scope is that facet's.
fn item_view(item: &Item, sole: bool) -> ItemView {
    let reason_text = item
        .reasons
        .iter()
        .map(|reason| reason_words(*reason))
        .collect::<Vec<_>>()
        .join(", ");
    let reliance_text = if item.reliance.is_empty() {
        None
    } else {
        Some(format!(
            "Relied on — {}",
            item.reliance
                .iter()
                .map(|r| reliance_words(*r))
                .collect::<Vec<_>>()
                .join(", ")
        ))
    };
    ItemView {
        lane: item.lane,
        belief_id: item.belief_id.clone(),
        entity_id: item.entity_id.clone(),
        path: item.path.clone(),
        predicate: item.predicate.clone(),
        state_stage: item.state_stage.clone(),
        scope_text: if sole { None } else { scope_text(item) },
        reasons: item.reasons.clone(),
        reason_text,
        reliance: item.reliance.clone(),
        reliance_text,
        edge_id: item.edge_id.clone(),
        relation_id: item.relation_id.clone(),
    }
}

fn lane_of(id: &str) -> Option<Lane> {
    Lane::ALL.into_iter().find(|lane| lane.as_str() == id)
}

// --- What changed (M26 convergence, read aloud) -----------------------------
//
// The composition lives HERE and not in `convergence::diff` for two reasons.
// `Output` is content-hashed and stored, so growing it a prose field would
// change the bytes of every row already on disk for no epistemic gain. And
// this module is the one place that owns the Epistemic Status vocabulary —
// one surface, one set of words, one file to read when the wording is wrong.

/// One thing that moved, in a sentence.
///
/// One rule for `text` (M52.4): a line with a subject is a predicate that
/// reads after the concept's name ("was revised", "lost its last support"),
/// and a line with no subject is a whole sentence ("A coverage gap closed").
/// The surface puts the name in front; it never rephrases the words.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ChangeLine {
    pub text: String,
    /// What the sentence is about, so a surface can title the row and link it.
    pub belief_id: Option<String>,
    pub entity_id: Option<String>,
    /// The knowledge-relative projection path of the subject, when a file
    /// projects it — the same field a lane item carries, so the surface names
    /// a change line the way it names a lane row. `None` for a line with no
    /// subject, and for a subject no file projects.
    pub path: Option<String>,
}

/// Where each subject of a change line lives on disk, read from the fold at
/// the window's end (M52.4).
///
/// Built beside [`change_sections`] rather than inside `convergence::diff`:
/// `Output` is content-hashed and stored, and a path is a reading of the
/// present, not part of what changed.
#[derive(Debug, Default)]
pub struct Subjects {
    beliefs: BTreeMap<String, String>,
    entities: BTreeMap<String, String>,
}

impl Subjects {
    /// Every projected belief by id, and each entity by its LOWEST projected
    /// belief id — one deterministic file per entity, rather than whichever
    /// belief a map happened to yield last.
    pub fn of(state: &crate::ledger::reduce::EpistemicState) -> Self {
        let mut subjects = Subjects::default();
        // `beliefs` is a BTreeMap, so this walk is already in id order and the
        // first projected belief of an entity is its lowest.
        for belief in state.beliefs.values() {
            let Some(path) = &belief.path else { continue };
            subjects
                .beliefs
                .insert(belief.belief_id.clone(), path.clone());
            subjects
                .entities
                .entry(belief.entity_id.clone())
                .or_insert_with(|| path.clone());
        }
        subjects
    }

    fn belief(&self, belief_id: &str) -> Option<String> {
        self.beliefs.get(belief_id).cloned()
    }

    fn entity(&self, entity_id: &str) -> Option<String> {
        self.entities.get(entity_id).cloned()
    }
}

/// One section of what changed, present whether or not anything moved in it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ChangeSection {
    pub id: String,
    pub label: String,
    pub empty_text: String,
    pub lines: Vec<ChangeLine>,
}

/// What changed between two folds of one store, for the surface.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ChangesView {
    pub schema_version: String,
    pub window: crate::convergence::diff::Window,
    /// M26's own answer to "did anything move". Asked here rather than
    /// recounted, so a section this build forgot to render cannot make a loud
    /// window look quiet.
    pub quiet: bool,
    pub sections: Vec<ChangeSection>,
}

fn change_kind_words(kind: crate::convergence::diff::ChangeKind) -> &'static str {
    use crate::convergence::diff::ChangeKind;
    match kind {
        ChangeKind::Created => "appeared",
        ChangeKind::Revised => "was revised",
        // M52.5 — the app's words for the ledger's: "tombstoned" is
        // Retire on a card, qualification is draft or not, and lifecycle is
        // whether the concept is the current one.
        ChangeKind::Tombstoned => "was retired",
        ChangeKind::QualificationChanged => "changed its draft status",
        ChangeKind::LifecycleChanged => "changed whether it is current",
        ChangeKind::ContestOpened => "became contested",
        ChangeKind::ContestClosed => "stopped being contested",
    }
}

/// "1 check now covers it" / "3 checks now cover it".
///
/// The verb is here with the number because it has to agree with it, and a
/// surface reading "1 checks cover it" is a machine talking — which is the
/// tone the whole nothing-speaks-first rule exists to avoid. A check that
/// covers it, not an "assessment naming it" (M52.5): a gap closes because
/// something now looked at what it covers.
fn assessments(n: u32) -> String {
    if n == 1 {
        format!("{n} check now covers it")
    } else {
        format!("{n} checks now cover it")
    }
}

/// Which claim a shift is about, after the words it qualifies: " for CI
/// status, at the implemented stage", or — for the `unknown/unknown` facet —
/// the chips' words for it, set apart.
fn shift_scope(shift: &crate::convergence::diff::CertaintyShift) -> String {
    match shift.predicate.as_deref() {
        None => format!(" ({UNRECORDED_SCOPE})"),
        Some(predicate) => format!(" for {}", scope_words(predicate, Some(&shift.state_stage))),
    }
}

/// Read one convergence run aloud, section by section.
///
/// `subjects` names the file each line is about. It is a lookup and not a
/// second diff: nothing in it decides whether a line exists, only what the
/// surface may call the line's subject.
pub fn change_sections(
    output: &crate::convergence::diff::Output,
    subjects: &Subjects,
) -> ChangesView {
    use crate::convergence::diff::{Blindness, Staleness};

    let about_belief = |text: String, belief_id: &str| ChangeLine {
        text,
        belief_id: Some(belief_id.to_string()),
        entity_id: None,
        path: subjects.belief(belief_id),
    };
    let about_entity = |text: String, entity_id: &str| ChangeLine {
        text,
        belief_id: None,
        entity_id: Some(entity_id.to_string()),
        path: subjects.entity(entity_id),
    };
    let sentence = |text: String| ChangeLine {
        text,
        belief_id: None,
        entity_id: None,
        path: None,
    };

    let material = output
        .material_changes
        .iter()
        .map(|change| ChangeLine {
            text: change
                .kinds
                .iter()
                .map(|kind| change_kind_words(*kind))
                .collect::<Vec<_>>()
                .join(", "),
            belief_id: Some(change.belief_id.clone()),
            entity_id: Some(change.entity_id.clone()),
            // The belief's own file. Its entity's other beliefs may project
            // elsewhere, and naming one of them would name the wrong change.
            path: subjects.belief(&change.belief_id),
        })
        .collect();

    let blindness = output
        .blindness
        .iter()
        .map(|item| match item {
            // §90's distinction, arriving as news: "all known sources
            // considered" was never "all sources known".
            Blindness::SubjectBecameBlind { entity_id } => about_entity(
                "lost every check that covered it — each was replaced and nothing took its place"
                    .to_string(),
                entity_id,
            ),
            Blindness::SubjectNoLongerBlind {
                entity_id,
                assessments_now,
            } => about_entity(
                // The lane is "Gaps"; a subject leaving it is a gap closing.
                format!("is no longer a gap — {}", assessments(*assessments_now)),
                entity_id,
            ),
            // A gap's id is the ledger's; the source is what a reader can
            // place. With no source there is nothing more to say.
            Blindness::GapOpened { source_id, .. } => sentence(match source_id {
                Some(source) => format!("A coverage gap opened for {source}"),
                None => "A coverage gap opened".to_string(),
            }),
            Blindness::GapClosed { source_id, .. } => sentence(match source_id {
                Some(source) => format!("A coverage gap closed for {source}"),
                None => "A coverage gap closed".to_string(),
            }),
        })
        .collect();

    let staleness = output
        .staleness
        .iter()
        .map(|item| match item {
            Staleness::EvidenceRefreshed {
                belief_id,
                from,
                to,
            } => about_belief(
                format!("has newer evidence — it moved from {from} to {to}"),
                belief_id,
            ),
            Staleness::BecameSupported {
                belief_id,
                newest_evidence_at,
            } => about_belief(
                format!("is supported now — newest evidence {newest_evidence_at}"),
                belief_id,
            ),
            Staleness::LostSupport { belief_id } => {
                about_belief("lost its last support".to_string(), belief_id)
            }
        })
        .collect();

    let certainty = output
        .certainty_shift
        .iter()
        .map(|shift| {
            // A level in the chip's words (M52.5): "single_source" is a
            // code, and "single source" beside a chip saying "one source" was
            // one level worded twice.
            let level = crate::dynamics::support::level_words;
            let text = match &shift.from {
                Some(from) => format!(
                    "went from {} to {}{}",
                    level(from),
                    level(&shift.to),
                    shift_scope(shift)
                ),
                // No `from` means this scope had no facet then — the belief is
                // new, or it grew a claim it was not making. "went from
                // nothing" would imply a fall from somewhere, and "is one
                // source" is no sentence: the level follows as the chip's
                // label does.
                None => format!(
                    "has a new claim{} — {}",
                    shift_scope(shift),
                    level(&shift.to)
                ),
            };
            about_belief(text, &shift.belief_id)
        })
        .collect();

    let contestation = output
        .new_contestation
        .iter()
        .map(|edge| {
            // "agent-supplied" travels verbatim. A semantic verdict a model
            // proposed must never read on screen as a reducer fact.
            let by = match edge.classified_by {
                "agent_supplied" => "agent-supplied",
                other => other,
            };
            let kind = edge.kind.replace('_', " ");
            let reasons = if edge.reason_codes.is_empty() {
                String::new()
            } else {
                format!(" — {}", edge.reason_codes.join(", "))
            };
            about_belief(
                format!("is in a new {kind} contradiction, classified {by}{reasons}"),
                &edge.left_belief_id,
            )
        })
        .collect();

    // Named for what a reader sees (M52.4): a concept, not a "belief", and
    // what it rests on, not "what rests underneath".
    let sections = [
        (
            "material",
            "Concepts that changed",
            "No concept changed.",
            material,
        ),
        (
            "blindness",
            "What came into and out of view",
            "Nothing changed about what can be seen.",
            blindness,
        ),
        ("staleness", "Evidence", "No evidence moved.", staleness),
        ("certainty", "Support", "No support changed.", certainty),
        (
            "contestation",
            "New contradictions",
            "No new contradictions opened.",
            contestation,
        ),
    ]
    .into_iter()
    .map(|(id, label, empty, lines)| ChangeSection {
        id: id.to_string(),
        label: label.to_string(),
        empty_text: empty.to_string(),
        lines,
    })
    .collect();
    ChangesView {
        schema_version: output.schema_version.to_string(),
        window: output.window,
        quiet: output.quiet(),
        sections,
    }
}

/// Group computed lanes into what one surface renders.
///
/// The per-lane `withheld` is DERIVED here rather than returned by the
/// firewall: `present` owns one number and one rule, and giving it a second
/// shape to keep in agreement is how two ways to say a thing become one way to
/// disagree. A test asserts the split sums to the total it was derived from.
pub fn view(
    definitions: &Definitions,
    lanes: &Lanes,
    prefs: &Preferences,
    incomplete: Vec<String>,
) -> LanesView {
    let presented = preferences::present(definitions, lanes, prefs);
    // Absent is never zero (M49.10, K31): coverage nobody assessed is kept
    // out of the blindness lane's items, so an empty lane must not say "No
    // gaps." about beliefs nobody looked at.
    let unassessed = (lanes.unassessed > 0).then(|| unassessed_text(lanes.unassessed));
    let mut incomplete = incomplete;

    let mut computed: BTreeMap<Lane, usize> = BTreeMap::new();
    for item in &lanes.items {
        *computed.entry(item.lane).or_default() += 1;
    }
    let mut kept: BTreeMap<Lane, Vec<ItemView>> = BTreeMap::new();
    for item in &presented.items {
        let sole = lanes.facets.get(&item.belief_id) == Some(&1);
        kept.entry(item.lane)
            .or_default()
            .push(item_view(item, sole));
    }

    let views = definitions
        .order()
        .iter()
        .filter_map(|id| lane_of(id))
        .map(|lane| {
            let words = lane_words(lane);
            let items = kept.remove(&lane).unwrap_or_default();
            let empty_text = match &unassessed {
                Some(text) if lane == Lane::Blindness => text.clone(),
                _ => words.empty.to_string(),
            };
            LaneView {
                id: lane.as_str().to_string(),
                label: words.label.to_string(),
                blurb: words.blurb.to_string(),
                empty_text,
                protected: definitions.is_protected(lane),
                // Saturating because a wrap would render as "18446744073709551615
                // more" in a release build. The paired sum test below is the
                // tripwire that would catch the disagreement itself.
                withheld: computed
                    .get(&lane)
                    .copied()
                    .unwrap_or(0)
                    .saturating_sub(items.len()),
                items,
            }
        })
        .collect::<Vec<LaneView>>();

    // A blindness lane that HOLDS items never shows its empty line, so the
    // unassessed count goes where every "could not see" goes.
    if let Some(text) = unassessed {
        if views
            .iter()
            .any(|v| v.id == Lane::Blindness.as_str() && !v.items.is_empty())
        {
            incomplete.push(text);
        }
    }

    LanesView {
        rule_version: lanes.rule_version.clone(),
        lanes: views,
        withheld: presented.withheld,
        incomplete,
    }
}

/// What the blindness lane says when coverage was never assessed for some
/// beliefs — the unknown, named as unknown rather than counted as no gap.
/// "Claims" on screen (M52.3): a belief is the ledger's word, not a reader's.
fn unassessed_text(count: usize) -> String {
    let noun = if count == 1 { "claim" } else { "claims" };
    format!(
        "Coverage has not been assessed for {count} {noun}, so a gap there is unknown, not \
         absent."
    )
}

/// The four lanes for one vault.
///
/// `parked` is `None` when the operational database could not be read, which
/// is NOT the same as a base with nothing parked: the debt lane would be
/// missing every `promotion_blocked` item and look like good news. That case
/// is named in `incomplete` and the lanes are still computed, because a
/// contradiction is worth showing even when app-data is unavailable.
///
/// The clock is an argument, as it is everywhere downstream of freshness.
pub fn for_vault(
    vault: &Path,
    parked: Option<&[ParkedPromotion]>,
    prefs: &Preferences,
    as_of: chrono::DateTime<chrono::Utc>,
) -> Result<LanesView, String> {
    let tables = bundle::Tables::load()?;
    let definitions = lanes::load()?;
    let incomplete = match parked {
        Some(_) => Vec::new(),
        None => vec![
            "Parked promotions could not be read, so what is taken on trust may be \
             under-reported."
                .to_string(),
        ],
    };
    crate::ledger::shadow::with_writer(vault, |writer| {
        let read = crate::ledger::read_ledger(&crate::ledger::ledger_dir(vault))
            .map_err(|e| e.to_string())?;
        let state = crate::ledger::reduce::reduce(&read.frames, writer.store_id());
        let computed = lanes::lanes(&state, &tables, &definitions, parked.unwrap_or(&[]), as_of);
        Ok(view(&definitions, &computed, prefs, incomplete))
    })
    .unwrap_or_else(|| Err("no active ledger writer for this vault".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{B_ONE, B_TWO};
    use crate::attention::lanes::tests::standing;
    use crate::attention::preferences::{Cadence, Ordering, Verbosity};

    fn at(stamp: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn computed() -> (Definitions, Lanes) {
        let definitions = lanes::load().expect("the shipped artifact");
        let tables = bundle::Tables::load().expect("the shipped artifacts");
        let state = standing();
        let computed = lanes::lanes(
            &state,
            &tables,
            &definitions,
            &[ParkedPromotion {
                belief_id: B_TWO.into(),
                missing_roles: vec!["owner".into()],
            }],
            at("2026-08-12T00:00:00Z"),
        );
        (definitions, computed)
    }

    /// Every lane the artifact declares is in the output, holding items or
    /// not. A surface that only received non-empty lanes could not tell "no
    /// contradictions" from "contradictions were not computed", which is the
    /// distinction this whole milestone is built around.
    #[test]
    fn every_lane_is_present_in_the_artifacts_order_even_when_it_holds_nothing() {
        let definitions = lanes::load().expect("the shipped artifact");
        let empty = Lanes {
            rule_version: definitions.rule_version.clone(),
            items: Vec::new(),
            unassessed: 0,
            facets: Default::default(),
        };
        let out = view(&definitions, &empty, &Preferences::default(), Vec::new());

        assert_eq!(
            out.lanes.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            definitions
                .order()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        );
        for lane in &out.lanes {
            assert!(lane.items.is_empty());
            assert!(
                !lane.empty_text.is_empty(),
                "lane {} has no words for holding nothing",
                lane.id
            );
        }
    }

    /// The `match` guarantees a word exists; it does not guarantee the word
    /// is any good. An empty string renders as a blank row and a duplicate
    /// makes two different findings read as one — both are the exact failure
    /// composing here was supposed to prevent.
    #[test]
    fn every_reason_and_lane_has_its_own_non_empty_words() {
        let mut seen: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
        for lane in Lane::ALL {
            let words = lane_words(lane);
            for text in [words.label, words.blurb, words.empty] {
                assert!(!text.is_empty(), "{lane:?} has an empty string in it");
            }
            for reason in lanes::Reason::of(lane) {
                let text = reason_words(*reason);
                assert!(!text.is_empty(), "{reason:?} has no words");
                assert!(
                    seen.insert(text),
                    "{reason:?} reads exactly like another reason: {text:?}"
                );
            }
        }
        for reliance in Reliance::ALL {
            assert!(!reliance_words(reliance).is_empty());
        }
    }

    /// Every item that crosses the wire can say why it is there, in words.
    #[test]
    fn no_item_reaches_a_surface_without_a_reason_it_can_read_aloud() {
        let (definitions, lanes) = computed();
        let out = view(&definitions, &lanes, &Preferences::default(), Vec::new());
        let items: Vec<&ItemView> = out.lanes.iter().flat_map(|lane| &lane.items).collect();

        assert!(!items.is_empty(), "the fixture must produce lane items");
        for item in items {
            assert!(!item.reasons.is_empty());
            assert!(
                !item.reason_text.is_empty(),
                "{} in {:?} has codes but no words",
                item.belief_id,
                item.lane
            );
        }
    }

    /// The per-lane split is derived, so it has to be proven against the
    /// number the firewall actually owns.
    #[test]
    fn the_per_lane_withheld_counts_sum_to_the_firewalls_total() {
        let (definitions, lanes) = computed();
        for prefs in [
            Preferences::default(),
            Preferences {
                verbosity: Verbosity::Terse,
                ..Preferences::default()
            },
            Preferences {
                cadence: Cadence::Quiet,
                shown_recently: [B_ONE.to_string(), B_TWO.to_string()].into_iter().collect(),
                ..Preferences::default()
            },
            Preferences {
                ordering: Ordering::ByEntity,
                dismissed: [B_TWO.to_string()].into_iter().collect(),
                ..Preferences::default()
            },
        ] {
            let out = view(&definitions, &lanes, &prefs, Vec::new());
            let split: usize = out.lanes.iter().map(|lane| lane.withheld).sum();
            assert_eq!(split, out.withheld, "with {prefs:?}");
        }
    }

    /// §33 through the one path that has a reader. If this ever fails, a
    /// surface is being handed a suppressed protected lane.
    #[test]
    fn a_protected_lane_arrives_whole_no_matter_what_is_configured() {
        let (definitions, lanes) = computed();
        let protected: Vec<&Item> = lanes
            .items
            .iter()
            .filter(|item| definitions.is_protected(item.lane))
            .collect();
        assert!(!protected.is_empty(), "the fixture must protect something");

        let everything_off = Preferences {
            verbosity: Verbosity::Terse,
            ordering: Ordering::ByEntity,
            cadence: Cadence::Quiet,
            dismissed: lanes.items.iter().map(|i| i.belief_id.clone()).collect(),
            shown_recently: lanes.items.iter().map(|i| i.belief_id.clone()).collect(),
        };
        let out = view(&definitions, &lanes, &everything_off, Vec::new());

        for lane in out.lanes.iter().filter(|lane| lane.protected) {
            let expected = lanes
                .items
                .iter()
                .filter(|i| i.lane.as_str() == lane.id)
                .count();
            assert_eq!(lane.items.len(), expected, "lane {} lost items", lane.id);
            assert_eq!(lane.withheld, 0, "lane {} reported withholding", lane.id);
        }
    }

    /// Absent is never zero (M49.10, K31): coverage nobody assessed is kept
    /// out of the blindness lane's items, and the lane must not answer "No
    /// gaps." about beliefs nobody looked at — the production state, since no
    /// coverage assessor has shipped.
    #[test]
    fn unassessed_coverage_is_said_out_loud_rather_than_read_as_no_gaps() {
        let definitions = lanes::load().expect("the shipped artifact");
        let tables = bundle::Tables::load().expect("the shipped artifacts");
        let blindness = |out: &LanesView| {
            out.lanes
                .iter()
                .find(|l| l.id == Lane::Blindness.as_str())
                .cloned()
                .expect("the blindness lane is always present")
        };

        // Nothing assessed: the lane holds nothing and says WHY.
        let mut state = standing();
        state.coverage_assessments.clear();
        let nothing_assessed = lanes::lanes(
            &state,
            &tables,
            &definitions,
            &[],
            at("2026-08-12T00:00:00Z"),
        );
        assert_eq!(nothing_assessed.unassessed, 2, "both fixture beliefs");
        let out = view(
            &definitions,
            &nothing_assessed,
            &Preferences::default(),
            Vec::new(),
        );
        let lane = blindness(&out);
        assert!(lane.items.is_empty());
        assert_ne!(lane.empty_text, "No gaps.");
        assert_eq!(
            lane.empty_text,
            "Coverage has not been assessed for 2 claims, so a gap there is unknown, not absent."
        );
        assert!(out.incomplete.is_empty(), "said once, in the lane itself");

        // Assessed blind spots AND an unassessed belief — B_TWO has no
        // evidence, so no source anybody could have assessed: the items fill
        // the lane, so the count goes where every "could not see" goes.
        let (definitions, mut computed) = computed();
        assert_eq!(computed.unassessed, 1);
        let out = view(&definitions, &computed, &Preferences::default(), Vec::new());
        assert!(!blindness(&out).items.is_empty());
        assert_eq!(
            out.incomplete,
            ["Coverage has not been assessed for 1 claim, so a gap there is unknown, not absent."]
        );

        // Everything assessed: nothing to say, and the ordinary words stand.
        computed.unassessed = 0;
        computed.items.retain(|item| item.lane != Lane::Blindness);
        let out = view(&definitions, &computed, &Preferences::default(), Vec::new());
        assert!(out.incomplete.is_empty());
        assert_eq!(blindness(&out).empty_text, "No gaps.");
    }

    /// A feed this process could not read is named, not silently dropped.
    #[test]
    fn an_unreadable_feed_is_said_out_loud_rather_than_read_as_good_news() {
        let (definitions, lanes) = computed();
        let parked = "Parked promotions could not be read.";
        let quiet = view(&definitions, &lanes, &Preferences::default(), Vec::new());
        assert!(!quiet.incomplete.iter().any(|s| s == parked));

        let degraded = view(
            &definitions,
            &lanes,
            &Preferences::default(),
            vec![parked.into()],
        );
        assert_eq!(degraded.incomplete.len(), quiet.incomplete.len() + 1);
        assert!(degraded.incomplete.iter().any(|s| s == parked));
    }

    /// The wire shape, pinned. `src/lib/mockIpc.ts` mirrors these keys by hand
    /// and a spec seeding the old shape would pass against a page reading the
    /// new one.
    #[test]
    fn the_wire_shape_is_the_one_the_mock_backend_mirrors() {
        let (definitions, lanes) = computed();
        let out = view(&definitions, &lanes, &Preferences::default(), Vec::new());
        let json = serde_json::to_value(&out).expect("serializable");

        let mut top: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        top.sort_unstable();
        assert_eq!(top, ["incomplete", "lanes", "rule_version", "withheld"]);

        let mut lane: Vec<&str> = json["lanes"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        lane.sort_unstable();
        assert_eq!(
            lane,
            [
                "blurb",
                "empty_text",
                "id",
                "items",
                "label",
                "protected",
                "withheld"
            ]
        );

        let item = json["lanes"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|lane| lane["items"].as_array().unwrap().first())
            .expect("the fixture must produce one item");
        let mut keys: Vec<&str> = item
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "belief_id",
                "edge_id",
                "entity_id",
                "lane",
                "path",
                "predicate",
                "reason_text",
                "reasons",
                "relation_id",
                "reliance",
                "reliance_text",
                "scope_text",
                "state_stage"
            ],
            "if this changed on purpose, change src/lib/mockIpc.ts with it"
        );
    }

    // --- What changed -------------------------------------------------------

    use crate::convergence::diff::{
        Blindness, CertaintyShift, ChangeKind, Contestation, MaterialChange, Output, Staleness,
        Window, SCHEMA_VERSION,
    };

    /// Every variant of every section, so no arm can go wordless unnoticed.
    fn loud() -> Output {
        Output {
            schema_version: SCHEMA_VERSION,
            window: Window {
                from_seq: 1,
                to_seq: 9,
            },
            material_changes: vec![MaterialChange {
                belief_id: B_ONE.into(),
                entity_id: "entity".into(),
                kinds: vec![ChangeKind::Revised, ChangeKind::QualificationChanged],
                revision_then: None,
                revision_now: None,
            }],
            blindness: vec![
                Blindness::SubjectBecameBlind {
                    entity_id: "entity".into(),
                },
                Blindness::SubjectNoLongerBlind {
                    entity_id: "entity".into(),
                    assessments_now: 1,
                },
                Blindness::GapOpened {
                    gap_id: "g1".into(),
                    source_id: Some("source".into()),
                },
                Blindness::GapClosed {
                    gap_id: "g2".into(),
                    source_id: None,
                },
            ],
            staleness: vec![
                Staleness::EvidenceRefreshed {
                    belief_id: B_ONE.into(),
                    from: "2020-01-01T00:00:00Z".into(),
                    to: "2026-01-01T00:00:00Z".into(),
                },
                Staleness::BecameSupported {
                    belief_id: B_TWO.into(),
                    newest_evidence_at: "2026-01-01T00:00:00Z".into(),
                },
                Staleness::LostSupport {
                    belief_id: B_TWO.into(),
                },
            ],
            certainty_shift: vec![
                CertaintyShift {
                    belief_id: B_ONE.into(),
                    predicate: Some("ci_status".into()),
                    state_stage: "implemented".into(),
                    from: Some("single_source".into()),
                    to: "corroborated".into(),
                },
                CertaintyShift {
                    belief_id: B_TWO.into(),
                    predicate: None,
                    state_stage: "unknown".into(),
                    from: None,
                    to: "unsupported".into(),
                },
            ],
            new_contestation: vec![Contestation {
                edge_id: "e".repeat(32),
                left_belief_id: B_ONE.into(),
                right_belief_id: B_TWO.into(),
                kind: "genuine_direct",
                reason_codes: vec!["same_predicate".into()],
                classified_by: "agent_supplied",
            }],
        }
    }

    /// Every section is present whether or not anything moved in it, and every
    /// row can be read aloud. A section that only appeared when it had content
    /// would make "nothing came into view" and "we did not look" the same
    /// screen.
    #[test]
    fn every_change_section_is_present_and_every_line_has_words() {
        let quiet = change_sections(
            &Output {
                schema_version: SCHEMA_VERSION,
                window: Window {
                    from_seq: 0,
                    to_seq: 0,
                },
                material_changes: Vec::new(),
                blindness: Vec::new(),
                staleness: Vec::new(),
                certainty_shift: Vec::new(),
                new_contestation: Vec::new(),
            },
            &Subjects::default(),
        );
        assert!(quiet.quiet);
        assert_eq!(quiet.sections.len(), 5);
        for section in &quiet.sections {
            assert!(section.lines.is_empty());
            assert!(!section.empty_text.is_empty());
        }

        let view = change_sections(&loud(), &Subjects::default());
        assert!(!view.quiet);
        assert_eq!(
            view.sections
                .iter()
                .map(|s| (s.id.as_str(), s.lines.len()))
                .collect::<Vec<_>>(),
            [
                ("material", 1),
                ("blindness", 4),
                ("staleness", 3),
                ("certainty", 2),
                ("contestation", 1)
            ]
        );
        for line in view.sections.iter().flat_map(|s| &s.lines) {
            assert!(!line.text.is_empty());
        }
    }

    /// `quiet` is M26's answer, not a recount. A section this build has not
    /// learned to render must not be able to make a loud window look quiet.
    #[test]
    fn quiet_is_asked_of_the_output_and_not_recounted_from_the_sections() {
        let mut output = loud();
        output.material_changes.clear();
        output.blindness.clear();
        output.staleness.clear();
        output.certainty_shift.clear();
        // Only a contestation left — the section M27.5d had to ungate before
        // it could make a window loud at all.
        let view = change_sections(&output, &Subjects::default());
        assert!(!view.quiet);
        assert_eq!(
            view.sections
                .iter()
                .filter(|s| !s.lines.is_empty())
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["contestation"]
        );
    }

    /// The words the spec names, in the places it names them.
    #[test]
    fn a_model_supplied_verdict_never_reads_as_a_reducer_fact() {
        let view = change_sections(&loud(), &Subjects::default());
        let contestation = &view.sections[4].lines[0].text;
        assert!(
            contestation.contains("agent-supplied"),
            "the spec's word travels verbatim: {contestation}"
        );
        assert!(contestation.contains("genuine direct"));
        assert!(contestation.contains("same_predicate"));
    }

    /// A support that had nowhere to fall from must not read as a fall.
    #[test]
    fn a_scope_with_no_facet_before_reads_as_arriving_and_not_as_falling() {
        let view = change_sections(&loud(), &Subjects::default());
        let certainty = &view.sections[3].lines;
        assert_eq!(
            certainty[0].text,
            "went from one source to corroborated for CI status, at the implemented stage"
        );
        assert_eq!(
            certainty[1].text,
            "has a new claim (what it is about isn't recorded) — no evidence offered"
        );
        assert!(
            !certainty[1].text.contains("from"),
            "a new scope did not come from anywhere"
        );
    }

    /// One check is not "1 checks", and the verb agrees with it.
    #[test]
    fn a_single_assessment_is_counted_and_conjugated_in_the_singular() {
        let view = change_sections(&loud(), &Subjects::default());
        assert_eq!(
            view.sections[1].lines[1].text,
            "is no longer a gap — 1 check now covers it"
        );
        assert_eq!(assessments(0), "0 checks now cover it");
        assert_eq!(assessments(2), "2 checks now cover it");
    }

    /// A line names its subject by the file that projects it (M52.4), so the
    /// surface can say "Sync error rate lost its last support" rather than a
    /// 32-hex id. A belief-only line reads its own belief's file; an
    /// entity-only line reads its entity's lowest projected belief; a line
    /// with no subject has no file, and says its sentence without a gap id.
    #[test]
    fn a_line_carries_the_file_its_subject_projects_to() {
        use crate::assembly::fixture::{belief, revision, unsupported, B_KESTREL, REV_ONE};
        use crate::ledger::reduce::EpistemicState;

        let mut state = EpistemicState::default();
        let projected = |id: &str, path: Option<&str>| {
            let mut b = belief(id, "entity", vec![revision(1, REV_ONE, "x", unsupported())]);
            b.path = path.map(str::to_string);
            b
        };
        // Inserted highest first: the lowest id must win on the ORDER of the
        // map, not on the order anything was written.
        for b in [
            projected(B_KESTREL, Some("systems/other.md")),
            projected(B_TWO, None),
            projected(B_ONE, Some("metrics/sync-error-rate.md")),
        ] {
            state.beliefs.insert(b.belief_id.clone(), b);
        }
        let view = change_sections(&loud(), &Subjects::of(&state));
        let section = |id: &str| {
            &view
                .sections
                .iter()
                .find(|s| s.id == id)
                .expect("every section is present")
                .lines
        };
        let sync = Some("metrics/sync-error-rate.md".to_string());

        // Belief-only: EvidenceRefreshed names B_ONE and no entity at all.
        let refreshed = &section("staleness")[0];
        assert_eq!(refreshed.entity_id, None);
        assert_eq!(refreshed.path, sync);
        assert_eq!(
            refreshed.text,
            "has newer evidence — it moved from 2020-01-01T00:00:00Z to 2026-01-01T00:00:00Z"
        );
        // B_TWO is a belief no file projects: nothing to name, and no guess.
        assert_eq!(section("staleness")[2].text, "lost its last support");
        assert_eq!(section("staleness")[2].path, None);

        assert_eq!(section("material")[0].path, sync);
        assert_eq!(section("certainty")[0].path, sync);
        assert_eq!(section("contestation")[0].path, sync);
        assert_eq!(
            section("contestation")[0].text,
            "is in a new genuine direct contradiction, classified agent-supplied — same_predicate"
        );

        // Entity-only: the lowest projected belief of that entity.
        let blind = section("blindness");
        assert_eq!(blind[0].belief_id, None);
        assert_eq!(blind[0].path, sync);
        // No subject: a whole sentence, no file, and no gap id.
        assert_eq!(blind[2].text, "A coverage gap opened for source");
        assert_eq!(blind[3].text, "A coverage gap closed");
        for gap in &blind[2..] {
            assert_eq!(
                (&gap.belief_id, &gap.entity_id, &gap.path),
                (&None, &None, &None)
            );
        }

        // The wire shape `src/lib/mockIpc.ts` mirrors by hand.
        let json = serde_json::to_value(refreshed).expect("serializable");
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["belief_id", "entity_id", "path", "text"],
            "if this changed on purpose, change src/lib/mockIpc.ts with it"
        );
    }

    /// An unknown stage is not a stage. "CI status, at the unknown stage"
    /// would name a stage nobody recorded, and the honest sentence is just
    /// the field.
    #[test]
    fn an_unknown_stage_drops_out_of_the_scope_sentence() {
        let base = Item {
            lane: Lane::Blindness,
            belief_id: B_ONE.into(),
            entity_id: "entity".into(),
            path: None,
            predicate: Some("ci_status".into()),
            state_stage: Some("unknown".into()),
            reasons: vec![Reason::CoverageUnassessed],
            reliance: Vec::new(),
            edge_id: None,
            relation_id: None,
        };
        assert_eq!(scope_text(&base).as_deref(), Some("CI status"));

        let staged = Item {
            state_stage: Some("implemented".into()),
            ..base.clone()
        };
        assert_eq!(
            scope_text(&staged).as_deref(),
            Some("CI status, at the implemented stage")
        );

        let unscoped = Item {
            predicate: None,
            ..base
        };
        assert_eq!(scope_text(&unscoped), None);
    }

    /// A field in words: initials as initials, the first word capitalised,
    /// and a stage said as a stage.
    #[test]
    fn a_predicate_reads_as_the_field_it_names() {
        assert_eq!(field_words("ci_status"), "CI status");
        assert_eq!(field_words("bill_of_materials"), "Bill of materials");
        assert_eq!(field_words("owner_id"), "Owner ID");
        assert_eq!(
            scope_words("pick_queue_drain", Some("go_live")),
            "Pick queue drain, at the go live stage"
        );
    }

    /// A row about its belief's only facet names no scope: the belief's
    /// scope is that facet's. A belief with two names each row's.
    #[test]
    fn a_sole_facet_leaves_its_scope_unsaid() {
        let definitions = lanes::load().expect("the shipped artifact");
        let item = |belief: &str| Item {
            lane: Lane::Staleness,
            belief_id: belief.into(),
            entity_id: "entity".into(),
            path: None,
            predicate: Some("ci_status".into()),
            state_stage: Some("implemented".into()),
            reasons: vec![Reason::FreshnessStale],
            reliance: Vec::new(),
            edge_id: None,
            relation_id: None,
        };
        let computed = Lanes {
            rule_version: definitions.rule_version.clone(),
            items: vec![item(B_ONE), item(B_TWO)],
            unassessed: 0,
            facets: [(B_ONE.to_string(), 1), (B_TWO.to_string(), 2)].into(),
        };
        let out = view(&definitions, &computed, &Preferences::default(), Vec::new());
        let stale = out
            .lanes
            .iter()
            .find(|lane| lane.id == Lane::Staleness.as_str())
            .unwrap();
        let scope = |belief: &str| {
            stale
                .items
                .iter()
                .find(|i| i.belief_id == belief)
                .unwrap()
                .scope_text
                .clone()
        };
        assert_eq!(scope(B_ONE), None);
        assert_eq!(
            scope(B_TWO).as_deref(),
            Some("CI status, at the implemented stage")
        );
    }
}
