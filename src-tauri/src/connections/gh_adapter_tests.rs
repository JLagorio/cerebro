//! Synthetic adapter orchestration only; never launches gh or reads accounts.
use super::*;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::ffi::OsString;

const HELP: &[u8] = b"USAGE\n  gh auth token [flags]\n\nFLAGS\n  -h, --hostname string  The hostname\n  -u, --user string      The selected login\n      --no-refresh       Do not refresh\n";

fn context() -> GhNativeContext {
    GhNativeContext {
        executable: ExecutablePin {
            canonical: PathBuf::from("/private/tmp/cerebro-gh-adapter/gh"),
            device: 1,
            inode: 2,
            bytes: 3,
            modified_seconds: 4,
            modified_nanos: 5,
        },
        native_home: PathBuf::from("/private/tmp/cerebro-gh-adapter/home"),
        neutral_cwd: PathBuf::from("/"),
    }
}
fn recipe() -> GhTokenCommand {
    GhTokenCommand {
        program: "gh",
        args: ["auth", "token", "--hostname", "github.com", "--user", "alice", "--no-refresh"]
            .into_iter().map(str::to_owned).collect(),
        clear_environment: true,
        environment: RECIPE_ENVIRONMENT.to_vec(),
        timeout_ms: CAPTURE_TIMEOUT_MS,
        output_limit: PRIVATE_OUTPUT_LIMIT,
    }
}
struct Executor {
    replies: RefCell<VecDeque<Result<Vec<u8>, ConnectionError>>>,
    launches: RefCell<Vec<Vec<OsString>>>,
    homes: RefCell<Vec<Option<OsString>>>,
    checks: Cell<usize>,
    refuse_check: usize,
    cancel_after_capture: usize,
    cancelled: Cell<bool>,
}
impl Executor {
    fn new(replies: Vec<Result<Vec<u8>, ConnectionError>>) -> Self {
        Self {
            replies: RefCell::new(replies.into()),
            launches: RefCell::new(Vec::new()),
            homes: RefCell::new(Vec::new()),
            checks: Cell::new(0),
            refuse_check: 0,
            cancel_after_capture: 0,
            cancelled: Cell::new(false),
        }
    }
    fn run(&self) -> Result<SecretValue, ConnectionError> {
        capture_selected(&context(), Path::new("/private/tmp/cerebro-gh-adapter/empty"),
            &recipe(), self, &|| self.cancelled.get())
    }
}
impl GhExecutor for Executor {
    fn revalidate(&self, _: &GhNativeContext) -> Result<(), ConnectionError> {
        let count = self.checks.get() + 1;
        self.checks.set(count);
        if count == self.refuse_check { Err(ConnectionError::SourceChanged) } else { Ok(()) }
    }
    fn capture(&self, command: &mut Command, _: &dyn Fn() -> bool) -> Result<PrivateOutput, ConnectionError> {
        self.launches.borrow_mut().push(command.get_args().map(OsString::from).collect());
        self.homes.borrow_mut().push(command.get_envs().find_map(|(key, value)| {
            (key == "HOME").then(|| value.map(OsString::from)).flatten()
        }));
        if self.launches.borrow().len() == self.cancel_after_capture {
            self.cancelled.set(true);
        }
        self.replies.borrow_mut().pop_front().expect("no extra subprocess")
            .map(PrivateOutput::synthetic)
    }
}
#[test]
fn selected_acquisition_checks_help_then_launches_only_the_fixed_login_recipe() {
    let executor = Executor::new(vec![Ok(HELP.to_vec()), Ok(b"sentinel-secret\n".to_vec())]);
    let secret = executor.run().unwrap();
    assert_eq!(secret.expose(), b"sentinel-secret");
    let launches = executor.launches.borrow();
    assert_eq!(launches.len(), 2);
    assert_eq!(launches[0], ["auth", "token", "--help"].map(OsString::from));
    assert_eq!(launches[1], recipe().args.iter().map(OsString::from).collect::<Vec<_>>());
    assert_eq!(executor.homes.borrow()[0], Some(OsString::from("/private/tmp/cerebro-gh-adapter/empty")));
    assert_eq!(executor.homes.borrow()[1], Some(context().native_home.into_os_string()));
    assert!(executor.checks.get() >= 2);
}
#[test]
fn unsupported_help_never_attempts_token_or_weaker_flags() {
    let executor = Executor::new(vec![Ok(b"FLAGS\n  -h, --hostname string  host\n  -u, --user string  login\n".to_vec())]);
    assert_eq!(executor.run().err(), Some(ConnectionError::Unsupported));
    assert_eq!(executor.launches.borrow().len(), 1);
}
#[test]
fn changed_native_source_between_help_and_token_refuses_token_launch() {
    let mut executor = Executor::new(vec![Ok(HELP.to_vec())]);
    executor.refuse_check = 2;
    assert_eq!(executor.run().err(), Some(ConnectionError::SourceChanged));
    assert_eq!(executor.launches.borrow().len(), 1);
}
#[test]
fn cancelled_before_acquisition_launches_nothing() {
    let executor = Executor::new(vec![]);
    executor.cancelled.set(true);
    assert_eq!(executor.run().err(), Some(ConnectionError::Cancelled));
    assert!(executor.launches.borrow().is_empty());
}
#[test]
fn cancellation_after_help_or_token_discards_private_success() {
    for stage in [1, 2] {
        let mut executor = Executor::new(vec![Ok(HELP.to_vec()), Ok(b"sentinel-secret".to_vec())]);
        executor.cancel_after_capture = stage;
        assert_eq!(executor.run().err(), Some(ConnectionError::Cancelled));
        assert_eq!(executor.launches.borrow().len(), stage);
    }
}
#[test]
fn channel_failure_is_returned_without_retry_or_secret_conversion() {
    let executor = Executor::new(vec![Ok(HELP.to_vec()), Err(ConnectionError::Unavailable)]);
    assert_eq!(executor.run().err(), Some(ConnectionError::Unavailable));
    assert_eq!(executor.launches.borrow().len(), 2);
}
#[test]
fn malformed_selected_token_is_rejected_without_fallback() {
    let executor = Executor::new(vec![Ok(HELP.to_vec()), Ok(b"sentinel-secret\nsecond-line".to_vec())]);
    assert_eq!(executor.run().err(), Some(ConnectionError::Unavailable));
    assert_eq!(executor.launches.borrow().len(), 2);
}

#[test]
fn invalid_recipe_is_rejected_before_any_compatibility_or_token_launch() {
    let executor = Executor::new(vec![]);
    let mut invalid = recipe();
    invalid.args.pop();
    assert_eq!(capture_selected(&context(), Path::new("/private/tmp/cerebro-gh-adapter/empty"),
        &invalid, &executor, &|| false).err(), Some(ConnectionError::InvalidSelection));
    assert!(executor.launches.borrow().is_empty());
}
#[test]
fn changed_native_source_after_capture_discards_the_token() {
    let mut executor = Executor::new(vec![Ok(HELP.to_vec()), Ok(b"sentinel-secret".to_vec())]);
    executor.refuse_check = 3;
    assert_eq!(executor.run().err(), Some(ConnectionError::SourceChanged));
    assert_eq!(executor.launches.borrow().len(), 2);
}
#[test]
fn help_capture_failure_has_no_token_retry() {
    let executor = Executor::new(vec![Err(ConnectionError::Unavailable)]);
    assert_eq!(executor.run().err(), Some(ConnectionError::Unavailable));
    assert_eq!(executor.launches.borrow().len(), 1);
}
