//! Preferences over the lanes, and the firewall they cannot cross (M27.7).
//!
//! **§33 is the whole module.** Preference may tune verbosity, ordering
//! within normal lanes, phrasing, grouping and cadence. It may NEVER suppress
//! blindness, material contradiction, `critical_attention`, or a high-impact
//! human-review requirement. Which lanes those are is declared in
//! `shared/policy/lanes.v1.json`, not decided here — widening the protected
//! set should be a diff somebody can see.
//!
//! **The firewall is two things and both are tested.** Schema-disjointness
//! (these tables never touch belief tables) is the first, and it is a
//! property of where the data lives. This module is the second: every knob
//! is applied through [`present`], and [`present`] cannot drop a protected
//! item whatever it is handed. The test attempts suppression through every
//! field and asserts visibility survives.
//!
//! **The knobs are deliberately weak.** Verbosity caps how many items an
//! UNPROTECTED lane shows; ordering may re-sort within unprotected lanes;
//! cadence says how long an unprotected item may stay quiet after it has been
//! shown once. None of them can reach a protected lane, and none of them can
//! reorder the LANES themselves — that order is the artifact's, because the
//! point of ranking in Rust is that a person can check it.
//!
//! **A dismissal is not a preference** (M8). Dismissals are per-item and
//! stay per-item; [`present`] takes them as a set and refuses them on
//! protected items for the same reason it refuses every other suppression
//! path. A preference that could dismiss a class in bulk would be exactly
//! the firewall breach §33 names.

use std::collections::BTreeSet;

use super::lanes::{Definitions, Item, Lane, Lanes};

/// How much an unprotected lane says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Verbosity {
    /// At most three items per unprotected lane.
    Terse,
    #[default]
    Normal,
    /// Everything, in every lane.
    Detailed,
}

impl Verbosity {
    /// The cap this setting puts on ONE unprotected lane. `None` is no cap.
    fn cap(self) -> Option<usize> {
        match self {
            Verbosity::Terse => Some(3),
            Verbosity::Normal => Some(10),
            Verbosity::Detailed => None,
        }
    }
}

/// How items sort WITHIN an unprotected lane. The lane order itself is the
/// artifact's and is not a preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Ordering {
    /// The artifact's reason order, then belief id — what [`super::lanes`]
    /// already produced.
    #[default]
    ByRuleClass,
    /// Group an entity's items together, for a reader working entity by
    /// entity. Still a permutation: nothing is added and nothing is dropped.
    ByEntity,
}

/// How long an unprotected item may stay quiet after it has been shown.
///
/// Not a timer and not a scheduler: the caller passes the set of items it has
/// already shown within the window, and this decides whether to repeat them.
/// M27 builds no notification system — nothing speaks first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Cadence {
    /// Show everything every time the surface is opened.
    #[default]
    EveryOpen,
    /// Do not repeat an unprotected item that was shown inside the window.
    Quiet,
}

/// Every knob. Defaults are the loudest safe setting: a user who has changed
/// nothing sees everything.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Preferences {
    pub verbosity: Verbosity,
    pub ordering: Ordering,
    pub cadence: Cadence,
    /// Per-item dismissals (M8). Keyed by belief id, exactly as the knowledge
    /// surface's insight dismissals are keyed by path.
    pub dismissed: BTreeSet<String>,
    /// Items already shown inside the cadence window.
    pub shown_recently: BTreeSet<String>,
}

/// What one surface renders, after preferences.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Presented {
    pub items: Vec<Item>,
    /// How many UNPROTECTED items a preference held back, so a surface can
    /// say "3 more" rather than silently showing fewer. A cap nobody can see
    /// is a cap that reads as "there is nothing else".
    pub withheld: usize,
}

