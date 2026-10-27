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
/// call or recorded write started this one; NULL names a root. A chain's total cost is the sum over the tree, derived at read
/// time, never stored: a stored total would go stale the moment a late child
/// finalized. The index is bare because the one query is "children of this
/// run", and it already arrives holding the parent's id.
pub const SCHEMA_V15: &str = "
    ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
    CREATE INDEX runs_by_parent ON runs (parent_run_id);
";

/// M34.2 — the job runner's three ledgers move out of localStorage.
///
/// One row per (vault, ledger, key): `attempts` and `skillRuns` remember the
/// last run_key answered (a note version, a fire key) and are written through
/// a CLAIM — conditional on the stored key differing — so two windows deriving
/// the same due job race for one insert and the loser spawns nothing.
/// `triggerRuns` is a cooldown clock, last-write-wins. The table is the
/// duplicate-spend guard the renderer's localStorage never was: a webview data
/// wipe used to re-fire every schedule ever answered.
pub const SCHEMA_V16: &str = "
    CREATE TABLE job_ledger (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        ledger TEXT NOT NULL CHECK (ledger IN ('attempts', 'skillRuns', 'triggerRuns')),
        key TEXT NOT NULL CHECK (length(key) > 0),
        run_key TEXT NOT NULL CHECK (length(run_key) > 0),
        recorded_at TEXT NOT NULL CHECK (recorded_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, ledger, key)
    );
";

/// The M49.10 step (the 2026-09 owner decision, Q4): ordinary vault writes
/// — a note saved, patched, renamed, deleted — are OPERATIONAL history, not
/// epistemic. They were appended to the vault ledger's tamper-evident chain
/// as `vault.*` shadow events that nothing read (write amplification, F96);
/// they are recorded here instead.
pub const SCHEMA_V17: &str = "
    CREATE TABLE vault_writes (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        kind TEXT NOT NULL CHECK (kind IN ('vault.write', 'vault.rename', 'vault.delete')),
        path TEXT NOT NULL CHECK (length(path) > 0),
        to_path TEXT CHECK (to_path IS NULL OR length(to_path) > 0),
        content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) = 64),
        actor TEXT,
        recorded_at TEXT NOT NULL CHECK (recorded_at LIKE '____-__-__T%Z'),
        CHECK ((kind = 'vault.rename') = (to_path IS NOT NULL))
    );
    CREATE INDEX vault_writes_by_path ON vault_writes (vault_id, path);
";

/// M49.9 (K25): `runs.counters_booked`. Before M49.9 nothing wrote
/// `proposals_submitted`/`applied`/`rejected` — they were inserted as 0 and
/// stayed there, so a legacy row's zeros are NOT a measurement. Every row
/// that exists at this migration keeps the default 0 and reads as "not
/// recorded". From here on a row is stamped 1 only if it stands WHILE its run
/// writes, which is the promise that the policy commit path
/// (`CommitOutcome::book`) and the human decision path (`book_decision`)
/// count against it: the ambient claim's INSERT, and the attended row
/// `dispatch::begin_attended` opens before the child spawns. An attended row
/// the meter could only write at the END (`meter_attended` with nothing
/// opened) is stamped 0 — no booking could have reached it. Its own version
/// rather than part of v17, because a dev database may already stand at 17.
pub const SCHEMA_V18: &str = "
    ALTER TABLE runs ADD COLUMN counters_booked INTEGER NOT NULL DEFAULT 0
        CHECK (counters_booked IN (0, 1));
";

/// M54.11 — the last status each connector was seen in, per vault.
///
/// One row per (vault, connector), keyed by the connector's name in the
/// vault's list. `state` is what the newest observation concluded, `signal`
/// what in its run's stream decided it, and `seen_at` and `run_id` when and
/// which run. No row means not observed yet: no run has used the connector,
/// or none said anything either way (an init that read `pending`, a server
/// the stream never mentioned). A newer observation replaces an older one
/// whatever order the runs finish in (`connector_status::record`).
///
/// Names, states, times and run ids only. No URL, header or token is ever
/// stored here.
///
/// The signal CHECK also names `authenticate` and `server_error`, which CLI
/// 2.1.250 does not emit in `-p` (recorded on toy servers: no
/// `mcp__<server>__authenticate` tool, no server-error key in the result), so
/// nothing writes them yet and a build that measures them needs no rebuild.
pub const SCHEMA_V19: &str = "
    CREATE TABLE connector_status (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        connector TEXT NOT NULL CHECK (length(connector) > 0),
        state TEXT NOT NULL
            CHECK (state IN ('working', 'needs_sign_in', 'failed', 'not_approved')),
        signal TEXT NOT NULL
            CHECK (signal IN ('init', 'tool_result', 'tool_errors', 'permission_denial',
                              'authenticate', 'server_error')),
        seen_at TEXT NOT NULL CHECK (seen_at LIKE '____-__-__T%Z'),
        run_id TEXT NOT NULL CHECK (length(run_id) > 0),
        PRIMARY KEY (vault_id, connector)
    );
";

/// M56.7 — why a run started, and the Claude Code session it ran as.
///
/// `runs.cause` is a JSON object whose `kind` is one of the ten in
/// `runtime::cause::WORDS` at that time (v28 adds client), in that order,
/// at most 2048 characters. The kind
/// test sits in `coalesce(…, 0)` because SQLite passes a CHECK that reads
/// NULL, and an object with no `kind` would read exactly that. Written
/// with the run row, by the runtime only: the claim, the attended open and
/// the meter's fallback insert (`dispatch`). Nullable and never backfilled —
/// a row from before this step holds NULL, read as "why not recorded".
///
/// `runs.cli_session_id` is the Claude Code session the run ran as, 8 to
/// 64 characters of `[0-9A-Za-z-]` and never a leading `-`, so neither a path
/// nor a flag fits. Written by the meter when the child spawns, with the id
/// Cerebro minted or resumed (M56.3), and again when the run finishes, with
/// the one its stream reported (`dispatch::record_cli_session`). Nullable and
/// never backfilled too.
pub const SCHEMA_V20: &str = "
    ALTER TABLE runs ADD COLUMN cause TEXT CHECK (cause IS NULL OR (
        json_valid(cause) AND json_type(cause) = 'object'
        AND coalesce(json_extract(cause, '$.kind') IN ('schedule', 'event', 'assigned', 'handoff', 'manual', 'followup', 'attended', 'ingest', 'maintenance', 'assembly'), 0)
        AND length(cause) <= 2048));
    ALTER TABLE runs ADD COLUMN cli_session_id TEXT CHECK (cli_session_id IS NULL OR (
        length(cli_session_id) BETWEEN 8 AND 64
        AND NOT cli_session_id GLOB '*[^0-9A-Za-z-]*'
        AND NOT cli_session_id GLOB '-*'));
";

/// The M56.9 schema — the two indexes a run's detail reads by.
///
/// `operational_log_by_run` is the index M54 left for this step: refusals
/// have carried their run's id since M54.9, and the run detail lists them in
/// id order. `runs_by_cli_session` finds the runs that share one Claude Code
/// session, so a transcript can say how many it holds. Both are partial: a
/// row with no run, or a run with no session, is never looked up this way.
pub const SCHEMA_V21: &str = "
    CREATE INDEX operational_log_by_run ON operational_log (run_id, id)
        WHERE run_id IS NOT NULL;
    CREATE INDEX runs_by_cli_session ON runs (cli_session_id)
        WHERE cli_session_id IS NOT NULL;
";

/// M57.4c — the page writes an ask-first agent queued for the person.
///
/// A run nobody watches cannot ask, so an ask-first agent's confirmable write
/// waits here for Review instead of landing (`runtime::pending_writes`). One
/// queue, two doors: the MCP door queues a row, and Review's Allow or Reject
/// decides it. Operational, never epistemic: the vault and the ledger hear of
/// a pending write only once it is applied, through the write itself.
///
/// - `pending_id` is 128 bits of lowercase hex; `vault_id` a registered vault.
/// - `actor` is always a `process:` agent: only an agent asks first. `tool` is
///   1 to 64 characters, with no tool list here (CV-04): Rust inserts only
///   the manifest's confirmable rows.
/// - `target` is the page or folder the write names (at most 1024
///   characters), and `target_hash` the SHA-256 of the page's bytes when it
///   was queued, NULL for a page that did not exist yet.
/// - `input` is the agent's draft, a key-sorted JSON object of at most
///   256 KiB (the table's `queue_limits.input_bytes`), `input_hash` its
///   canonical hash, and `grant_json` the queuing run's grant, which the
///   apply re-runs every guard under.
/// - `state` is pending until a person decides. `applying` is the claim, so
///   two decisions cannot both apply; `applied`, `rejected` and `refused` are
///   decided; `interrupted` is an apply a crash cut short, which the agent is
///   told to check. `decided_at` is NULL exactly while pending, a rejection
///   and a refusal carry their `reason`, and `reported_run_id` names the run
///   that heard the outcome, only once decided.
/// - `pending_writes_open_once` keeps one open row per vault, actor, tool and
///   input: the dedupe is a constraint, never a read-then-write. A rejected
///   write can be queued again.
pub const SCHEMA_V22: &str = "
    CREATE TABLE pending_writes (
        pending_id TEXT PRIMARY KEY
            CHECK (length(pending_id) = 32 AND NOT pending_id GLOB '*[^0-9a-f]*'),
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        run_id TEXT NOT NULL CHECK (length(run_id) > 0),
        actor TEXT NOT NULL CHECK (actor LIKE 'process:_%'),
        tool TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 64),
        target TEXT NOT NULL CHECK (length(target) <= 1024),
        target_hash TEXT CHECK (target_hash IS NULL OR (
            length(target_hash) = 64 AND NOT target_hash GLOB '*[^0-9a-f]*')),
        input TEXT NOT NULL CHECK (
            json_valid(input) AND json_type(input) = 'object' AND length(input) <= 262144),
        input_hash TEXT NOT NULL
            CHECK (length(input_hash) = 64 AND NOT input_hash GLOB '*[^0-9a-f]*'),
        grant_json TEXT NOT NULL
            CHECK (json_valid(grant_json) AND json_type(grant_json) = 'object'),
        queued_at TEXT NOT NULL CHECK (queued_at LIKE '____-__-__T%Z'),
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
            ('pending', 'applying', 'applied', 'rejected', 'refused', 'interrupted')),
        decided_at TEXT CHECK (decided_at IS NULL OR decided_at LIKE '____-__-__T%Z'),
        decided_by TEXT CHECK (decided_by IS NULL OR length(decided_by) BETWEEN 1 AND 256),
        reason TEXT CHECK (reason IS NULL OR length(reason) <= 4096),
        applied_input TEXT CHECK (applied_input IS NULL OR (
            json_valid(applied_input) AND json_type(applied_input) = 'object'
            AND length(applied_input) <= 262144)),
        result TEXT CHECK (result IS NULL OR length(result) <= 4096),
        reported_run_id TEXT CHECK (reported_run_id IS NULL OR length(reported_run_id) > 0),
        CHECK ((state = 'pending') = (decided_at IS NULL)),
        CHECK (state NOT IN ('rejected', 'refused') OR length(trim(coalesce(reason, ''))) > 0),
        CHECK (reported_run_id IS NULL OR state NOT IN ('pending', 'applying'))
    );
    CREATE UNIQUE INDEX pending_writes_open_once
        ON pending_writes (vault_id, actor, tool, input_hash) WHERE state = 'pending';
    CREATE INDEX pending_writes_open ON pending_writes (vault_id, queued_at)
        WHERE state = 'pending';
    CREATE INDEX pending_writes_unreported ON pending_writes (vault_id, actor, decided_at)
        WHERE reported_run_id IS NULL AND state NOT IN ('pending', 'applying');
";

