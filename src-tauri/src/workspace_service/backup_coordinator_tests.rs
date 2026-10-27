use super::*;
use std::{sync::atomic::AtomicUsize, time::Duration};

fn registration(app: &Arc<AppSlot>, number: usize) -> Arc<Registration> {
    Arc::new(Registration { app: app.clone(), identity: WindowIdentity { window: number, view: number + 100, label: crate::shell::MAIN_WINDOW.into() }, origin: PathBuf::from("/synthetic-cerebro-origin"), origin_pin: None, live: AtomicBool::new(true), book: Mutex::new(Book::Idle) })
}
fn observation(window: &Arc<Registration>) -> WindowObservation {
    WindowObservation { registration: window.clone(), injected: window.identity.clone(), current: window.identity.clone(), origin: window.origin.clone(), allowed_entry: true }
}
fn proof(window: &Arc<Registration>) -> WindowProof { authenticate(window, observation(window)).unwrap() }
fn resource() -> Arc<AtomicUsize> { Arc::new(AtomicUsize::new(0)) }
fn choice(mode: Mode, dropped: &Arc<AtomicUsize>) -> Choice { Choice::Fixture { mode, resource: ChoiceResource(dropped.clone()) } }
fn instant() -> Instant { Instant::now().checked_add(Duration::from_secs(120)).unwrap() }
fn seed_pending(window: &Arc<Registration>, mode: Mode, expires: Instant, dropped: &Arc<AtomicUsize>) -> Review {
    let review = Review { operation: "00000000000000000000000000000003".into(), token: "00000000000000000000000000000001".into(), mode, labels: WorkspaceBackupLabels::default(), summary: None, expires_at: None };
    *window.book.lock().unwrap() = Book::Pending(Pending { review: review.clone(), expires, choice: choice(mode, dropped), slot: window.app.acquire().unwrap() });
    review
}
fn seed_choosing(window: &Arc<Registration>, mode: Mode) -> ChoosingWork {
    let operation = "00000000000000000000000000000004".to_owned();
    *window.book.lock().unwrap() = Book::Choosing { operation: operation.clone(), mode, labels: WorkspaceBackupLabels::default() };
    ChoosingWork { registration: window.clone(), operation, mode, labels: WorkspaceBackupLabels::default(), input: Some(ChoosingInput::Fixture { mode, retained: None }), slot: Some(window.app.acquire().unwrap()), finished: false }
}
fn seed_running(window: &Arc<Registration>, dropped: &Arc<AtomicUsize>) -> RunningWork {
    let operation = "00000000000000000000000000000005".to_owned();
    let token = "00000000000000000000000000000002".to_owned();
    *window.book.lock().unwrap() = Book::Running { operation: operation.clone(), token: token.clone(), mode: Mode::Restore, labels: WorkspaceBackupLabels::default() };
    RunningWork { registration: window.clone(), operation, token, mode: Mode::Restore, labels: WorkspaceBackupLabels::default(), choice: Some(choice(Mode::Restore, dropped)), began: false, finished: false, real_kernel: false, progress: None, slot: Some(window.app.acquire().unwrap()) }
}
fn refused<T>(result: Result<T, Refusal>, expected: Refusal) { assert_eq!(result.err(), Some(expected)); }
fn assert_pending(window: &Registration, token: &str) {
    let book = window.book.lock().unwrap();
    assert!(matches!(&*book, Book::Pending(pending) if pending.review.token == token));
}

#[test]
fn authentic_original_window_is_a_scalar_observation_control() {
    let app = AppSlot::new(); let window = registration(&app, 1);
    assert!(authenticate(&window, observation(&window)).is_ok());
}

