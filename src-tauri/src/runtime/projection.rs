//! The cost-projection contract (M26.7f) — data, not a Skeptic.
//!
//! **This artifact ships a formula and a table, and implements no policy.**
//! M28's Skeptic is the thing that will ASK "what would this cost if we ran
//! it?"; what M26 owes it is one arithmetic that both implementations agree
//! on, pinned in a file, so the answer does not depend on who computed it.
//!
//! The projection is exactly
//! `ceil(q * multiplier_ppm / 1_000_000) + fixed_quantity` — integer
//! throughout. Parts-per-million rather than a float because a projection
//! that rounded differently on two machines would make a spend estimate a
//! matter of opinion, and `ceil` rather than round-half because a projection
//! that can come in UNDER the truth is worse than one that cannot.
//!
//! **The unit map cannot be overridden.** It belongs to the component
//! ([`super::governance::Component`]) and this artifact has no column for it.
//! An artifact that could redefine `output_tokens` as bytes would be able to
//! make any run look cheap.
//!
//! **The shipped multipliers are all 1:1 with nothing fixed**, which is not a
//! placeholder: the identity projection is the honest starting point for a
//! model nobody has measured yet. Changing them is a deliberate edit with a
//! digest to regenerate, which is the whole reason the artifact exists.

use std::collections::BTreeMap;

use crate::ledger::sha256_hex;

use super::governance::Component;

const PROJECTION_JSON: &str = include_str!("../../../shared/policy/cost-projection.v1.json");
const PROJECTION_DIGEST: &str = include_str!("../../../shared/policy/cost-projection.v1.sha256");

/// One component's projection rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub multiplier_ppm: u64,
    pub fixed_quantity: u64,
}

impl Rule {
    /// `ceil(q * multiplier_ppm / 1_000_000) + fixed_quantity`.
    ///
    /// Done in `u128` because `q * multiplier_ppm` overflows `u64` for
    /// perfectly ordinary inputs — a million tokens at a 20× multiplier is
    /// already 2e13, and the product with the ppm scale is 2e19.
    pub fn project(&self, quantity: u64) -> u64 {
        let scaled = (quantity as u128) * (self.multiplier_ppm as u128);
        let projected = scaled.div_ceil(1_000_000);
        (projected + self.fixed_quantity as u128).min(u64::MAX as u128) as u64
    }
}

/// One per-unit rate, in integer micros. Used ONLY for monetary totals —
/// never for gating, which counts quantities.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PricingSnapshot {
    pub snapshot_id: String,
    /// Component name → micros per unit.
    pub micros_per_unit: BTreeMap<String, u64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    component: String,
    multiplier_ppm: u64,
    fixed_quantity: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    format: u64,
    artifact_version: u64,
    skeptic_model_id: String,
    components: Vec<Entry>,
    pricing_snapshot: Option<PricingSnapshot>,
}

/// The loaded contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contract {
    pub artifact_version: u64,
    pub skeptic_model_id: String,
    rules: BTreeMap<&'static str, Rule>,
    pub pricing_snapshot: Option<PricingSnapshot>,
}

impl Contract {
    /// The rule for one component. Total: [`load`] refuses an artifact that
    /// does not name all ten, so this never has to guess a default.
    pub fn rule(&self, component: Component) -> Rule {
        *self
            .rules
            .get(component.as_str())
            .expect("load refuses an artifact missing a component")
    }

    pub fn project(&self, component: Component, quantity: u64) -> u64 {
        self.rule(component).project(quantity)
    }

    /// The monetary total of one projected quantity, when a snapshot is
    /// pinned. `None` means no vendor price is known — which is a legitimate
    /// state and not a zero.
    pub fn micros(&self, component: Component, projected: u64) -> Option<u64> {
        let snapshot = self.pricing_snapshot.as_ref()?;
        let rate = snapshot.micros_per_unit.get(component.as_str())?;
        Some(projected.saturating_mul(*rate))
    }
}