/// M58.1 — every vault write records who made it, in which run.
///
/// `vault_writes` is rebuilt the v14 way (rename, create, copy in rowid
/// order, drop, then the indexes), because a CHECK cannot change in place:
///
/// - `kind` keeps the three kinds v17 admits and adds `vault.create` (a file
///   that did not exist) and `vault.comment` (a page's comment sidecar,
///   M70.2), which never counts as a change to the page.
/// - `run_id` is the run a write belongs to: NULL for a person's write or
///   the app's, never empty.
/// - `approved_by` names who allowed a run's write (M57 Q21): NULL, or a
///   `human:` actor, and only on a run's row.
/// - `first_at` is when an autosave burst began, `recorded_at` its latest
///   write (`runtime::vault_writes`, Q3). A copied row's burst is itself.
///
/// Every earlier row survives with NULL run and approver: v17 recorded
/// neither. The indexes serve a page's history (by path), a time window
/// (by time) and a run's writes (by run, only where one is set).
///
/// `runs.writes_booked` says whether a run's writes are in that table: 1
/// for every row from here on (the default, so no INSERT changes), 2 for a
/// run whose plan let the CLI's own writers or the shell run (booked, but
/// the shell may have written elsewhere), and 0 for every run before this
/// step, whose writes read as not recorded rather than as none.
pub const SCHEMA_V23: &str = "
    ALTER TABLE vault_writes RENAME TO vault_writes_v17;
    CREATE TABLE vault_writes (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        kind TEXT NOT NULL CHECK (kind IN
            ('vault.write', 'vault.create', 'vault.rename', 'vault.delete', 'vault.comment')),
        path TEXT NOT NULL CHECK (length(path) > 0),
        to_path TEXT CHECK (to_path IS NULL OR length(to_path) > 0),
        content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) = 64),
        actor TEXT,
        run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
        approved_by TEXT CHECK (approved_by IS NULL OR
            (approved_by LIKE 'human:_%' AND run_id IS NOT NULL)),
        first_at TEXT NOT NULL CHECK (first_at LIKE '____-__-__T%Z'),
        recorded_at TEXT NOT NULL CHECK (recorded_at LIKE '____-__-__T%Z'),
        CHECK ((kind = 'vault.rename') = (to_path IS NOT NULL))
    );
    INSERT INTO vault_writes (rowid, vault_id, kind, path, to_path, content_hash, actor,
                              run_id, approved_by, first_at, recorded_at)
        SELECT rowid, vault_id, kind, path, to_path, content_hash, actor, NULL, NULL,
               recorded_at, recorded_at
        FROM vault_writes_v17 ORDER BY rowid;
    DROP TABLE vault_writes_v17;
    CREATE INDEX vault_writes_by_path ON vault_writes (vault_id, path);
    CREATE INDEX vault_writes_by_time ON vault_writes (vault_id, recorded_at);
    CREATE INDEX vault_writes_by_run ON vault_writes (run_id) WHERE run_id IS NOT NULL;
    ALTER TABLE runs ADD COLUMN writes_booked INTEGER NOT NULL DEFAULT 1
        CHECK (writes_booked IN (0, 1, 2));
    UPDATE runs SET writes_booked = 0;
";

/// M58.4 — which run made which commit.
///
/// `run_commits` is the one record History names an agent from (CV-35): a
/// run's commit (`git::changeset::settle_run`) writes its row right after
/// `git commit` hands back the full hash, and nothing else writes one. A
/// trailer, a message or a git author never names a run; a commit with no
/// row here reads "unattributed".
///
/// - `commit_sha`: the full hash, 40 hex (sha1) or 64 (sha256), lowercase,
///   so a short or upper-case spelling can never match.
/// - `committed_at`: when the row was written, the stored spelling, so it
///   compares with `vault_writes` times as a string.
///
/// Keyed by vault and hash: the same commit seen from two vaults that share
/// a repository is two rows, each naming its own run.
pub const SCHEMA_V24: &str = "
    CREATE TABLE run_commits (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        commit_sha TEXT NOT NULL CHECK (length(commit_sha) IN (40, 64)
            AND NOT commit_sha GLOB '*[^0-9a-f]*'),
        run_id TEXT NOT NULL REFERENCES runs (run_id),
        committed_at TEXT NOT NULL CHECK (committed_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, commit_sha)
    );
";

/// M63.1 — durable wakes: each trigger match is admitted once, claimed
/// inside the dispatch transaction, and ends in a closed outcome.
///
/// The CHECKs bound lengths and the lifecycle only. Key shapes per cause
/// kind, cause kinds, skip reasons and cancel whys are closed lists in Rust
/// (`runtime::wakes`), so a later kind or reason needs no rebuild.
///
/// - `wake_key`: 1 to 96 characters; an event wake's is 64 hex.
/// - `trigger_digest`: the 16 hex of the trigger that matched, so a claim
///   coalesces only wakes of the same trigger.
/// - `cause`: the cleaned cause the run will record, written at admission.
/// - `not_before` and `deferred`: when a deferred pending wake may be tried
///   again, and the gate's reasons.
/// - `note`: skip context, a JSON object, on a skipped row only.
///
/// One lifecycle CHECK: a pending wake has no run, times, outcome, reason,
/// detail or note; a started one has its run and start and no retry; a
/// finished one has its end and outcome, a run exactly for succeeded,
/// failed, interrupted and coalesced, a reason exactly for skipped and
/// cancelled, a detail only when cancelled and a note only when skipped.
///
/// The unique key covers LIVE wakes only (pending and started): content keys
/// repeat, so a change removed and made again must wake again. Single flight
/// is a second partial UNIQUE: one started wake per agent.
pub const SCHEMA_V25: &str = "
    CREATE TABLE agent_wakes (
        wake_id TEXT PRIMARY KEY
            CHECK (length(wake_id) = 32 AND NOT wake_id GLOB '*[^0-9a-f]*'),
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        agent TEXT NOT NULL CHECK (agent LIKE 'process:_%' AND length(agent) <= 128),
        wake_key TEXT NOT NULL CHECK (length(wake_key) BETWEEN 1 AND 96),
        trigger_digest TEXT NOT NULL CHECK (length(trigger_digest) = 16
            AND NOT trigger_digest GLOB '*[^0-9a-f]*'),
        cause TEXT NOT NULL CHECK (
            json_valid(cause) AND json_type(cause) = 'object' AND length(cause) <= 2048),
        admitted_at TEXT NOT NULL CHECK (admitted_at LIKE '____-__-__T%Z'),
        not_before TEXT CHECK (not_before IS NULL OR not_before LIKE '____-__-__T%Z'),
        deferred TEXT CHECK (deferred IS NULL OR length(deferred) BETWEEN 1 AND 400),
        state TEXT NOT NULL DEFAULT 'pending'
            CHECK (state IN ('pending', 'started', 'finished')),
        run_id TEXT REFERENCES runs (run_id),
        started_at TEXT CHECK (started_at IS NULL OR started_at LIKE '____-__-__T%Z'),
        finished_at TEXT CHECK (finished_at IS NULL OR finished_at LIKE '____-__-__T%Z'),
        outcome TEXT CHECK (outcome IS NULL OR outcome IN
            ('succeeded', 'failed', 'skipped', 'cancelled', 'interrupted', 'coalesced')),
        reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 32),
        detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 32),
        note TEXT CHECK (note IS NULL OR (
            json_valid(note) AND json_type(note) = 'object' AND length(note) <= 2048)),
        CHECK (CASE state
            WHEN 'pending' THEN run_id IS NULL AND started_at IS NULL AND finished_at IS NULL
                AND outcome IS NULL AND reason IS NULL AND detail IS NULL AND note IS NULL
            WHEN 'started' THEN run_id IS NOT NULL AND started_at IS NOT NULL
                AND not_before IS NULL AND deferred IS NULL AND finished_at IS NULL
                AND outcome IS NULL AND reason IS NULL AND detail IS NULL AND note IS NULL
            ELSE finished_at IS NOT NULL AND outcome IS NOT NULL
                AND (run_id IS NOT NULL) =
                    (outcome IN ('succeeded', 'failed', 'interrupted', 'coalesced'))
                AND (reason IS NOT NULL) = (outcome IN ('skipped', 'cancelled'))
                AND (detail IS NULL OR outcome = 'cancelled')
                AND (note IS NULL OR outcome = 'skipped')
        END)
    );
    CREATE UNIQUE INDEX agent_wakes_live_key ON agent_wakes (vault_id, agent, wake_key)
        WHERE state IN ('pending', 'started');
    CREATE UNIQUE INDEX agent_wakes_single_flight ON agent_wakes (vault_id, agent)
        WHERE state = 'started';
    CREATE INDEX agent_wakes_pending ON agent_wakes (vault_id, agent)
        WHERE state = 'pending';
    CREATE INDEX agent_wakes_by_run ON agent_wakes (run_id) WHERE run_id IS NOT NULL;
";

/// M60.6 — the batch journal: one row per database-wide change in flight,
/// holding what recovery needs to put every page back.
///
/// - `batch_id`: 32 lowercase hex.
/// - `state`: `staged` once every temp is written, `applying` from the first
///   rename. Either way an unfinished row is rolled back.
/// - `files`: a JSON array, one object per page the change writes: its path,
///   staged temp, pre-image and both hashes, and the Trash stamp a delete or
///   restore moves through (`runtime::batch_journal::JournalFile`). No CHECK
///   names an op kind, so a later op (M60.10's renames) needs no rebuild.
///   At most 64 MiB: a change holds 16 MiB of pages, before and after.
/// - `actor`: a person (`human:%`). Only a person's doors start a batch.
/// - `started_at`: the stored spelling, so recovery compares it with the
///   process start as a string.
///
/// A row lives only while its batch runs: the commit deletes it, so an
/// empty table is the healthy one. Operational, never the ledger (CV-06).
pub const SCHEMA_V26: &str = "
    CREATE TABLE batch_journal (
        batch_id TEXT PRIMARY KEY
            CHECK (length(batch_id) = 32 AND NOT batch_id GLOB '*[^0-9a-f]*'),
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        state TEXT NOT NULL CHECK (state IN ('staged', 'applying')),
        files TEXT NOT NULL CHECK (json_valid(files) AND json_type(files) = 'array'
            AND length(files) <= 67108864),
        actor TEXT NOT NULL CHECK (actor LIKE 'human:%'),
        started_at TEXT NOT NULL CHECK (started_at LIKE '____-__-__T%Z')
    );
    CREATE INDEX batch_journal_by_vault ON batch_journal (vault_id, started_at);
";

/// M64.3 — durable, vault-scoped reminder claims and revision-aware Done marks.
pub const SCHEMA_V27: &str = "
    CREATE TABLE reminder_fires (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
        chip TEXT NOT NULL CHECK (length(chip) = 16 AND NOT chip GLOB '*[^0-9a-f]*'),
        ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
        fire_at TEXT NOT NULL CHECK (length(fire_at) = 16
            AND fire_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'
            AND substr(fire_at, 1, 4) BETWEEN '0001' AND '9999'
            AND datetime(fire_at, '+0 days') IS NOT NULL
            AND strftime('%Y-%m-%dT%H:%M', fire_at, '+0 days') = fire_at),
        outcome TEXT NOT NULL CHECK (outcome IN ('fired', 'missed', 'moved', 'imported')),
        claimed_at TEXT NOT NULL CHECK (claimed_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, path, chip, ordinal, fire_at)
    );
    CREATE TABLE done_marks (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        lane TEXT NOT NULL CHECK (lane IN ('insight', 'run', 'reminder', 'change')),
        subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 1024),
        until TEXT NOT NULL CHECK (until IN ('revision', 'forever')),
        revision TEXT CHECK (revision IS NULL OR length(revision) BETWEEN 1 AND 256),
        marked_at TEXT NOT NULL CHECK (marked_at LIKE '____-__-__T%Z'),
        CHECK ((until = 'revision') = (revision IS NOT NULL)),
        PRIMARY KEY (vault_id, lane, subject)
    );
";

/// M62.5 — personal token fingerprints and one new runtime-only cause.
/// The cause column is copied inside the migration's BEGIN IMMEDIATE; every
/// row, run foreign key and existing cause survives, or the whole step rolls
/// back. No plaintext token is a column in this database.
pub const SCHEMA_V28: &str = "
    CREATE TABLE client_tokens (
        token_id TEXT PRIMARY KEY NOT NULL CHECK (length(token_id) = 32
            AND NOT token_id GLOB '*[^0-9a-f]*'),
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 32
            AND NOT slug GLOB '*[^a-z0-9-]*'),
        secret_sha256 TEXT NOT NULL UNIQUE CHECK (length(secret_sha256) = 64
            AND NOT secret_sha256 GLOB '*[^0-9a-f]*'),
        toolsets TEXT NOT NULL CHECK (json_valid(toolsets) AND json_type(toolsets) = 'array'),
        write_scope TEXT NOT NULL CHECK (json_valid(write_scope) AND json_type(write_scope) = 'array'),
        read_scope TEXT CHECK (read_scope IS NULL OR
            (json_valid(read_scope) AND json_type(read_scope) = 'array')),
        created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T%Z'),
        last_used_at TEXT CHECK (last_used_at IS NULL OR last_used_at LIKE '____-__-__T%Z'),
        UNIQUE (vault_id, slug)
    );
    CREATE INDEX client_tokens_by_vault ON client_tokens (vault_id, created_at);
    ALTER TABLE runs ADD COLUMN cause_next TEXT CHECK (cause_next IS NULL OR (
        json_valid(cause_next) AND json_type(cause_next) = 'object'
        AND coalesce(json_extract(cause_next, '$.kind') IN ('schedule', 'event', 'assigned', 'handoff', 'manual', 'followup', 'attended', 'ingest', 'maintenance', 'assembly', 'client'), 0)
        AND length(cause_next) <= 2048));
    UPDATE runs SET cause_next = cause;
    ALTER TABLE runs DROP COLUMN cause;
    ALTER TABLE runs RENAME COLUMN cause_next TO cause;