#[test]
fn wrong_native_observations_refuse_without_consuming_rightful_pending() {
    let app = AppSlot::new(); let window = registration(&app, 1); let different = registration(&app, 2);
    let dropped = resource(); let review = seed_pending(&window, Mode::Check, instant(), &dropped);
    for case in 0..6 {
        let mut observed = observation(&window);
        match case {
            0 => observed.registration = different.clone(),
            1 => observed.injected.window += 1,
            2 => observed.current.view += 1,
            3 => observed.origin = PathBuf::from("/other-synthetic-origin"),
            4 => observed.allowed_entry = false,
            5 => observed.current.label = "main-again".into(),
            _ => unreachable!(),
        }
        refused(authenticate(&window, observed), Refusal::WrongWindow);
        assert_pending(&window, &review.token);
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn production_book_admits_one_check_before_its_callback_can_run() {
    let app = AppSlot::new(); let window = registration(&app, 1);
    let work = proof(&window).begin_check().unwrap();
    assert!(app.occupied.load(Ordering::SeqCst));
    assert!(matches!(&*window.book.lock().unwrap(), Book::Choosing { mode: Mode::Check, .. }));
    refused(proof(&window).begin_check(), Refusal::Busy);
    drop(work);
    assert!(!app.occupied.load(Ordering::SeqCst));
    assert!(matches!(&*window.book.lock().unwrap(), Book::Idle));
}

#[test]
fn occupied_chooser_refuses_a_second_schedule_before_any_callback() {
    let app = AppSlot::new(); let window = registration(&app, 1);
    let original = seed_choosing(&window, Mode::Check);
    refused(proof(&window).begin_check(), Refusal::Busy);
    assert!(app.occupied.load(Ordering::SeqCst));
    drop(original);
}

#[test]
fn picker_cancellation_releases_only_its_own_slot_without_a_pending_choice() {
    let app = AppSlot::new(); let window = registration(&app, 1);
    let chooser = seed_choosing(&window, Mode::Check);
    assert_eq!(chooser.complete(instant, || Ok(None)).unwrap(), None);
    assert!(matches!(&*window.book.lock().unwrap(), Book::Idle));
    assert!(!app.occupied.load(Ordering::SeqCst));
}

#[test]
fn pending_expiry_drops_original_choice_before_new_work_can_start() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource(); let now = instant();
    let review = seed_pending(&window, Mode::Create, now, &dropped);
    refused(proof(&window).commit(&review.token, Mode::Create, now), Refusal::ExpiredChoice);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(!app.occupied.load(Ordering::SeqCst));
    assert!(matches!(&*window.book.lock().unwrap(), Book::Terminal { outcome: Terminal::Refused { reason: Refusal::ExpiredChoice, none_created: true }, .. }));
}

#[test]
fn wrong_mode_and_random_token_never_consume_rightful_pending() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource();
    let review = seed_pending(&window, Mode::Create, instant(), &dropped);
    refused(proof(&window).commit(&review.token, Mode::Restore, Instant::now()), Refusal::WrongMode);
    refused(proof(&window).commit("ffffffffffffffffffffffffffffffff", Mode::Create, Instant::now()), Refusal::InvalidChoice);
    refused(proof(&window).cancel("ffffffffffffffffffffffffffffffff", Instant::now()), Refusal::InvalidChoice);
    assert_pending(&window, &review.token); assert_eq!(dropped.load(Ordering::SeqCst), 0);
}

#[test]
fn exact_cancel_releases_matching_pending_resource_and_global_slot() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource();
    let review = seed_pending(&window, Mode::Check, instant(), &dropped);
    assert_eq!(proof(&window).cancel(&review.token, Instant::now()).unwrap(), Status::Idle);
    assert_eq!(dropped.load(Ordering::SeqCst), 1); assert!(!app.occupied.load(Ordering::SeqCst));
}

#[test]
fn choose_restore_consumes_checked_token_and_retains_original_input_until_callback_settles() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource();
    let review = seed_pending(&window, Mode::Check, instant(), &dropped);
    let chooser = proof(&window).choose_restore(&review.token, Instant::now()).unwrap();
    assert!(matches!(&*window.book.lock().unwrap(), Book::Choosing { mode: Mode::Restore, .. }));
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    refused(proof(&window).commit(&review.token, Mode::Restore, Instant::now()), Refusal::InvalidChoice);
    drop(chooser);
    assert_eq!(dropped.load(Ordering::SeqCst), 1); assert!(!app.occupied.load(Ordering::SeqCst));
}

