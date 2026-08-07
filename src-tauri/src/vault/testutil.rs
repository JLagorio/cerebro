//! Test-only helpers: build throwaway fixture vaults under the system temp dir.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Create a unique empty directory to use as a vault root. Callers remove it
/// with `std::fs::remove_dir_all` at the end of each test.
pub fn temp_vault(label: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("cerebro-test-{label}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp vault");
    dir
}

/// Write a file at a vault-relative path, creating parent directories.
pub fn write(vault: &Path, rel: &str, content: &str) {
    let path = vault.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent dir");
    }
    std::fs::write(path, content).expect("write fixture file");
}

/// Spawn the current test binary as a child running exactly one scenario
/// test with a crash point armed (M21 crash-injection harness — see
/// `crate::crash`). `scenario` is the FULL test path
/// (`module::path::test_name`); the child filters with `--exact`, so the
/// scenario must be `#[ignore]`d and read `CEREBRO_CRASH_VAULT` to find its
/// fixture. The caller asserts filesystem post-conditions afterwards.
pub fn run_crash_scenario(
    scenario: &str,
    crash_point: &str,
    vault: &Path,
) -> std::process::ExitStatus {
    std::process::Command::new(std::env::current_exe().expect("current test binary"))
        .args([scenario, "--exact", "--include-ignored", "--test-threads=1"])
        .env("CEREBRO_CRASH_POINT", crash_point)
        .env("CEREBRO_CRASH_VAULT", vault)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("spawn crash-scenario child")
}