";

/// M63.2 — who caused a wake, and the recorded run whose chain it extends.
/// Existing rows remain NULL: attribution cannot be reconstructed honestly.
pub const SCHEMA_V29: &str = "
    ALTER TABLE agent_wakes ADD COLUMN author TEXT
        CHECK (author IS NULL OR author IN ('person', 'run', 'not_recorded'));
    ALTER TABLE agent_wakes ADD COLUMN author_actor TEXT
        CHECK (author_actor IS NULL OR (length(author_actor) BETWEEN 1 AND 128
            AND author IS NOT NULL AND author IN ('person', 'run')));
    ALTER TABLE agent_wakes ADD COLUMN parent_run_id TEXT REFERENCES runs (run_id)
        CHECK (parent_run_id IS NULL OR author IS 'run');
";

/// M63.8 — self-only later runs, with a bounded durable claim lifecycle.
pub const SCHEMA_V30: &str = "
    CREATE TABLE agent_followups (
        followup_id TEXT PRIMARY KEY NOT NULL CHECK (length(followup_id) = 32
            AND NOT followup_id GLOB '*[^0-9a-f]*'),
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        actor TEXT NOT NULL CHECK (actor LIKE 'process:_%' AND length(actor) <= 128),
        note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
        due_at TEXT NOT NULL CHECK (due_at LIKE '____-__-__T%Z'),
        requested_at TEXT NOT NULL CHECK (requested_at LIKE '____-__-__T%Z'),
        requested_by_run TEXT NOT NULL CHECK (length(requested_by_run) > 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'fired', 'cancelled')),
        claimed_at TEXT CHECK (claimed_at IS NULL OR claimed_at LIKE '____-__-__T%Z'),
        run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
        ended_at TEXT CHECK (ended_at IS NULL OR ended_at LIKE '____-__-__T%Z'),
        cancel_reason TEXT CHECK (cancel_reason IS NULL OR cancel_reason IN ('person', 'agent_gone', 'paused')),
        CHECK (state != 'claimed' OR claimed_at IS NOT NULL),
        CHECK (state != 'pending' OR claimed_at IS NULL),
        CHECK ((state = 'fired') = (run_id IS NOT NULL)),
        CHECK ((state = 'cancelled') = (cancel_reason IS NOT NULL)),
        CHECK ((state IN ('fired', 'cancelled')) = (ended_at IS NOT NULL))
    );
    CREATE INDEX agent_followups_by_due ON agent_followups (vault_id, state, due_at);
";

/// M69.9b — local, vault-scoped dismissal of an address or company domain.
pub const SCHEMA_V31: &str = "
    CREATE TABLE mail_dismissals (
        vault_id TEXT NOT NULL REFERENCES vault_registry (vault_id),
        kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
        value TEXT NOT NULL CHECK (length(value) BETWEEN 3 AND 320 AND value = lower(value)),
        dismissed_at TEXT NOT NULL CHECK (dismissed_at LIKE '____-__-__T%Z'),
        PRIMARY KEY (vault_id, kind, value)
    ) WITHOUT ROWID;
";

/// M96.2 — native connection metadata and revocable acquisition attempts.
/// Secret bytes are absent: only typed references enter the cleanup journal.
pub const SCHEMA_V32: &str = r#"
    CREATE TABLE managed_connections (
        connection_id TEXT PRIMARY KEY NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 128),
        person TEXT NOT NULL CHECK (person LIKE 'human:_%' AND length(person) <= 128),
        status TEXT NOT NULL CHECK (json_valid(status) AND json_type(status) = 'object' AND length(status) <= 8192),
        active_attempt TEXT CHECK (active_attempt IS NULL OR length(active_attempt) = 32),
        secret_ref TEXT CHECK (secret_ref IS NULL OR (json_valid(secret_ref) AND json_type(secret_ref) = 'object' AND length(secret_ref) <= 2048)),
        CHECK (json_extract(status, '$.connectionId') IS connection_id),
        CHECK (json_type(status, '$.revision') IS 'integer' AND json_extract(status, '$.revision') BETWEEN 1 AND 9007199254740991),
        CHECK (json_type(status, '$.secretRevision') IS 'integer' AND json_extract(status, '$.secretRevision') BETWEEN 0 AND 9007199254740991),
        CHECK (json_type(status, '$.revocationGeneration') IS 'integer' AND json_extract(status, '$.revocationGeneration') BETWEEN 0 AND 9007199254740991),
        CHECK (coalesce(json_extract(status, '$.health') IN ('sign_in_required', 'ready', 'unavailable', 'unsupported', 'disabled'), 0)),
        CHECK (json_extract(status, '$.remoteRevocation') IS 'not_attempted'),
        CHECK (json_extract(status, '$.health') != 'ready' OR (json_type(status, '$.account') IS 'object' AND secret_ref IS NOT NULL)),
        CHECK (json_type(status, '$.cleanupPending') IN ('true', 'false')),
        CHECK (coalesce(json_extract(status, '$.observedAt') LIKE '____-__-__T%Z', 0)),
        CHECK (json_type(status, '$.account') IS 'null' OR (json_type(status, '$.account.accountRevision') IS 'integer' AND json_extract(status, '$.account.accountRevision') BETWEEN 1 AND 9007199254740991))
    );
    CREATE TABLE managed_connection_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL CHECK (length(attempt_id) = 32 AND NOT attempt_id GLOB '*[^0-9a-f]*'),
        connection_id TEXT NOT NULL REFERENCES managed_connections (connection_id),
        person TEXT NOT NULL CHECK (person LIKE 'human:_%' AND length(person) <= 128),
        payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object' AND length(payload) <= 4096),
        CHECK (json_extract(payload, '$.attemptId') IS attempt_id),
        CHECK (json_extract(payload, '$.connectionId') IS connection_id),
        CHECK (json_extract(payload, '$.person') IS person),
        CHECK (json_extract(payload, '$.host') IS 'github.com'),
        CHECK (json_type(payload, '$.expectedRevision') IS 'integer' AND json_extract(payload, '$.expectedRevision') BETWEEN 1 AND 9007199254740991),
        CHECK (json_type(payload, '$.revocationGeneration') IS 'integer' AND json_extract(payload, '$.revocationGeneration') BETWEEN 0 AND 9007199254740991),
        CHECK (coalesce(json_extract(payload, '$.state') IN ('pending', 'installed', 'cancelled', 'failed'), 0)),
        CHECK (json_type(payload, '$.error') IS 'null' OR coalesce(json_extract(payload, '$.error') IN ('sign_in_required', 'invalid_selection', 'stale_revision', 'not_found', 'unavailable', 'unsupported', 'identity_mismatch', 'cancelled', 'source_changed', 'unsafe_path', 'invalid_config'), 0)),
        CHECK (coalesce(json_extract(payload, '$.observedAt') LIKE '____-__-__T%Z', 0))
    );
    CREATE INDEX managed_attempts_by_connection ON managed_connection_attempts(connection_id);
    CREATE TABLE managed_secret_cleanup (
        secret_id TEXT PRIMARY KEY NOT NULL CHECK (length(secret_id) = 32 AND NOT secret_id GLOB '*[^0-9a-f]*'),
        connection_id TEXT NOT NULL REFERENCES managed_connections (connection_id),
        disposition TEXT NOT NULL CHECK (disposition IN ('reserved', 'delete')),
        reference TEXT NOT NULL CHECK (json_valid(reference) AND json_type(reference) = 'object' AND length(reference) <= 2048),
        CHECK (json_extract(reference, '$.id') IS secret_id),
        CHECK (json_type(reference, '$.secretRevision') IS 'integer' AND json_extract(reference, '$.secretRevision') BETWEEN 1 AND 9007199254740991)
    );
"#;

/// M96.2 repair — observation writes have their own CAS epoch. V32 bindings
/// retain their exact status bytes and start at epoch zero on upgrade.
pub const SCHEMA_V33: &str = "
    ALTER TABLE managed_connections ADD COLUMN observation_revision INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(observation_revision) = 'integer'
            AND observation_revision BETWEEN 0 AND 9007199254740991);
";

/// M96.3 — minimal operational action evidence, independent of chat retention.
/// The active-fence index arbitrates dispatch across runs and windows.
pub const SCHEMA_V34: &str = r#"
    CREATE TABLE action_invocations (
        invocation_id TEXT PRIMARY KEY NOT NULL CHECK(length(invocation_id)=32 AND NOT invocation_id GLOB '*[^0-9a-f]*'),
        subject_scope TEXT NOT NULL CHECK(length(subject_scope)=64 AND NOT subject_scope GLOB '*[^0-9a-f]*'),
        request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 256),
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND NOT request_digest GLOB '*[^0-9a-f]*'),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
        state TEXT NOT NULL CHECK(state IN ('prepared','awaiting_approval','ready','dispatched','succeeded','failed','outcome_unknown','cancelled')),
        fence TEXT CHECK(fence IS NULL OR (length(fence)=64 AND NOT fence GLOB '*[^0-9a-f]*')),
        payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object' AND length(payload)<=1048576),
        CHECK(json_extract(payload,'$.details.effect.invocationId') IS invocation_id),
        CHECK(json_extract(payload,'$.details.effect.state') IS state),
        CHECK(json_extract(payload,'$.details.revision') IS revision),
        CHECK(json_extract(payload,'$.request.requestKey') IS request_key),
        CHECK(json_extract(payload,'$.request_digest') IS request_digest),
        UNIQUE(subject_scope,request_key)
    );
    CREATE UNIQUE INDEX action_unresolved_fence ON action_invocations(fence)
        WHERE fence IS NOT NULL AND state IN ('dispatched','outcome_unknown');
    CREATE TABLE action_approvals (
        approval_id TEXT PRIMARY KEY NOT NULL CHECK(length(approval_id)=32 AND NOT approval_id GLOB '*[^0-9a-f]*'),
        invocation_id TEXT NOT NULL REFERENCES action_invocations(invocation_id),
        payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object' AND length(payload)<=131072),
        CHECK(json_extract(payload,'$.view.approvalId') IS approval_id),
        CHECK(json_type(payload,'$.view.revision') IS 'integer' AND json_extract(payload,'$.view.revision') BETWEEN 1 AND 9007199254740991),
        CHECK(json_type(payload,'$.consumed') IN ('true','false')),
        CHECK(json_type(payload,'$.retired') IN ('true','false'))
    );
    CREATE INDEX action_approvals_by_invocation ON action_approvals(invocation_id);
    CREATE TABLE action_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL CHECK(length(attempt_id)=32 AND NOT attempt_id GLOB '*[^0-9a-f]*'),
        invocation_id TEXT NOT NULL REFERENCES action_invocations(invocation_id),
        ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal BETWEEN 1 AND 9007199254740991),
        payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object' AND length(payload)<=8192),
        CHECK(json_extract(payload,'$.attemptId') IS attempt_id),
        CHECK(json_extract(payload,'$.ordinal') IS ordinal),
        UNIQUE(invocation_id,ordinal)
    );
"#;