#[test]
fn concurrent_duplicate_commit_produces_exactly_one_owned_copy() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource();
    let review = seed_pending(&window, Mode::Create, instant(), &dropped);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let mut threads = Vec::new();
    for _ in 0..2 {
        let window = window.clone(); let token = review.token.clone(); let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || { barrier.wait(); proof(&window).commit(&token, Mode::Create, Instant::now()) }));
    }
    let mut started = Vec::new(); let mut observed = 0;
    for thread in threads { match thread.join().unwrap() {
        Ok(Commit::Started(work)) => started.push(work),
        Ok(Commit::AlreadyStarted(Status::Running { .. })) => observed += 1,
        other => panic!("unexpected duplicate commit classification: {:?}", other.err()),
    }}
    assert_eq!(started.len(), 1); assert_eq!(observed, 1);
    let calls = AtomicUsize::new(0);
    started.pop().unwrap().execute(|_, gate| { gate.check()?; calls.fetch_add(1, Ordering::SeqCst); Ok(()) }).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1); assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(matches!(proof(&window).commit(&review.token, Mode::Create, Instant::now()).unwrap(), Commit::AlreadyStarted(Status::Terminal { outcome: Terminal::Completed, .. })));
}

#[test]
fn retirement_before_gate_prevents_kernel_and_reports_no_created_output() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource();
    let copy = seed_running(&window, &dropped); window.retire(); let calls = AtomicUsize::new(0);
    refused(copy.execute(|_, _| { calls.fetch_add(1, Ordering::SeqCst); Ok(()) }), Refusal::WrongWindow);
    assert_eq!(calls.load(Ordering::SeqCst), 0); assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(matches!(&*window.book.lock().unwrap(), Book::Terminal { outcome: Terminal::Refused { reason: Refusal::WrongWindow, none_created: true }, .. }));
}

#[test]
fn recreated_window_is_busy_until_original_chooser_callback_actually_finishes() {
    let app = AppSlot::new(); let original = registration(&app, 1); let replacement = registration(&app, 2);
    let chooser = seed_choosing(&original, Mode::Check); let dropped = resource(); let callbacks = AtomicUsize::new(0);
    let result = chooser.complete(instant, || {
        callbacks.fetch_add(1, Ordering::SeqCst); original.retire();
        refused(proof(&replacement).begin_check(), Refusal::Busy);
        assert!(app.occupied.load(Ordering::SeqCst));
        Ok(Some(ChoiceCompletion { chosen: NativeChoice::Fixture(choice(Mode::Check, &dropped)), observation: observation(&original) }))
    });
    assert_eq!(callbacks.load(Ordering::SeqCst), 1); refused(result, Refusal::WrongWindow);
    assert_eq!(dropped.load(Ordering::SeqCst), 1); assert!(!app.occupied.load(Ordering::SeqCst));
    let next = proof(&replacement).begin_check().unwrap(); drop(next);
    assert!(matches!(&*original.book.lock().unwrap(), Book::Idle));
}

#[test]
fn recreated_window_is_busy_after_original_copy_gate_until_kernel_returns() {
    let app = AppSlot::new(); let original = registration(&app, 1); let replacement = registration(&app, 2); let dropped = resource();
    let copy = seed_running(&original, &dropped); let kernels = AtomicUsize::new(0);
    copy.execute(|_owned_choice, gate| {
        gate.check()?; kernels.fetch_add(1, Ordering::SeqCst); original.retire();
        refused(proof(&replacement).begin_check(), Refusal::Busy);
        assert!(app.occupied.load(Ordering::SeqCst)); assert_eq!(dropped.load(Ordering::SeqCst), 0);
        Ok(())
    }).unwrap();
    assert_eq!(kernels.load(Ordering::SeqCst), 1); assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(!app.occupied.load(Ordering::SeqCst));
    let next = proof(&replacement).begin_check().unwrap(); drop(next);
}

#[test]
fn failed_scheduling_releases_original_choice_before_its_terminal_slot() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource();
    let copy = seed_running(&window, &dropped); drop(copy);
    assert_eq!(dropped.load(Ordering::SeqCst), 1); assert!(!app.occupied.load(Ordering::SeqCst));
    assert!(matches!(&*window.book.lock().unwrap(), Book::Terminal { outcome: Terminal::Refused { reason: Refusal::Unavailable, none_created: true }, .. }));
}

