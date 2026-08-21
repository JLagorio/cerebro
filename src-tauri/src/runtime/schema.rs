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

    -- The singleton ambient lease, as v3 shipped it: background LLM
    -- concurrency was ONE, encoded as a one-row table rather than a comment.
    -- SUPERSEDED AT v14 (M33b.1), which rebuilds this table keyed by run_id
    -- so the ceiling is a counted number rather than a primary key. This
    -- statement is history and stays true of v3; nothing here describes the
    -- schema the app runs on.
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

/// The M26.5 schema — what one question was shown, and what came of the
/// discovery it proposed.
///
/// **Two tables, two different jobs.** A manifest is a RECEIPT: it says what
/// an assembly held at a moment, it is content-addressed by `assembly_id`,
/// and it never changes. A discovery plan run is a LIFECYCLE: it starts
/// pending and moves, once, toward a terminal state.
///
/// **Operational, not ledger**, by the standing when-in-doubt rule. A manifest
/// is reproducible: the assembler is deterministic, so the same question
/// against the same `chain_head` re-derives the identical bytes. Losing
/// app-data loses a cache and a worklist, never a fact about what the base
/// believes. What a synthesis CONCLUDED is a different matter and lands in the
/// vault ledger, where it belongs.
///
/// **The lifecycle is a CHECK, not a convention.** `completed` and `failed`
/// require a start, because a plan that finished without starting is a claim
/// nobody made; `dismissed` may skip it, because dismissing a plan you never
/// ran is the ordinary case. `terminal_at` is set exactly on the three
/// terminal states — a stamped time beside a non-terminal state, or a terminal
/// state with no time, is a row that disagrees with itself.
///
/// `manifest_json` holds the whole serialized manifest rather than a
/// reconstruction. The columns beside it are the ones a surface filters and
/// sorts by; they are derived from the same value at write time and checked
/// against it on read, so a query can never disagree with the receipt it is
/// summarising.
pub const SCHEMA_V5: &str = "
    CREATE TABLE working_memory_manifests (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        assembly_id TEXT NOT NULL
            CHECK (length(assembly_id) = 32 AND assembly_id = lower(assembly_id)),
        question_hash TEXT NOT NULL
            CHECK (length(question_hash) = 64 AND question_hash = lower(question_hash)),
        chain_head TEXT NOT NULL CHECK (chain_head <> ''),
        assembler_version TEXT NOT NULL CHECK (assembler_version <> ''),
        intended_use_kind TEXT NOT NULL CHECK (intended_use_kind IN (
            'draft_note', 'reversible_work', 'operational_decision',
            'production_release', 'safety_or_compliance'
        )),
        stakes TEXT NOT NULL CHECK (stakes IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        predicate_class TEXT CHECK (predicate_class IS NULL OR predicate_class <> ''),
        counterevidence_state TEXT NOT NULL
            CHECK (counterevidence_state IN ('included', 'exhausted', 'blocked')),
        source_count INTEGER NOT NULL CHECK (source_count >= 0),
        context_bytes INTEGER NOT NULL CHECK (context_bytes >= 0),
        evidence_item_count INTEGER NOT NULL CHECK (evidence_item_count >= 0),
        manifest_json TEXT NOT NULL CHECK (manifest_json <> ''),
        assembled_at TEXT NOT NULL CHECK (assembled_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, store_uuid, assembly_id)
    );
    CREATE INDEX working_memory_by_question
        ON working_memory_manifests (vault_id, store_uuid, question_hash, assembled_at);

    CREATE TABLE discovery_plan_runs (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        plan_id TEXT NOT NULL
            CHECK (length(plan_id) = 64 AND plan_id = lower(plan_id)),
        assembly_id TEXT NOT NULL
            CHECK (length(assembly_id) = 32 AND assembly_id = lower(assembly_id)),
        state TEXT NOT NULL
            CHECK (state IN ('pending', 'started', 'completed', 'dismissed', 'failed')),
        created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T%Z'),
        started_at TEXT CHECK (started_at IS NULL OR started_at LIKE '____-__-__T%Z'),
        terminal_at TEXT CHECK (terminal_at IS NULL OR terminal_at LIKE '____-__-__T%Z'),
        detail TEXT CHECK (detail IS NULL OR detail <> ''),
        PRIMARY KEY (vault_id, store_uuid, plan_id),
        CHECK (state <> 'pending' OR (started_at IS NULL AND terminal_at IS NULL)),
        CHECK (state NOT IN ('started', 'completed', 'failed') OR started_at IS NOT NULL),
        CHECK (
            (state IN ('completed', 'dismissed', 'failed') AND terminal_at IS NOT NULL)
            OR (state IN ('pending', 'started') AND terminal_at IS NULL)
        )
    );
    CREATE INDEX discovery_plan_runs_open
        ON discovery_plan_runs (vault_id, store_uuid, state, created_at)
        WHERE state IN ('pending', 'started');
";

/// The M26.6 schema — what the maintenance pass has already said.
///
/// **The key IS the content.** A finding's id is a hash of what it found —
/// the kind, the subject, and the exact belief ids — so re-surfacing the same
/// key means nothing about the base changed. That is what stops a pass
/// proposing the same merge every tick without needing a clock to decide how
/// long "recently" is. When the underlying beliefs change, the key changes,
/// and the finding comes back on its own.
///
/// `chain_head` records what the base looked like when it was first said, so a
/// reviewer can re-run the finders at that head and see the same thing.
///
/// Operational, not ledger: every row is re-derivable by replaying to
/// `chain_head` and running `maintain::candidates::find`. Losing app-data
/// loses a "we already mentioned this", not a fact about the world.
pub const SCHEMA_V6: &str = "
    CREATE TABLE maintenance_findings (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        finding_key TEXT NOT NULL
            CHECK (length(finding_key) = 64 AND finding_key = lower(finding_key)),
        kind TEXT NOT NULL CHECK (kind IN ('exact_merge', 'compress', 'attention')),
        subject_id TEXT NOT NULL CHECK (subject_id <> ''),
        detail TEXT NOT NULL CHECK (detail <> ''),
        chain_head TEXT NOT NULL CHECK (chain_head <> ''),
        surfaced_at TEXT NOT NULL CHECK (surfaced_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, store_uuid, finding_key)
    );
    CREATE INDEX maintenance_findings_by_kind
        ON maintenance_findings (vault_id, store_uuid, kind, surfaced_at);
";

/// The M26.7 schema — the attention primitives, stored and unranked.
///
/// **Schema-disjoint from everything epistemic, on purpose.** This is the
/// firewall M27's lanes inherit: an attention row may be recomputed, deleted,
/// or ignored, and no belief changes. Nothing in the vault references it, and
/// nothing here references a vault table — the only keys are ids the ledger
/// already minted.
///
/// **Every row is a REPLACEMENT, keyed by belief.** These signals describe the
/// base as it stands, so a history of them is a history of the computation
/// rather than of the base — and the base already keeps its own history, in
/// the place that is tamper-evident. `computed_at` and `chain_head` say what
/// the row was computed from, so a stale row announces itself.
///
/// **There is no priority column, and that is the design.** Ranking belongs
/// to the layer that has to justify itself to a person; a number stored here
/// would make the decision invisibly, one migration ahead of the surface that
/// was supposed to make it.
pub const SCHEMA_V7: &str = "
    CREATE TABLE attention_signals (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        belief_id TEXT NOT NULL
            CHECK (length(belief_id) = 32 AND belief_id = lower(belief_id)),
        entity_id TEXT NOT NULL
            CHECK (length(entity_id) = 32 AND entity_id = lower(entity_id)),
        revision_event_id TEXT NOT NULL CHECK (revision_event_id <> ''),
        signals_version TEXT NOT NULL CHECK (signals_version <> ''),
        supporting_assertions INTEGER NOT NULL CHECK (supporting_assertions >= 0),
        distinct_sources INTEGER NOT NULL CHECK (distinct_sources >= 0),
        newest_evidence_at TEXT
            CHECK (newest_evidence_at IS NULL OR newest_evidence_at LIKE '____-__-__T%Z'),
        evidence_age_seconds INTEGER CHECK (evidence_age_seconds IS NULL
                                            OR evidence_age_seconds >= 0),
        coverage_assessments INTEGER NOT NULL CHECK (coverage_assessments >= 0),
        open_coverage_gaps INTEGER NOT NULL CHECK (open_coverage_gaps >= 0),
        declared_contradictions INTEGER NOT NULL CHECK (declared_contradictions >= 0),
        open_comparisons INTEGER NOT NULL CHECK (open_comparisons >= 0),
        chain_head TEXT NOT NULL CHECK (chain_head <> ''),
        computed_at TEXT NOT NULL CHECK (computed_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, store_uuid, belief_id),
        -- An age without a stamp, or a stamp without an age, is a row that
        -- disagrees with itself. Both absent means an unsupported revision,
        -- which is a real state and not a missing one.
        CHECK ((newest_evidence_at IS NULL) = (evidence_age_seconds IS NULL))
    );
    CREATE INDEX attention_signals_by_entity
        ON attention_signals (vault_id, store_uuid, entity_id);
";

/// The M26.7d schema — what the Source Monitor last saw of each cached copy.
///
/// **Vault-scoped, not store-scoped, and that is deliberate.** A cached copy
/// is a FILE. Its identity is its path in the vault, and it means the same
/// thing whichever ledger store the vault is currently keeping — so a
/// `store_uuid` column here would imply a distinction that does not exist and
/// would silently split one file's history in two if a vault were ever
/// re-storied.
///
/// `content_hash` is the source's own content, with the fetch bookkeeping
/// removed (see `monitor::sources`). `last_changed_at` moves only when that
/// hash moves — a refetch that brought back identical bytes updates
/// `last_checked_at` and nothing else, which is exactly the outcome the hash
/// exists to make visible.
pub const SCHEMA_V8: &str = "
    CREATE TABLE source_monitor_state (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        item_key TEXT NOT NULL CHECK (item_key <> ''),
        source_id TEXT NOT NULL CHECK (source_id <> ''),
        source_kind TEXT CHECK (source_kind IS NULL OR source_kind <> ''),
        source_url TEXT CHECK (source_url IS NULL OR source_url <> ''),
        monitor_version TEXT NOT NULL CHECK (monitor_version <> ''),
        content_hash TEXT NOT NULL
            CHECK (length(content_hash) = 64 AND content_hash = lower(content_hash)),
        fetched_at TEXT CHECK (fetched_at IS NULL OR fetched_at <> ''),
        stale_after TEXT CHECK (stale_after IS NULL OR length(stale_after) = 10),
        first_seen_at TEXT NOT NULL CHECK (first_seen_at LIKE '____-__-__T%Z'),
        last_checked_at TEXT NOT NULL CHECK (last_checked_at LIKE '____-__-__T%Z'),
        last_changed_at TEXT NOT NULL CHECK (last_changed_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, item_key)
    );
    CREATE INDEX source_monitor_by_source
        ON source_monitor_state (vault_id, source_id);
";

/// The M26.7e schema — the governance rows M28's windows are reproducible
/// from.
///
/// **These exist so later promotions are argued from records rather than from
/// anecdotes.** They were written before anything read them; that was the
/// point. A decision about whether the resolver is good enough to run
/// unattended, or whether a pass costs what it claims, has to be answerable
/// from rows that were already being written when nobody was looking. The
/// M28.1 trigger runner now reads them, and `run_cost_components` gained its
/// one production writer — the attended assembly path — in M31.6.
/// `resolver_outcomes` is the one table still in the original posture, and
/// inverted: M28.1's R7 leg READS it, `record_attempt` is called only from
/// tests, so it is a shape waiting for its producer rather than rows waiting
/// for a reader. Whatever gives it one owes this comment an edit.
///
/// **`run_cost_components` is one row per component, not one wide row.** The
/// unit belongs to the component and the component list is closed, so a CHECK
/// can enforce the pairing — a wide row would have ten nullable columns and
/// no way to tell "zero" from "we did not measure". Zero is a valid quantity
/// here; absence is not, which is exactly why a successful belief-affecting
/// synthesis writes all ten.
///
/// **`resolver_outcomes` is a flat union with CHECKs**, mirroring the tagged
/// union in `ingest::resolver`. Flat because SQL has no sum type; checked
/// because the invariants are the whole value of the record. An attached row
/// must name what it attached to; a parked row must not.
///
/// **`source_taint_assessments` is rebuilt to carry an explicit verdict.** It
/// has held `signals` since M25, and "suspected" was derivable from the list
/// being non-empty — in Rust, by a method. The design wants that invariant
/// structural, so the verdict is a column and a CHECK ties it to the list.
/// The signal SPELLINGS stay as `ingest::taint` writes them: they name the
/// same five heuristics as the design's list, and renaming them would break
/// the downgrade contract (`Signal::parse` returns `None` for a name a build
/// does not know) for nothing.
pub const SCHEMA_V9: &str = "
    CREATE TABLE resolver_outcomes (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        attempt_id TEXT NOT NULL CHECK (attempt_id <> ''),
        run_id TEXT NOT NULL CHECK (run_id <> ''),
        ingest_item_id TEXT NOT NULL CHECK (ingest_item_id <> ''),
        artifact_id TEXT NOT NULL CHECK (artifact_id <> ''),
        assertion_event_id TEXT
            CHECK (assertion_event_id IS NULL OR length(assertion_event_id) = 32),
        assertion_candidate_hash TEXT NOT NULL
            CHECK (length(assertion_candidate_hash) = 64),
        eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
        ineligible_reason TEXT CHECK (ineligible_reason IS NULL OR ineligible_reason IN (
            'subject_none', 'malformed_subject', 'non_assertion_observation',
            'missing_assertion_event', 'already_attached'
        )),
        outcome TEXT NOT NULL CHECK (outcome IN (
            'ineligible', 'exact_id', 'known_alias', 'explicit_relation',
            'normalized_match', 'unresolved', 'claim_granularity_blocked',
            'conflicting_attachment'
        )),
        attachment_state TEXT CHECK (attachment_state IS NULL
                                     OR attachment_state IN ('attached', 'parked')),
        chosen_entity_id TEXT CHECK (chosen_entity_id IS NULL OR length(chosen_entity_id) = 32),
        prior_entity_id TEXT CHECK (prior_entity_id IS NULL OR length(prior_entity_id) = 32),
        prior_resolution_event_id TEXT
            CHECK (prior_resolution_event_id IS NULL OR length(prior_resolution_event_id) = 32),
        target_count INTEGER CHECK (target_count IS NULL OR target_count >= 1),
        candidate_count INTEGER CHECK (candidate_count IS NULL OR candidate_count >= 0),
        normalized_mention_hashes TEXT,
        candidate_entity_ids TEXT,
        reason_codes TEXT NOT NULL,
        attempted_at TEXT NOT NULL CHECK (attempted_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, store_uuid, attempt_id),
        -- An ineligible attempt never reached an outcome, and an eligible one
        -- always did. The two halves cannot borrow each other's columns.
        CHECK ((eligible = 0) = (outcome = 'ineligible')),
        CHECK ((eligible = 0) = (ineligible_reason IS NOT NULL)),
        CHECK ((eligible = 1) = (attachment_state IS NOT NULL)),
        CHECK ((eligible = 1) = (target_count IS NOT NULL)),
        -- Attaching means naming what you attached to; parking means not.
        CHECK (attachment_state IS NOT 'attached' OR chosen_entity_id IS NOT NULL),
        CHECK (outcome <> 'conflicting_attachment'
               OR (prior_entity_id IS NOT NULL AND prior_resolution_event_id IS NOT NULL))
    );
    CREATE INDEX resolver_outcomes_by_outcome
        ON resolver_outcomes (vault_id, store_uuid, outcome, attempted_at);

    CREATE TABLE run_cost_components (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        run_id TEXT NOT NULL CHECK (run_id <> ''),
        component TEXT NOT NULL CHECK (component IN (
            'uncached_input_tokens', 'cache_read_tokens', 'cache_write_tokens',
            'output_tokens', 'retrieval_calls', 'tool_calls',
            'selected_context_bytes', 'selected_context_tokens',
            'prompt_template_bytes', 'prompt_template_tokens'
        )),
        unit TEXT NOT NULL CHECK (unit IN ('tokens', 'calls', 'bytes')),
        model_id TEXT CHECK (model_id IS NULL OR model_id <> ''),
        quantity INTEGER NOT NULL CHECK (quantity >= 0),
        observed_cost_micros INTEGER
            CHECK (observed_cost_micros IS NULL OR observed_cost_micros >= 0),
        pricing_snapshot_id TEXT
            CHECK (pricing_snapshot_id IS NULL OR pricing_snapshot_id <> ''),
        recorded_at TEXT NOT NULL CHECK (recorded_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, store_uuid, run_id, component),
        -- The unit belongs to the component, not to the caller.
        CHECK (
            (component IN ('uncached_input_tokens', 'cache_read_tokens',
                           'cache_write_tokens', 'output_tokens',
                           'selected_context_tokens', 'prompt_template_tokens')
             AND unit = 'tokens')
            OR (component IN ('retrieval_calls', 'tool_calls') AND unit = 'calls')
            OR (component IN ('selected_context_bytes', 'prompt_template_bytes')
                AND unit = 'bytes')
        ),
        -- Model accounting needs a model. The call, context, and template
        -- rows are measurements of what we did, not of what a model charged.
        CHECK (component NOT IN ('uncached_input_tokens', 'cache_read_tokens',
                                 'cache_write_tokens', 'output_tokens')
               OR model_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX run_cost_components_once
        ON run_cost_components (run_id, component);

    CREATE TABLE assembly_metrics (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        run_id TEXT NOT NULL CHECK (run_id <> ''),
        manifest_id TEXT NOT NULL
            CHECK (length(manifest_id) = 32 AND manifest_id = lower(manifest_id)),
        intended_stakes TEXT NOT NULL
            CHECK (intended_stakes IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        source_count INTEGER NOT NULL CHECK (source_count >= 0),
        evidence_item_count INTEGER NOT NULL CHECK (evidence_item_count >= 0),
        context_bytes INTEGER NOT NULL CHECK (context_bytes >= 0),
        retrieval_query_count INTEGER NOT NULL CHECK (retrieval_query_count >= 0),
        blocked_intent_count INTEGER NOT NULL CHECK (blocked_intent_count >= 0),
        recorded_at TEXT NOT NULL CHECK (recorded_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, store_uuid, run_id, manifest_id)
    );

    -- The taint table, rebuilt with an explicit verdict. SQLite cannot add a
    -- CHECK to a live table, and the invariant is worth a rebuild: `signals`
    -- alone made 'we looked and found nothing' and 'we never looked' the same
    -- row.
    ALTER TABLE source_taint_assessments RENAME TO source_taint_assessments_v4;
    CREATE TABLE source_taint_assessments (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        observation_event_id TEXT NOT NULL,
        classifier_version TEXT NOT NULL,
        verdict TEXT NOT NULL
            CHECK (verdict IN ('no_signal', 'suspected_instructional_content')),
        signals TEXT NOT NULL,
        assessed_at TEXT NOT NULL CHECK (assessed_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, store_uuid, observation_event_id, classifier_version),
        CHECK ((verdict = 'no_signal') = (signals = ''))
    );
    INSERT INTO source_taint_assessments
        (vault_id, store_uuid, observation_event_id, classifier_version,
         verdict, signals, assessed_at)
        SELECT vault_id, store_uuid, observation_event_id, classifier_version,
               CASE WHEN signals = '' THEN 'no_signal'
                    ELSE 'suspected_instructional_content' END,
               signals, assessed_at
        FROM source_taint_assessments_v4;
    DROP TABLE source_taint_assessments_v4;
    CREATE INDEX source_taint_suspected
        ON source_taint_assessments (vault_id, store_uuid)
        WHERE verdict = 'suspected_instructional_content';
";

/// The M26.8 schema — scheduled convergence output, disposable by design.
///
/// **This table is a cache, and the schema says so.** A convergence output is
/// a READING of the ledger between two sequence numbers, not a claim about
/// the world: there is no ledger event, no cross-run identity, no
/// user-editable projection, and deleting a row causes recomputation and
/// nothing else. §31's earned-persistence trigger is what a narrative object
/// would have to pass, and a scheduled background summary does not pass it.
///
/// `output_content_hash` is over the same canonical bytes stored in
/// `output_json`, so a re-run that found the identical answer is recognizable
/// as a repeat rather than stored twice.
///
/// `superseded_by_run_id` is a pointer, not a lifecycle: a newer run for an
/// overlapping window marks the older one so a surface can render the latest
/// without a max-by-date query racing an insert. The row stays readable.
pub const SCHEMA_V10: &str = "
    CREATE TABLE convergence_runs (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        run_id TEXT NOT NULL CHECK (run_id <> ''),
        from_seq INTEGER NOT NULL CHECK (from_seq >= 0),
        to_seq INTEGER NOT NULL CHECK (to_seq >= from_seq),
        trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'on_demand')),
        schema_version TEXT NOT NULL CHECK (schema_version <> ''),
        output_content_hash TEXT NOT NULL
            CHECK (length(output_content_hash) = 64
                   AND output_content_hash = lower(output_content_hash)),
        output_json TEXT NOT NULL CHECK (output_json <> ''),
        generated_at TEXT NOT NULL CHECK (generated_at LIKE '____-__-__T%Z'),
        superseded_by_run_id TEXT
            CHECK (superseded_by_run_id IS NULL OR superseded_by_run_id <> run_id),
        PRIMARY KEY (vault_id, store_uuid, run_id)
    );
    CREATE INDEX convergence_runs_latest
        ON convergence_runs (vault_id, store_uuid, generated_at)
        WHERE superseded_by_run_id IS NULL;
";

/// The M28.0 schema — the two governance tables, and ONLY those two.
///
/// **The registry authorizes nothing, and neither does this DDL.** A trigger
/// evaluation is a reading of already-persisted rows against the closed
/// artifact `shared/policy/trigger-registry.v1.json`; recording one changes
/// no ledger, no vault, no flag, and launches nothing. A `fired` row permits
/// exactly one thing — a dated plan document plus a matrix update in one
/// commit — and that permission lives in review, not in code.
///
/// **`trigger_input_snapshots` is immutable by contract.** `snapshot_id` is
/// the domain-separated hash of the canonical payload, so a rerun over the
/// same rows lands on the same id, and the writer refuses the same id with
/// different bytes — a snapshot that could be amended would make every
/// evaluation derived from it unreproducible, which is the one property the
/// table exists to provide. The payload keeps the CANONICAL SOURCE ROWS and
/// their distinct ids, not only aggregates, so each metric, day, bucket,
/// source, artifact, attempt, plan, and gap episode can be recomputed.
///
/// **The variant decides which columns exist, and the CHECKs say so.** A
/// measurable record carries a window and metrics and no evidence pack and
/// no owner; a discretionary record is the mirror image; a hybrid carries
/// both halves. Those are the design's closed union arms spelled as DDL, so
/// a row from a build with a looser validator still cannot land here.
///
/// **Scope is columns, not prose.** `subscription_global` rows carry NULL
/// vault/store (R1/R2 deliberately aggregate the whole subscription);
/// `vault_store` rows carry both, and the vault must be registered. A
/// cross-scope input is a refusal at the evaluator, but the row itself
/// cannot even express a half-scoped evaluation.
pub const SCHEMA_V11: &str = "
    CREATE TABLE trigger_input_snapshots (
        snapshot_id TEXT PRIMARY KEY
            CHECK (length(snapshot_id) = 64 AND snapshot_id = lower(snapshot_id)),
        registry_id TEXT NOT NULL CHECK (registry_id IN (
            'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7',
            'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14'
        )),
        subkey TEXT NOT NULL CHECK (subkey <> ''),
        scope_kind TEXT NOT NULL
            CHECK (scope_kind IN ('subscription_global', 'vault_store')),
        vault_id TEXT REFERENCES vault_registry (vault_id),
        store_uuid TEXT CHECK (store_uuid IS NULL OR store_uuid <> ''),
        rule_version TEXT NOT NULL CHECK (rule_version <> ''),
        payload_json TEXT NOT NULL CHECK (payload_json <> ''),
        collected_at TEXT NOT NULL CHECK (collected_at LIKE '____-__-__T%Z'),
        CHECK ((scope_kind = 'vault_store') = (vault_id IS NOT NULL)),
        CHECK ((scope_kind = 'vault_store') = (store_uuid IS NOT NULL))
    );
    CREATE INDEX trigger_input_snapshots_by_gate
        ON trigger_input_snapshots (registry_id, subkey, collected_at);

    CREATE TABLE trigger_evaluations (
        evaluation_id TEXT PRIMARY KEY
            CHECK (length(evaluation_id) = 64 AND evaluation_id = lower(evaluation_id)),
        registry_id TEXT NOT NULL CHECK (registry_id IN (
            'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7',
            'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14'
        )),
        subkey TEXT NOT NULL CHECK (subkey <> ''),
        variant TEXT NOT NULL
            CHECK (variant IN ('measurable', 'discretionary', 'hybrid')),
        scope_kind TEXT NOT NULL
            CHECK (scope_kind IN ('subscription_global', 'vault_store')),
        vault_id TEXT REFERENCES vault_registry (vault_id),
        store_uuid TEXT CHECK (store_uuid IS NULL OR store_uuid <> ''),
        evaluated_at TEXT NOT NULL CHECK (evaluated_at LIKE '____-__-__T%Z'),
        window_start TEXT CHECK (window_start IS NULL OR window_start <> ''),
        window_end TEXT CHECK (window_end IS NULL OR window_end >= window_start),
        window_timezone TEXT CHECK (window_timezone IS NULL OR window_timezone <> ''),
        input_snapshot_refs_json TEXT NOT NULL CHECK (input_snapshot_refs_json <> ''),
        input_snapshot_hash TEXT NOT NULL
            CHECK (length(input_snapshot_hash) = 64
                   AND input_snapshot_hash = lower(input_snapshot_hash)),
        metrics_json TEXT CHECK (metrics_json IS NULL OR metrics_json <> ''),
        evidence_pack_path TEXT
            CHECK (evidence_pack_path IS NULL OR evidence_pack_path <> ''),
        result TEXT NOT NULL CHECK (result IN ('not_ready', 'not_fired', 'fired')),
        rule_version TEXT NOT NULL CHECK (rule_version <> ''),
        approving_owner TEXT
            CHECK (approving_owner IS NULL OR approving_owner <> ''),
        parent_evaluation_id TEXT
            REFERENCES trigger_evaluations (evaluation_id)
            CHECK (parent_evaluation_id IS NULL
                   OR parent_evaluation_id <> evaluation_id),
        record_json TEXT NOT NULL CHECK (record_json <> ''),
        CHECK ((scope_kind = 'vault_store') = (vault_id IS NOT NULL)),
        CHECK ((scope_kind = 'vault_store') = (store_uuid IS NOT NULL)),
        -- The union arms as arithmetic: a window and metrics belong to the
        -- measuring variants, an evidence pack and an owner to the
        -- discretionary ones, and hybrid is exactly both halves.
        CHECK ((variant = 'discretionary') = (window_start IS NULL)),
        CHECK ((variant = 'discretionary') = (window_end IS NULL)),
        CHECK ((variant = 'discretionary') = (window_timezone IS NULL)),
        CHECK ((variant = 'discretionary') = (metrics_json IS NULL)),
        CHECK ((variant = 'measurable') = (evidence_pack_path IS NULL)),
        CHECK ((variant = 'measurable') = (approving_owner IS NULL))
    );
    CREATE INDEX trigger_evaluations_by_gate
        ON trigger_evaluations (registry_id, subkey, evaluated_at);
";

/// The M31.5 schema — the run facts the CLI was already sending, and the two
/// columns M31.6 went on to write.
///
/// **Landed whole, before anything writes the M31.6 halves (D5).** A
/// committed migration's text is immutable — the runner only executes steps
/// with `to > version`, so a column added to committed DDL later would
/// silently never reach a database already stamped 12. That is why
/// `estimated` (M31.6's exact-vs-estimated cost provenance on
/// `run_cost_components`) and `answer_latency_micros` (M31.6 writes it on
/// `assembly_metrics`, R15's gate reads it — a gate may only name a
/// persisted primitive) were part of this step even though nothing wrote
/// them until M31.6 landed.
///
/// **Every fact column is nullable, and NULL is the honest answer** — for a
/// run predating this migration, and for a stream that never said. Absent is
/// never zero; the one non-null addition (`estimated`) defaults to 0 because
/// every component row written before M31.6 was, in fact, exact.
pub const SCHEMA_V12: &str = "
    ALTER TABLE runs ADD COLUMN model_id TEXT;
    ALTER TABLE runs ADD COLUMN stop_reason TEXT;
    ALTER TABLE runs ADD COLUMN service_tier TEXT;
    ALTER TABLE runs ADD COLUMN total_cost_micros INTEGER
        CHECK (total_cost_micros IS NULL OR total_cost_micros >= 0);
    ALTER TABLE runs ADD COLUMN num_turns INTEGER;
    ALTER TABLE runs ADD COLUMN duration_ms INTEGER;
    ALTER TABLE runs ADD COLUMN duration_api_ms INTEGER;
    ALTER TABLE runs ADD COLUMN cache_write_5m INTEGER;
    ALTER TABLE runs ADD COLUMN cache_write_1h INTEGER;
    ALTER TABLE runs ADD COLUMN server_tool_use INTEGER;
    ALTER TABLE run_cost_components ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0
        CHECK (estimated IN (0, 1));
    ALTER TABLE assembly_metrics ADD COLUMN answer_latency_micros INTEGER;
";

/// M33.1 — runs learn who ran them.
///
/// Nullable by design. Rows written before this migration are unattributed
/// and STAY that way: nothing backfills, and nothing guesses. A run whose
/// spawn site named nobody reads as "unattributed" in the fleet, which is
/// the truth — absent is never zero, and in the one table whose whole job is
/// to say honestly what the app spent, an invented attribution is worse than
/// an admitted gap.
///
/// The value is an actor string, minted by the spawn site and shared with the
/// ledger's `generated.by` for the same run rather than forked into a second
/// vocabulary: `agent:m26-ingest` and its two siblings for the internal
/// constructs (see `agent::meter::CONSTRUCT_ACTORS`), `process:<slug>` for an
/// Agent record's run, absent for bare attended chat.
///
/// The index is `(actor, started_at)` because every query that filters by
/// actor also orders by recency — an agent's dossier asks for exactly one
/// actor's runs, newest first, and would otherwise scan the table.
pub const SCHEMA_V13: &str = "
    ALTER TABLE runs ADD COLUMN actor TEXT;
    CREATE INDEX runs_by_actor ON runs (actor, started_at);
";

/// M33b.1 — the ambient lease stops being a singleton.
///
/// **What the singleton row guaranteed, and what replaces it.** The v3 table
/// carried `singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'ambient')`,
/// so the database could hold at most one ambient lease. Four properties fell
/// out of that one column, and each is now carried by something else:
///
/// 1. *Mutual exclusion at claim time.* Now the claim transaction, which was
///    always the real mechanism: `dispatch::claim` opens `BEGIN IMMEDIATE`,
///    and the gate counts live leases inside it. Two dispatchers cannot
///    interleave a count and an insert, so the count a claim acts on is the
///    count at commit. The primary key only ever fired in one case the gate
///    did not already cover — see `budget::ambient_leases_held`.
/// 2. *Crash recovery.* Unchanged, and it never lived here: recovery sweeps
///    `runs` by `lease_expires_at`, not this table.
/// 3. *Accounting.* Unchanged, and it never lived here either. Spend is a
///    `runs` row plus a `budget_days` reservation, one pair per run; N runs
///    make N pairs, and the gate sums them.
/// 4. *Headroom for attended chat inside `agent::MAX_CONCURRENT_RUNS`.* Now
///    the Settings ceiling, which defaults to 1 — the same headroom, until a
///    person raises it.
///
/// **`run_id` is the key now, and it is the honest one.** It was already
/// `NOT NULL UNIQUE` in v3, so no row's identity changes and the copy cannot
/// collide; a lease has always been one run's, and the singleton column was
/// the only thing pretending otherwise. SQLite cannot drop a primary key in
/// place, so this is the create-new / copy / drop / rename dance — with the
/// live rows carried across, because a database migrated mid-run must come
/// back holding the lease it held.
///
/// The index is on `lease_expires_at` because the gate's one question is "how
/// many leases have not expired", asked on every dispatch attempt.
pub const SCHEMA_V14: &str = "
    ALTER TABLE ambient_dispatch RENAME TO ambient_dispatch_v13;
    CREATE TABLE ambient_dispatch (
        run_id TEXT PRIMARY KEY REFERENCES runs (run_id),
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        store_uuid TEXT NOT NULL,
        lane TEXT NOT NULL REFERENCES lane_registry (lane),
        acquired_at TEXT NOT NULL CHECK (acquired_at LIKE '____-__-__T%Z'),
        lease_expires_at TEXT NOT NULL CHECK (lease_expires_at LIKE '____-__-__T%Z')
    );
    INSERT INTO ambient_dispatch
        (run_id, vault_id, store_uuid, lane, acquired_at, lease_expires_at)
        SELECT run_id, vault_id, store_uuid, lane, acquired_at, lease_expires_at
        FROM ambient_dispatch_v13;
    DROP TABLE ambient_dispatch_v13;
    CREATE INDEX ambient_dispatch_live ON ambient_dispatch (lease_expires_at);
";

/// M34.3 — a run can be started by another run, and the chain must be
/// walkable from the table alone. `parent_run_id` names the run whose tool
/// call started this one; NULL is every run a person or a schedule started —
/// the roots. A chain's total cost is the sum over the tree, derived at read
/// time, never stored: a stored total would go stale the moment a late child
/// finalized. The index is bare because the one query is "children of this
/// run", and it already arrives holding the parent's id.
pub const SCHEMA_V15: &str = "
    ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
    CREATE INDEX runs_by_parent ON runs (parent_run_id);
";