/// Native action provenance and explicit account/action grants. No legacy backfill.
pub const SCHEMA_V35: &str = r#"
CREATE TABLE action_native_runs (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(run_id)
        CHECK(length(run_id) BETWEEN 1 AND 128),
    authority_id TEXT NOT NULL UNIQUE
        CHECK(length(authority_id)=32 AND NOT authority_id GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL
        CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
    vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
    store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
    canonical_vault_path TEXT NOT NULL CHECK(length(canonical_vault_path) BETWEEN 1 AND 4096),
    owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
    source_kind TEXT NOT NULL CHECK(source_kind IN ('attended_operation','run','client','job')),
    app_session_id TEXT NOT NULL CHECK(length(app_session_id) BETWEEN 1 AND 1024),
    cli_session_id TEXT CHECK(cli_session_id IS NULL OR length(cli_session_id) BETWEEN 8 AND 64),
    parent_run_id TEXT REFERENCES action_native_runs(run_id)
        CHECK(parent_run_id IS NULL OR parent_run_id<>run_id),
    client_id TEXT CHECK(client_id IS NULL OR
        (length(client_id)=32 AND NOT client_id GLOB '*[^0-9a-f]*')),
    child_job_id TEXT CHECK(child_job_id IS NULL OR length(child_job_id) BETWEEN 1 AND 128),
    admitted_at TEXT NOT NULL CHECK(admitted_at LIKE '____-__-__T%Z'),
    closed_at TEXT CHECK(closed_at IS NULL OR closed_at LIKE '____-__-__T%Z'),
    close_kind TEXT CHECK(close_kind IS NULL OR close_kind IN ('completed','stopped','revoked','context_closed')),
    CHECK((closed_at IS NULL)=(close_kind IS NULL)),
    CHECK((source_kind='client')=(client_id IS NOT NULL)),
    CHECK((source_kind='job')=(child_job_id IS NOT NULL)),
    CHECK((source_kind IN ('run','job'))=(cli_session_id IS NOT NULL)),
    FOREIGN KEY(app_session_id,vault_id,store_uuid)
        REFERENCES app_sessions(session_id,vault_id,store_uuid)
);
CREATE INDEX action_native_runs_by_owner_scope
    ON action_native_runs(owner_person,vault_id,store_uuid,run_id);
CREATE INDEX action_native_runs_by_parent ON action_native_runs(parent_run_id);
CREATE INDEX action_native_runs_by_client ON action_native_runs(client_id)
    WHERE client_id IS NOT NULL;

CREATE TABLE action_account_grants (
    grant_id TEXT PRIMARY KEY NOT NULL
        CHECK(length(grant_id)=32 AND NOT grant_id GLOB '*[^0-9a-f]*'),
    run_id TEXT NOT NULL REFERENCES action_native_runs(run_id),
    connection_id TEXT NOT NULL REFERENCES managed_connections(connection_id),
    account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 128),
    account_identity_digest TEXT NOT NULL
        CHECK(length(account_identity_digest)=64 AND NOT account_identity_digest GLOB '*[^0-9a-f]*'),
    account_revision INTEGER NOT NULL
        CHECK(typeof(account_revision)='integer' AND account_revision BETWEEN 1 AND 9007199254740991),
    revocation_generation INTEGER NOT NULL
        CHECK(typeof(revocation_generation)='integer' AND revocation_generation BETWEEN 0 AND 9007199254740991),
    action_id TEXT NOT NULL CHECK(length(action_id) BETWEEN 1 AND 8192 AND instr(action_id,':')>1),
    definition_digest TEXT NOT NULL
        CHECK(length(definition_digest)=64 AND NOT definition_digest GLOB '*[^0-9a-f]*'),
    input_scope TEXT NOT NULL CHECK(input_scope IN ('all_valid_inputs','exact_canonical_input')),
    input_digest TEXT CHECK(input_digest IS NULL OR
        (length(input_digest)=64 AND NOT input_digest GLOB '*[^0-9a-f]*')),
    capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)
        AND json_type(capabilities_json)='array' AND length(capabilities_json)<=65536
        AND json_array_length(capabilities_json)<=256),
    parent_grant_id TEXT REFERENCES action_account_grants(grant_id)
        CHECK(parent_grant_id IS NULL OR parent_grant_id<>grant_id),
    revision INTEGER NOT NULL
        CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
    granted_by TEXT NOT NULL CHECK(granted_by='human:me'),
    granted_at TEXT NOT NULL CHECK(granted_at LIKE '____-__-__T%Z'),
    revoked_at TEXT CHECK(revoked_at IS NULL OR revoked_at LIKE '____-__-__T%Z'),
    CHECK((input_scope='exact_canonical_input')=(input_digest IS NOT NULL))
);
CREATE UNIQUE INDEX action_account_grants_active_all
    ON action_account_grants(run_id,connection_id,account_id,action_id,definition_digest)
    WHERE revoked_at IS NULL AND input_scope='all_valid_inputs';
CREATE UNIQUE INDEX action_account_grants_active_exact
    ON action_account_grants(run_id,connection_id,account_id,action_id,definition_digest,input_digest)
    WHERE revoked_at IS NULL AND input_scope='exact_canonical_input';
CREATE INDEX action_account_grants_by_parent ON action_account_grants(parent_grant_id)
    WHERE parent_grant_id IS NOT NULL;
"#;

/// M97.3 — immutable, capped configuration facts. No payload backfill or run purge.
pub const SCHEMA_V36: &str = r#"
ALTER TABLE runs ADD COLUMN configuration_capture TEXT NOT NULL DEFAULT 'legacy'
 CHECK(configuration_capture IN ('legacy','required','recorded','expired','deleted','capture_failed'));
ALTER TABLE runs ADD COLUMN configuration_failure_code TEXT
 CHECK(configuration_failure_code IS NULL OR configuration_failure_code IN ('too_large','active_capacity','invalid_metadata','write_failed','interrupted'));
ALTER TABLE runs ADD COLUMN configuration_disposed_at TEXT
 CHECK(configuration_disposed_at IS NULL OR configuration_disposed_at LIKE '____-__-__T%Z');
ALTER TABLE runs ADD COLUMN configuration_publication_failure TEXT
 CHECK(configuration_publication_failure IS NULL OR configuration_publication_failure IN ('failed_before_start','failed_publication'));
CREATE TABLE run_configurations (
 run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(run_id),
 vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),store_uuid TEXT,
 format INTEGER NOT NULL CHECK(format=1),
 captured_at TEXT NOT NULL CHECK(captured_at LIKE '____-__-__T%Z'),
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND json_type(manifest_json)='object'),
 payload_bytes INTEGER NOT NULL CHECK(typeof(payload_bytes)='integer' AND payload_bytes BETWEEN 1 AND 65536),
 CHECK(length(CAST(manifest_json AS BLOB))=payload_bytes),
 CHECK(json_extract(manifest_json,'$.run_id') IS run_id),
 CHECK(json_extract(manifest_json,'$.vault_id') IS vault_id),
 CHECK(json_extract(manifest_json,'$.store_uuid') IS store_uuid)
);
CREATE INDEX run_configurations_by_vault ON run_configurations(vault_id,run_id);
"#;

/// M96 native catalog reads — admit dotted IDs in the storage shape without
/// rewriting V35 or changing grants. Strict namespace semantics are the shared
/// action-id contract consumed by the definition compiler, not this SQL shape.
pub const SCHEMA_V37: &str = r#"
CREATE TABLE action_account_grants_v37 (
    grant_id TEXT PRIMARY KEY NOT NULL
        CHECK(length(grant_id)=32 AND NOT grant_id GLOB '*[^0-9a-f]*'),
    run_id TEXT NOT NULL REFERENCES action_native_runs(run_id),
    connection_id TEXT NOT NULL REFERENCES managed_connections(connection_id),
    account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 128),
    account_identity_digest TEXT NOT NULL
        CHECK(length(account_identity_digest)=64 AND NOT account_identity_digest GLOB '*[^0-9a-f]*'),
    account_revision INTEGER NOT NULL
        CHECK(typeof(account_revision)='integer' AND account_revision BETWEEN 1 AND 9007199254740991),
    revocation_generation INTEGER NOT NULL
        CHECK(typeof(revocation_generation)='integer' AND revocation_generation BETWEEN 0 AND 9007199254740991),
    action_id TEXT NOT NULL CHECK(length(action_id) BETWEEN 1 AND 8192 AND (instr(action_id,':')>1 OR instr(action_id,'.')>1)),
    definition_digest TEXT NOT NULL
        CHECK(length(definition_digest)=64 AND NOT definition_digest GLOB '*[^0-9a-f]*'),
    input_scope TEXT NOT NULL CHECK(input_scope IN ('all_valid_inputs','exact_canonical_input')),
    input_digest TEXT CHECK(input_digest IS NULL OR
        (length(input_digest)=64 AND NOT input_digest GLOB '*[^0-9a-f]*')),
    capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)
        AND json_type(capabilities_json)='array' AND length(capabilities_json)<=65536
        AND json_array_length(capabilities_json)<=256),
    parent_grant_id TEXT REFERENCES action_account_grants_v37(grant_id)
        CHECK(parent_grant_id IS NULL OR parent_grant_id<>grant_id),
    revision INTEGER NOT NULL
        CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
    granted_by TEXT NOT NULL CHECK(granted_by='human:me'),
    granted_at TEXT NOT NULL CHECK(granted_at LIKE '____-__-__T%Z'),
    revoked_at TEXT CHECK(revoked_at IS NULL OR revoked_at LIKE '____-__-__T%Z'),
    CHECK((input_scope='exact_canonical_input')=(input_digest IS NOT NULL))
);
INSERT INTO action_account_grants_v37 (grant_id,run_id,connection_id,account_id,account_identity_digest,account_revision,revocation_generation,action_id,definition_digest,input_scope,input_digest,capabilities_json,parent_grant_id,revision,granted_by,granted_at,revoked_at)
SELECT grant_id,run_id,connection_id,account_id,account_identity_digest,account_revision,revocation_generation,action_id,definition_digest,input_scope,input_digest,capabilities_json,parent_grant_id,revision,granted_by,granted_at,revoked_at FROM action_account_grants;
DROP TABLE action_account_grants;
ALTER TABLE action_account_grants_v37 RENAME TO action_account_grants;
CREATE UNIQUE INDEX action_account_grants_active_all
    ON action_account_grants(run_id,connection_id,account_id,action_id,definition_digest)
    WHERE revoked_at IS NULL AND input_scope='all_valid_inputs';
CREATE UNIQUE INDEX action_account_grants_active_exact
    ON action_account_grants(run_id,connection_id,account_id,action_id,definition_digest,input_digest)
    WHERE revoked_at IS NULL AND input_scope='exact_canonical_input';
CREATE INDEX action_account_grants_by_parent ON action_account_grants(parent_grant_id)
    WHERE parent_grant_id IS NOT NULL;
"#;

/// M95.6 — original native parent-attempt identity only. No legacy backfill,
/// request bodies, job reservation or execution authority. The native owner
/// checks that run and authority name the SAME joined parent before recording.
pub const SCHEMA_V38: &str = r#"
CREATE TABLE chat_parent_attempts (
    parent_run_id TEXT PRIMARY KEY NOT NULL
        REFERENCES action_native_runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL UNIQUE
        CHECK(length(attempt_id)=32 AND NOT attempt_id GLOB '*[^0-9a-f]*'),
    authority_id TEXT NOT NULL UNIQUE
        REFERENCES action_native_runs(authority_id) ON DELETE CASCADE
);
"#;

/// M95.6 inert original-root intent/allocation metadata. No bodies/backfill,
/// running child rows, lifecycle, credentials or admission. Writers stay test-only.
pub const SCHEMA_V39: &str = r#"
CREATE UNIQUE INDEX chat_parent_attempt_binding
    ON chat_parent_attempts(parent_run_id,attempt_id,authority_id);
CREATE TABLE chat_delegation_intents (
    slot_id TEXT PRIMARY KEY NOT NULL
        CHECK(length(slot_id)=32 AND NOT slot_id GLOB '*[^0-9a-f]*'),
    request_key TEXT NOT NULL
        CHECK(length(request_key)=32 AND NOT request_key GLOB '*[^0-9a-f]*'),
    parent_run_id TEXT NOT NULL CHECK(length(parent_run_id) BETWEEN 1 AND 128),
    attempt_id TEXT NOT NULL
        CHECK(length(attempt_id)=32 AND NOT attempt_id GLOB '*[^0-9a-f]*'),
    authority_id TEXT NOT NULL
        CHECK(length(authority_id)=32 AND NOT authority_id GLOB '*[^0-9a-f]*'),
    authority_revision INTEGER NOT NULL
        CHECK(typeof(authority_revision)='integer' AND authority_revision BETWEEN 1 AND 9007199254740991),
    owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
    vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
    store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
    parent_cli_session_id TEXT NOT NULL CHECK(length(parent_cli_session_id)=36),
    app_session_id TEXT NOT NULL CHECK(length(app_session_id) BETWEEN 1 AND 1024),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
    slot_ordinal INTEGER NOT NULL CHECK(typeof(slot_ordinal)='integer' AND slot_ordinal BETWEEN 0 AND 4294967295),
    CHECK(slot_id<>request_key),
    UNIQUE(parent_run_id,attempt_id,slot_ordinal),
    UNIQUE(owner_person,vault_id,store_uuid,parent_run_id,attempt_id,request_key),
    FOREIGN KEY(parent_run_id,attempt_id,authority_id)
        REFERENCES chat_parent_attempts(parent_run_id,attempt_id,authority_id) ON DELETE RESTRICT,
    FOREIGN KEY(app_session_id,vault_id,store_uuid)
        REFERENCES app_sessions(session_id,vault_id,store_uuid) ON DELETE RESTRICT
);
CREATE INDEX chat_delegation_session
    ON chat_delegation_intents(owner_person,vault_id,store_uuid,parent_cli_session_id);
