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
    /// "ci_status at implemented" — what this row is about, when the reason is
    /// per-facet. `None` for the contradiction lane, whose subject is a pair.
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
fn lane_words(lane: Lane) -> Words {
    match lane {
        Lane::Contradiction => Words {
            label: "Contradictions",
            blurb: "Two things this base holds that cannot both be true.",
            empty: "No open contradictions.",
        },
        Lane::Blindness => Words {
            label: "Coverage gaps",
            blurb: "Where the evidence was looked at and found blind, and where nobody has \
                    looked at all.",
            empty: "No coverage gaps.",
        },
        Lane::Staleness => Words {
            label: "Stale understanding",
            blurb: "Past the freshness rule for its predicate class. Not wrong — unchecked.",
            empty: "Nothing is stale.",
        },
        Lane::EpistemicDebt => Words {
            label: "Epistemic debt",
            blurb: "Things the base is relied upon for that it cannot yet stand behind.",
            empty: "No recorded debt.",
        },
    }
}

/// Every reason, in the words the spec insists on: "stage lag", "unassessed",
/// "no admissible evidence". Honest words are spec compliance, so they live
/// beside the derivation that produced the code and not in a UI file.
fn reason_words(reason: Reason) -> &'static str {
    match reason {
        Reason::OpenEdgeGenuineDirect => "genuine direct conflict",
        Reason::OpenEdgePartial => "partial conflict",
        Reason::OpenEdgeConditional => "conditional conflict",
        Reason::LegacyUnclassified => "declared contradiction, not yet classified",
        Reason::CoverageBlindAssessed => "assessed, and blind",
        Reason::CoverageUnassessed => "coverage unassessed",
        Reason::FreshnessStale => "past its freshness rule",
        Reason::UnresolvedContradiction => "unresolved contradiction",
        // Never "false", and never "wrong". D9's unsupported means nobody has
        // offered admissible evidence, which says nothing about the claim.
        Reason::UnsupportedInference => "no admissible evidence",
        Reason::AuthorityRouteUnmatched => "no evidence met the authority route",
        Reason::NoAuthorityRouteDeclared => "no authority route declared",
        Reason::PromotionBlocked => "promotion parked, waiting on missing fields",
        Reason::StaleEvidence => "its evidence is stale",
        Reason::CoverageNotObserved => "coverage is not observed",
        // §78/§80. Never "reasoning in circles" — the finding is a graph fact
        // about which evidence traces back to this belief's own output, and
        // it says which walk it took rather than what it thinks of it.
        Reason::CircularSupport => "some of its support traces back to itself",
        Reason::DuplicatedLineageFamily => "two of its supports are the same message twice",
        Reason::DescendantOnlyReinforcement => "all of its support traces back to itself",
    }
}

fn reliance_words(reliance: Reliance) -> &'static str {
    match reliance {
        Reliance::Qualified => "promoted past draft",
        Reliance::PromotionAttempted => "a promotion was attempted",
        Reliance::RefinedBy => "something refines it",
    }
}

fn scope_text(item: &Item) -> Option<String> {
    let predicate = item.predicate.as_deref()?;
    Some(match item.state_stage.as_deref() {
        Some("unknown") | None => predicate.to_string(),
        Some(stage) => format!("{predicate} at {stage}"),
    })
}

fn item_view(item: &Item) -> ItemView {
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
            "relied on: {}",
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
        scope_text: scope_text(item),
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ChangeLine {
    pub text: String,
    /// What the sentence is about, so a surface can title the row and link it.
    pub belief_id: Option<String>,
    pub entity_id: Option<String>,
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
        ChangeKind::Tombstoned => "was tombstoned",
        ChangeKind::QualificationChanged => "changed qualification",
        ChangeKind::LifecycleChanged => "changed lifecycle",
        ChangeKind::ContestOpened => "became contested",
        ChangeKind::ContestClosed => "stopped being contested",
    }
}

/// "1 assessment names it" / "3 assessments name it".
///
/// The verb is here with the number because it has to agree with it, and a
/// surface reading "1 assessments name it" is a machine talking — which is
/// the tone the whole nothing-speaks-first rule exists to avoid.
fn assessments(n: u32) -> String {
    if n == 1 {
        format!("{n} assessment names it")
    } else {
        format!("{n} assessments name it")
    }
}

fn shift_scope(shift: &crate::convergence::diff::CertaintyShift) -> String {
    match shift.predicate.as_deref() {
        // The same words the chips use for the `unknown/unknown` facet. It is
        // a row and not an absence, and calling it nothing would hide it.
        None => "no recorded predicate".to_string(),
        Some(predicate) if shift.state_stage == "unknown" => predicate.to_string(),
        Some(predicate) => format!("{predicate} at {}", shift.state_stage),
    }
}

