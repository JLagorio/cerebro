//! R1 — the cost-evidence protocol (M28.0e).
//!
//! Twenty-eight complete local days of successful synthesis runs, read from
//! `assembly_metrics` and `run_cost_components` ACROSS the whole
//! subscription — R1 is deliberately `subscription_global`, because one
//! personal CLI plan is metered once no matter how many vaults debit it.
//!
//! **No sampled run is represented as an actual adversarial-review run.**
//! The protocol projects what one independent review-tier run WOULD cost,
//! through `runtime::projection`'s pinned formula, and persists the policy
//! hash beside the sample so the projection is reproducible. The protected
//! name stays out of this module on purpose: nothing here reviews anything.
//!
//! **The floors are the firing condition.** R1's protocol is a data-quality
//! gate — ≥30 runs, ≥10 HIGH/CRITICAL, component-complete quantities for
//! ≥95% of the sample. A sample below any floor is `not_ready`; a sample
//! meeting all of them FIRES planning. There is no `not_fired` arm, because
//! the question "is the record good enough to plan from" has only those two
//! answers.
//!
//! Percentiles are nearest-rank over sorted integers — `x[ceil(p*n)-1]` —
//! never interpolated, never floated.

use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::runtime::governance::Component;
use crate::runtime::projection;
use crate::trigger::evaluate::{MeasurableOutcome, Recorded};
use crate::trigger::evaluation::{
    ComponentRef, MetricSeriesKey, Quantile, QuantityName, TriggerMetric, TriggerResult,
};
use crate::trigger::registry::Registry;

/// One sampled synthesis run: its highest manifest stakes, and its ten
/// component quantities when complete.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct R1Run {
    pub run_id: String,
    pub high_stakes: bool,
    /// Component name → quantity. Complete means exactly the ten.
    pub components: BTreeMap<String, u64>,
}

impl R1Run {
    pub fn complete(&self) -> bool {
        self.components.len() == Component::ALL.len()
            && Component::ALL
                .iter()
                .all(|c| self.components.contains_key(c.as_str()))
    }
}

/// `x[ceil(p_ppm * n / 1_000_000) - 1]` over ascending values — the design's
/// nearest-rank rule, in integers.
pub fn nearest_rank(sorted: &[u64], p_ppm: u64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let n = sorted.len() as u64;
    let rank = (p_ppm * n).div_ceil(1_000_000).max(1);
    sorted.get((rank - 1) as usize).copied()
}

fn statistic(quantile: Quantile) -> MetricSeriesKey {
    MetricSeriesKey::Statistic { quantile }
}

fn quantity(name: QuantityName, value: u64, unit: &str, series: MetricSeriesKey) -> TriggerMetric {
    TriggerMetric::Quantity {
        name,
        value,
        unit: unit.to_string(),
        series,
    }
}

