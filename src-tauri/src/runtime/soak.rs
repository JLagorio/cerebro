//! The simulated-day soak (M25.8) — the milestone's exit criterion.
//!
//! Everything M25 built is a claim about what happens over a day of ordinary
//! use: file churn, a `git checkout`, quota deaths, restarts, a deleted
//! database, a corrupted one. This drives all of it against the real modules
//! — the real budget arithmetic, the real claim transaction, the real
//! recovery planner — and asserts the properties the plan's exit criteria
//! name, one assertion each:
//!
//! - **≤20 ambient runs globally**, across two vaults sharing one
//!   subscription;
//! - **exact global arithmetic**, checked against injected usage;
//! - **vault isolation**: two vaults' scheduler rows never collide;
//! - **zero mtime spend**: a checkout queues nothing;
//! - **no automatic recovery spend**: a deleted database dispatches nothing
//!   until a person decides;
//! - **every failure visible**: each one leaves a row a surface can read.
//!
//! Time is INJECTED, not slept. A soak that took a real day to run would
//! never be run.

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Duration, Utc};
    use rusqlite::Connection;

    use crate::agent::usage::Usage;
    use crate::runtime::budget::{self, Reservation, Settings};
    use crate::runtime::catchup::{self, Scanned};
    use crate::runtime::dispatch::{self, Dispatched, ItemOutcome, RunOutcome};
    use crate::runtime::normalize;
    use crate::runtime::scheduler::{self, SchedulerState};
    use crate::runtime::{health, scope, status};
    use crate::vault::entry::Entry;
    use crate::vault::testutil;

    fn at(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    /// One note, as catch-up sees it. `body` decides the artifact hash and
    /// `title` the normalized field — so a change to `body` alone is a
    /// non-material change and a change to `title` is a material one.
    fn note(key: &str, title: &str, body: &str) -> Scanned {
        let mut entry = Entry::empty_for_test(key);
        entry.title = title.into();
        Scanned {
            item_key: key.to_string(),
            artifact_hash: normalize::artifact_hash(body.as_bytes()),
            snapshot: normalize::snapshot(&entry),
        }
    }

    /// A modest reservation: 40 of these fit the day's 200,000-token ceiling,
    /// so the RUN ceiling (20) is what binds. That is deliberate — the soak
    /// must prove the run cap holds, not that a token cap masked it.
    fn reservation() -> Reservation {
        Reservation {
            total_tokens: 5_000,
            output_tokens: 1_000,
        }
    }

    struct Vaults {
        dir_a: std::path::PathBuf,
        dir_b: std::path::PathBuf,
        a: String,
        b: String,
    }

    fn open_day(label: &str) -> (std::path::PathBuf, Connection, Vaults) {
        let data = testutil::temp_vault(&format!("soak-data-{label}"));
        let conn = crate::runtime::open(&data).unwrap();
        let dir_a = testutil::temp_vault(&format!("soak-a-{label}"));
        let dir_b = testutil::temp_vault(&format!("soak-b-{label}"));
        let a = scope::register(&conn, &dir_a).unwrap();
        let b = scope::register(&conn, &dir_b).unwrap();
        budget::append_version(
            &conn,
            &Settings {
                ceilings: budget::shipped_defaults().unwrap(),
                timezone_id: "UTC".into(),
            },
            at("2026-08-09T00:10:00Z"),
        )
        .unwrap();
        (data, conn, Vaults { dir_a, dir_b, a, b })
    }

    fn cleanup(data: std::path::PathBuf, vaults: Vaults) {
        for dir in [data, vaults.dir_a, vaults.dir_b] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// Queue whatever changed, the way launch catch-up does.
    fn sync(conn: &Connection, vault: &str, store: &str, items: &[Scanned]) -> usize {
        let plan = catchup::plan(conn, vault, store, items).unwrap();
        catchup::apply(conn, vault, store, items, &plan).unwrap()
    }

    /// Run one ambient item to completion with injected usage. Returns
    /// whether it dispatched at all.
    fn run_one(
        conn: &Connection,
        vault: &str,
        store: &str,
        item: &str,
        usage: Usage,
        now: DateTime<Utc>,
    ) -> bool {
        match dispatch::claim(
            conn,
            vault,
            store,
            "behind",
            reservation(),
            &[item.into()],
            now,
        )
        .unwrap()
        {
            Dispatched::Started(lease) => {
                dispatch::finalize(
                    conn,
                    &lease.run_id,
                    RunOutcome::Succeeded,
                    Some(usage),
                    ItemOutcome::Consume,
                    now + Duration::minutes(1),
                )
                .unwrap();
                true
            }
            _ => false,
        }
    }

    #[test]
    fn a_simulated_day_across_two_vaults_stays_inside_one_subscriptions_ceiling() {
        let _lock = status::test_lock();
        status::clear();
        let (data, conn, vaults) = open_day("ceiling");

        // 30 items in each vault — 60 pieces of work against a ceiling of 20
        // runs. What binds must be the ceiling, not the supply.
        let items_a: Vec<Scanned> = (0..30)
            .map(|n| {
                note(
                    &format!("a{n:02}.md"),
                    &format!("A{n}"),
                    &format!("body {n}"),
                )
            })
            .collect();
        let items_b: Vec<Scanned> = (0..30)
            .map(|n| {
                note(
                    &format!("b{n:02}.md"),
                    &format!("B{n}"),
                    &format!("body {n}"),
                )
            })
            .collect();
        assert_eq!(sync(&conn, &vaults.a, "store-a", &items_a), 30);
        assert_eq!(sync(&conn, &vaults.b, "store-b", &items_b), 30);

        let usage = Usage {
            input_tokens: 10,
            output_tokens: 400,
            cache_read: 1_000,
            cache_write: 90,
        };
        let mut started = 0usize;
        let mut minute = 0i64;
        // Alternate vaults so both compete for the same subscription.
        for round in 0..40 {
            let (vault, store, items) = if round % 2 == 0 {
                (&vaults.a, "store-a", &items_a)
            } else {
                (&vaults.b, "store-b", &items_b)
            };
            let item = &items[round / 2].item_key;
            let now = at("2026-08-09T09:00:00Z") + Duration::minutes(minute);
            minute += 5;
            if run_one(&conn, vault, store, item, usage, now) {
                started += 1;
            }
        }

        // ≤20 globally, and the number below it is the lane ramp working
        // rather than an accident: `behind` is priority 3 of 7, so it sheds
        // at 90% of the run ceiling — 18 — leaving the last two runs for
        // higher-priority work. Degradation halts lowest-priority lanes
        // FIRST, and this is what that looks like from the outside.
        assert!(started <= 20, "the global ceiling is never exceeded");
        assert_eq!(started, 18, "a mid-priority lane sheds before the ceiling");

        let day = dispatch::day_totals(&conn, at("2026-08-09T20:00:00Z")).unwrap();
        assert_eq!(day.ambient_runs_started, 18);
        assert_eq!(
            day.ambient_tokens_used,
            18 * usage.total(),
            "exact global arithmetic against the injected usage"
        );
        assert_eq!(day.ambient_output_tokens, 18 * 400);
        assert!(day.accounting_exact);
        assert_eq!(day.reserved_total_tokens, 0, "every reservation released");

        // The highest-priority lane still runs, right up to the ceiling —
        // and then it stops too.
        let mut filed = 0usize;
        for round in 0..5 {
            let item = &items_a[20 + round].item_key;
            match dispatch::claim(
                &conn,
                &vaults.a,
                "store-a",
                "filed",
                reservation(),
                std::slice::from_ref(item),
                at("2026-08-09T18:00:00Z") + Duration::minutes(round as i64 * 5),
            )
            .unwrap()
            {
                Dispatched::Started(lease) => {
                    dispatch::finalize(
                        &conn,
                        &lease.run_id,
                        RunOutcome::Succeeded,
                        Some(usage),
                        ItemOutcome::Consume,
                        at("2026-08-09T18:01:00Z") + Duration::minutes(round as i64 * 5),
                    )
                    .unwrap();
                    filed += 1;
                }
                _ => break,
            }
        }
        assert_eq!(filed, 2, "the highest-priority lane runs to the ceiling");
        let day = dispatch::day_totals(&conn, at("2026-08-09T20:00:00Z")).unwrap();
        assert_eq!(day.ambient_runs_started, 20, "and never past it");
        assert_eq!(day.ceiling_state().0, "exhausted");

        // Vault isolation: each vault's queue is its own, and consuming one
        // vault's item never touched the other's.
        let consumed_a =
            scheduler::keys_in_state(&conn, &vaults.a, "store-a", SchedulerState::Consumed)
                .unwrap();
        let consumed_b =
            scheduler::keys_in_state(&conn, &vaults.b, "store-b", SchedulerState::Consumed)
                .unwrap();
        assert_eq!(consumed_a.len() + consumed_b.len(), 20);
        assert!(consumed_a.iter().all(|k| k.starts_with('a')));
        assert!(consumed_b.iter().all(|k| k.starts_with('b')));

        // And the next day opens with a fresh ceiling — the work that waited
        // is still waiting, not lost.
        let tomorrow = dispatch::day_totals(&conn, at("2026-08-10T09:00:00Z")).unwrap();
        assert_eq!(tomorrow.ambient_runs_started, 0);
        assert_eq!(tomorrow.ceiling_state().0, "under_budget");
        let waiting_a =
            scheduler::keys_in_state(&conn, &vaults.a, "store-a", SchedulerState::Pending).unwrap();
        let waiting_b =
            scheduler::keys_in_state(&conn, &vaults.b, "store-b", SchedulerState::Pending).unwrap();
        assert_eq!(
            waiting_a.len() + waiting_b.len(),
            40,
            "every item the ceiling refused is still waiting, in its own vault"
        );
        cleanup(data, vaults);
    }

    #[test]
    fn a_git_checkout_costs_nothing_and_a_real_edit_costs_one_run() {
        // Zero mtime spend, and the control that proves the test can tell the
        // difference: same content queues nothing, changed content queues one.
        let _lock = status::test_lock();
        status::clear();
        let (data, conn, vaults) = open_day("checkout");
        let before: Vec<Scanned> = (0..12)
            .map(|n| {
                note(
                    &format!("n{n:02}.md"),
                    &format!("N{n}"),
                    &format!("body {n}"),
                )
            })
            .collect();
        assert_eq!(sync(&conn, &vaults.a, "store-a", &before), 12);
        // Consume them so the queue is empty.
        scheduler::move_state(
            &conn,
            &vaults.a,
            "store-a",
            SchedulerState::Pending,
            SchedulerState::Consumed,
        )
        .unwrap();

        // The checkout: every mtime rewritten, not one byte changed.
        assert_eq!(
            sync(&conn, &vaults.a, "store-a", &before),
            0,
            "a checkout is not work"
        );

        // One real edit.
        let mut after = before.clone();
        after[3] = note("n03.md", "N3 revised", "body 3 revised");
        assert_eq!(sync(&conn, &vaults.a, "store-a", &after), 1);
        assert_eq!(
            scheduler::keys_in_state(&conn, &vaults.a, "store-a", SchedulerState::Pending).unwrap(),
            vec!["n03.md".to_string()]
        );
        cleanup(data, vaults);
    }

    #[test]
    fn a_quota_death_mid_day_stops_the_day_visibly_and_loses_no_work() {
        let _lock = status::test_lock();
        status::clear();
        let (data, conn, vaults) = open_day("quota");
        let items: Vec<Scanned> = (0..5)
            .map(|n| note(&format!("n{n}.md"), &format!("N{n}"), &format!("body {n}")))
            .collect();
        sync(&conn, &vaults.a, "store-a", &items);

        let now = at("2026-08-09T09:00:00Z");
        let Dispatched::Started(lease) = dispatch::claim(
            &conn,
            &vaults.a,
            "store-a",
            "behind",
            reservation(),
            &["n0.md".into()],
            now,
        )
        .unwrap() else {
            panic!("the first dispatch must go");
        };
        // It spent tokens and then died on quota.
        dispatch::finalize(
            &conn,
            &lease.run_id,
            RunOutcome::QuotaFailed,
            Some(Usage {
                output_tokens: 120,
                ..Usage::default()
            }),
            ItemOutcome::Requeue,
            now + Duration::minutes(2),
        )
        .unwrap();

        // Visible: runtime health degraded, the work is back in the queue,
        // and the count a banner would say is right.
        let (state, _, _) = health::runtime_health(&conn, health::COMPONENT_CLI)
            .unwrap()
            .unwrap();
        assert_eq!(state, health::RuntimeState::Degraded);
        assert_eq!(
            scheduler::keys_in_state(&conn, &vaults.a, "store-a", SchedulerState::Pending)
                .unwrap()
                .len(),
            5,
            "nothing was consumed by a run that could not do it"
        );
        let day = dispatch::day_totals(&conn, now).unwrap();
        assert_eq!(day.ambient_tokens_used, 120, "spent tokens still counted");

        // And the OTHER vault is stopped too — one subscription, one wall.
        assert_eq!(
            dispatch::claim(
                &conn,
                &vaults.b,
                "store-b",
                "behind",
                reservation(),
                &[],
                now + Duration::minutes(5),
            )
            .unwrap(),
            Dispatched::Deferred(vec![budget::GateReason::QuotaBackoff])
        );

        // After the window, work resumes.
        assert!(matches!(
            dispatch::claim(
                &conn,
                &vaults.a,
                "store-a",
                "behind",
                reservation(),
                &["n1.md".into()],
                now + Duration::hours(6),
            )
            .unwrap(),
            Dispatched::Started(_)
        ));
        cleanup(data, vaults);
    }

    #[test]
    fn a_crash_mid_run_loses_neither_the_work_nor_the_accounting() {
        let _lock = status::test_lock();
        status::clear();
        let (data, conn, vaults) = open_day("crash");
        let items = [note("n0.md", "N0", "body")];
        sync(&conn, &vaults.a, "store-a", &items);
        let now = at("2026-08-09T09:00:00Z");
        let Dispatched::Started(_) = dispatch::claim(
            &conn,
            &vaults.a,
            "store-a",
            "behind",
            reservation(),
            &["n0.md".into()],
            now,
        )
        .unwrap() else {
            panic!("dispatch");
        };
        // The process dies. Nothing finalizes. A later launch sweeps.
        let recovered = dispatch::recover_expired_leases(&conn, now + Duration::hours(1)).unwrap();
        assert_eq!(recovered, 1);
        assert_eq!(
            scheduler::keys_in_state(&conn, &vaults.a, "store-a", SchedulerState::Pending).unwrap(),
            vec!["n0.md".to_string()],
            "the work came back"
        );
        let day = dispatch::day_totals(&conn, now).unwrap();
        assert!(
            !day.accounting_exact,
            "and the day says its spend is unknown rather than zero"
        );
        assert!(!status::ambient_allowed(), "which pauses ambient work");
        status::clear();
        cleanup(data, vaults);
    }

    #[test]
    fn a_deleted_database_never_automatically_spends_again() {
        let _lock = status::test_lock();
        status::clear();
        let (data, conn, vaults) = open_day("deleted");
        let items: Vec<Scanned> = (0..4)
            .map(|n| note(&format!("n{n}.md"), &format!("N{n}"), &format!("body {n}")))
            .collect();
        sync(&conn, &vaults.a, "store-a", &items);
        scheduler::move_state(
            &conn,
            &vaults.a,
            "store-a",
            SchedulerState::Pending,
            SchedulerState::Consumed,
        )
        .unwrap();
        drop(conn);

        // The database is deleted. Everything operational is gone.
        crate::runtime::mark_closed(&data);
        let _ = std::fs::remove_file(crate::runtime::runtime_db_path(&data));
        let conn = crate::runtime::open(&data).unwrap();
        let vault_a = scope::register(&conn, &vaults.dir_a).unwrap();
        assert_eq!(
            vault_a, vaults.a,
            "the vault id re-derives, so rows rejoin it"
        );

        // No receipts exist in this fixture's ledger, so nothing is provable:
        // every item is HELD, and nothing is pending.
        let current: Vec<crate::runtime::recovery::CurrentItem> = items
            .iter()
            .map(|item| crate::runtime::recovery::CurrentItem {
                item_key: item.item_key.clone(),
                item_id: crate::ledger::schema::derive_item_id("store-a", "source", &item.item_key),
                artifact_hash: item.artifact_hash.clone(),
                snapshot: item.snapshot.clone(),
            })
            .collect();
        let plan = crate::runtime::recovery::plan(&current, &[]);
        assert_eq!(plan.held(), 4);
        crate::runtime::recovery::apply(&conn, &vault_a, "store-a", &current, &plan).unwrap();
        crate::runtime::recovery::begin(crate::runtime::status::RecoveryReason::DatabaseLost);

        assert!(!status::ambient_allowed(), "ambient pauses before dispatch");
        assert!(
            scheduler::keys_in_state(&conn, &vault_a, "store-a", SchedulerState::Pending)
                .unwrap()
                .is_empty(),
            "and nothing is queued to spend on"
        );

        // Only an explicit owner decision releases it.
        let moved = crate::runtime::recovery::resolve(
            &conn,
            &vault_a,
            "store-a",
            crate::runtime::import::Choice::Baseline,
        )
        .unwrap();
        assert_eq!(moved, 4);
        assert!(status::ambient_allowed());
        assert_eq!(
            scheduler::keys_in_state(&conn, &vault_a, "store-a", SchedulerState::Consumed)
                .unwrap()
                .len(),
            4,
            "the owner chose baseline, so nothing is re-spent"
        );
        status::clear();
        drop(conn);
        cleanup(data, vaults);
    }

    #[test]
    fn a_corrupt_database_is_preserved_and_the_app_keeps_working() {
        let _lock = status::test_lock();
        status::clear();
        let (data, conn, vaults) = open_day("corrupt");
        sync(&conn, &vaults.a, "store-a", &[note("n0.md", "N0", "body")]);
        drop(conn);
        crate::runtime::mark_closed(&data);

        let path = crate::runtime::runtime_db_path(&data);
        let mut bytes = std::fs::read(&path).unwrap();
        for byte in bytes.iter_mut().skip(4096).take(4096) {
            *byte ^= 0xff;
        }
        std::fs::write(&path, &bytes).unwrap();

        let conn = crate::runtime::open(&data).unwrap();
        assert_eq!(status::current().code(), "database_corrupt");
        assert!(!status::ambient_allowed());
        let preserved = std::fs::read_dir(&data)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(preserved, 1, "the only diagnostic copy is kept");
        // The replacement works: a vault registers, a day opens.
        let vault_a = scope::register(&conn, &vaults.dir_a).unwrap();
        assert_eq!(vault_a, vaults.a);
        budget::append_version(
            &conn,
            &Settings {
                ceilings: budget::shipped_defaults().unwrap(),
                timezone_id: "UTC".into(),
            },
            at("2026-08-09T00:10:00Z"),
        )
        .unwrap();
        assert_eq!(
            dispatch::day_totals(&conn, at("2026-08-09T09:00:00Z"))
                .unwrap()
                .ambient_runs_started,
            0
        );
        status::clear();
        drop(conn);
        cleanup(data, vaults);
    }

    #[test]
    fn every_failure_the_day_can_produce_leaves_a_row_a_surface_can_read() {
        // "Every failure mode is visible, none silent" — checked as one
        // assertion per face rather than as a claim in a doc.
        let _lock = status::test_lock();
        status::clear();
        let (data, conn, vaults) = open_day("visible");
        let now = at("2026-08-09T09:00:00Z");
        sync(&conn, &vaults.a, "store-a", &[note("n0.md", "N0", "body")]);

        health::record_quota_failure(&conn, "store-a", "usage limit reached", now).unwrap();
        conn.execute(
            "INSERT INTO source_registration (store_uuid, source_id, registration_event_id, \
             kind, source_key, authority_capability) \
             VALUES ('store-a', ?1, ?2, 'connector', 'connector:x', 'direct_system_artifact')",
            rusqlite::params!["a".repeat(32), "e".repeat(32)],
        )
        .unwrap();
        health::record_probe(
            &conn,
            "store-a",
            &"a".repeat(32),
            &health::Probe::unreachable("gone"),
            now,
        )
        .unwrap();
        health::record_ingestion_failure(
            &conn,
            &vaults.a,
            "store-a",
            "broken.md",
            health::Stage::Parse,
            "unclosed frontmatter",
            now,
        )
        .unwrap();

        let view = crate::runtime::surface::overview(&conn, &vaults.a, "store-a", now).unwrap();
        let kinds: Vec<&str> = view.banners.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec!["runtime_health", "source_health", "ingestion"],
            "three faces, three banners, in the order a person reads them"
        );
        assert_eq!(view.banners[0].count, 1, "N items unprocessed");
        assert_eq!(view.banners[2].count, 1, "N items failed ingestion");
        status::clear();
        cleanup(data, vaults);
    }
}