CREATE TABLE child_job_reservations (
    slot_id TEXT PRIMARY KEY NOT NULL REFERENCES chat_delegation_intents(slot_id) ON DELETE RESTRICT,
    job_id TEXT NOT NULL UNIQUE
        CHECK(length(job_id)=32 AND NOT job_id GLOB '*[^0-9a-f]*'),
    reserved_run_id TEXT NOT NULL UNIQUE
        CHECK(length(reserved_run_id)=32 AND NOT reserved_run_id GLOB '*[^0-9a-f]*'),
    reserved_cli_session_id TEXT NOT NULL UNIQUE CHECK(length(reserved_cli_session_id)=36),
    request_digest TEXT NOT NULL
        CHECK(length(request_digest)=64 AND NOT request_digest GLOB '*[^0-9a-f]*'),
    deadline_at INTEGER NOT NULL
        CHECK(typeof(deadline_at)='integer' AND deadline_at BETWEEN 1 AND 9007199254740991),
    elapsed_seconds INTEGER NOT NULL
        CHECK(typeof(elapsed_seconds)='integer' AND elapsed_seconds BETWEEN 1 AND 4294967295),
    result_bytes INTEGER NOT NULL
        CHECK(typeof(result_bytes)='integer' AND result_bytes BETWEEN 1 AND 4294967295),
    occupies_slot INTEGER NOT NULL CHECK(typeof(occupies_slot)='integer' AND occupies_slot IN (0,1)),
    CHECK(job_id<>reserved_run_id)
);
CREATE TRIGGER chat_delegation_intents_immutable BEFORE UPDATE ON chat_delegation_intents
BEGIN SELECT RAISE(ABORT,'delegation intent is immutable'); END;
CREATE TRIGGER chat_delegation_intents_retained BEFORE DELETE ON chat_delegation_intents
BEGIN SELECT RAISE(ABORT,'delegation intent accounting is retained'); END;
CREATE TRIGGER child_job_reservations_immutable BEFORE UPDATE ON child_job_reservations
WHEN NEW.slot_id IS NOT OLD.slot_id OR NEW.job_id IS NOT OLD.job_id
    OR NEW.reserved_run_id IS NOT OLD.reserved_run_id
    OR NEW.reserved_cli_session_id IS NOT OLD.reserved_cli_session_id
    OR NEW.request_digest IS NOT OLD.request_digest OR NEW.deadline_at IS NOT OLD.deadline_at
    OR NEW.elapsed_seconds IS NOT OLD.elapsed_seconds OR NEW.result_bytes IS NOT OLD.result_bytes
    OR (OLD.occupies_slot=0 AND NEW.occupies_slot<>0)
BEGIN SELECT RAISE(ABORT,'reservation identity is immutable'); END;
CREATE TRIGGER child_job_reservations_retained BEFORE DELETE ON child_job_reservations
BEGIN SELECT RAISE(ABORT,'reservation lifetime accounting is retained'); END;
"#;

/// M95.6 local built-in grant freeze. Only immutable digests, one original V39
/// reservation; no body, child run, configuration, account or execution state.
pub const SCHEMA_V40: &str = r#"
CREATE TABLE child_job_grant_freezes (
    slot_id TEXT PRIMARY KEY NOT NULL REFERENCES child_job_reservations(slot_id) ON DELETE RESTRICT,
    contract_digest TEXT NOT NULL UNIQUE
        CHECK(length(contract_digest)=64 AND NOT contract_digest GLOB '*[^0-9a-f]*'),
    instruction_source_version TEXT NOT NULL
        CHECK(length(instruction_source_version)=64 AND NOT instruction_source_version GLOB '*[^0-9a-f]*'),
    policy_digest TEXT NOT NULL
        CHECK(length(policy_digest)=64 AND NOT policy_digest GLOB '*[^0-9a-f]*')
);
CREATE TRIGGER child_job_grant_freezes_no_replace BEFORE INSERT ON child_job_grant_freezes
WHEN EXISTS(SELECT 1 FROM child_job_grant_freezes WHERE slot_id=NEW.slot_id OR contract_digest=NEW.contract_digest)
BEGIN SELECT RAISE(ABORT,'grant freeze is immutable'); END;
CREATE TRIGGER child_job_grant_freezes_immutable BEFORE UPDATE ON child_job_grant_freezes
BEGIN SELECT RAISE(ABORT,'grant freeze is immutable'); END;
CREATE TRIGGER child_job_grant_freezes_retained BEFORE DELETE ON child_job_grant_freezes
BEGIN SELECT RAISE(ABORT,'grant freeze is retained'); END;
"#;

/// M95 actual pre-launch claims. No prompt, configuration, process or result.
/// Immutable reservation/freeze/intent joins supply the remaining identity axes.
pub const SCHEMA_V41: &str = r#"
CREATE TABLE child_job_claims (
    slot_id TEXT PRIMARY KEY NOT NULL REFERENCES child_job_grant_freezes(slot_id),
    claim_id TEXT NOT NULL UNIQUE CHECK(length(claim_id)=32 AND NOT claim_id GLOB '*[^0-9a-f]*'),
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
    authority_id TEXT NOT NULL UNIQUE REFERENCES action_native_runs(authority_id),
    contract_digest TEXT NOT NULL REFERENCES child_job_grant_freezes(contract_digest),
    app_session_id TEXT NOT NULL CHECK(length(app_session_id) BETWEEN 1 AND 1024),
    claimed_at TEXT NOT NULL CHECK(claimed_at LIKE '____-__-__T%Z'),
    state TEXT NOT NULL CHECK(state IN ('claimed','backend_unavailable','cancelled','expired','interrupted')),
    ended_at TEXT CHECK(ended_at IS NULL OR ended_at LIKE '____-__-__T%Z'),
    CHECK((state='claimed')=(ended_at IS NULL)),
    CHECK(ended_at IS NULL OR ended_at>=claimed_at)
);
CREATE TRIGGER child_job_claims_no_replace BEFORE INSERT ON child_job_claims
WHEN EXISTS(SELECT 1 FROM child_job_claims WHERE slot_id=NEW.slot_id OR claim_id=NEW.claim_id
    OR run_id=NEW.run_id OR authority_id=NEW.authority_id)
BEGIN SELECT RAISE(ABORT,'child claim cannot be replaced'); END;
CREATE TRIGGER child_job_claims_immutable BEFORE UPDATE ON child_job_claims
WHEN NEW.slot_id IS NOT OLD.slot_id OR NEW.claim_id IS NOT OLD.claim_id
    OR NEW.run_id IS NOT OLD.run_id OR NEW.authority_id IS NOT OLD.authority_id
    OR NEW.contract_digest IS NOT OLD.contract_digest OR NEW.app_session_id IS NOT OLD.app_session_id
    OR NEW.claimed_at IS NOT OLD.claimed_at OR OLD.state<>'claimed'
    OR NEW.state='claimed' OR NEW.ended_at IS NULL
BEGIN SELECT RAISE(ABORT,'child claim identity and terminal disposition are immutable'); END;
CREATE TRIGGER child_job_claims_retained BEFORE DELETE ON child_job_claims
BEGIN SELECT RAISE(ABORT,'child claim is retained'); END;
"#;

/// M95.5 — metadata-only pre-dispatch generation admission. No content archive,
/// effect permission, historical backfill or child enablement.
pub const SCHEMA_V42: &str = r#"
CREATE TABLE chat_generations (
    generation_id TEXT PRIMARY KEY NOT NULL CHECK(length(generation_id)=32 AND NOT generation_id GLOB '*[^0-9a-f]*'),
    owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
    vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
    store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
    request_key TEXT NOT NULL CHECK(length(request_key)=32 AND NOT request_key GLOB '*[^0-9a-f]*'),
    request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND NOT request_digest GLOB '*[^0-9a-f]*'),
    first_run_id TEXT NOT NULL UNIQUE CHECK(length(first_run_id)=32 AND NOT first_run_id GLOB '*[^0-9a-f]*'),
    current_run_id TEXT NOT NULL UNIQUE CHECK(length(current_run_id)=32 AND NOT current_run_id GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK(state IN ('admitted','running','deferred','completed','failed','cancelled','interrupted')),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
    UNIQUE(owner_person,vault_id,store_uuid,request_key)
);
CREATE TABLE chat_generation_runs (
    run_id TEXT PRIMARY KEY NOT NULL CHECK(length(run_id)=32 AND NOT run_id GLOB '*[^0-9a-f]*'),
    generation_id TEXT NOT NULL REFERENCES chat_generations(generation_id) ON DELETE RESTRICT,
    predecessor_run_id TEXT REFERENCES chat_generation_runs(run_id) ON DELETE RESTRICT,
    answer_key TEXT UNIQUE CHECK(answer_key IS NULL OR (length(answer_key)=32 AND NOT answer_key GLOB '*[^0-9a-f]*')),
    cli_session_id TEXT CHECK(cli_session_id IS NULL OR length(cli_session_id)=36),
    app_session_id TEXT NOT NULL CHECK(length(app_session_id) BETWEEN 1 AND 1024),
    state TEXT NOT NULL CHECK(state IN ('admitted','running','deferred','completed','failed','cancelled','interrupted')),
    CHECK((predecessor_run_id IS NULL)=(answer_key IS NULL))
);
"#;