/// Read one convergence run aloud, section by section.
pub fn change_sections(output: &crate::convergence::diff::Output) -> ChangesView {
    use crate::convergence::diff::{Blindness, Staleness};

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
        })
        .collect();

    let blindness = output
        .blindness
        .iter()
        .map(|item| match item {
            // §90's distinction, arriving as news: "all known sources
            // considered" was never "all sources known".
            Blindness::SubjectBecameBlind { entity_id } => ChangeLine {
                text: "every assessment naming it was superseded, and nothing replaced them"
                    .to_string(),
                belief_id: None,
                entity_id: Some(entity_id.clone()),
            },
            Blindness::SubjectNoLongerBlind {
                entity_id,
                assessments_now,
            } => ChangeLine {
                text: format!("no longer blind — {}", assessments(*assessments_now)),
                belief_id: None,
                entity_id: Some(entity_id.clone()),
            },
            Blindness::GapOpened { gap_id, source_id } => ChangeLine {
                text: match source_id {
                    Some(source) => format!("a coverage gap opened for {source} ({gap_id})"),
                    None => format!("a coverage gap opened ({gap_id})"),
                },
                belief_id: None,
                entity_id: None,
            },
            Blindness::GapClosed { gap_id, source_id } => ChangeLine {
                text: match source_id {
                    Some(source) => format!("a coverage gap closed for {source} ({gap_id})"),
                    None => format!("a coverage gap closed ({gap_id})"),
                },
                belief_id: None,
                entity_id: None,
            },
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
            } => ChangeLine {
                text: format!("its newest evidence moved from {from} to {to}"),
                belief_id: Some(belief_id.clone()),
                entity_id: None,
            },
            Staleness::BecameSupported {
                belief_id,
                newest_evidence_at,
            } => ChangeLine {
                text: format!("something supports it now, newest evidence {newest_evidence_at}"),
                belief_id: Some(belief_id.clone()),
                entity_id: None,
            },
            Staleness::LostSupport { belief_id } => ChangeLine {
                text: "it lost its last support".to_string(),
                belief_id: Some(belief_id.clone()),
                entity_id: None,
            },
        })
        .collect();

    let certainty = output
        .certainty_shift
        .iter()
        .map(|shift| ChangeLine {
            text: match &shift.from {
                Some(from) => format!(
                    "{}: support went from {from} to {}",
                    shift_scope(shift),
                    shift.to
                ),
                // No `from` means this scope had no facet then — the belief is
                // new, or it grew a claim it was not making. "went from
                // nothing" would imply a fall from somewhere.
                None => format!("{}: support is {}", shift_scope(shift), shift.to),
            },
            belief_id: Some(shift.belief_id.clone()),
            entity_id: None,
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
            ChangeLine {
                text: format!("a {kind} contradiction opened, classified {by}{reasons}"),
                belief_id: Some(edge.left_belief_id.clone()),
                entity_id: None,
            }
        })
        .collect();

    let sections = [
        (
            "material",
            "Beliefs that moved",
            "No beliefs moved.",
            material,
        ),
        (
            "blindness",
            "What came into and out of view",
            "Nothing changed about what can be seen.",
            blindness,
        ),
        ("staleness", "Evidence", "No evidence moved.", staleness),
        (
            "certainty",
            "What rests underneath",
            "Nothing changed about what rests underneath.",
            certainty,
        ),
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

    let mut computed: BTreeMap<Lane, usize> = BTreeMap::new();
    for item in &lanes.items {
        *computed.entry(item.lane).or_default() += 1;
    }
    let mut kept: BTreeMap<Lane, Vec<ItemView>> = BTreeMap::new();
    for item in &presented.items {
        kept.entry(item.lane).or_default().push(item_view(item));
    }

    let views = definitions
        .order()
        .iter()
        .filter_map(|id| lane_of(id))
        .map(|lane| {
            let words = lane_words(lane);
            let items = kept.remove(&lane).unwrap_or_default();
            LaneView {
                id: lane.as_str().to_string(),
                label: words.label.to_string(),
                blurb: words.blurb.to_string(),
                empty_text: words.empty.to_string(),
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
        .collect();

    LanesView {
        rule_version: lanes.rule_version.clone(),
        lanes: views,
        withheld: presented.withheld,
        incomplete,
    }
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
            "Parked promotions could not be read, so epistemic debt may be under-reported."
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

    /// A feed this process could not read is named, not silently dropped.
    #[test]
    fn an_unreadable_feed_is_said_out_loud_rather_than_read_as_good_news() {
        let (definitions, lanes) = computed();
        let quiet = view(&definitions, &lanes, &Preferences::default(), Vec::new());
        assert!(quiet.incomplete.is_empty());

        let degraded = view(
            &definitions,
            &lanes,
            &Preferences::default(),
            vec!["Parked promotions could not be read.".into()],
        );
        assert_eq!(degraded.incomplete.len(), 1);
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
        let quiet = change_sections(&Output {
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
        });
        assert!(quiet.quiet);
        assert_eq!(quiet.sections.len(), 5);
        for section in &quiet.sections {
            assert!(section.lines.is_empty());
            assert!(!section.empty_text.is_empty());
        }

        let view = change_sections(&loud());
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
        let view = change_sections(&output);
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
        let view = change_sections(&loud());
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
        let view = change_sections(&loud());
        let certainty = &view.sections[3].lines;
        assert_eq!(
            certainty[0].text,
            "ci_status at implemented: support went from single_source to corroborated"
        );
        assert_eq!(
            certainty[1].text,
            "no recorded predicate: support is unsupported"
        );
        assert!(
            !certainty[1].text.contains("from"),
            "a new scope did not come from anywhere"
        );
    }

    /// One assessment is not "1 assessments", and the verb agrees with it.
    #[test]
    fn a_single_assessment_is_counted_and_conjugated_in_the_singular() {
        let view = change_sections(&loud());
        assert_eq!(
            view.sections[1].lines[1].text,
            "no longer blind — 1 assessment names it"
        );
        assert_eq!(assessments(0), "0 assessments name it");
        assert_eq!(assessments(2), "2 assessments name it");
    }

    /// An unknown stage is not a stage. "ci_status at unknown" would read as a
    /// place, and the honest sentence is just the predicate.
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
        assert_eq!(scope_text(&base).as_deref(), Some("ci_status"));

        let staged = Item {
            state_stage: Some("implemented".into()),
            ..base.clone()
        };
        assert_eq!(
            scope_text(&staged).as_deref(),
            Some("ci_status at implemented")
        );

        let unscoped = Item {
            predicate: None,
            ..base
        };
        assert_eq!(scope_text(&unscoped), None);
    }
}