/// Load the shipped contract, with the artifact's bytes checked against the
/// committed digest.
///
/// The digest is the same discipline the budget ceilings carry: these numbers
/// decide what a projection SAYS a run will cost, and a reflow or a dropped
/// zero would be invisible until somebody trusted the number.
pub fn load() -> Result<Contract, String> {
    let expected = PROJECTION_DIGEST.trim();
    let actual = sha256_hex(PROJECTION_JSON.as_bytes());
    if actual != expected {
        return Err(format!(
            "shared/policy/cost-projection.v1.json hashes to {actual}, and the committed digest \
             says {expected} — regenerate the digest deliberately, or find out who changed the \
             projection"
        ));
    }
    let artifact: Artifact = serde_json::from_str(PROJECTION_JSON)
        .map_err(|e| format!("cost-projection.v1.json: {e}"))?;
    if artifact.format != 1 {
        return Err(format!(
            "cost-projection format {} is not one this build speaks",
            artifact.format
        ));
    }
    if artifact.skeptic_model_id.is_empty() {
        return Err("skeptic_model_id must be non-empty".to_string());
    }

    let mut rules: BTreeMap<&'static str, Rule> = BTreeMap::new();
    for entry in &artifact.components {
        let component = Component::parse(&entry.component).ok_or_else(|| {
            format!(
                "cost-projection names component {:?}, which is not one of the ten",
                entry.component
            )
        })?;
        if rules
            .insert(
                component.as_str(),
                Rule {
                    multiplier_ppm: entry.multiplier_ppm,
                    fixed_quantity: entry.fixed_quantity,
                },
            )
            .is_some()
        {
            return Err(format!(
                "cost-projection names {} twice — one rule per component",
                entry.component
            ));
        }
    }
    let missing: Vec<&str> = Component::ALL
        .iter()
        .filter(|c| !rules.contains_key(c.as_str()))
        .map(|c| c.as_str())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "cost-projection is missing a rule for {} — the component set is closed, and a \
             projection that silently skipped one would under-report every run that used it",
            missing.join(", ")
        ));
    }
    if let Some(snapshot) = &artifact.pricing_snapshot {
        if snapshot.snapshot_id.is_empty() {
            return Err("a pricing snapshot must name itself".to_string());
        }
        for name in snapshot.micros_per_unit.keys() {
            if Component::parse(name).is_none() {
                return Err(format!(
                    "pricing snapshot prices {name:?}, which is not one of the ten components"
                ));
            }
        }
    }

    Ok(Contract {
        artifact_version: artifact.artifact_version,
        skeptic_model_id: artifact.skeptic_model_id,
        rules,
        pricing_snapshot: artifact.pricing_snapshot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_artifact_loads_and_names_all_ten() {
        let contract = load().expect("the shipped contract");
        for component in Component::ALL {
            // Total by construction: `rule` would panic on a gap, and `load`
            // is what makes the gap impossible.
            let _ = contract.rule(component);
        }
        assert!(!contract.skeptic_model_id.is_empty());
    }

    #[test]
    fn the_identity_projection_is_the_identity() {
        let contract = load().unwrap();
        for component in Component::ALL {
            assert_eq!(contract.project(component, 12_345), 12_345);
            assert_eq!(contract.project(component, 0), 0);
        }
    }

    #[test]
    fn the_formula_rounds_up_and_never_under_reports() {
        // A projection that can come in UNDER the truth is worse than one
        // that cannot, which is why this is `ceil` and not round-half.
        let half = Rule {
            multiplier_ppm: 500_000,
            fixed_quantity: 0,
        };
        assert_eq!(half.project(1), 1, "0.5 rounds UP");
        assert_eq!(half.project(3), 2, "1.5 rounds UP");
        assert_eq!(half.project(4), 2);
        assert_eq!(half.project(0), 0, "nothing projects to nothing");
    }

    #[test]
    fn the_fixed_quantity_is_added_after_the_multiplier() {
        let rule = Rule {
            multiplier_ppm: 2_000_000,
            fixed_quantity: 7,
        };
        assert_eq!(rule.project(10), 27);
        assert_eq!(
            rule.project(0),
            7,
            "a fixed cost is paid even for a run that measured nothing"
        );
    }

    #[test]
    fn a_realistic_multiplier_does_not_overflow() {
        // `q * multiplier_ppm` leaves u64 for perfectly ordinary inputs: a
        // million tokens at 20x is 2e13, and times the ppm scale is 2e19.
        let rule = Rule {
            multiplier_ppm: 20_000_000,
            fixed_quantity: 0,
        };
        assert_eq!(rule.project(1_000_000), 20_000_000);
        assert_eq!(rule.project(u64::MAX), u64::MAX, "saturates, never wraps");
    }

    #[test]
    fn no_vendor_price_is_no_answer_rather_than_zero() {
        let contract = load().unwrap();
        assert_eq!(contract.pricing_snapshot, None);
        assert_eq!(contract.micros(Component::OutputTokens, 1_000), None);
    }

    #[test]
    fn the_unit_map_is_not_in_this_artifact_at_all() {
        // An artifact that could redefine `output_tokens` as bytes would be
        // able to make any run look cheap. The unit belongs to the component.
        assert!(
            !PROJECTION_JSON.contains("\"unit\""),
            "the projection contract must not carry units"
        );
        for component in Component::ALL {
            assert!(!component.unit().is_empty());
        }
    }

    #[test]
    fn the_digest_is_over_the_bytes_that_ship() {
        assert_eq!(
            sha256_hex(PROJECTION_JSON.as_bytes()),
            PROJECTION_DIGEST.trim(),
            "regenerate shared/policy/cost-projection.v1.sha256"
        );
    }
}
