//! Ignored, root-owned native acceptance. N0 is expected to fail at acquisition.
//! A libtest pass alone cannot qualify the outer owner or prove child absence.
use super::*;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

const STARTUP: Duration = Duration::from_secs(3);
const LOCAL_OBSERVATION: Duration = Duration::from_secs(22);
const ABSENCE_OBSERVATION: Duration = Duration::from_secs(10);
const DOCUMENT_LIMIT: u64 = 8192;
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const PARENT_CONTROLS: &[&str] = &["GH_TOKEN", "GH_HOST", "GH_DEBUG", "HTTPS_PROXY"];

struct NativeCase {
    id: &'static str,
    scenario: &'static str,
    root: PathBuf,
    python: PathBuf,
    nonce: String,
    intent: String,
    owner: String,
}

fn configured(name: &str) -> String {
    std::env::var(name).expect("root must supply the reviewed synthetic native-test configuration")
}

fn hex_pin(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl NativeCase {
    fn new(id: &'static str, scenario: &'static str) -> Self {
        let case = Self {
            id,
            scenario,
            root: PathBuf::from(configured("M96_PRIVATE_TOY_ROOT")),
            python: PathBuf::from(configured("M96_PRIVATE_TOY_PYTHON")),
            nonce: configured("M96_PRIVATE_TOY_NONCE"),
            intent: configured("M96_PRIVATE_TOY_INTENT_SHA256"),
            owner: configured("M96_PRIVATE_TOY_OWNER_SHA256"),
        };
        assert!(
            case.root.is_absolute() && case.python.is_absolute(),
            "root must pin absolute paths"
        );
        assert!(
            hex_pin(&case.nonce) && hex_pin(&case.intent) && hex_pin(&case.owner),
            "root must pin the synthetic run identity"
        );
        case
    }

    fn command(&self) -> Command {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/private-output/toy.py");
        let mut command = crate::spawn::command(&self.python);
        command
            .args(["-I", "-S", "-B"])
            .arg(fixture)
            .arg(self.scenario)
            .arg(&self.root)
            .arg(&self.nonce)
            .current_dir(&self.root)
            .env_clear()
            .env("HOME", self.root.join("home"))
            .env("GH_CONFIG_DIR", self.root.join("config"))
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .env("M96_SYNTHETIC", "private-output-v1")
            .env("M96_PRIVATE_TOY_CASE", self.id)
            .env("M96_PRIVATE_TOY_INTENT_SHA256", &self.intent)
            .env("M96_PRIVATE_TOY_OWNER_SHA256", &self.owner)
            // Conflicting caller settings: the private launcher must override all three.
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        command
    }

    fn binding(&self, identity: AcquiredIdentity) -> serde_json::Value {
        serde_json::json!({
            "format": 1, "case": self.id, "scenario": self.scenario,
            "nonce": self.nonce, "pid": identity.pid, "pgid": identity.pgid,
            "intent_sha256": self.intent, "owner_sha256": self.owner,
        })
    }

    fn matches(&self, document: &serde_json::Value, identity: AcquiredIdentity) -> bool {
        let binding = self.binding(identity);
        binding.as_object().is_some_and(|fields| {
            fields
                .iter()
                .all(|(key, value)| document.get(key) == Some(value))
        })
    }

    fn publish_acquired(&self, identity: AcquiredIdentity) -> Result<(), TestSetupFailure> {
        let metadata = fs::symlink_metadata(&self.root).map_err(|_| TestSetupFailure::Refused)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o077 != 0
            || identity.pid <= 1
            || i32::try_from(identity.pid).ok() != Some(identity.pgid)
        {
            return Err(TestSetupFailure::Refused);
        }
        let bytes =
            serde_json::to_vec(&self.binding(identity)).map_err(|_| TestSetupFailure::Refused)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.root.join("rust-claim.json"))
            .map_err(|_| TestSetupFailure::Refused)?;
        file.write_all(&bytes)
            .map_err(|_| TestSetupFailure::Refused)
    }

    fn after_acquired(&self, identity: AcquiredIdentity) -> Result<(), TestSetupFailure> {
        self.publish_acquired(identity)?;
        let started = Instant::now();
        loop {
            let arm = read_document(&self.root.join("arm.json"));
            let ready = read_document(&self.root.join("ready.json"));
            if arm.as_ref().is_some_and(|value| {
                self.matches(value, identity)
                    && value.get("armed").and_then(serde_json::Value::as_bool) == Some(true)
                    && value
                        .get("root_bound_start")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|start| !start.is_empty() && start.len() <= 128)
            }) && ready.as_ref().is_some_and(|value| {
                self.matches(value, identity)
                    && value.get("ready").and_then(serde_json::Value::as_bool) == Some(true)
            }) {
                return Ok(());
            }
            if started.elapsed() >= STARTUP {
                return Err(TestSetupFailure::Refused);
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn assert_qualified_absence(&self, identity: AcquiredIdentity) {
        let arm = read_document(&self.root.join("arm.json"));
        assert!(
            arm.as_ref()
                .is_some_and(|value| self.matches(value, identity)),
            "a bound arm receipt must exist"
        );
        let start_identity = arm.as_ref().and_then(|value| value.get("root_bound_start"));
        let started = Instant::now();
        loop {
            if let Some(receipt) = read_document(&self.root.join("observed-absence.json")) {
                assert!(
                    self.matches(&receipt, identity),
                    "absence must bind this exact synthetic run"
                );
                assert!(
                    receipt.get("root_bound_start") == start_identity,
                    "absence must bind the armed start identity"
                );
                assert!(
                    receipt.get("absent").and_then(serde_json::Value::as_bool) == Some(true),
                    "unknown identity is not absence"
                );
                assert!(
                    receipt
                        .get("qualified_observations")
                        .and_then(serde_json::Value::as_u64)
                        .is_some_and(|count| count >= 2),
                    "two qualified observations are required"
                );
                return;
            }
            assert!(
                started.elapsed() < ABSENCE_OBSERVATION,
                "outer absence evidence is unavailable"
            );
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

fn read_document(path: &Path) -> Option<serde_json::Value> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > DOCUMENT_LIMIT {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(DOCUMENT_LIMIT + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > DOCUMENT_LIMIT {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn acquire(case: &NativeCase, setup_refusal: bool) -> (PrivateCapture, Arc<Mutex<NativeWitness>>) {
    let witness = Arc::new(Mutex::new(NativeWitness::default()));
    let mut hook = |identity| {
        case.after_acquired(identity)?;
        if setup_refusal {
            Err(TestSetupFailure::Refused)
        } else {
            Ok(())
        }
    };
    let result =
        start_private_output_for_test(&mut case.command(), Arc::clone(&witness), &mut hook);
    // N0's only credited RED: do not format Result<PrivateOutput> or a private buffer.
    assert!(
        result.is_ok(),
        "valid toy command must acquire a PrivateCapture"
    );
    let capture = match result {
        Ok(capture) => capture,
        Err(_) => unreachable!(),
    };
    (capture, witness)
}

fn events(witness: &Arc<Mutex<NativeWitness>>) -> Vec<NativeEvent> {
    let witness = witness
        .lock()
        .expect("finite witness must remain available");
    assert!(
        !witness.overflowed,
        "native witness cannot silently truncate observations"
    );
    witness.events.clone()
}

fn acquired(witness: &Arc<Mutex<NativeWitness>>) -> AcquiredIdentity {
    let observations = events(witness);
    let identities: Vec<_> = observations
        .iter()
        .filter_map(|event| match event {
            NativeEvent::Acquired(identity) => Some(*identity),
            _ => None,
        })
        .collect();
    assert_eq!(
        identities.len(),
        1,
        "exactly one actual Child may be acquired"
    );
    identities[0]
}

fn assert_reaped(witness: &Arc<Mutex<NativeWitness>>, killed: bool) {
    let observations = events(witness);
    let statuses: Vec<_> = observations
        .iter()
        .filter_map(|event| match event {
            NativeEvent::Reaped(status) => Some(*status),
            _ => None,
        })
        .collect();
    assert_eq!(
        statuses.len(),
        1,
        "actual native wait must reap exactly once"
    );
    if killed {
        assert_eq!(
            statuses[0].signal(),
            Some(libc::SIGKILL),
            "fixture alarm or self-exit cannot stand in for owned cleanup"
        );
    } else {
        assert!(
            statuses[0].success(),
            "the exact-cap leader must exit successfully"
        );
    }
    assert!(
        observations
            .iter()
            .any(|event| matches!(event, NativeEvent::GroupObserved(GroupAbsence::Absent))),
        "actual group probe must record absence"
    );
    for signal in [GroupSignal::Term, GroupSignal::Kill] {
        let dispositions: Vec<_> = observations
            .iter()
            .filter_map(|event| match event {
                NativeEvent::Signal(observed, disposition) if *observed == signal => {
                    Some(*disposition)
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            dispositions.len(),
            1,
            "each cleanup signal has one real disposition"
        );
        assert!(
            matches!(
                dispositions[0],
                GroupSignalDisposition::Sent | GroupSignalDisposition::AlreadyAbsent
            ),
            "signal refusal must remain a failure"
        );
    }
}

fn finish(
    capture: &mut PrivateCapture,
    witness: &Arc<Mutex<NativeWitness>>,
    cancel: bool,
) -> Result<PrivateOutput, PrivateFailure> {
    let started = Instant::now();
    loop {
        let state = capture.poll(cancel);
        if state == CapturePoll::Finished {
            assert!(
                events(witness)
                    .iter()
                    .any(|event| matches!(event, NativeEvent::Reaped(_))),
                "Finished cannot precede actual native reap"
            );
            let result = capture
                .take_result()
                .expect("one private result must be available");
            assert!(
                capture.take_result().is_none(),
                "private result is consumed once"
            );
            let count = events(witness).len();
            assert_eq!(capture.poll(false), CapturePoll::Finished);
            assert_eq!(
                events(witness).len(),
                count,
                "finished capture does no more native work"
            );
            assert_eq!(
                capture.retained_len(),
                0,
                "no private bytes remain in the capture"
            );
            return result;
        }
        assert!(
            capture.take_result().is_none(),
            "pending or reaping capture cannot release a result"
        );
        assert!(
            started.elapsed() < LOCAL_OBSERVATION,
            "local observation exhausted; Drop and outer owner still own cleanup"
        );
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn assert_failure(result: Result<PrivateOutput, PrivateFailure>, expected: FailureKind) {
    let failure = match result {
        Err(failure) => failure,
        Ok(_) => panic!("a refused capture must not return private bytes"),
    };
    assert_eq!(failure.kind, expected);
    assert_eq!(failure.cleanup.child, ChildOwnership::Reaped);
    assert_eq!(failure.cleanup.group, GroupAbsence::Absent);
    assert!(matches!(
        failure.cleanup.term,
        GroupSignalDisposition::Sent | GroupSignalDisposition::AlreadyAbsent
    ));
    assert!(matches!(
        failure.cleanup.kill,
        GroupSignalDisposition::Sent | GroupSignalDisposition::AlreadyAbsent
    ));
}

#[test]
#[ignore = "root-owned synthetic child only; reviewed intent and separate-group owner required"]
fn m96_private_child_native_exact_cap_discards_stderr_and_clears_env() {
    let case = NativeCase::new("N01", "exact-cap-stderr-env");
    let (mut capture, witness) = acquire(&case, false);
    assert!(
        PARENT_CONTROLS
            .iter()
            .all(|name| std::env::var(name).ok().as_deref() == Some("m96-synthetic-forbidden")),
        "parent must supply the deliberate synthetic inheritance controls"
    );
    let identity = acquired(&witness);
    let ready =
        read_document(&case.root.join("ready.json")).expect("bounded toy readiness must exist");
    assert!(case.matches(&ready, identity));
    for key in [
        "stdin_eof",
        "stdin_null",
        "stderr_null",
        "stdout_pipe",
        "environment_exact",
        "forbidden_absent",
    ] {
        assert!(
            ready.get(key).and_then(serde_json::Value::as_bool) == Some(true),
            "toy stdio/environment contract failed"
        );
    }
    let observations = events(&witness);
    assert!(observations
        .iter()
        .any(|event| matches!(event, NativeEvent::StdioReady)));
    assert!(observations
        .iter()
        .any(|event| matches!(event, NativeEvent::NonblockingReady)));
    let result = finish(&mut capture, &witness, false);
    let output = match result {
        Ok(output) => output,
        Err(_) => panic!("exact-cap capture must succeed"),
    };
    assert!(
        output.as_bytes().len() == PRIVATE_OUTPUT_LIMIT
            && output.as_bytes().iter().all(|byte| *byte == b'Q'),
        "only the exact synthetic stdout may be returned"
    );
    drop(output);
    assert_reaped(&witness, false);
    case.assert_qualified_absence(identity);
}

#[test]
#[ignore = "root-owned synthetic child only; reviewed intent and separate-group owner required"]
fn m96_private_child_native_overflow_reaps_leader() {
    let case = NativeCase::new("N02", "overflow-live");
    let (mut capture, witness) = acquire(&case, false);
    let identity = acquired(&witness);
    assert_failure(
        finish(&mut capture, &witness, false),
        FailureKind::OutputLimit,
    );
    assert_reaped(&witness, true);
    case.assert_qualified_absence(identity);
}

#[test]
#[ignore = "root-owned synthetic child only; real 15-second capture budget"]
fn m96_private_child_native_eof_deadline_reaps_leader() {
    let case = NativeCase::new("N03", "eof-live");
    let before_start = Instant::now();
    let (mut capture, witness) = acquire(&case, false);
    let identity = acquired(&witness);
    let observe_eof = Instant::now();
    loop {
        assert_eq!(
            capture.poll(false),
            CapturePoll::Pending,
            "EOF without a child exit must remain pending"
        );
        assert!(capture.take_result().is_none());
        let observations = events(&witness);
        assert!(!observations
            .iter()
            .any(|event| matches!(event, NativeEvent::Reaped(_))));
        if observations
            .iter()
            .any(|event| matches!(event, NativeEvent::StdoutEof))
        {
            break;
        }
        assert!(
            observe_eof.elapsed() < STARTUP,
            "actual EOF was not observed"
        );
        std::thread::sleep(POLL_INTERVAL);
    }
    assert_failure(finish(&mut capture, &witness, false), FailureKind::TimedOut);
    assert!(
        before_start.elapsed() >= Duration::from_millis(CAPTURE_TIMEOUT_MS),
        "the real capture budget cannot be shortened"
    );
    assert_reaped(&witness, true);
    case.assert_qualified_absence(identity);
}

#[test]
#[ignore = "root-owned synthetic child only; reviewed intent and separate-group owner required"]
fn m96_private_child_native_cancel_reaps_leader() {
    let case = NativeCase::new("N04", "live");
    let (mut capture, witness) = acquire(&case, false);
    let identity = acquired(&witness);
    assert_eq!(
        capture.poll(false),
        CapturePoll::Pending,
        "armed leader must be live before cancellation"
    );
    assert!(capture.take_result().is_none());
    assert_failure(finish(&mut capture, &witness, true), FailureKind::Cancelled);
    assert_reaped(&witness, true);
    case.assert_qualified_absence(identity);
}

#[test]
#[ignore = "real acquired child with injected setup refusal; outer owner required"]
fn m96_private_child_native_setup_refusal_retains_owner() {
    let case = NativeCase::new("N05", "live");
    let (mut capture, witness) = acquire(&case, true);
    let identity = acquired(&witness);
    assert!(
        capture.take_result().is_none(),
        "post-acquisition refusal must retain ownership before polling"
    );
    assert!(
        !events(&witness)
            .iter()
            .any(|event| matches!(event, NativeEvent::Reaped(_))),
        "setup refusal must not fabricate a reap"
    );
    assert_failure(finish(&mut capture, &witness, false), FailureKind::Pipe);
    assert_reaped(&witness, true);
    case.assert_qualified_absence(identity);
}

#[test]
#[ignore = "synchronous Drop with real child; independent outer cleanup owner required"]
fn m96_private_child_native_drop_reaps_leader() {
    let case = NativeCase::new("N06", "live");
    let (capture, witness) = acquire(&case, false);
    let identity = acquired(&witness);
    assert!(!events(&witness)
        .iter()
        .any(|event| matches!(event, NativeEvent::Reaped(_))));
    drop(capture);
    assert_reaped(&witness, true);
    case.assert_qualified_absence(identity);
}

#[test]
#[ignore = "root-only native spawn-refusal controls; N0 generic refusal is not native evidence"]
fn m96_private_child_native_preacquisition_failures_are_finite() {
    let case = NativeCase::new("N07", "no-successful-child");
    let missing = case.root.join("must-not-exist-executable");
    assert!(
        fs::symlink_metadata(&missing)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
        "root must reserve an absent executable path"
    );
    for (program, kind) in [
        (
            PathBuf::from("relative-python"),
            FailureKind::InvalidCommand,
        ),
        (missing, FailureKind::Spawn),
    ] {
        let result = start_private_output(&mut crate::spawn::command(program));
        let failure = match result {
            Err(failure) => failure,
            Ok(_) => panic!("invalid command cannot acquire a capture"),
        };
        assert_eq!(
            failure,
            PrivateFailure {
                kind,
                cleanup: CleanupFacts {
                    child: ChildOwnership::NotAcquired,
                    term: GroupSignalDisposition::NotAttempted,
                    kill: GroupSignalDisposition::NotAttempted,
                    group: GroupAbsence::NotChecked,
                }
            }
        );
    }
}