/// M98.2/.3 — durable sequential workflow identities and active recovery values.
/// Completed-detail retention remains off; activation/provider authority is absent.
pub const SCHEMA_V43: &str = r#"
CREATE TABLE workflow_runs (
    run_id TEXT PRIMARY KEY NOT NULL CHECK(length(run_id)=32 AND NOT run_id GLOB '*[^0-9a-f]*'),
    owner_person TEXT NOT NULL CHECK(length(owner_person) BETWEEN 1 AND 128),
    vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
    store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
    workflow_id TEXT NOT NULL CHECK(length(workflow_id) BETWEEN 1 AND 128),
    definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64),
    input_schema_digest TEXT NOT NULL CHECK(length(input_schema_digest)=64),
    start_key TEXT NOT NULL CHECK(length(start_key)=32),
    start_digest TEXT NOT NULL CHECK(length(start_digest)=64),
    input_ref TEXT NOT NULL CHECK(length(input_ref)=32),
    input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
    configuration_digest TEXT NOT NULL CHECK(length(configuration_digest)=64),
    grant_digest TEXT NOT NULL CHECK(length(grant_digest)=64),
    act_scope_digest TEXT CHECK(act_scope_digest IS NULL OR length(act_scope_digest)=64),
    act_run_id TEXT CHECK(act_run_id IS NULL OR length(act_run_id) BETWEEN 1 AND 128),
    state TEXT NOT NULL CHECK(state IN ('queued','running','waiting','blocked','succeeded','failed','cancelled')),
    reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 64),
    cursor TEXT CHECK(cursor IS NULL OR length(cursor) BETWEEN 1 AND 128),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
    output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(output_bytes>=0),
    reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((act_scope_digest IS NULL)=(act_run_id IS NULL)),
    UNIQUE(owner_person,vault_id,store_uuid,start_key)
);
CREATE TABLE workflow_steps (
    run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE RESTRICT,
    step_id TEXT NOT NULL CHECK(length(step_id) BETWEEN 1 AND 128),
    definition_ordinal INTEGER NOT NULL CHECK(definition_ordinal>=0),
    kind TEXT NOT NULL CHECK(kind IN ('read','transform','condition','action','timer','external_input','result')),
    next_step TEXT,
    otherwise_step TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending','running','waiting','blocked','succeeded','failed','skipped','cancelled')),
    attempt_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(attempt_ordinal>=0),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token)=32),
    process_id TEXT CHECK(process_id IS NULL OR length(process_id) BETWEEN 1 AND 1024),
    input_ref TEXT CHECK(input_ref IS NULL OR length(input_ref)=32),
    input_digest TEXT CHECK(input_digest IS NULL OR length(input_digest)=64),
    output_ref TEXT CHECK(output_ref IS NULL OR length(output_ref)=32),
    output_digest TEXT CHECK(output_digest IS NULL OR length(output_digest)=64),
    effect_revision INTEGER NOT NULL DEFAULT 0 CHECK(effect_revision>=0),
    reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 64),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(run_id,step_id),
    UNIQUE(run_id,definition_ordinal)
);
CREATE TABLE workflow_attempts (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>=1),
    request_key TEXT NOT NULL UNIQUE CHECK(length(request_key)=64),
    input_ref TEXT NOT NULL CHECK(length(input_ref)=32),
    input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
    invocation_id TEXT CHECK(invocation_id IS NULL OR length(invocation_id) BETWEEN 1 AND 128),
    approval_id TEXT CHECK(approval_id IS NULL OR length(approval_id) BETWEEN 1 AND 128),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(run_id,step_id,ordinal),
    FOREIGN KEY(run_id,step_id) REFERENCES workflow_steps(run_id,step_id) ON DELETE RESTRICT
);
CREATE TABLE workflow_waits (
    continuation_id TEXT PRIMARY KEY NOT NULL CHECK(length(continuation_id)=32),
    run_id TEXT NOT NULL,
    definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64),
    step_id TEXT NOT NULL,
    attempt_ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('timer','external_input','person_approval')),
    state TEXT NOT NULL CHECK(state IN ('pending','consumed','cancelled','expired')),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    due_at INTEGER,
    expires_at INTEGER,
    schema_ref TEXT CHECK(schema_ref IS NULL OR length(schema_ref)=32),
    schema_digest TEXT CHECK(schema_digest IS NULL OR length(schema_digest)=64),
    invocation_id TEXT,
    approval_id TEXT,
    signal_key TEXT CHECK(signal_key IS NULL OR length(signal_key)=32),
    signal_digest TEXT CHECK(signal_digest IS NULL OR length(signal_digest)=64),
    rejection_count INTEGER NOT NULL DEFAULT 0 CHECK(rejection_count BETWEEN 0 AND 9007199254740991),
    rejection_reason TEXT CHECK(rejection_reason IS NULL OR length(rejection_reason) BETWEEN 1 AND 64),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(run_id,step_id,attempt_ordinal),
    FOREIGN KEY(run_id,step_id,attempt_ordinal) REFERENCES workflow_attempts(run_id,step_id,ordinal) ON DELETE RESTRICT
);
CREATE TABLE workflow_values (
    run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE RESTRICT,
    value_ref TEXT NOT NULL CHECK(length(value_ref)=32),
    digest TEXT NOT NULL CHECK(length(digest)=64),
    role TEXT NOT NULL CHECK(role IN ('run_input','step_input','step_output','wait_schema')),
    step_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json)),
    byte_count INTEGER NOT NULL CHECK(byte_count=length(CAST(canonical_json AS BLOB))),
    PRIMARY KEY(run_id,value_ref),
    UNIQUE(run_id,role,step_id,ordinal)
);
"#;

/// M96: explicitly registered FLOW consumers' active ACT output handoff.
pub const SCHEMA_V44: &str = r#"
CREATE TABLE action_output_handoffs (
    invocation_id TEXT PRIMARY KEY NOT NULL REFERENCES action_invocations(invocation_id) ON DELETE RESTRICT,
    workflow_run_id TEXT NOT NULL,
    step_id TEXT NOT NULL CHECK(length(step_id) BETWEEN 1 AND 128),
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 9007199254740991),
    request_key TEXT NOT NULL CHECK(length(request_key)=64 AND NOT request_key GLOB '*[^0-9a-f]*'),
    owner_person TEXT NOT NULL CHECK(length(owner_person) BETWEEN 1 AND 128),
    vault_id TEXT NOT NULL CHECK(length(vault_id)=32 AND NOT vault_id GLOB '*[^0-9a-f]*'),
    store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
    act_scope_json TEXT NOT NULL CHECK(json_valid(act_scope_json) AND length(CAST(act_scope_json AS BLOB))<=8192),
    act_scope_digest TEXT NOT NULL CHECK(length(act_scope_digest)=64 AND NOT act_scope_digest GLOB '*[^0-9a-f]*'),
    original_request_digest TEXT NOT NULL CHECK(length(original_request_digest)=64 AND NOT original_request_digest GLOB '*[^0-9a-f]*'),
    original_input_digest TEXT NOT NULL CHECK(length(original_input_digest)=64 AND NOT original_input_digest GLOB '*[^0-9a-f]*'),
    effective_input_digest TEXT CHECK(effective_input_digest IS NULL OR (length(effective_input_digest)=64 AND NOT effective_input_digest GLOB '*[^0-9a-f]*')),
    reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes BETWEEN 1 AND 9007199254740991),
    attempt_id TEXT CHECK(attempt_id IS NULL OR (length(attempt_id)=32 AND NOT attempt_id GLOB '*[^0-9a-f]*')),
    receipt_id TEXT CHECK(receipt_id IS NULL OR (length(receipt_id)=32 AND NOT receipt_id GLOB '*[^0-9a-f]*')),
    observation_revision INTEGER CHECK(observation_revision IS NULL OR observation_revision BETWEEN 1 AND 9007199254740991),
    state TEXT NOT NULL CHECK(state IN ('registered','retained','acknowledged')),
    output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
    output_digest TEXT CHECK(output_digest IS NULL OR (length(output_digest)=64 AND NOT output_digest GLOB '*[^0-9a-f]*')),
    byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 0 AND reserved_bytes),
    ack_kind TEXT CHECK(ack_kind IS NULL OR ack_kind IN ('transferred','discarded')),
    CHECK((attempt_id IS NULL)=(effective_input_digest IS NULL)),
    CHECK((receipt_id IS NULL)=(observation_revision IS NULL)),
    CHECK((receipt_id IS NULL)=(output_digest IS NULL)),
    CHECK((state='registered' AND receipt_id IS NULL AND output_json IS NULL AND byte_count=0 AND ack_kind IS NULL)
       OR (state='retained' AND attempt_id IS NOT NULL AND receipt_id IS NOT NULL AND output_json IS NOT NULL AND byte_count=length(CAST(output_json AS BLOB)) AND ack_kind IS NULL)
       OR (state='acknowledged' AND attempt_id IS NOT NULL AND receipt_id IS NOT NULL AND output_json IS NULL AND byte_count>0 AND ack_kind IS NOT NULL)),
    UNIQUE(workflow_run_id,step_id,ordinal,request_key),
    FOREIGN KEY(workflow_run_id,step_id,ordinal) REFERENCES workflow_attempts(run_id,step_id,ordinal) ON DELETE RESTRICT
);
"#;

/// M98: original workflow action request selectors; original input bytes remain in V43.
pub const SCHEMA_V45: &str = r#"
CREATE TABLE workflow_action_inputs (
 run_id TEXT NOT NULL, step_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 9007199254740991),
 act_scope_digest TEXT NOT NULL CHECK(length(act_scope_digest)=64 AND NOT act_scope_digest GLOB '*[^0-9a-f]*'),
 act_run_id TEXT NOT NULL CHECK(length(act_run_id) BETWEEN 1 AND 128),
 action_id TEXT NOT NULL CHECK(length(action_id) BETWEEN 1 AND 128),
 definition_digest TEXT NOT NULL CHECK(length(definition_digest)=64 AND NOT definition_digest GLOB '*[^0-9a-f]*'),
 connection_id TEXT NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 128),
 account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 128),
 snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest)=64 AND NOT snapshot_digest GLOB '*[^0-9a-f]*'),
 configuration_digest TEXT NOT NULL CHECK(length(configuration_digest)=64 AND NOT configuration_digest GLOB '*[^0-9a-f]*'),
 input_ref TEXT NOT NULL CHECK(length(input_ref)=32),
 input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND NOT input_digest GLOB '*[^0-9a-f]*'),
 request_key TEXT NOT NULL UNIQUE CHECK(length(request_key)=64 AND NOT request_key GLOB '*[^0-9a-f]*'),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND NOT request_digest GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(run_id,step_id,ordinal),
 FOREIGN KEY(run_id,step_id,ordinal) REFERENCES workflow_attempts(run_id,step_id,ordinal) ON DELETE RESTRICT
);
"#;

/// Fixed physical namespace pins: never auto-rebind after directory/file replacement.
pub const SCHEMA_V46: &str = r#"
CREATE TABLE action_submission_namespace (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
    protocol INTEGER NOT NULL CHECK(protocol=1),
    runtime_device TEXT NOT NULL CHECK(length(runtime_device)=16 AND NOT runtime_device GLOB '*[^0-9a-f]*'),
    runtime_inode TEXT NOT NULL CHECK(length(runtime_inode)=16 AND NOT runtime_inode GLOB '*[^0-9a-f]*'),
    parent_device TEXT NOT NULL CHECK(length(parent_device)=16 AND NOT parent_device GLOB '*[^0-9a-f]*'),
    parent_inode TEXT NOT NULL CHECK(length(parent_inode)=16 AND NOT parent_inode GLOB '*[^0-9a-f]*'),
    directory_device TEXT NOT NULL CHECK(length(directory_device)=16 AND NOT directory_device GLOB '*[^0-9a-f]*'),
    directory_inode TEXT NOT NULL CHECK(length(directory_inode)=16 AND NOT directory_inode GLOB '*[^0-9a-f]*')
);
CREATE TABLE action_submission_files (
    invocation_id TEXT PRIMARY KEY NOT NULL REFERENCES action_invocations(invocation_id) ON DELETE RESTRICT,
    namespace_id INTEGER NOT NULL REFERENCES action_submission_namespace(singleton) ON DELETE RESTRICT CHECK(namespace_id=1),
    lock_device TEXT NOT NULL CHECK(length(lock_device)=16 AND NOT lock_device GLOB '*[^0-9a-f]*'),
    lock_inode TEXT NOT NULL CHECK(length(lock_inode)=16 AND NOT lock_inode GLOB '*[^0-9a-f]*')
);
"#;

