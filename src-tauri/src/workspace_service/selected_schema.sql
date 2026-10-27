-- Mutable selected store 2. Verified on open; initialized only by test fixtures here.
PRAGMA user_version=2;
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
    operation TEXT NOT NULL CHECK(operation='page.full_width'),
    at TEXT NOT NULL
);
