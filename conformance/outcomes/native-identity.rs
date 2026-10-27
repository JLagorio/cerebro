//! One test-only compiled producer identity shared by the offline observers.
use serde_json::json;
use sha2::{Digest, Sha256};

// Generated from one bounded repository inventory. Every entry's bytes are
// compiled into this test binary; capture never substitutes a later disk read.
include!("native-inputs.generated.rs");

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn native_input_identity() -> serde_json::Value {
    const SCOPE: &str = "cerebro-native-producer-inputs-v1";
    const MAX_FILES: usize = 2048;
    const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
    const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
    let inventory_bytes = include_bytes!("native-inputs.v1.json");
    assert!(
        inventory_bytes.len() <= 512 * 1024,
        "input inventory exceeds its cap"
    );
    let inventory: serde_json::Value = serde_json::from_slice(inventory_bytes).unwrap();
    assert_eq!(inventory["version"], 1);
    assert_eq!(inventory["scope"], SCOPE);
    let paths = inventory["paths"].as_array().unwrap();
    assert!(!NATIVE_PRODUCER_INPUTS.is_empty());
    assert!(
        NATIVE_PRODUCER_INPUTS.len() <= MAX_FILES,
        "input file count exceeds its cap"
    );
    assert_eq!(paths.len(), NATIVE_PRODUCER_INPUTS.len());
    let mut aggregate = Sha256::new();
    aggregate.update(format!("{SCOPE}\n").as_bytes());
    let mut previous = "";
    let mut total = 0usize;
    for (index, &(path, bytes)) in NATIVE_PRODUCER_INPUTS.iter().enumerate() {
        assert!(path.len() <= 512 && path.is_ascii(), "invalid input path");
        assert!(
            path.split('/').count() <= 16,
            "input path depth exceeds its cap"
        );
        assert!(
            path.split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."),
            "invalid input path"
        );
        assert!(path > previous, "input paths must be unique and sorted");
        assert_eq!(
            paths[index].as_str().unwrap(),
            path,
            "generated input inventory differs"
        );
        assert!(
            bytes.len() <= MAX_FILE_BYTES,
            "input file bytes exceed their cap"
        );
        total = total
            .checked_add(bytes.len())
            .expect("input byte count overflow");
        assert!(
            total <= MAX_TOTAL_BYTES,
            "input total bytes exceed their cap"
        );
        let byte_hash = sha256(bytes);
        aggregate.update(format!("{path}\0{}\0{byte_hash}\n", bytes.len()).as_bytes());
        previous = path;
    }
    json!({
        "version":1,
        "aggregateDigest":format!("{:x}", aggregate.finalize()),
        "fileCount":NATIVE_PRODUCER_INPUTS.len(),
        "totalBytes":total
    })
}