#[test]
fn kernel_panic_is_unknown_and_does_not_leave_a_live_global_slot() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource(); let copy = seed_running(&window, &dropped);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        copy.execute(|_, gate| { gate.check()?; panic!("synthetic owned backup kernel panic"); })
    }));
    assert!(result.is_err(), "actual owned kernel was not called");
    assert_eq!(dropped.load(Ordering::SeqCst), 1); assert!(!app.occupied.load(Ordering::SeqCst));
    assert!(matches!(&*window.book.lock().unwrap(), Book::Terminal { outcome: Terminal::Refused { reason: Refusal::UnknownOutcome, none_created: false }, .. }));
}

#[test]
fn status_reads_do_not_dispatch_or_consume_a_live_review() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource();
    let review = seed_pending(&window, Mode::Check, instant(), &dropped);
    for _ in 0..16 { assert_eq!(proof(&window).status(Instant::now()).unwrap(), Status::Pending(review.clone())); }
    assert_eq!(dropped.load(Ordering::SeqCst), 0); assert!(app.occupied.load(Ordering::SeqCst));
}

#[test]
fn retirement_releases_pending_resources_without_inheriting_old_tokens() {
    let app = AppSlot::new(); let original = registration(&app, 1); let dropped = resource();
    let review = seed_pending(&original, Mode::Check, instant(), &dropped); original.retire();
    assert_eq!(dropped.load(Ordering::SeqCst), 1); assert!(!app.occupied.load(Ordering::SeqCst));
    let replacement = registration(&app, 2);
    refused(proof(&replacement).cancel(&review.token, Instant::now()), Refusal::InvalidChoice);
    let next = proof(&replacement).begin_check().unwrap(); drop(next);
}

#[test]
fn successful_choice_starts_fresh_lease_only_after_native_callback_finishes() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource();
    let chooser = seed_choosing(&window, Mode::Check);
    let before_callback = instant();
    let finished_callback = before_callback.checked_add(Duration::from_secs(180)).unwrap();
    let now = std::cell::Cell::new(before_callback);
    let callback_done = std::cell::Cell::new(false);
    let clock_calls = std::cell::Cell::new(0);
    let review = chooser.complete(|| {
        assert!(callback_done.get(), "lease clock was sampled before native callback completion");
        clock_calls.set(clock_calls.get() + 1);
        now.get()
    }, || {
        now.set(finished_callback); callback_done.set(true);
        Ok(Some(ChoiceCompletion { chosen: NativeChoice::Fixture(choice(Mode::Check, &dropped)), observation: observation(&window) }))
    }).unwrap().unwrap();
    assert_eq!(clock_calls.get(), 1);
    let expires = match &*window.book.lock().unwrap() { Book::Pending(pending) => pending.expires, _ => panic!("choice was not published Pending") };
    let lease = Duration::from_secs(crate::workspace_service::backup_policy::rules().pending_lease_seconds);
    assert_eq!(expires, finished_callback.checked_add(lease).unwrap());
    assert_eq!(review.token.len(), 32);
    assert!(review.token.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    assert_eq!(dropped.load(Ordering::SeqCst), 0); assert!(app.occupied.load(Ordering::SeqCst));
    assert_eq!(proof(&window).status(finished_callback).unwrap(), Status::Pending(review.clone()));
    assert_eq!(proof(&window).cancel(&review.token, finished_callback).unwrap(), Status::Idle);
    assert_eq!(dropped.load(Ordering::SeqCst), 1); assert!(!app.occupied.load(Ordering::SeqCst));
}

#[test]
fn retired_chooser_never_opens_its_native_dialog_after_scheduling() {
    let app=AppSlot::new();let window=registration(&app,1);
    let chooser=seed_choosing(&window,Mode::Check);window.retire();
    let calls=AtomicUsize::new(0);
    let result=chooser.complete(instant,||{calls.fetch_add(1,Ordering::SeqCst);Ok(None)});
    refused(result,Refusal::WrongWindow);
    assert_eq!(calls.load(Ordering::SeqCst),0,"retired native registration must be checked before opening the chooser");
    assert!(!app.occupied.load(Ordering::SeqCst));
    assert!(matches!(&*window.book.lock().unwrap(),Book::Idle));
}

