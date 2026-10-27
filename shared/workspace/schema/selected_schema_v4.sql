-- Selected metadata request store 4. Explicit staged initializer; never an implicit migration.
PRAGMA user_version=4;
CREATE TABLE workspace (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    format INTEGER NOT NULL CHECK(format=2),
    workspace_id TEXT NOT NULL UNIQUE,
    schema_revision INTEGER NOT NULL CHECK(schema_revision>=1),
    metadata_epoch INTEGER NOT NULL CHECK(metadata_epoch>=1)
);
CREATE TABLE records (
    id TEXT PRIMARY KEY NOT NULL,
    path TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL CHECK(revision>=1),
    body_hash TEXT NOT NULL,
    metadata TEXT NOT NULL
);
CREATE TABLE metadata_receipts (
    epoch INTEGER PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES records(id),
    previous_revision INTEGER NOT NULL CHECK(previous_revision>=1),
    revision INTEGER NOT NULL CHECK(revision>=1),
    metadata_before_hash TEXT NOT NULL,
    metadata_after_hash TEXT NOT NULL,
    actor TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('page.full_width','page.body','metadata.patch')),
    at TEXT NOT NULL,
    body_before_hash TEXT NOT NULL,
    body_after_hash TEXT NOT NULL,
    run_id TEXT,
    approved_by TEXT
);
CREATE TABLE metadata_requests (
    request_key TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    record_id TEXT NOT NULL REFERENCES records(id),
    path TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    expected_revision INTEGER NOT NULL CHECK(expected_revision>=1),
    expected_metadata_hash TEXT NOT NULL,
    expected_body_hash TEXT NOT NULL,
    result_kind TEXT NOT NULL CHECK(result_kind IN ('applied','unchanged')),
    receipt_epoch INTEGER UNIQUE REFERENCES metadata_receipts(epoch),
    result_revision INTEGER NOT NULL CHECK(result_revision>=1),
    result_metadata_hash TEXT NOT NULL,
    result_body_hash TEXT NOT NULL,
    actor TEXT NOT NULL,
    at TEXT NOT NULL,
    CHECK((result_kind='applied' AND receipt_epoch IS NOT NULL) OR (result_kind='unchanged' AND receipt_epoch IS NULL))
);
