//! Cost completeness and projection (M26.9b).
//!
//! The claim M28's windows rest on: a run's accounting is reproducible from
//! persisted rows alone. That is only true if a partial set is impossible,
//! the unit cannot be chosen by whoever wrote the row, and the projection
//! formula is the same arithmetic everywhere.
//!
//! The wrong implementation these are aimed at is the one that writes the
//! components it happened to measure. Its rows look fine one at a time, and
//! a window summed over them silently under-reports — because "no cache
//! reads" and "we did not record cache reads" are the same absence to a SUM.

use rusqlite::{params, Connection};

use crate::runtime::governance::{costs, record_costs, Component, Measured};
use crate::runtime::projection::{load, Rule};

const VAULT: &str = "vault-1";
const STORE: &str = "cafebabecafebabecafebabecafebabe";
const RUN: &str = "run-1";

fn conn() -> Connection {
    let conn = Connection::open_in_memory().expect("memory db");
    conn.execute_batch(
        "CREATE TABLE vault_registry (vault_id TEXT PRIMARY KEY, path TEXT NOT NULL);
         CREATE TABLE source_taint_assessments (
             vault_id TEXT, store_uuid TEXT, observation_event_id TEXT,
             classifier_version TEXT, signals TEXT, assessed_at TEXT);",
    )
    .expect("registry");
    conn.execute(
        "INSERT INTO vault_registry (vault_id, path) VALUES (?1, '/tmp/v')",
        params![VAULT],
    )
    .expect("register");
    conn.execute_batch(crate::runtime::schema::SCHEMA_V9)
        .expect("v9");
    conn
}

fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339("2026-08-12T12:00:00.000Z")
        .unwrap()
        .with_timezone(&chrono::Utc)
}

#[test]
fn a_run_that_measured_only_what_it_used_is_refused() {
    // THE fixture. This build's rows are individually valid and its windows
    // are wrong, because a SUM cannot tell "zero" from "absent".
    let conn = conn();
    let partial: Vec<Measured> = [
        Component::UncachedInputTokens,
        Component::OutputTokens,
        Component::ToolCalls,
    ]
    .into_iter()
    .map(Measured::zero)
    .collect();
    let detail = record_costs(&conn, VAULT, STORE, RUN, "m", &partial, now())
        .expect_err("a partial set has to be refused, not stored");
    for missing in ["cache_read_tokens", "cache_write_tokens", "retrieval_calls"] {
        assert!(detail.contains(missing), "{detail}");
    }
    assert!(
        costs(&conn, VAULT, STORE, RUN).unwrap().is_empty(),
        "and it writes nothing at all, so there is no half-accounted run to sum"
    );
}

#[test]
fn zero_is_written_and_a_window_can_tell_it_from_nothing() {
    let conn = conn();
    let all: Vec<Measured> = Component::ALL.into_iter().map(Measured::zero).collect();
    record_costs(&conn, VAULT, STORE, RUN, "claude-x", &all, now()).unwrap();
    let rows = costs(&conn, VAULT, STORE, RUN).unwrap();
    assert_eq!(rows.len(), 10);
    assert!(rows.iter().all(|(_, quantity)| *quantity == 0));
    assert_eq!(
        costs(&conn, VAULT, STORE, "a-run-that-never-happened")
            .unwrap()
            .len(),
        0,
        "absence still reads as absence for a run that was never accounted"
    );
}

#[test]
fn the_unit_is_the_components_and_the_table_says_so_too() {
    // Two definitions of one mapping — the enum's and the CHECK's. A build
    // where they drifted could make any run look cheap.
    let conn = conn();
    let all: Vec<Measured> = Component::ALL.into_iter().map(Measured::zero).collect();
    record_costs(&conn, VAULT, STORE, RUN, "claude-x", &all, now()).unwrap();
    let mut stmt = conn
        .prepare("SELECT component, unit FROM run_cost_components")
        .unwrap();
    let pairs: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(pairs.len(), 10);
    for (name, unit) in pairs {
        assert_eq!(
            Component::parse(&name).expect("a known component").unit(),
            unit
        );
    }
}

#[test]
fn the_projection_is_the_same_arithmetic_for_every_component() {
    let contract = load().expect("the shipped contract");
    for component in Component::ALL {
        let rule = contract.rule(component);
        for quantity in [0u64, 1, 7, 1_000, 999_999] {
            let expected = (quantity as u128)
                .checked_mul(rule.multiplier_ppm as u128)
                .expect("no overflow in the test's own arithmetic")
                .div_ceil(1_000_000) as u64
                + rule.fixed_quantity;
            assert_eq!(contract.project(component, quantity), expected);
        }
    }
}

#[test]
fn a_projection_never_comes_in_under_the_truth() {
    // `ceil`, not round-half. A spend estimate that can be too low is worse
    // than one that cannot, and a build that rounded to nearest would pass
    // every whole-number case and fail exactly here.
    let third = Rule {
        multiplier_ppm: 333_333,
        fixed_quantity: 0,
    };
    for quantity in 1u64..50 {
        let exact = (quantity as f64) * 0.333_333;
        assert!(
            third.project(quantity) as f64 >= exact,
            "projected {} for {quantity}, which is under {exact}",
            third.project(quantity)
        );
    }
}

#[test]
fn no_vendor_price_is_no_answer_rather_than_free() {
    let contract = load().expect("the shipped contract");
    assert_eq!(
        contract.micros(Component::OutputTokens, 1_000_000),
        None,
        "a run whose monetary total is unknown and a run that was free are \
         different facts, and zero would say the second"
    );
}