struct PinFixture { root: PathBuf, window: Arc<Registration> }
impl PinFixture {
    fn new() -> Self {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        let root = crate::vault::testutil::temp_vault("backup-original-owner-pin");
        let path = root.join("private"); std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let directory = std::fs::File::open(&path).unwrap(); let metadata = directory.metadata().unwrap();
        let pin = Arc::new(OriginPin { directory, path: path.clone(), device: metadata.dev(), inode: metadata.ino() });
        let window = Arc::new(Registration { app: AppSlot::new(), identity: WindowIdentity { window: 1, view: 101, label: crate::shell::MAIN_WINDOW.into() }, origin: path, origin_pin: Some(pin), live: AtomicBool::new(true), book: Mutex::new(Book::Idle) });
        Self { root, window }
    }
}
impl Drop for PinFixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }
#[test]
fn replaced_original_config_object_refuses_a_fresh_window_observation() {
    let fixture = PinFixture::new();
    assert!(authenticate(&fixture.window, observation(&fixture.window)).is_ok());
    std::fs::rename(&fixture.window.origin, fixture.root.join("retired-private")).unwrap();
    std::fs::create_dir(&fixture.window.origin).unwrap();
    let result = authenticate(&fixture.window, observation(&fixture.window));
    refused(result, Refusal::Unavailable);
    assert!(!fixture.window.app.occupied.load(Ordering::SeqCst));
}
#[test]
fn original_commit_gate_rechecks_private_config_permissions_after_authentication() {
    use std::os::unix::fs::PermissionsExt as _;
    let fixture = PinFixture::new(); let original = proof(&fixture.window);
    let gate = CommitWindow { registration: original.registration };
    std::fs::set_permissions(&fixture.window.origin, std::fs::Permissions::from_mode(0o777)).unwrap();
    let result = gate.check();
    std::fs::set_permissions(&fixture.window.origin, std::fs::Permissions::from_mode(0o700)).unwrap();
    refused(result, Refusal::Unavailable);
}
#[test]
fn completed_chooser_publishes_display_expiry_from_its_fresh_lease() {
    let app = AppSlot::new(); let window = registration(&app, 1); let dropped = resource();
    let chooser = seed_choosing(&window, Mode::Check);
    let review = chooser.complete(Instant::now, || Ok(Some(ChoiceCompletion { chosen: NativeChoice::Fixture(choice(Mode::Check, &dropped)), observation: observation(&window) }))).unwrap().unwrap();
    assert!(review.expires_at.as_ref().is_some_and(|value| value.parse::<u128>().is_ok()));
    assert_eq!(proof(&window).status(Instant::now()).unwrap(), Status::Pending(review.clone()));
    proof(&window).cancel(&review.token, Instant::now()).unwrap();
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}
#[test]
fn failed_choice_keeps_typed_cause_in_original_terminal_without_retaining_slot() {
    let app = AppSlot::new(); let window = registration(&app, 1);
    let chooser = seed_choosing(&window, Mode::Check);
    let error = crate::workspace_service::authority::error(crate::workspace_service::types::selected::AuthorityErrorKind::SourceChanged, "synthetic original source changed");
    let context = crate::workspace_service::authority::AuthorityContext::new(PathBuf::from("/synthetic-unused-choice-context"));
    let result = chooser.complete_bound(&context, Instant::now, || Err(KernelFailure::Authority(error.clone())));
    assert_eq!(result.err(), Some(KernelFailure::Authority(error.clone())));
    assert!(matches!(proof(&window).status(Instant::now()).unwrap(), Status::Terminal { mode: Mode::Check, outcome: Terminal::ChoiceRefused(KernelFailure::Authority(ref actual)), .. } if actual == &error));
    assert!(!app.occupied.load(Ordering::SeqCst));
}
