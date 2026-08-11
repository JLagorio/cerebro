//! The runtime DB's DDL, one constant per `user_version` step (M25.1).
//!
//! **This is an executable relational contract, not a column-name sketch.**
//! Every closed enum in the design is a `CHECK`, every count is
//! `CHECK (x >= 0)`, every hash is checked for lowercase-hex shape, and every
//! stored time is checked for the `…Z` RFC3339 spelling the core stamps. A
//! constraint written here is a rule two future call sites cannot disagree
//! about; a constraint left to Rust is a rule the next caller forgets.
//!
//! **What is app-global and what is scoped.** `runtime.db` is shared by every
//! vault the app opens, so scheduler, run, source, coverage-cache, failure,
//! and session rows carry `vault_id` (the app's registration for a path) and
//! `store_uuid` (the portable ledger identity). `budget_days`,
//! `budget_settings_versions`, `runtime_health`, and `lane_registry` are
//! deliberately global: one personal CLI subscription is metered once, no
//! matter how many vaults debit it.
//!
//! SQLite never compares NULLs as equal, so every "global row" uniqueness
//! (`vault_id IS NULL`) is a pair of partial unique indexes rather than a
//! composite key with a nullable column — a nullable column in a UNIQUE
//! constraint silently permits duplicates, which is the exact bug a global
//! budget cannot survive.

/// The M24.2 schema — the operational log.
///
/// `recorded_at` is core-stamped, never caller-supplied — the same rule the
/// ledger holds for system time. Nullable columns are the ones a refusal
/// genuinely may not have: a malformed argument arrives before a vault is
/// resolved, and a transport failure has no rule and no proposal.
pub const SCHEMA_V1: &str = "
    CREATE TABLE operational_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at TEXT NOT NULL,
        store_uuid TEXT,
        surface TEXT NOT NULL,
        code TEXT NOT NULL,
        rule TEXT,
        detail TEXT NOT NULL,
        proposal_id TEXT,
        run_id TEXT
    );
    CREATE INDEX operational_log_code ON operational_log (code, id);
";

/// The M24.6 schema — visibly parked promotions.
///
/// Operational, not ledger, by the standing when-in-doubt rule: every column
/// here is recomputable from the vault's records plus the type docs, so it is
/// a cache of a question ('what is not promotable yet, and what is missing')
/// and never an authority. Wiping app-data loses a worklist, not history.
///
/// `as_of` and `cleared_at` are core-stamped like `recorded_at`. They are
/// display and ordering only: no policy decision reads them, because a clock
/// is not evidence.
///
/// The partial unique index is the whole idempotency story. The gate runs
/// twice per commit set (decide, then again before append) and once more on
/// every retry; without it the debt lane would count attempts instead of
/// items.
pub const SCHEMA_V2: &str = "
    CREATE TABLE parked_promotions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id TEXT NOT NULL,
        belief_id TEXT NOT NULL,
        record_path TEXT,
        type_id TEXT NOT NULL,
        type_schema_hash TEXT NOT NULL,
        missing_roles TEXT NOT NULL,
        as_of TEXT NOT NULL,
        cleared_at TEXT
    );
    CREATE UNIQUE INDEX parked_promotions_open
        ON parked_promotions (store_id, belief_id) WHERE cleared_at IS NULL;
";

