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