/// The pure core: floors, projections, and the persisted distributions.
pub fn r1_outcome(
    runs: &[R1Run],
    contract: &projection::Contract,
    min_sample_runs: u64,
    min_high_stakes_runs: u64,
    min_completeness_ppm: u64,
    window_days: u64,
) -> (Vec<TriggerMetric>, TriggerResult) {
    let sample = runs.len() as u64;
    let high_stakes = runs.iter().filter(|r| r.high_stakes).count() as u64;
    let complete: Vec<&R1Run> = runs.iter().filter(|r| r.complete()).collect();
    let mut metrics = vec![
        TriggerMetric::Count {
            name: "sample_runs".into(),
            series: MetricSeriesKey::Aggregate,
            value: sample,
        },
        TriggerMetric::Count {
            name: "high_stakes_runs".into(),
            series: MetricSeriesKey::Aggregate,
            value: high_stakes,
        },
        TriggerMetric::Count {
            name: "complete_runs".into(),
            series: MetricSeriesKey::Aggregate,
            value: complete.len() as u64,
        },
        // Mean daily HIGH/CRITICAL load, rounded UP — a projection that can
        // come in under the truth is worse than one that cannot.
        TriggerMetric::Count {
            name: "high_stakes_runs".into(),
            series: MetricSeriesKey::HighStakesDailyLoad,
            value: high_stakes.div_ceil(window_days.max(1)),
        },
    ];
    let completeness_ppm = if sample > 0 {
        metrics.push(TriggerMetric::RatioPpm {
            name: "component_completeness".into(),
            numerator: complete.len() as u64,
            denominator: sample,
            value_ppm: (complete.len() as u64) * 1_000_000 / sample,
            series: MetricSeriesKey::Aggregate,
        });
        (complete.len() as u64) * 1_000_000 / sample
    } else {
        0
    };

    // Distributions over COMPLETE runs only: per-component projections at
    // p50/p90, and the input/output/calls/cost roll-ups.
    let mut per_component: BTreeMap<Component, Vec<u64>> = BTreeMap::new();
    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    let mut calls = Vec::new();
    let mut costs = Vec::new();
    for run in &complete {
        let mut input = 0u64;
        let mut output = 0u64;
        let mut call = 0u64;
        let mut cost = Some(0u64);
        for component in Component::ALL {
            let q = run.components[component.as_str()];
            let projected = contract.project(component, q);
            per_component.entry(component).or_default().push(projected);
            match component {
                Component::UncachedInputTokens
                | Component::CacheReadTokens
                | Component::CacheWriteTokens => input += projected,
                Component::OutputTokens => output += projected,
                Component::RetrievalCalls | Component::ToolCalls => call += projected,
                _ => {}
            }
            cost = match (cost, contract.micros(component, projected)) {
                (Some(total), Some(more)) => Some(total.saturating_add(more)),
                _ => None,
            };
        }
        inputs.push(input);
        outputs.push(output);
        calls.push(call);
        if let Some(cost) = cost {
            costs.push(cost);
        }
    }
    for values in per_component.values_mut() {
        values.sort_unstable();
    }
    inputs.sort_unstable();
    outputs.sort_unstable();
    calls.sort_unstable();
    costs.sort_unstable();

    for quantile in [Quantile::P50, Quantile::P90] {
        let p_ppm = match quantile {
            Quantile::P50 => 500_000,
            Quantile::P90 => 900_000,
        };
        for (component, values) in &per_component {
            if let Some(value) = nearest_rank(values, p_ppm) {
                metrics.push(quantity(
                    QuantityName::Component {
                        projected_component: ComponentRef {
                            component: component.as_str().to_string(),
                        },
                    },
                    value,
                    component.unit(),
                    statistic(quantile),
                ));
            }
        }
        for (name, values, unit) in [
            ("projected_input", &inputs, "tokens"),
            ("projected_output", &outputs, "tokens"),
            ("projected_calls", &calls, "calls"),
        ] {
            if let Some(value) = nearest_rank(values, p_ppm) {
                metrics.push(quantity(
                    QuantityName::Fixed(name.to_string()),
                    value,
                    unit,
                    statistic(quantile),
                ));
            }
        }
        // Priced cost exists only when a pricing snapshot is pinned. Absent
        // is absent — never a zero.
        if let Some(value) = nearest_rank(&costs, p_ppm) {
            metrics.push(quantity(
                QuantityName::Fixed("projected_cost".to_string()),
                value,
                "micros",
                statistic(quantile),
            ));
        }
    }

    let result = if sample < min_sample_runs
        || high_stakes < min_high_stakes_runs
        || completeness_ppm < min_completeness_ppm
    {
        TriggerResult::NotReady
    } else {
        TriggerResult::Fired
    };
    (metrics, result)
}