/// The M25.1 schema — scheduler, meter, budget, coverage cache, and the
/// scoping that keeps two vaults from spending each other's work.
///
/// The tables arrive together because they reference each other: a run names
/// a lane, a gate decision pins a budget day, a budget day pins the immutable
/// settings version it copied, and a coverage dimension belongs to an
/// assessment. Splitting them across `user_version` steps would ship a
/// schema in which half the foreign keys point at nothing.
///
/// `vault_registry` is the one table the design's list does not name, and it
/// is what makes the rest of the list expressible: `vault_id` is described as
/// "the app's stable registration for a vault path", and a registration with
/// no record is a derivation nobody can audit. It is derived AND recorded —
/// the id is a pure function of the canonical path (see `scope.rs`), so a
/// deleted runtime DB re-derives the same ids and rebuilt rows rejoin their
/// vault instead of orphaning.
pub const SCHEMA_V3: &str = r#"
    -- The app's registration of a vault path. `vault_id` is derived from the
    -- canonical path, so DB loss re-derives it rather than renaming a vault's
    -- whole history.
    CREATE TABLE vault_registry (
        vault_id TEXT PRIMARY KEY
            CHECK (length(vault_id) = 32 AND NOT vault_id GLOB '*[^0-9a-f]*'),
        vault_path TEXT NOT NULL UNIQUE,
        first_seen_at TEXT NOT NULL CHECK (first_seen_at LIKE '____-__-__T%Z')
    );

    -- The lane vocabulary. `lane` is closed by this registry, not by
    -- arbitrary strings: a milestone that wants a new lane adds a migration
    -- before any dispatcher can name it.
    CREATE TABLE lane_registry (
        lane TEXT PRIMARY KEY,
        priority INTEGER NOT NULL UNIQUE CHECK (priority >= 0),
        enabled_by_default INTEGER NOT NULL CHECK (enabled_by_default IN (0, 1)),
        introduced_version TEXT NOT NULL
    );

    -- Immutable budget settings. Every edit appends a version, even one whose
    -- content reverts to an older digest, so an M28 R2 observation window can
    -- detect a change-and-revert instead of seeing one unchanged digest.
    CREATE TABLE budget_settings_versions (
        settings_version INTEGER PRIMARY KEY CHECK (settings_version >= 0),
        settings_digest TEXT NOT NULL
            CHECK (length(settings_digest) = 64
                   AND NOT settings_digest GLOB '*[^0-9a-f]*'),
        recorded_at TEXT NOT NULL CHECK (recorded_at LIKE '____-__-__T%Z'),
        effective_window_start_utc TEXT NOT NULL
            CHECK (effective_window_start_utc LIKE '____-__-__T%Z'),
        timezone_id TEXT NOT NULL CHECK (length(timezone_id) > 0),
        max_daily_runs INTEGER NOT NULL CHECK (max_daily_runs >= 0),
        max_daily_tokens INTEGER NOT NULL CHECK (max_daily_tokens >= 0),
        max_daily_output_tokens INTEGER NOT NULL CHECK (max_daily_output_tokens >= 0),
        max_ambient_run_tokens INTEGER NOT NULL CHECK (max_ambient_run_tokens >= 0),
        max_ambient_run_output_tokens INTEGER NOT NULL
            CHECK (max_ambient_run_output_tokens >= 0),
        max_consecutive_failures INTEGER NOT NULL CHECK (max_consecutive_failures >= 0),
        max_run_elapsed_seconds INTEGER NOT NULL CHECK (max_run_elapsed_seconds >= 0),
        warning_ppm INTEGER NOT NULL CHECK (warning_ppm BETWEEN 0 AND 1000000)
    );

    -- One local day of the ONE personal subscription. Deliberately without a
    -- vault column: every vault debits the same account.
    --
    -- The ceiling columns are COPIES, not references. A budget edit tomorrow
    -- must not reinterpret what today's gate decided, so the day owns its own
    -- snapshot and pins the version/digest it copied.
    CREATE TABLE budget_days (
        window_start_utc TEXT PRIMARY KEY CHECK (window_start_utc LIKE '____-__-__T%Z'),
        window_end_utc TEXT NOT NULL CHECK (window_end_utc LIKE '____-__-__T%Z'),
        timezone_id TEXT NOT NULL CHECK (length(timezone_id) > 0),
        settings_version INTEGER NOT NULL
            REFERENCES budget_settings_versions (settings_version),
        settings_digest TEXT NOT NULL
            CHECK (length(settings_digest) = 64
                   AND NOT settings_digest GLOB '*[^0-9a-f]*'),
        max_daily_runs INTEGER NOT NULL CHECK (max_daily_runs >= 0),
        max_daily_tokens INTEGER NOT NULL CHECK (max_daily_tokens >= 0),
        max_daily_output_tokens INTEGER NOT NULL CHECK (max_daily_output_tokens >= 0),
        max_ambient_run_tokens INTEGER NOT NULL CHECK (max_ambient_run_tokens >= 0),
        max_ambient_run_output_tokens INTEGER NOT NULL
            CHECK (max_ambient_run_output_tokens >= 0),
        max_consecutive_failures INTEGER NOT NULL CHECK (max_consecutive_failures >= 0),
        max_run_elapsed_seconds INTEGER NOT NULL CHECK (max_run_elapsed_seconds >= 0),
        warning_ppm INTEGER NOT NULL CHECK (warning_ppm BETWEEN 0 AND 1000000),
        accounting_state TEXT NOT NULL CHECK (accounting_state IN ('exact', 'unknown')),
        ambient_tokens_used INTEGER NOT NULL CHECK (ambient_tokens_used >= 0),
        ambient_output_tokens INTEGER NOT NULL CHECK (ambient_output_tokens >= 0),
        reserved_total_tokens INTEGER NOT NULL CHECK (reserved_total_tokens >= 0),
        reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens >= 0),
        ambient_runs_started INTEGER NOT NULL CHECK (ambient_runs_started >= 0),
        ceiling_state TEXT NOT NULL
            CHECK (ceiling_state IN ('under_budget', 'warning', 'exhausted')),
        -- A sorted, duplicate-free JSON array of CeilingReason. Gate-only
        -- reasons never leak into this column; the writer is the only place
        -- that decides, and `json_valid` is the tripwire for anything else.
        ceiling_reasons TEXT NOT NULL CHECK (json_valid(ceiling_reasons))
    );

    -- Every preflight decision, with the counters it actually observed. This
    -- is what makes a historical gate decision reproducible rather than
    -- re-derived from settings that have since moved.
    CREATE TABLE ambient_gate_decisions (
        decision_id TEXT PRIMARY KEY,
        attempted_at TEXT NOT NULL CHECK (attempted_at LIKE '____-__-__T%Z'),
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        lane TEXT NOT NULL REFERENCES lane_registry (lane),
        window_start_utc TEXT NOT NULL REFERENCES budget_days (window_start_utc),
        settings_version INTEGER NOT NULL
            REFERENCES budget_settings_versions (settings_version),
        settings_digest TEXT NOT NULL
            CHECK (length(settings_digest) = 64
                   AND NOT settings_digest GLOB '*[^0-9a-f]*'),
        total_reservation INTEGER NOT NULL CHECK (total_reservation >= 0),
        output_reservation INTEGER NOT NULL CHECK (output_reservation >= 0),
        used_total_tokens INTEGER NOT NULL CHECK (used_total_tokens >= 0),
        used_output_tokens INTEGER NOT NULL CHECK (used_output_tokens >= 0),
        runs_started INTEGER NOT NULL CHECK (runs_started >= 0),
        reserved_total_tokens INTEGER NOT NULL CHECK (reserved_total_tokens >= 0),
        reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens >= 0),
        decision TEXT NOT NULL CHECK (decision IN ('proceed', 'deferred')),
        -- Sorted, duplicate-free JSON array of GateReason — empty EXACTLY for
        -- proceed, which is the one shape a reader can trust without asking
        -- the writer what it meant.
        reasons TEXT NOT NULL CHECK (json_valid(reasons)),
        CHECK ((decision = 'proceed') = (reasons = '[]'))
    );

    -- Every LLM run the app started, attended or ambient. Attended runs are
    -- METERED here and never gated; ambient runs are both.
    CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        vault_id TEXT REFERENCES vault_registry (vault_id),
        store_uuid TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('attended', 'ambient')),
        lane TEXT NOT NULL REFERENCES lane_registry (lane),
        started_at TEXT NOT NULL CHECK (started_at LIKE '____-__-__T%Z'),
        ended_at TEXT CHECK (ended_at IS NULL OR ended_at LIKE '____-__-__T%Z'),
        outcome TEXT NOT NULL CHECK (outcome IN (
            'running', 'succeeded', 'failed', 'quota_failed',
            'elapsed_aborted', 'cancelled', 'abandoned_usage_unknown')),
        usage_state TEXT NOT NULL CHECK (usage_state IN ('pending', 'exact', 'unknown')),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cache_read INTEGER NOT NULL CHECK (cache_read >= 0),
        cache_write INTEGER NOT NULL CHECK (cache_write >= 0),
        reserved_total_tokens INTEGER NOT NULL CHECK (reserved_total_tokens >= 0),
        reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens >= 0),
        lease_expires_at TEXT
            CHECK (lease_expires_at IS NULL OR lease_expires_at LIKE '____-__-__T%Z'),
        proposals_submitted INTEGER NOT NULL CHECK (proposals_submitted >= 0),
        applied INTEGER NOT NULL CHECK (applied >= 0),
        rejected INTEGER NOT NULL CHECK (rejected >= 0),
        -- A run is either app-global (attended, no vault resolved) or fully
        -- scoped. One of the two present is a row nothing can attribute.
        CHECK ((vault_id IS NULL) = (store_uuid IS NULL)),
        -- Ambient work is always somebody's vault.
        CHECK (mode = 'attended' OR vault_id IS NOT NULL)
    );
    CREATE INDEX runs_by_window ON runs (mode, started_at);
    CREATE INDEX runs_by_vault ON runs (vault_id, started_at);

    -- The singleton ambient lease: background LLM concurrency is ONE, inside
    -- the process-wide cap of four, so attended chat always has headroom.
    -- Encoded as a one-row table rather than a comment, because a comment has
    -- never stopped a second dispatcher.
    CREATE TABLE ambient_dispatch (
        singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'ambient'),
        run_id TEXT NOT NULL UNIQUE REFERENCES runs (run_id),
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        lane TEXT NOT NULL REFERENCES lane_registry (lane),
        acquired_at TEXT NOT NULL CHECK (acquired_at LIKE '____-__-__T%Z'),
        lease_expires_at TEXT NOT NULL CHECK (lease_expires_at LIKE '____-__-__T%Z')
    );

    -- Consecutive-failure and busy state, per vault and lane.
    CREATE TABLE ambient_gate_state (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        lane TEXT NOT NULL REFERENCES lane_registry (lane),
        consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
        active_run_started_at TEXT
            CHECK (active_run_started_at IS NULL
                   OR active_run_started_at LIKE '____-__-__T%Z'),
        last_outcome TEXT,
        PRIMARY KEY (vault_id, store_uuid, lane)
    );

    -- Durable session heartbeats. The closed-app interval is not inferred
    -- from a shutdown callback that does not exist: a clean close stamps an
    -- exact time, and an unclean one leaves the last durable heartbeat as an
    -- honest lower bound.
    CREATE TABLE app_sessions (
        session_id TEXT NOT NULL,
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        opened_at TEXT NOT NULL CHECK (opened_at LIKE '____-__-__T%Z'),
        last_heartbeat_at TEXT NOT NULL CHECK (last_heartbeat_at LIKE '____-__-__T%Z'),
        clean_closed_at TEXT
            CHECK (clean_closed_at IS NULL OR clean_closed_at LIKE '____-__-__T%Z'),
        close_precision TEXT NOT NULL
            CHECK (close_precision IN ('open', 'clean_exact', 'heartbeat_lower_bound')),
        CHECK ((close_precision = 'clean_exact') = (clean_closed_at IS NOT NULL)),
        PRIMARY KEY (session_id, vault_id, store_uuid)
    );

    -- The durable scheduler. `normalized_prior_snapshot` is the whole point
    -- of the row: two hashes can only say "different", and a restart that
    -- cannot say WHICH FIELD moved cannot reproduce its own verdict.
    CREATE TABLE scheduler (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        item_key TEXT NOT NULL,
        source_id TEXT,
        content_hash TEXT NOT NULL
            CHECK (length(content_hash) = 64 AND NOT content_hash GLOB '*[^0-9a-f]*'),
        normalized_prior_snapshot TEXT NOT NULL
            CHECK (json_valid(normalized_prior_snapshot)),
        normalizer_version TEXT NOT NULL CHECK (length(normalizer_version) > 0),
        processing_epoch INTEGER NOT NULL CHECK (processing_epoch >= 0),
        event_cursor TEXT,
        route TEXT,
        state TEXT NOT NULL CHECK (state IN (
            'baseline_held', 'recovery_held', 'pending', 'claimed',
            'pending_review', 'consumed', 'failed_visible')),
        claimed_by_run_id TEXT REFERENCES runs (run_id),
        claim_expires_at TEXT
            CHECK (claim_expires_at IS NULL OR claim_expires_at LIKE '____-__-__T%Z'),
        first_seen TEXT NOT NULL CHECK (first_seen LIKE '____-__-__T%Z'),
        updated_at TEXT NOT NULL CHECK (updated_at LIKE '____-__-__T%Z'),
        -- A claim is a lease or it is nothing: an owner with no expiry is an
        -- item no crash recovery can ever free.
        CHECK ((state = 'claimed') = (claimed_by_run_id IS NOT NULL)),
        CHECK ((claimed_by_run_id IS NULL) = (claim_expires_at IS NULL)),
        PRIMARY KEY (vault_id, store_uuid, item_key)
    );
    CREATE INDEX scheduler_by_state ON scheduler (vault_id, store_uuid, state);

    -- Lane backoff. A NULL vault means every vault: the CLI's quota window is
    -- a property of the subscription, not of a folder.
    CREATE TABLE backoff (
        vault_id TEXT REFERENCES vault_registry (vault_id),
        lane TEXT NOT NULL REFERENCES lane_registry (lane),
        until TEXT NOT NULL CHECK (until LIKE '____-__-__T%Z'),
        reason TEXT NOT NULL,
        quota_window_key TEXT NOT NULL
    );
    CREATE UNIQUE INDEX backoff_scoped
        ON backoff (vault_id, lane, quota_window_key) WHERE vault_id IS NOT NULL;
    CREATE UNIQUE INDEX backoff_global
        ON backoff (lane, quota_window_key) WHERE vault_id IS NULL;

    -- A byte-faithful cache of the ledger's portable `source.registered`
    -- union. Disposable: losing it rebuilds from the ledger. A source
    -- reference with no committed registration is held or refused, never
    -- reconstructed from a provider guess.
    CREATE TABLE source_registration (
        store_uuid TEXT NOT NULL,
        source_id TEXT NOT NULL
            CHECK (length(source_id) = 32 AND NOT source_id GLOB '*[^0-9a-f]*'),
        registration_event_id TEXT NOT NULL
            CHECK (length(registration_event_id) = 32
                   AND NOT registration_event_id GLOB '*[^0-9a-f]*'),
        kind TEXT NOT NULL CHECK (kind IN (
            'human_actor', 'connector', 'builtin', 'cerebro_runtime', 'legacy_reference')),
        source_key TEXT NOT NULL,
        actor_id TEXT,
        connector_instance_id TEXT,
        logical_scope_id TEXT,
        service_id TEXT,
        legacy_resource_hash TEXT
            CHECK (legacy_resource_hash IS NULL
                   OR (length(legacy_resource_hash) = 64
                       AND NOT legacy_resource_hash GLOB '*[^0-9a-f]*')),
        authority_capability TEXT NOT NULL CHECK (authority_capability IN (
            'content_only', 'human_assertion', 'direct_system_artifact')),
        independence_domain_id TEXT,
        -- A legacy reference is content-only and has no independence domain:
        -- an imported locator is not an observation Cerebro made.
        CHECK (kind <> 'legacy_reference'
               OR (authority_capability = 'content_only'
                   AND independence_domain_id IS NULL)),
        PRIMARY KEY (store_uuid, source_id)
    );
    CREATE UNIQUE INDEX source_registration_event
        ON source_registration (store_uuid, registration_event_id);

    -- Connection and health are SEPARATE live signals. Connected never
    -- implies healthy, and neither is written by CLI runtime health.
    CREATE TABLE source_connection (
        store_uuid TEXT NOT NULL,
        source_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('connected', 'disconnected', 'unknown')),
        since TEXT NOT NULL CHECK (since LIKE '____-__-__T%Z'),
        detail TEXT,
        PRIMARY KEY (store_uuid, source_id),
        FOREIGN KEY (store_uuid, source_id)
            REFERENCES source_registration (store_uuid, source_id)
    );
    CREATE TABLE source_health (
        store_uuid TEXT NOT NULL,
        source_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('healthy', 'unhealthy', 'unknown')),
        since TEXT NOT NULL CHECK (since LIKE '____-__-__T%Z'),
        detail TEXT,
        PRIMARY KEY (store_uuid, source_id),
        FOREIGN KEY (store_uuid, source_id)
            REFERENCES source_registration (store_uuid, source_id)
    );

    -- Reasoning-runtime health: a dead CLI quota means evidence exists and
    -- cannot currently be processed. A different sentence from a dead
    -- connector, in a different table, on purpose (§86).
    CREATE TABLE runtime_health (
        component TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('healthy', 'degraded', 'unavailable', 'unknown')),
        since TEXT NOT NULL CHECK (since LIKE '____-__-__T%Z'),
        detail TEXT
    );

    -- A query cache over portable coverage events. Disposable and rebuilt
    -- from the ledger; predicate class and canonical scope digest are stored
    -- so two assessments about the same entity and source cannot collide.
    CREATE TABLE coverage_cache (
        store_uuid TEXT NOT NULL,
        assessment_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        subject_id TEXT,
        predicate_class TEXT,
        scope_digest TEXT NOT NULL
            CHECK (length(scope_digest) = 64 AND NOT scope_digest GLOB '*[^0-9a-f]*'),
        event_id TEXT NOT NULL
            CHECK (length(event_id) = 32 AND NOT event_id GLOB '*[^0-9a-f]*'),
        PRIMARY KEY (store_uuid, assessment_id)
    );
    CREATE INDEX coverage_cache_current
        ON coverage_cache (store_uuid, source_id, subject_id, predicate_class, scope_digest);

    -- Seven dimensions, seven rows. 'Partial' is a UI projection and is never
    -- stored: collapsing these is the review-blocking defect §46 names.
    CREATE TABLE coverage_dimension_cache (
        store_uuid TEXT NOT NULL,
        assessment_id TEXT NOT NULL,
        dimension TEXT NOT NULL CHECK (dimension IN (
            'source_connected', 'source_healthy', 'scope_known', 'scope_accessible',
            'retention_known', 'index_current', 'retrieval_attempted')),
        state TEXT NOT NULL CHECK (state IN ('yes', 'no', 'unknown', 'not_applicable')),
        basis_event_ids_json TEXT NOT NULL CHECK (json_valid(basis_event_ids_json)),
        as_of TEXT NOT NULL CHECK (as_of LIKE '____-__-__T%Z'),
        -- yes/no is carried by committed facts; unknown/not_applicable is
        -- carried by a limitation and never by a silent empty basis.
        CHECK ((state IN ('yes', 'no')) = (basis_event_ids_json <> '[]')),
        PRIMARY KEY (store_uuid, assessment_id, dimension),
        FOREIGN KEY (store_uuid, assessment_id)
            REFERENCES coverage_cache (store_uuid, assessment_id) ON DELETE CASCADE
    );

    -- The third face of failure (§29): scan, parse, and extraction errors.
    -- Visible-and-skipped per item, never silently dropped, and never worded
    -- like a quota death.
    CREATE TABLE ingestion_failures (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        item_key TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('scan', 'parse', 'extraction')),
        detail TEXT NOT NULL,
        first_seen TEXT NOT NULL CHECK (first_seen LIKE '____-__-__T%Z'),
        last_seen TEXT NOT NULL CHECK (last_seen LIKE '____-__-__T%Z'),
        resolved_at TEXT CHECK (resolved_at IS NULL OR resolved_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, store_uuid, item_key, stage)
    );

    -- Owner-declared responsibility contracts, append-only by version. An
    -- edit closes the old half-open interval and inserts the next version, so
    -- "the contract active during that episode" stays answerable after later
    -- edits.
    CREATE TABLE responsibility_contracts (
        store_uuid TEXT NOT NULL,
        responsibility_id TEXT NOT NULL,
        contract_version INTEGER NOT NULL CHECK (contract_version >= 0),
        contract_digest TEXT NOT NULL
            CHECK (length(contract_digest) = 64
                   AND NOT contract_digest GLOB '*[^0-9a-f]*'),
        source_id TEXT NOT NULL,
        subject_id TEXT,
        predicate_class TEXT,
        scope_digest TEXT NOT NULL
            CHECK (length(scope_digest) = 64 AND NOT scope_digest GLOB '*[^0-9a-f]*'),
        retention_seconds INTEGER NOT NULL CHECK (retention_seconds >= 0),
        deadline_seconds INTEGER NOT NULL CHECK (deadline_seconds >= 0),
        active_from TEXT NOT NULL CHECK (active_from LIKE '____-__-__T%Z'),
        active_to TEXT CHECK (active_to IS NULL OR active_to LIKE '____-__-__T%Z'),
        PRIMARY KEY (store_uuid, responsibility_id, contract_version)
    );

    -- One typed launch catch-up outcome per closed-app episode and active
    -- contract version. These rows are the M28 R10 numerator; the linked gap
    -- carries the epistemic half.
    CREATE TABLE catchup_outcomes (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        responsibility_id TEXT NOT NULL,
        contract_version INTEGER NOT NULL CHECK (contract_version >= 0),
        contract_digest TEXT NOT NULL
            CHECK (length(contract_digest) = 64
                   AND NOT contract_digest GLOB '*[^0-9a-f]*'),
        app_closed_at TEXT NOT NULL CHECK (app_closed_at LIKE '____-__-__T%Z'),
        close_precision TEXT NOT NULL
            CHECK (close_precision IN ('clean_exact', 'heartbeat_lower_bound')),
        reopened_at TEXT NOT NULL CHECK (reopened_at LIKE '____-__-__T%Z'),
        resolved_at TEXT NOT NULL CHECK (resolved_at LIKE '____-__-__T%Z'),
        coverage_gap_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN (
            'caught_up', 'retention_lost', 'declared_deadline_missed', 'not_applicable')),
        detail TEXT,
        PRIMARY KEY (store_uuid, episode_id, responsibility_id, contract_version),
        FOREIGN KEY (store_uuid, responsibility_id, contract_version)
            REFERENCES responsibility_contracts
                (store_uuid, responsibility_id, contract_version)
    );

    -- Generic durable settings. A NULL vault is a global setting; SQLite
    -- would happily store two of those under one key, so uniqueness is two
    -- partial indexes rather than a nullable composite.
    CREATE TABLE settings (
        key TEXT NOT NULL,
        vault_id TEXT REFERENCES vault_registry (vault_id),
        value TEXT NOT NULL
    );
    CREATE UNIQUE INDEX settings_scoped
        ON settings (key, vault_id) WHERE vault_id IS NOT NULL;
    CREATE UNIQUE INDEX settings_global ON settings (key) WHERE vault_id IS NULL;
