use super::*;
fn request() -> Request {
    Request {
        anchor_ms: 0,
        cursor_ms: 0,
        now_ms: 60_500,
        interval_seconds: 60,
        catch_up: CatchUp::SkipMissed,
        observation: Observation::Native {
            previous_ms: 59_500,
            same_opening: true,
            resumed: false,
        },
        enabled: true,
        ready: true,
        recovery_held: false,
    }
}
#[test]
fn shared_policy_has_explicit_awake_coverage_and_bounded_coalescing() {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("../../../shared/workflows/schedule.v1.json")).unwrap();
    assert_eq!(value["formatVersion"], 1);
    assert_eq!(value["maxObservationGapMs"], 5_000);
    assert_eq!(value["coalesceLookbackMs"], 86_400_000);
    assert_eq!(value["clock"], "utc_elapsed");
}
#[test]
fn awake_interval_emits_one_intended_instant() {
    let p = evaluate(request()).unwrap();
    assert_eq!(p.disposition, Disposition::Due);
    assert_eq!(p.due_ms, Some(60_000));
    assert_eq!(p.cursor_ms, 60_000);
    assert_eq!((p.skipped, p.coalesced), (0, 0));
    assert_eq!(
        (p.first_due_ms, p.last_due_ms),
        (Some(60_000), Some(60_000))
    );
    assert!(p.coverage_known);
}
#[test]
fn no_due_slot_remains_idle() {
    let p = evaluate(Request {
        now_ms: 59_900,
        observation: Observation::Native {
            previous_ms: 59_000,
            same_opening: true,
            resumed: false,
        },
        ..request()
    })
    .unwrap();
    assert_eq!(p.disposition, Disposition::Idle);
    assert_eq!(p.due_ms, None);
    assert_eq!(p.cursor_ms, 0);
    assert_eq!((p.first_due_ms, p.last_due_ms), (None, None));
}
#[test]
fn first_observation_skips_closed_interval_without_inventing_coverage() {
    let p = evaluate(Request {
        now_ms: 600_500,
        observation: Observation::Unknown,
        ..request()
    })
    .unwrap();
    assert_eq!(p.due_ms, None);
    assert_eq!(p.cursor_ms, 600_000);
    assert_eq!(p.skipped, 10);
    assert_eq!(p.first_due_ms, Some(60_000));
    assert_eq!(p.last_due_ms, Some(600_000));
    assert!(!p.coverage_known);
}
#[test]
fn resumed_process_does_not_treat_a_short_clock_gap_as_awake() {
    let p = evaluate(Request {
        observation: Observation::Native {
            previous_ms: 59_500,
            same_opening: true,
            resumed: true,
        },
        ..request()
    })
    .unwrap();
    assert_eq!(p.due_ms, None);
    assert_eq!(p.skipped, 1);
    assert!(!p.coverage_known);
}
#[test]
fn replacement_opening_does_not_reuse_previous_coverage() {
    let p = evaluate(Request {
        observation: Observation::Native {
            previous_ms: 59_500,
            same_opening: false,
            resumed: false,
        },
        ..request()
    })
    .unwrap();
    assert_eq!(p.due_ms, None);
    assert_eq!(p.skipped, 1);
    assert!(!p.coverage_known);
}
#[test]
fn long_poll_gap_is_unknown_coverage() {
    let p = evaluate(Request {
        observation: Observation::Native {
            previous_ms: 55_499,
            same_opening: true,
            resumed: false,
        },
        ..request()
    })
    .unwrap();
    assert_eq!(p.due_ms, None);
    assert_eq!(p.skipped, 1);
    assert!(!p.coverage_known);
}
#[test]
fn observation_gap_at_shared_bound_is_continuous() {
    let p = evaluate(Request {
        observation: Observation::Native {
            previous_ms: 55_500,
            same_opening: true,
            resumed: false,
        },
        ..request()
    })
    .unwrap();
    assert_eq!(p.due_ms, Some(60_000));
    assert!(p.coverage_known);
}
#[test]
fn already_missed_slots_skip_but_current_awake_slot_can_run() {
    let p = evaluate(Request {
        now_ms: 600_500,
        observation: Observation::Native {
            previous_ms: 599_500,
            same_opening: true,
            resumed: false,
        },
        ..request()
    })
    .unwrap();
    assert_eq!(p.due_ms, Some(600_000));
    assert_eq!(p.skipped, 9);
    assert_eq!(p.cursor_ms, 600_000);
}
#[test]
fn coalesce_emits_only_latest_missed_slot() {
    let p = evaluate(Request {
        now_ms: 600_500,
        observation: Observation::Unknown,
        catch_up: CatchUp::CoalesceLatest,
        ..request()
    })
    .unwrap();
    assert_eq!(p.due_ms, Some(600_000));
    assert_eq!((p.skipped, p.coalesced), (0, 9));
    assert!(!p.coverage_known);
}
#[test]
fn coalesce_skips_slots_outside_the_exclusive_24_hour_window() {
    let p = evaluate(Request {
        now_ms: 259_200_001,
        interval_seconds: 3600,
        observation: Observation::Unknown,
        catch_up: CatchUp::CoalesceLatest,
        ..request()
    })
    .unwrap();
    assert_eq!(p.due_ms, Some(259_200_000));
    assert_eq!((p.skipped, p.coalesced), (48, 23));
    assert_eq!(p.cursor_ms, 259_200_000);
}
#[test]
fn coalesce_cannot_run_a_latest_slot_older_than_24_hours() {
    let p = evaluate(Request {
        now_ms: 777_600_000,
        interval_seconds: 604_800,
        observation: Observation::Unknown,
        catch_up: CatchUp::CoalesceLatest,
        ..request()
    })
    .unwrap();
    assert_eq!(p.due_ms, None);
    assert_eq!(p.skipped, 1);
    assert_eq!(p.cursor_ms, 604_800_000);
}
#[test]
fn backwards_clock_never_moves_persisted_cursor_back() {
    let p = evaluate(Request {
        cursor_ms: 120_000,
        now_ms: 60_500,
        ..request()
    })
    .unwrap();
    assert_eq!(p.disposition, Disposition::ClockBackwards);
    assert_eq!(p.due_ms, None);
    assert_eq!(p.cursor_ms, 120_000);
    assert_eq!((p.skipped, p.coalesced), (0, 0));
}
#[test]
fn paused_plan_never_claims_or_advances() {
    let p = evaluate(Request {
        enabled: false,
        ..request()
    })
    .unwrap();
    assert_eq!(p.disposition, Disposition::Paused);
    assert_eq!(p.due_ms, None);
    assert_eq!(p.cursor_ms, 0);
}
#[test]
fn unavailable_readiness_keeps_occurrences_unclaimed() {
    let p = evaluate(Request {
        ready: false,
        ..request()
    })
    .unwrap();
    assert_eq!(p.disposition, Disposition::NotReady);
    assert_eq!(p.due_ms, None);
    assert_eq!(p.cursor_ms, 0);
}
#[test]
fn recovery_hold_dominates_ready_enabled_state() {
    let p = evaluate(Request {
        recovery_held: true,
        ..request()
    })
    .unwrap();
    assert_eq!(p.disposition, Disposition::RecoveryHeld);
    assert_eq!(p.due_ms, None);
    assert_eq!(p.cursor_ms, 0);
}
#[test]
fn reenable_anchor_excludes_every_slot_from_the_paused_epoch() {
    let p = evaluate(Request {
        anchor_ms: 600_500,
        cursor_ms: 600_500,
        now_ms: 660_500,
        observation: Observation::Native {
            previous_ms: 659_500,
            same_opening: true,
            resumed: false,
        },
        ..request()
    })
    .unwrap();
    assert_eq!(p.due_ms, Some(660_500));
    assert_eq!(p.first_due_ms, Some(660_500));
    assert_eq!((p.skipped, p.coalesced), (0, 0));
}
#[test]
fn observed_cursor_prevents_duplicate_tick() {
    let first = evaluate(request()).unwrap();
    let second = evaluate(Request {
        cursor_ms: first.cursor_ms,
        ..request()
    })
    .unwrap();
    assert_eq!(second.disposition, Disposition::Idle);
    assert_eq!(second.due_ms, None);
    assert_eq!(second.cursor_ms, 60_000);
}
#[test]
fn preview_is_repeatable_without_mutating_input_or_booking_anything() {
    let input = request();
    let first = evaluate(input).unwrap();
    let again = evaluate(input).unwrap();
    assert_eq!(first, again);
    assert_eq!(input.cursor_ms, 0);
}
#[test]
fn interval_outside_actual_shared_definition_bounds_is_refused() {
    assert_eq!(
        evaluate(Request {
            interval_seconds: 59,
            ..request()
        }),
        Err(Error::Invalid)
    );
    assert_eq!(
        evaluate(Request {
            interval_seconds: 31_536_001,
            ..request()
        }),
        Err(Error::Invalid)
    );
}
#[test]
fn cursor_from_another_interval_grid_is_refused() {
    assert_eq!(
        evaluate(Request {
            cursor_ms: 1,
            ..request()
        }),
        Err(Error::Invalid)
    );
}
#[test]
fn future_prior_observation_is_unknown_not_fabricated_awake() {
    let p = evaluate(Request {
        observation: Observation::Native {
            previous_ms: 70_000,
            same_opening: true,
            resumed: false,
        },
        ..request()
    })
    .unwrap();
    assert!(!p.coverage_known);
    assert_eq!(p.due_ms, None);
    assert_eq!(p.skipped, 1);
}
#[test]
fn negative_or_unrepresentable_clock_is_refused() {
    assert_eq!(
        evaluate(Request {
            now_ms: -1,
            ..request()
        }),
        Err(Error::Invalid)
    );
    assert_eq!(
        evaluate(Request {
            now_ms: i64::MAX,
            ..request()
        }),
        Err(Error::Invalid)
    );
}