/// M98: immutable workflow-owned operation and current narrowed admission.
pub const SCHEMA_V47: &str = r#"
CREATE TABLE workflow_run_origins (
 workflow_run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_runs(run_id) ON DELETE RESTRICT,
 native_run_id TEXT NOT NULL UNIQUE REFERENCES action_native_runs(run_id) ON DELETE RESTRICT,
 authority_id TEXT NOT NULL CHECK(length(authority_id)=32 AND NOT authority_id GLOB '*[^0-9a-f]*'),
 owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
 vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
 store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
 canonical_vault_path TEXT NOT NULL CHECK(length(canonical_vault_path) BETWEEN 1 AND 4096),
 actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
 configuration_digest TEXT NOT NULL CHECK(length(configuration_digest)=64 AND NOT configuration_digest GLOB '*[^0-9a-f]*'),
 definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64 AND NOT definition_hash GLOB '*[^0-9a-f]*'),
 permission_digest TEXT NOT NULL CHECK(length(permission_digest)=64 AND NOT permission_digest GLOB '*[^0-9a-f]*'),
 selector_digest TEXT NOT NULL CHECK(length(selector_digest)=64 AND NOT selector_digest GLOB '*[^0-9a-f]*'),
 original_permissions_json TEXT NOT NULL CHECK(json_valid(original_permissions_json) AND json_type(original_permissions_json)='object' AND length(CAST(original_permissions_json AS BLOB))<=8192),
 current_permissions_json TEXT NOT NULL CHECK(json_valid(current_permissions_json) AND json_type(current_permissions_json)='object' AND length(CAST(current_permissions_json AS BLOB))<=8192),
 current_permission_digest TEXT NOT NULL CHECK(length(current_permission_digest)=64 AND NOT current_permission_digest GLOB '*[^0-9a-f]*'),
 creation_session_id TEXT NOT NULL CHECK(length(creation_session_id) BETWEEN 1 AND 1024),
 admission_session_id TEXT NOT NULL CHECK(length(admission_session_id) BETWEEN 1 AND 1024),
 admission_process_id TEXT NOT NULL CHECK(length(admission_process_id) BETWEEN 1 AND 1024),
 admission_epoch INTEGER NOT NULL CHECK(admission_epoch BETWEEN 1 AND 9007199254740991),
 revoked_at TEXT CHECK(revoked_at IS NULL OR revoked_at LIKE '____-__-__T%Z'),
 created_at TEXT NOT NULL CHECK(created_at LIKE '____-__-__T%Z'),
 updated_at TEXT NOT NULL CHECK(updated_at LIKE '____-__-__T%Z'),
 FOREIGN KEY(creation_session_id,vault_id,store_uuid) REFERENCES app_sessions(session_id,vault_id,store_uuid),
 FOREIGN KEY(admission_session_id,vault_id,store_uuid) REFERENCES app_sessions(session_id,vault_id,store_uuid)
);
CREATE TABLE workflow_run_action_selectors (
 workflow_run_id TEXT NOT NULL REFERENCES workflow_run_origins(workflow_run_id) ON DELETE RESTRICT,
 step_id TEXT NOT NULL CHECK(length(step_id) BETWEEN 1 AND 128),
 action_id TEXT NOT NULL CHECK(length(action_id) BETWEEN 1 AND 128),
 definition_digest TEXT NOT NULL CHECK(length(definition_digest)=64 AND NOT definition_digest GLOB '*[^0-9a-f]*'),
 connection_id TEXT NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 128),
 account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 128),
 snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest)=64 AND NOT snapshot_digest GLOB '*[^0-9a-f]*'),
 configuration_digest TEXT NOT NULL CHECK(length(configuration_digest)=64 AND NOT configuration_digest GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(workflow_run_id,step_id),
 FOREIGN KEY(workflow_run_id,step_id) REFERENCES workflow_steps(run_id,step_id) ON DELETE RESTRICT
);
CREATE TABLE workflow_origin_account_grants (
 workflow_run_id TEXT NOT NULL REFERENCES workflow_run_origins(workflow_run_id) ON DELETE RESTRICT,
 grant_id TEXT NOT NULL UNIQUE REFERENCES action_account_grants(grant_id) ON DELETE RESTRICT,
 PRIMARY KEY(workflow_run_id,grant_id)
);
CREATE TABLE workflow_submission_namespace (
 singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
 protocol INTEGER NOT NULL CHECK(protocol=1),
 runtime_device TEXT NOT NULL CHECK(length(runtime_device)=16 AND NOT runtime_device GLOB '*[^0-9a-f]*'),
 runtime_inode TEXT NOT NULL CHECK(length(runtime_inode)=16 AND NOT runtime_inode GLOB '*[^0-9a-f]*'),
 parent_device TEXT NOT NULL CHECK(length(parent_device)=16 AND NOT parent_device GLOB '*[^0-9a-f]*'),
 parent_inode TEXT NOT NULL CHECK(length(parent_inode)=16 AND NOT parent_inode GLOB '*[^0-9a-f]*'),
 directory_device TEXT NOT NULL CHECK(length(directory_device)=16 AND NOT directory_device GLOB '*[^0-9a-f]*'),
 directory_inode TEXT NOT NULL CHECK(length(directory_inode)=16 AND NOT directory_inode GLOB '*[^0-9a-f]*')
);
CREATE TABLE workflow_submission_files (
 workflow_run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_run_origins(workflow_run_id) ON DELETE RESTRICT,
 namespace_id INTEGER NOT NULL CHECK(namespace_id=1) REFERENCES workflow_submission_namespace(singleton),
 lock_device TEXT NOT NULL CHECK(length(lock_device)=16 AND NOT lock_device GLOB '*[^0-9a-f]*'),
 lock_inode TEXT NOT NULL CHECK(length(lock_inode)=16 AND NOT lock_inode GLOB '*[^0-9a-f]*')
);
"#;

/// M98: explicit awake activations, request receipts and occurrence identity.
pub const SCHEMA_V48: &str = r#"
CREATE TABLE workflow_activations (
 activation_id TEXT PRIMARY KEY NOT NULL CHECK(length(activation_id)=32 AND NOT activation_id GLOB '*[^0-9a-f]*'),
 owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
 vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
 store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
 canonical_vault_path TEXT NOT NULL CHECK(length(canonical_vault_path) BETWEEN 1 AND 4096),
 workflow_id TEXT NOT NULL CHECK(length(workflow_id) BETWEEN 1 AND 128),
 definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64 AND NOT definition_hash GLOB '*[^0-9a-f]*'),
 input_schema_digest TEXT NOT NULL CHECK(length(input_schema_digest)=64 AND NOT input_schema_digest GLOB '*[^0-9a-f]*'),
 configuration_digest TEXT NOT NULL CHECK(length(configuration_digest)=64 AND NOT configuration_digest GLOB '*[^0-9a-f]*'),
 trigger_digest TEXT NOT NULL CHECK(length(trigger_digest)=64 AND NOT trigger_digest GLOB '*[^0-9a-f]*'),
 input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND NOT input_digest GLOB '*[^0-9a-f]*'),
 permission_digest TEXT NOT NULL CHECK(length(permission_digest)=64 AND NOT permission_digest GLOB '*[^0-9a-f]*'),
 input_json TEXT CHECK(input_json IS NULL OR json_valid(input_json)),
 input_bytes INTEGER NOT NULL CHECK(input_bytes BETWEEN 0 AND 262144),
 permissions_json TEXT CHECK(permissions_json IS NULL OR (json_valid(permissions_json) AND json_type(permissions_json)='object' AND length(CAST(permissions_json AS BLOB))<=8192)),
 interval_seconds INTEGER NOT NULL CHECK(interval_seconds BETWEEN 1 AND 4294967295),
 catch_up TEXT NOT NULL CHECK(catch_up IN ('skip_missed','coalesce_latest')),
 state TEXT NOT NULL CHECK(state IN ('enabled','paused','removed')),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 epoch TEXT NOT NULL CHECK(length(epoch)=32 AND NOT epoch GLOB '*[^0-9a-f]*'),
 anchor_ms INTEGER NOT NULL CHECK(anchor_ms BETWEEN 0 AND 9007199254740991),
 cursor_ms INTEGER NOT NULL CHECK(cursor_ms BETWEEN anchor_ms AND 9007199254740991),
 observed_at_ms INTEGER CHECK(observed_at_ms IS NULL OR observed_at_ms BETWEEN 0 AND 9007199254740991),
 coverage_known INTEGER NOT NULL DEFAULT 0 CHECK(coverage_known IN (0,1)),
 skipped_count INTEGER NOT NULL DEFAULT 0 CHECK(skipped_count BETWEEN 0 AND 9007199254740991),
 coalesced_count INTEGER NOT NULL DEFAULT 0 CHECK(coalesced_count BETWEEN 0 AND 9007199254740991),
 first_skipped_ms INTEGER,
 last_skipped_ms INTEGER,
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 9007199254740991),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 9007199254740991),
 CHECK((state='removed' AND input_json IS NULL AND input_bytes=0 AND permissions_json IS NULL) OR (state<>'removed' AND input_json IS NOT NULL AND input_bytes=length(CAST(input_json AS BLOB)) AND permissions_json IS NOT NULL)),
 UNIQUE(owner_person,vault_id,store_uuid,workflow_id),
 UNIQUE(activation_id,epoch)
);
CREATE TABLE workflow_activation_requests (
 owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
 vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
 store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
 request_key TEXT NOT NULL CHECK(length(request_key)=32 AND NOT request_key GLOB '*[^0-9a-f]*'),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND NOT request_digest GLOB '*[^0-9a-f]*'),
 activation_id TEXT NOT NULL REFERENCES workflow_activations(activation_id) ON DELETE RESTRICT,
 operation TEXT NOT NULL CHECK(operation IN ('enable','pause','remove')),
 applied_revision INTEGER NOT NULL CHECK(applied_revision BETWEEN 1 AND 9007199254740991),
 applied_epoch TEXT NOT NULL CHECK(length(applied_epoch)=32 AND NOT applied_epoch GLOB '*[^0-9a-f]*'),
 applied_state TEXT NOT NULL CHECK(applied_state IN ('enabled','paused','removed')),
 applied_definition_hash TEXT NOT NULL CHECK(length(applied_definition_hash)=64 AND NOT applied_definition_hash GLOB '*[^0-9a-f]*'),
 applied_at_ms INTEGER NOT NULL CHECK(applied_at_ms BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(owner_person,vault_id,store_uuid,request_key)
);
CREATE TABLE workflow_occurrences (
 activation_id TEXT NOT NULL REFERENCES workflow_activations(activation_id) ON DELETE RESTRICT,
 epoch TEXT NOT NULL CHECK(length(epoch)=32 AND NOT epoch GLOB '*[^0-9a-f]*'),
 occurrence_digest TEXT NOT NULL CHECK(length(occurrence_digest)=64 AND NOT occurrence_digest GLOB '*[^0-9a-f]*'),
 trigger_digest TEXT NOT NULL CHECK(length(trigger_digest)=64 AND NOT trigger_digest GLOB '*[^0-9a-f]*'),
 intended_at_ms INTEGER CHECK(intended_at_ms IS NULL OR intended_at_ms BETWEEN 0 AND 9007199254740991),
 event_digest TEXT CHECK(event_digest IS NULL OR (length(event_digest)=64 AND NOT event_digest GLOB '*[^0-9a-f]*')),
 workflow_run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id) ON DELETE RESTRICT,
 start_key TEXT NOT NULL CHECK(length(start_key)=32 AND NOT start_key GLOB '*[^0-9a-f]*'),
 definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64 AND NOT definition_hash GLOB '*[^0-9a-f]*'),
 configuration_digest TEXT NOT NULL CHECK(length(configuration_digest)=64 AND NOT configuration_digest GLOB '*[^0-9a-f]*'),
 input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND NOT input_digest GLOB '*[^0-9a-f]*'),
 permission_digest TEXT NOT NULL CHECK(length(permission_digest)=64 AND NOT permission_digest GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 9007199254740991),
 CHECK((intended_at_ms IS NULL)<>(event_digest IS NULL)),
 PRIMARY KEY(activation_id,epoch,occurrence_digest),
 UNIQUE(activation_id,start_key),
 UNIQUE(activation_id,epoch,intended_at_ms),
 UNIQUE(activation_id,epoch,event_digest)
);
CREATE TABLE workflow_activation_journal (
 transition_id TEXT PRIMARY KEY NOT NULL CHECK(length(transition_id)=32 AND NOT transition_id GLOB '*[^0-9a-f]*'),
 owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
 vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
 store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
 canonical_vault_path TEXT NOT NULL CHECK(length(canonical_vault_path) BETWEEN 1 AND 4096),
 workflow_id TEXT NOT NULL CHECK(length(workflow_id) BETWEEN 1 AND 128),
 expected_publication_revision INTEGER NOT NULL CHECK(expected_publication_revision BETWEEN 1 AND 9007199254740991),
 expected_definition_hash TEXT NOT NULL CHECK(length(expected_definition_hash)=64 AND NOT expected_definition_hash GLOB '*[^0-9a-f]*'),
 phase TEXT NOT NULL CHECK(phase IN ('prepared','pointer_cleared','reconciled')),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 9007199254740991),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN 0 AND 9007199254740991),
 UNIQUE(owner_person,vault_id,store_uuid,workflow_id,expected_publication_revision)
);

CREATE TABLE workflow_activation_accounts (
 activation_id TEXT NOT NULL,
 epoch TEXT NOT NULL CHECK(length(epoch)=32 AND NOT epoch GLOB '*[^0-9a-f]*'),
 connection_id TEXT NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 128),
 account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 128),
 account_identity_digest TEXT NOT NULL CHECK(length(account_identity_digest)=64 AND NOT account_identity_digest GLOB '*[^0-9a-f]*'),
 account_revision INTEGER NOT NULL CHECK(account_revision BETWEEN 1 AND 9007199254740991),
 revocation_generation INTEGER NOT NULL CHECK(revocation_generation BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(activation_id,epoch,connection_id,account_id),
 FOREIGN KEY(activation_id,epoch) REFERENCES workflow_activations(activation_id,epoch) ON DELETE RESTRICT
);
"#;