/// Evaluate R1 over the whole subscription and record the outcome.
pub fn evaluate_r1(
    conn: &Connection,
    registry: &Registry,
    evaluated_at: chrono::DateTime<chrono::Utc>,
    timezone: &str,
) -> Result<Recorded, String> {
    let contract = projection::load()?;
    let gate = "R1:root";
    let outcome = MeasurableOutcome::subscription(registry, gate, evaluated_at, timezone)?;

    // The sample: every run that recorded a manifest in the window, with its
    // highest stakes — across ALL vaults, because the subscription is one.
    let mut runs: BTreeMap<String, R1Run> = BTreeMap::new();
    let mut statement = conn
        .prepare(
            "SELECT run_id, intended_stakes, recorded_at FROM assembly_metrics \
             ORDER BY run_id, manifest_id",
        )
        .map_err(|e| e.to_string())?;
    let fetched = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in fetched {
        let (run_id, stakes, recorded_at) = row.map_err(|e| e.to_string())?;
        if !outcome.contains(&recorded_at)? {
            continue;
        }
        let entry = runs.entry(run_id.clone()).or_insert_with(|| R1Run {
            run_id,
            high_stakes: false,
            components: BTreeMap::new(),
        });
        entry.high_stakes |= matches!(stakes.as_str(), "HIGH" | "CRITICAL");
    }
    let mut statement = conn
        .prepare("SELECT run_id, component, quantity FROM run_cost_components ORDER BY run_id")
        .map_err(|e| e.to_string())?;
    let fetched = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in fetched {
        let (run_id, component, q) = row.map_err(|e| e.to_string())?;
        if let Some(run) = runs.get_mut(&run_id) {
            run.components.insert(component, q.max(0) as u64);
        }
    }
    let runs: Vec<R1Run> = runs.into_values().collect();

    let (metrics, result) = r1_outcome(
        &runs,
        &contract,
        outcome.constant("min_sample_runs")?,
        outcome.constant("min_high_stakes_runs")?,
        outcome.constant("min_component_completeness_ppm")?,
        outcome.constant("window_days")?,
    );
    outcome.persist(
        conn,
        &serde_json::json!({
            "policy_hash": projection::shipped_digest(),
            "skeptic_model_id": contract.skeptic_model_id,
            "runs": runs,
        }),
        metrics,
        result,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(n: usize, high: bool, complete: bool) -> R1Run {
        let mut components = BTreeMap::new();
        let upto = if complete { Component::ALL.len() } else { 9 };
        for component in Component::ALL.iter().take(upto) {
            components.insert(component.as_str().to_string(), (n as u64 + 1) * 100);
        }
        R1Run {
            run_id: format!("run-{n}"),
            high_stakes: high,
            components,
        }
    }

    fn sample(total: usize, high: usize, incomplete: usize) -> Vec<R1Run> {
        (0..total)
            .map(|n| run(n, n < high, n >= incomplete))
            .collect()
    }

    #[test]
    fn r1_fires_at_the_floors_and_is_not_ready_one_run_short_of_any() {
        let contract = projection::load().unwrap();
        // 30 runs, 10 high, 1 incomplete → completeness 966_666: fires.
        let (_, result) = r1_outcome(&sample(30, 10, 1), &contract, 30, 10, 950_000, 28);
        assert_eq!(result, TriggerResult::Fired);
        // 29 runs: the sample floor.
        let (_, result) = r1_outcome(&sample(29, 10, 0), &contract, 30, 10, 950_000, 28);
        assert_eq!(result, TriggerResult::NotReady);
        // 9 high: the stakes floor.
        let (_, result) = r1_outcome(&sample(30, 9, 0), &contract, 30, 10, 950_000, 28);
        assert_eq!(result, TriggerResult::NotReady);
        // 2 of 30 incomplete → 933_333 ppm: the completeness floor.
        let (_, result) = r1_outcome(&sample(30, 10, 2), &contract, 30, 10, 950_000, 28);
        assert_eq!(result, TriggerResult::NotReady);
    }

    #[test]
    fn the_nearest_rank_is_the_designs_and_never_interpolates() {
        let values = [10, 20, 30, 40];
        // p50 over 4: rank ceil(0.5*4)=2 → x[1]=20. Interpolation would say 25.
        assert_eq!(nearest_rank(&values, 500_000), Some(20));
        // p90 over 4: rank ceil(3.6)=4 → x[3]=40.
        assert_eq!(nearest_rank(&values, 900_000), Some(40));
        assert_eq!(nearest_rank(&[7], 500_000), Some(7));
        assert_eq!(nearest_rank(&[], 500_000), None);
    }

    #[test]
    fn an_incomplete_run_contributes_no_distribution_and_no_priced_cost_appears_unpinned() {
        let contract = projection::load().unwrap();
        let (metrics, _) = r1_outcome(&sample(30, 10, 1), &contract, 30, 10, 950_000, 28);
        // 29 complete runs feed the distributions; the shipped contract pins
        // no pricing snapshot, so no projected_cost row may exist.
        assert!(metrics.iter().any(|m| matches!(
            m,
            TriggerMetric::Count { name, series: MetricSeriesKey::Aggregate, value: 29 }
                if name == "complete_runs"
        )));
        assert!(!metrics.iter().any(|m| matches!(
            m,
            TriggerMetric::Quantity { name: QuantityName::Fixed(name), .. }
                if name == "projected_cost"
        )));
        // The daily load rounds UP: 10 high-stakes over 28 days is 1, not 0.
        assert!(metrics.iter().any(|m| matches!(
            m,
            TriggerMetric::Count { name, series: MetricSeriesKey::HighStakesDailyLoad, value: 1 }
                if name == "high_stakes_runs"
        )));
    }
}