"#;

/// The lane vocabulary M25 seeds, in priority order.
///
/// This is the shape `src/engine/jobs.ts`'s `RANK` already has — the same
/// seven names, the same order — moved from a `Record` in the renderer to a
/// table the dispatcher reads. `behind` survives the deletion of its mtime
/// feeder (M25.3) repurposed as the hash-diff launch catch-up lane: the lane
/// was never the bug, the trigger was.
pub const LANES: [(&str, i64, bool); 7] = [
    ("filed", 0, true),
    ("scheduled", 1, true),
    ("agent", 2, true),
    ("behind", 3, true),
    ("refresh", 4, true),
    ("stale", 5, true),
    ("schema", 6, true),
];

/// The version string stamped on every lane M25 introduces.
pub const LANE_INTRODUCED: &str = "M25";

/// The M26.4 step — where a source-taint assessment lives.
///
/// **Operational, and that placement is the argument.** §92's heuristic is a
/// guess this build makes about bytes; the ledger holds what the base
/// believes. A classifier that wrote into the vault would make epistemic
/// history a function of which version of a pattern list happened to be
/// running, and re-running a newer classifier would rewrite the past. So the
/// row lives here, keyed to the Observation event id it was assessed against,
/// and M22's closed Observation body is never touched.
///
/// `classifier_version` is part of the key rather than a column that gets
/// overwritten: "v1 saw nothing" and "v2 was never run" are different facts,
/// and a heuristic whose history is overwritten on every upgrade cannot be
/// audited at all.
///
/// `signals` is a sorted, comma-joined list of the closed vocabulary in
/// `ingest::taint`. It is empty exactly when the assessment is clean — the
/// `suspected` bit is DERIVED on read rather than stored, so a row can never
/// claim suspicion while naming no reason.
pub const SCHEMA_V4: &str = "
    CREATE TABLE source_taint_assessments (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        observation_event_id TEXT NOT NULL,
        classifier_version TEXT NOT NULL,
        signals TEXT NOT NULL,
        assessed_at TEXT NOT NULL CHECK (assessed_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, store_uuid, observation_event_id, classifier_version)
    );
    CREATE INDEX source_taint_suspected
        ON source_taint_assessments (vault_id, store_uuid)
        WHERE signals <> '';
";