/// Apply preferences to a computed set of lanes.
///
/// The one rule that cannot be configured: an item in a protected lane is in
/// the output. Every branch below asks `definitions.is_protected` FIRST, and
/// the test suite attempts suppression through each of them.
pub fn present(definitions: &Definitions, lanes: &Lanes, prefs: &Preferences) -> Presented {
    let mut kept: Vec<Item> = Vec::new();
    let mut withheld = 0usize;
    let mut per_lane: std::collections::BTreeMap<Lane, usize> = std::collections::BTreeMap::new();

    for item in &lanes.items {
        let protected = definitions.is_protected(item.lane);
        if !protected {
            if prefs.dismissed.contains(&item.belief_id) {
                withheld += 1;
                continue;
            }
            if prefs.cadence == Cadence::Quiet && prefs.shown_recently.contains(&item.belief_id) {
                withheld += 1;
                continue;
            }
            let count = per_lane.entry(item.lane).or_default();
            if prefs.verbosity.cap().is_some_and(|cap| *count >= cap) {
                withheld += 1;
                continue;
            }
            *count += 1;
        }
        kept.push(item.clone());
    }

    if prefs.ordering == Ordering::ByEntity {
        // A permutation of the UNPROTECTED items within their own lane.
        // Protected items keep the artifact's order, because a reader
        // checking the ranking must be able to find it where the rules say.
        kept.sort_by_key(|item| {
            let lane = definitions
                .order()
                .iter()
                .position(|id| id == item.lane.as_str())
                .unwrap_or(usize::MAX);
            let entity = if definitions.is_protected(item.lane) {
                String::new()
            } else {
                item.entity_id.clone()
            };
            (lane, entity, item.belief_id.clone())
        });
    }

    Presented {
        items: kept,
        withheld,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attention::lanes::Reason;

    fn item(lane: Lane, belief: &str, entity: &str) -> Item {
        Item {
            lane,
            belief_id: belief.into(),
            entity_id: entity.into(),
            path: None,
            predicate: Some("ci_status".into()),
            state_stage: Some("implemented".into()),
            reasons: vec![match lane {
                Lane::Contradiction => Reason::LegacyUnclassified,
                Lane::Blindness => Reason::CoverageUnassessed,
                Lane::Staleness => Reason::FreshnessStale,
                Lane::EpistemicDebt => Reason::StaleEvidence,
            }],
            reliance: Vec::new(),
            edge_id: None,
            relation_id: None,
        }
    }

    /// One item in every lane, plus enough unprotected ones to hit a cap.
    fn lanes() -> Lanes {
        let mut items = vec![
            item(Lane::Contradiction, "b-contradiction", "e1"),
            item(Lane::Blindness, "b-blindness", "e1"),
        ];
        for n in 0..12 {
            items.push(item(Lane::Staleness, &format!("b-stale-{n:02}"), "e2"));
            items.push(item(Lane::EpistemicDebt, &format!("b-debt-{n:02}"), "e3"));
        }
        Lanes {
            rule_version: "lanes-v1".into(),
            items,
        }
    }

    fn definitions() -> Definitions {
        crate::attention::lanes::load().expect("the shipped definitions")
    }

    fn survives(prefs: &Preferences) -> bool {
        let out = present(&definitions(), &lanes(), prefs);
        out.items
            .iter()
            .any(|i| i.lane == Lane::Contradiction && i.belief_id == "b-contradiction")
            && out
                .items
                .iter()
                .any(|i| i.lane == Lane::Blindness && i.belief_id == "b-blindness")
    }

    #[test]
    fn every_preference_path_is_attempted_and_the_protected_lanes_survive_all_of_them() {
        // §33's firewall, as a test that tries to break it. Each of these is a
        // real suppression path for an ordinary lane; none of them may reach a
        // protected one.
        let attempts: Vec<(&str, Preferences)> = vec![
            (
                "terse verbosity",
                Preferences {
                    verbosity: Verbosity::Terse,
                    ..Default::default()
                },
            ),
            (
                "dismissing them by id",
                Preferences {
                    dismissed: BTreeSet::from([
                        "b-contradiction".to_string(),
                        "b-blindness".to_string(),
                    ]),
                    ..Default::default()
                },
            ),
            (
                "a quiet cadence over already-shown items",
                Preferences {
                    cadence: Cadence::Quiet,
                    shown_recently: BTreeSet::from([
                        "b-contradiction".to_string(),
                        "b-blindness".to_string(),
                    ]),
                    ..Default::default()
                },
            ),
            (
                "re-ordering",
                Preferences {
                    ordering: Ordering::ByEntity,
                    ..Default::default()
                },
            ),
            (
                "all of them at once",
                Preferences {
                    verbosity: Verbosity::Terse,
                    ordering: Ordering::ByEntity,
                    cadence: Cadence::Quiet,
                    dismissed: BTreeSet::from([
                        "b-contradiction".to_string(),
                        "b-blindness".to_string(),
                    ]),
                    shown_recently: BTreeSet::from([
                        "b-contradiction".to_string(),
                        "b-blindness".to_string(),
                    ]),
                },
            ),
        ];
        for (what, prefs) in attempts {
            assert!(survives(&prefs), "{what} suppressed a protected lane");
        }
    }

    #[test]
    fn the_same_knobs_do_work_on_an_unprotected_lane() {
        // Otherwise the test above proves nothing: a firewall that holds
        // because no knob does anything is not a firewall.
        let definitions = definitions();
        let lanes = lanes();
        let terse = present(
            &definitions,
            &lanes,
            &Preferences {
                verbosity: Verbosity::Terse,
                ..Default::default()
            },
        );
        assert_eq!(
            terse
                .items
                .iter()
                .filter(|i| i.lane == Lane::Staleness)
                .count(),
            3,
            "terse caps an ordinary lane"
        );
        assert!(terse.withheld > 0, "and says how many it held back");

        let dismissed = present(
            &definitions,
            &lanes,
            &Preferences {
                dismissed: BTreeSet::from(["b-stale-00".to_string()]),
                ..Default::default()
            },
        );
        assert!(!dismissed.items.iter().any(|i| i.belief_id == "b-stale-00"));
    }

    #[test]
    fn a_cap_that_hid_something_says_so_rather_than_looking_empty() {
        // A cap nobody can see reads as "there is nothing else", which is the
        // failure mode the whole milestone is about.
        let out = present(
            &definitions(),
            &lanes(),
            &Preferences {
                verbosity: Verbosity::Terse,
                ..Default::default()
            },
        );
        // 12 stale + 12 debt, capped at 3 each.
        assert_eq!(out.withheld, 18);
    }

    #[test]
    fn detailed_verbosity_holds_nothing_back() {
        let out = present(
            &definitions(),
            &lanes(),
            &Preferences {
                verbosity: Verbosity::Detailed,
                ..Default::default()
            },
        );
        assert_eq!(out.withheld, 0);
        assert_eq!(out.items.len(), lanes().items.len());
    }

    #[test]
    fn ordering_is_a_permutation_and_never_a_filter() {
        let by_entity = present(
            &definitions(),
            &lanes(),
            &Preferences {
                ordering: Ordering::ByEntity,
                verbosity: Verbosity::Detailed,
                ..Default::default()
            },
        );
        let default = present(
            &definitions(),
            &lanes(),
            &Preferences {
                verbosity: Verbosity::Detailed,
                ..Default::default()
            },
        );
        let ids = |p: &Presented| {
            let mut out: Vec<String> = p.items.iter().map(|i| i.belief_id.clone()).collect();
            out.sort();
            out
        };
        assert_eq!(ids(&by_entity), ids(&default));
    }

    #[test]
    fn the_lane_order_itself_is_not_a_preference() {
        // Ranking in Rust exists so a person can check it. A knob that
        // reordered the lanes would put that back in the reader's hands and
        // call it a setting.
        let out = present(
            &definitions(),
            &lanes(),
            &Preferences {
                ordering: Ordering::ByEntity,
                verbosity: Verbosity::Detailed,
                ..Default::default()
            },
        );
        let order: Vec<&str> = out
            .items
            .iter()
            .map(|i| i.lane.as_str())
            .collect::<Vec<_>>();
        let mut seen: Vec<&str> = Vec::new();
        for lane in order {
            if seen.last() != Some(&lane) {
                seen.push(lane);
            }
        }
        assert_eq!(
            seen,
            ["contradiction", "blindness", "staleness", "epistemic_debt"]
        );
    }
}