/// M95.2/.3 opt-in conversation archive. No settings rows, import or content backfill.
pub const SCHEMA_V49: &str = r#"
CREATE UNIQUE INDEX conversation_generation_scope ON chat_generations(generation_id,owner_person,vault_id,store_uuid);
CREATE TABLE conversation_retention (
 owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
 vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
 store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
 choice TEXT NOT NULL CHECK(choice IN ('off','days30','days90','forever')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY(owner_person,vault_id,store_uuid)
);
CREATE TABLE conversation_threads (
 owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
 vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
 store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
 thread_id TEXT NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 128),
 parent_thread_id TEXT,
 branch_message_id TEXT,
 title TEXT CHECK(title IS NULL OR length(CAST(title AS BLOB))<=320),
 title_generation_id TEXT,
 created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
 updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN created_at AND 9007199254740991),
 tombstone_at INTEGER CHECK(tombstone_at IS NULL OR tombstone_at BETWEEN 0 AND 9007199254740991),
 CHECK((parent_thread_id IS NULL)=(branch_message_id IS NULL)),
 CHECK(parent_thread_id IS NULL OR parent_thread_id<>thread_id),
 CHECK(tombstone_at IS NULL OR (title IS NULL AND title_generation_id IS NULL)),
 PRIMARY KEY(owner_person,vault_id,store_uuid,thread_id),
 FOREIGN KEY(owner_person,vault_id,store_uuid,parent_thread_id) REFERENCES conversation_threads(owner_person,vault_id,store_uuid,thread_id)
);
CREATE TABLE conversation_bindings (
 generation_id TEXT PRIMARY KEY NOT NULL REFERENCES chat_generations(generation_id),
 owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
 vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
 store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
 thread_id TEXT NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 128),
 user_message_id TEXT NOT NULL CHECK(length(user_message_id) BETWEEN 1 AND 128),
 assistant_message_id TEXT NOT NULL CHECK(length(assistant_message_id) BETWEEN 1 AND 128 AND assistant_message_id<>user_message_id),
 binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64 AND NOT binding_digest GLOB '*[^0-9a-f]*'),
 display_json TEXT CHECK(display_json IS NULL OR (json_valid(display_json) AND length(CAST(display_json AS BLOB))<=65536)),
 pending_json TEXT CHECK(pending_json IS NULL OR (json_valid(pending_json) AND length(CAST(pending_json AS BLOB))<=4194304)),
 choice TEXT NOT NULL CHECK(choice IN ('off','days30','days90','forever')),
 archive_state TEXT NOT NULL CHECK(archive_state IN ('pending','retained','off','expired','unavailable','deleted')),
 completed_at INTEGER CHECK(completed_at IS NULL OR completed_at BETWEEN 0 AND 9007199254740991),
 expires_at INTEGER CHECK(expires_at IS NULL OR expires_at>=completed_at),
 CHECK((archive_state='pending')=(completed_at IS NULL)),
 CHECK(completed_at IS NULL OR (display_json IS NULL AND pending_json IS NULL)),
 UNIQUE(owner_person,vault_id,store_uuid,user_message_id),
 UNIQUE(owner_person,vault_id,store_uuid,assistant_message_id),
 FOREIGN KEY(owner_person,vault_id,store_uuid,thread_id) REFERENCES conversation_threads(owner_person,vault_id,store_uuid,thread_id),
 FOREIGN KEY(generation_id,owner_person,vault_id,store_uuid) REFERENCES chat_generations(generation_id,owner_person,vault_id,store_uuid)
);
CREATE TABLE conversation_content (
 generation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversation_bindings(generation_id),
 content_json TEXT NOT NULL CHECK(json_valid(content_json) AND length(CAST(content_json AS BLOB))<=4194304),
 logical_bytes INTEGER NOT NULL CHECK(logical_bytes=length(CAST(content_json AS BLOB))),
 completed_at INTEGER NOT NULL CHECK(completed_at BETWEEN 0 AND 9007199254740991),
 expires_at INTEGER CHECK(expires_at IS NULL OR expires_at>=completed_at)
);
CREATE TABLE conversation_search (
 generation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversation_content(generation_id) ON DELETE CASCADE,
 search_text TEXT NOT NULL CHECK(length(CAST(search_text AS BLOB))<=4194304)
);
CREATE INDEX conversation_thread_order ON conversation_threads(owner_person,vault_id,store_uuid,updated_at,thread_id);
CREATE INDEX conversation_expiry ON conversation_content(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX conversation_attempt_order ON conversation_bindings(owner_person,vault_id,store_uuid,thread_id,completed_at,generation_id);
CREATE TRIGGER conversation_ancestry_immutable BEFORE UPDATE ON conversation_threads
WHEN NEW.owner_person IS NOT OLD.owner_person OR NEW.vault_id IS NOT OLD.vault_id OR NEW.store_uuid IS NOT OLD.store_uuid OR NEW.thread_id IS NOT OLD.thread_id OR NEW.parent_thread_id IS NOT OLD.parent_thread_id OR NEW.branch_message_id IS NOT OLD.branch_message_id OR NEW.created_at IS NOT OLD.created_at OR (OLD.tombstone_at IS NOT NULL AND NEW.tombstone_at IS NOT OLD.tombstone_at)
BEGIN SELECT RAISE(ABORT,'conversation ancestry and tombstone are immutable'); END;
CREATE TRIGGER conversation_binding_immutable BEFORE UPDATE ON conversation_bindings
WHEN NEW.generation_id IS NOT OLD.generation_id OR NEW.owner_person IS NOT OLD.owner_person OR NEW.vault_id IS NOT OLD.vault_id OR NEW.store_uuid IS NOT OLD.store_uuid OR NEW.thread_id IS NOT OLD.thread_id OR NEW.user_message_id IS NOT OLD.user_message_id OR NEW.assistant_message_id IS NOT OLD.assistant_message_id OR NEW.binding_digest IS NOT OLD.binding_digest OR (NEW.display_json IS NOT NULL AND NEW.display_json IS NOT OLD.display_json) OR (OLD.completed_at IS NOT NULL AND (NEW.completed_at IS NOT OLD.completed_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.choice IS NOT OLD.choice OR NEW.display_json IS NOT NULL OR NEW.pending_json IS NOT NULL OR NEW.archive_state='pending'))
BEGIN SELECT RAISE(ABORT,'conversation attempt identity and completion are immutable'); END;
CREATE TRIGGER conversation_tombstones_retained BEFORE DELETE ON conversation_threads
BEGIN SELECT RAISE(ABORT,'conversation tombstones are retained'); END;
CREATE TRIGGER conversation_content_terminal_immutable BEFORE UPDATE ON conversation_content
BEGIN SELECT RAISE(ABORT,'completed conversation content is immutable'); END;
CREATE TRIGGER conversation_content_tombstone_guard BEFORE INSERT ON conversation_content
WHEN EXISTS(SELECT 1 FROM conversation_bindings b JOIN conversation_threads t USING(owner_person,vault_id,store_uuid,thread_id) WHERE b.generation_id=NEW.generation_id AND (t.tombstone_at IS NOT NULL OR b.archive_state<>'pending'))
BEGIN SELECT RAISE(ABORT,'conversation content is tombstoned or already terminal'); END;
"#;

/// Explicit browser-cache imports have no execution generation or run identity.
pub const SCHEMA_V50: &str = r#"
CREATE TABLE conversation_legacy_attempts (
 attempt_id TEXT PRIMARY KEY NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128),
 owner_person TEXT NOT NULL CHECK(owner_person='human:me'),
 vault_id TEXT NOT NULL REFERENCES vault_registry(vault_id),
 store_uuid TEXT NOT NULL CHECK(length(store_uuid) BETWEEN 1 AND 128),
 thread_id TEXT NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 128),
 user_message_id TEXT NOT NULL CHECK(length(user_message_id) BETWEEN 1 AND 128),
 assistant_message_id TEXT NOT NULL CHECK(length(assistant_message_id) BETWEEN 1 AND 128 AND assistant_message_id<>user_message_id),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND NOT source_digest GLOB '*[^0-9a-f]*'),
 original_completed_at INTEGER CHECK(original_completed_at IS NULL OR original_completed_at BETWEEN 0 AND 9007199254740991),
 imported_at INTEGER NOT NULL CHECK(imported_at BETWEEN 0 AND 9007199254740991),
 cli_session_id TEXT CHECK(cli_session_id IS NULL OR length(cli_session_id)=36),
 choice TEXT NOT NULL CHECK(choice IN ('days30','days90','forever')),
 archive_state TEXT NOT NULL CHECK(archive_state IN ('retained','expired','unavailable','deleted')),
 expires_at INTEGER CHECK(expires_at IS NULL OR (original_completed_at IS NOT NULL AND expires_at>=original_completed_at)),
 UNIQUE(owner_person,vault_id,store_uuid,user_message_id),
 UNIQUE(owner_person,vault_id,store_uuid,assistant_message_id),
 FOREIGN KEY(owner_person,vault_id,store_uuid,thread_id) REFERENCES conversation_threads(owner_person,vault_id,store_uuid,thread_id)
);
CREATE TABLE conversation_legacy_content (
 attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES conversation_legacy_attempts(attempt_id),
 content_json TEXT NOT NULL CHECK(json_valid(content_json) AND length(CAST(content_json AS BLOB))<=4194304),
 logical_bytes INTEGER NOT NULL CHECK(logical_bytes=length(CAST(content_json AS BLOB))),
 expires_at INTEGER CHECK(expires_at IS NULL OR expires_at BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE conversation_legacy_search (
 attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES conversation_legacy_content(attempt_id) ON DELETE CASCADE,
 search_text TEXT NOT NULL CHECK(length(CAST(search_text AS BLOB))<=4194304)
);
CREATE INDEX conversation_legacy_order ON conversation_legacy_attempts(owner_person,vault_id,store_uuid,thread_id,imported_at,attempt_id);
CREATE INDEX conversation_legacy_expiry ON conversation_legacy_content(expires_at) WHERE expires_at IS NOT NULL;
CREATE TRIGGER conversation_legacy_identity_immutable BEFORE UPDATE ON conversation_legacy_attempts
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.owner_person IS NOT OLD.owner_person OR NEW.vault_id IS NOT OLD.vault_id OR NEW.store_uuid IS NOT OLD.store_uuid OR NEW.thread_id IS NOT OLD.thread_id OR NEW.user_message_id IS NOT OLD.user_message_id OR NEW.assistant_message_id IS NOT OLD.assistant_message_id OR NEW.source_digest IS NOT OLD.source_digest OR NEW.original_completed_at IS NOT OLD.original_completed_at OR NEW.imported_at IS NOT OLD.imported_at OR NEW.cli_session_id IS NOT OLD.cli_session_id OR NEW.choice IS NOT OLD.choice OR NEW.expires_at IS NOT OLD.expires_at OR (OLD.archive_state IN ('expired','deleted') AND NEW.archive_state IS NOT OLD.archive_state)
BEGIN SELECT RAISE(ABORT,'legacy archive identity and expiry are immutable'); END;
CREATE TRIGGER conversation_legacy_content_immutable BEFORE UPDATE ON conversation_legacy_content
BEGIN SELECT RAISE(ABORT,'legacy completed content is immutable'); END;
CREATE TRIGGER conversation_legacy_content_tombstone_guard BEFORE INSERT ON conversation_legacy_content
WHEN NOT EXISTS(SELECT 1 FROM conversation_legacy_attempts a JOIN conversation_threads t USING(owner_person,vault_id,store_uuid,thread_id) WHERE a.attempt_id=NEW.attempt_id AND t.tombstone_at IS NULL AND a.archive_state IN ('retained','unavailable'))
BEGIN SELECT RAISE(ABORT,'legacy archive is tombstoned or expired'); END;
CREATE VIEW conversation_archive_attempts AS
 SELECT b.generation_id AS attempt_id,b.owner_person,b.vault_id,b.store_uuid,b.thread_id,b.user_message_id,b.assistant_message_id,g.current_run_id AS run_id,m.cli_session_id,b.completed_at,b.completed_at AS order_at,b.expires_at,b.archive_state,NULL AS imported_at,'native_run' AS origin
 FROM conversation_bindings b JOIN chat_generations g USING(generation_id) JOIN chat_generation_runs m ON m.run_id=g.current_run_id
 UNION ALL
 SELECT a.attempt_id,a.owner_person,a.vault_id,a.store_uuid,a.thread_id,a.user_message_id,a.assistant_message_id,NULL,a.cli_session_id,a.original_completed_at,a.imported_at,a.expires_at,a.archive_state,a.imported_at,'browser_cache'
 FROM conversation_legacy_attempts a;
CREATE VIEW conversation_archive_content AS
 SELECT generation_id AS attempt_id,content_json,logical_bytes,expires_at FROM conversation_content
 UNION ALL SELECT attempt_id,content_json,logical_bytes,expires_at FROM conversation_legacy_content;
CREATE VIEW conversation_archive_search AS
 SELECT generation_id AS attempt_id,search_text FROM conversation_search
 UNION ALL SELECT attempt_id,search_text FROM conversation_legacy_search;
"#;
