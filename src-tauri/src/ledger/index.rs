//! The disposable materialized index (M21.5): SQLite in app-data, keyed by
//! store id. A CACHE, constitutionally: nothing may exist in it that
//! segments cannot reproduce, it is never synced, never authoritative, and
//! on any sign of damage it is deleted and rebuilt — never trusted. It
//! lives in app-data precisely so SQLite never sits inside a possibly
//! cloud-synced vault (WAL + sync = corruption, D2).
//!
//! Tables: `events` — the replayed frames, whose max seq IS the replay
//! cursor; `meta` — the latest-seen head (the `Remembered` that feeds
//! divergence detection; app-data can be rewound too, so corroboration,
//! never proof) plus this installation's writer id for diagnostics.
//!
//! M22.3 adds the epistemic tables (sources, entities, aliases, beliefs,
//! revisions, basis links, observations, lineage, resolutions,
//! independence, derived sources, relations, batches, versions, anomalies).
//! They are MATERIALIZED VIEWS of `reduce::reduce()` — dropped and
//! re-written from the folded state on every replay, in deterministic
//! order, so a rebuild-from-zero is byte-identical and nothing exists here
//! that segments cannot reproduce.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::recovery::Remembered;
use super::LedgerRead;

/// Sub-directory of the app config dir holding one index per store.
const INDEX_DIR: &str = "ledger-index";

pub fn index_path(config_dir: &Path, store_id: &str) -> PathBuf {
    config_dir
        .join(INDEX_DIR)
        .join(format!("{store_id}.sqlite"))
}

#[derive(Debug)]
pub struct Index {
    conn: Connection,
    path: PathBuf,
}

fn open_connection(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    // WAL per D2; both rebuilds of a byte-identical pair set it the same
    // way, and the last connection's close checkpoints and removes the
    // sidecar files.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events (
            seq INTEGER PRIMARY KEY,
            event_id TEXT NOT NULL,
            hash TEXT NOT NULL,
            prev TEXT NOT NULL,
            ingested_at TEXT NOT NULL,
            wall_clock_anomaly INTEGER NOT NULL,
            kind TEXT NOT NULL,
            body TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(EPISTEMIC_DDL)
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// The complete M22.3 index schema beyond `events`/`meta`.
const EPISTEMIC_DDL: &str = "
    CREATE TABLE IF NOT EXISTS logical_batches (
        batch_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        marker_seq INTEGER,
        member_count INTEGER NOT NULL,
        operation_key TEXT
    );
    CREATE TABLE IF NOT EXISTS batch_members (
        batch_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (batch_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS state_versions (
        target_class TEXT NOT NULL,
        target_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        last_event_id TEXT NOT NULL,
        PRIMARY KEY (target_class, target_id)
    );
    CREATE TABLE IF NOT EXISTS sources (
        source_id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        capability TEXT NOT NULL,
        independence_domain_id TEXT,
        registration_event_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entities (
        entity_id TEXT PRIMARY KEY,
        registered_by_event_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS aliases (
        normalized_alias TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS beliefs (
        belief_id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        current_revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_event_id TEXT NOT NULL,
        attested_event_id TEXT,
        attested_revision_event_id TEXT
    );
    CREATE TABLE IF NOT EXISTS belief_revisions (
        belief_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        content TEXT NOT NULL,
        fields TEXT NOT NULL,
        basis_state TEXT NOT NULL,
        unsupported_reason TEXT,
        PRIMARY KEY (belief_id, revision)
    );
    CREATE TABLE IF NOT EXISTS belief_basis_links (
        belief_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        observation_event_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (belief_id, revision, ordinal)
    );
    CREATE TABLE IF NOT EXISTS observations (
        event_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        observation_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_registration_event_id TEXT NOT NULL,
        subject_resolution TEXT NOT NULL,
        subject_entity_id TEXT,
        raw_ref TEXT,
        effective_entity_id TEXT,
        effective_resolution_event_id TEXT,
        authority_provenance TEXT,
        assertion_basis TEXT,
        actor_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lineage_edges (
        observation_event_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        edge TEXT NOT NULL,
        parent_observation_event_id TEXT NOT NULL,
        PRIMARY KEY (observation_event_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS observation_subject_resolutions (
        event_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        observation_event_id TEXT NOT NULL,
        action TEXT NOT NULL,
        from_entity_id TEXT,
        to_entity_id TEXT NOT NULL,
        resolver_tier TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observation_independence (
        left_event_id TEXT NOT NULL,
        right_event_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        proof_kind TEXT NOT NULL,
        PRIMARY KEY (left_event_id, right_event_id)
    );
    CREATE TABLE IF NOT EXISTS derived_belief_sources (
        observation_event_id TEXT NOT NULL,
        belief_revision_event_id TEXT NOT NULL,
        PRIMARY KEY (observation_event_id, belief_revision_event_id)
    );
    CREATE TABLE IF NOT EXISTS relations (
        relation_id TEXT PRIMARY KEY,
        from_belief_id TEXT NOT NULL,
        to_belief_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        live INTEGER NOT NULL,
        last_add_event_id TEXT NOT NULL,
        last_event_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reducer_anomalies (
        ordinal INTEGER PRIMARY KEY,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        batch_id TEXT,
        code TEXT NOT NULL,
        detail TEXT NOT NULL
    );
";

/// The epistemic tables in drop/insert order — one list so materialize and
/// its tests cannot disagree about what "all of them" means.
const EPISTEMIC_TABLES: [&str; 16] = [
    "logical_batches",
    "batch_members",
    "state_versions",
    "sources",
    "entities",
    "aliases",
    "beliefs",
    "belief_revisions",
    "belief_basis_links",
    "observations",
    "lineage_edges",
    "observation_subject_resolutions",
    "observation_independence",
    "derived_belief_sources",
    "relations",
    "reducer_anomalies",
];

/// Is this database healthy enough to trust as a cache? Any failure —
/// unreadable header, malformed image, failed pragma — means no.
fn healthy(path: &Path) -> bool {
    let Ok(conn) = Connection::open(path) else {
        return false;
    };
    let check: Result<String, _> = conn.query_row("PRAGMA quick_check", [], |row| row.get(0));
    matches!(check.as_deref(), Ok("ok"))
}

impl Index {
    /// Open the store's index, creating it fresh when absent — and deleting
    /// it first when damaged. A cache that cannot prove itself healthy is
    /// deleted and rebuilt from segments, never trusted.
    pub fn open(config_dir: &Path, store_id: &str) -> Result<Index, String> {
        let path = index_path(config_dir, store_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if path.exists() && !healthy(&path) {
            remove_index_files(&path)?;
        }
        let conn = open_connection(&path)?;
        Ok(Index { conn, path })
    }

    /// Replay committed frames into the index, incrementally by seq, and
    /// remember the ledger's head. Refuses a ledger BEHIND the index or one
    /// whose history disagrees at the cursor — the cache must never smooth
    /// over a divergence the verdict layer exists to name.
    pub fn replay(&mut self, read: &LedgerRead, writer_id: &str) -> Result<(), String> {
        let cursor = self.max_seq()?;
        if let Some(cursor) = cursor {
            if read.head_seq.is_none() || read.head_seq < Some(cursor) {
                return Err(format!(
                    "ledger head {:?} is behind the index cursor {cursor} — diverged, not replayable",
                    read.head_seq
                ));
            }
            let cursor_hash: String = self
                .conn
                .query_row(
                    "SELECT hash FROM events WHERE seq = ?1",
                    [to_sql_seq(cursor)?],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let ledger_hash = read
                .frames
                .iter()
                .find(|f| f.seq == cursor)
                .map(|f| f.hash.as_str());
            if ledger_hash != Some(cursor_hash.as_str()) {
                return Err(format!(
                    "ledger history disagrees with the index at seq {cursor} — diverged, not replayable"
                ));
            }
        }

        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut insert = tx
                .prepare(
                    "INSERT INTO events
                     (seq, event_id, hash, prev, ingested_at, wall_clock_anomaly, kind, body)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .map_err(|e| e.to_string())?;
            for frame in read
                .frames
                .iter()
                .filter(|f| cursor.is_none_or(|c| f.seq > c))
            {
                insert
                    .execute(rusqlite::params![
                        to_sql_seq(frame.seq)?,
                        frame.event_id,
                        frame.hash,
                        frame.prev,
                        frame.ingested_at,
                        frame.wall_clock_anomaly,
                        frame.kind,
                        serde_json::to_string(&frame.body).map_err(|e| e.to_string())?,
                    ])
                    .map_err(|e| e.to_string())?;
            }
            let mut put_meta = tx
                .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)")
                .map_err(|e| e.to_string())?;
            let head_seq = read.head_seq.map_or_else(String::new, |s| s.to_string());
            for (key, value) in [
                ("store_id", read.store.store_id.as_str()),
                ("writer_id", writer_id),
                ("head_seq", head_seq.as_str()),
                ("head_hash", read.head_hash.as_str()),
            ] {
                put_meta.execute([key, value]).map_err(|e| e.to_string())?;
            }
            // The epistemic tables are a materialized view of the fold —
            // rewritten whole, in deterministic order, every replay.
            let state = super::reduce::reduce(&read.frames, &read.store.store_id);
            materialize(&tx, &state)?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Drop the file and replay everything from segments — the
    /// rebuild-from-zero path. Two rebuilds of the same ledger produce a
    /// byte-identical file (same pinned SQLite, same operation sequence).
    pub fn rebuild(self, read: &LedgerRead, writer_id: &str) -> Result<Index, String> {
        let path = self.path.clone();
        drop(self); // close cleanly: checkpoint WAL, remove sidecars
        remove_index_files(&path)?;
        let conn = open_connection(&path)?;
        let mut index = Index { conn, path };
        index.replay(read, writer_id)?;
        Ok(index)
    }

    /// Update only the remembered head — the cheap per-append path (shadow
    /// mode calls it after every commit). The events table catches up on
    /// the next activate replay; a briefly stale events table is fine in a
    /// cache whose meta is the anchor that matters.
    pub fn remember(&mut self, remembered: &Remembered, writer_id: &str) -> Result<(), String> {
        let head_seq = remembered
            .head_seq
            .map_or_else(String::new, |s| s.to_string());
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for (key, value) in [
            ("store_id", remembered.store_id.as_str()),
            ("writer_id", writer_id),
            ("head_seq", head_seq.as_str()),
            ("head_hash", remembered.head_hash.as_str()),
        ] {
            tx.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                [key, value],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// The head this machine last saw, for divergence classification.
    pub fn remembered(&self) -> Result<Option<Remembered>, String> {
        let get = |key: &str| -> Result<Option<String>, String> {
            match self
                .conn
                .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                    row.get::<_, String>(0)
                }) {
                Ok(value) => Ok(Some(value)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        };
        let (Some(store_id), Some(head_hash)) = (get("store_id")?, get("head_hash")?) else {
            return Ok(None);
        };
        let head_seq = match get("head_seq")?.as_deref() {
            None | Some("") => None,
            Some(raw) => Some(raw.parse::<u64>().map_err(|e| e.to_string())?),
        };
        Ok(Some(Remembered {
            store_id,
            head_seq,
            head_hash,
        }))
    }

    /// The replay cursor: seq of the newest indexed event.
    pub fn max_seq(&self) -> Result<Option<u64>, String> {
        let max: Option<i64> = self
            .conn
            .query_row("SELECT MAX(seq) FROM events", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        max.map(from_sql_seq).transpose()
    }

    pub fn event_count(&self) -> Result<u64, String> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        from_sql_seq(count)
    }

    /// Every row, for content-equality assertions (incremental vs rebuilt
    /// indexes differ in file bytes — transaction counters — but must never
    /// differ in content).
    pub fn dump_events(&self) -> Result<Vec<(u64, String, String, String)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, event_id, hash, body FROM events ORDER BY seq")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(|e| e.to_string())?;
        let rows = rows
            .collect::<Result<Vec<(i64, String, String, String)>, _>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter()
            .map(|(seq, event_id, hash, body)| Ok((from_sql_seq(seq)?, event_id, hash, body)))
            .collect()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Deterministic text dump of EVERY epistemic table — the
    /// content-equality assertion for rebuild/replay agreement (file bytes
    /// can differ between incremental and from-zero; content never may).
    pub fn dump_epistemic(&self) -> Result<String, String> {
        let mut out = String::new();
        for table in EPISTEMIC_TABLES {
            out.push_str("== ");
            out.push_str(table);
            out.push('\n');
            let mut stmt = self
                .conn
                .prepare(&format!("SELECT * FROM {table}"))
                .map_err(|e| e.to_string())?;
            let columns = stmt.column_count();
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                for i in 0..columns {
                    if i > 0 {
                        out.push('|');
                    }
                    let value: rusqlite::types::Value = row.get(i).map_err(|e| e.to_string())?;
                    match value {
                        rusqlite::types::Value::Null => out.push('∅'),
                        rusqlite::types::Value::Integer(v) => out.push_str(&v.to_string()),
                        rusqlite::types::Value::Real(v) => out.push_str(&v.to_string()),
                        rusqlite::types::Value::Text(v) => out.push_str(&v),
                        rusqlite::types::Value::Blob(v) => {
                            out.push_str(&crate::ledger::sha256_hex(&v))
                        }
                    }
                }
                out.push('\n');
            }
        }
        Ok(out)
    }
}

/// Rewrite every epistemic table from the folded state, inside the caller's
/// transaction. Deterministic: tables in EPISTEMIC_TABLES order, rows in
/// the state's own canonical order (BTreeMap iteration / fold order).
fn materialize(
    tx: &rusqlite::Transaction<'_>,
    state: &super::reduce::EpistemicState,
) -> Result<(), String> {
    let err = |e: rusqlite::Error| e.to_string();
    for table in EPISTEMIC_TABLES {
        tx.execute(&format!("DELETE FROM {table}"), [])
            .map_err(err)?;
    }
    for batch in &state.batches {
        tx.execute(
            "INSERT INTO logical_batches VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                batch.batch_id,
                batch.state,
                batch.marker_seq.map(|s| s as i64),
                batch.member_count as i64,
                batch.operation_key,
            ],
        )
        .map_err(err)?;
        for (ordinal, (event_id, seq)) in batch.members.iter().enumerate() {
            tx.execute(
                "INSERT INTO batch_members VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![batch.batch_id, ordinal as i64, event_id, *seq as i64],
            )
            .map_err(err)?;
        }
    }
    for ((class, id), (version, last_event)) in &state.versions {
        tx.execute(
            "INSERT INTO state_versions VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![class, id, *version as i64, last_event],
        )
        .map_err(err)?;
    }
    for source in state.sources.values() {
        tx.execute(
            "INSERT INTO sources VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                source.source_id,
                source.registration.source_key(),
                source.registration.kind_str(),
                capability_str(source.registration.capability()),
                source.registration.independence_domain_id(),
                source.registration_event_id,
            ],
        )
        .map_err(err)?;
    }
    for entity in state.entities.values() {
        tx.execute(
            "INSERT INTO entities VALUES (?1, ?2)",
            rusqlite::params![entity.entity_id, entity.registered_by_event_id],
        )
        .map_err(err)?;
    }
    for alias in state.alias_registry.values() {
        tx.execute(
            "INSERT INTO aliases VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                alias.normalized,
                alias.alias,
                alias.entity_id,
                alias.event_id
            ],
        )
        .map_err(err)?;
    }
    for belief in state.beliefs.values() {
        let current = belief.current();
        let projected = super::project::project(&current.content, &current.fields);
        let content_hash = super::schema::belief::attested_content_hash(projected.as_bytes());
        tx.execute(
            "INSERT INTO beliefs VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                belief.belief_id,
                belief.entity_id,
                current.revision as i64,
                content_hash,
                belief.created_event_id,
                belief.attested.as_ref().map(|(e, _)| e),
                belief.attested.as_ref().map(|(_, r)| r),
            ],
        )
        .map_err(err)?;
        for revision in &belief.revisions {
            let (basis_state, reason) = match &revision.basis {
                super::schema::BeliefBasis::Unsupported { reason } => {
                    ("unsupported", Some(reason.clone()))
                }
                super::schema::BeliefBasis::Linked { .. } => ("linked", None),
            };
            tx.execute(
                "INSERT INTO belief_revisions VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    belief.belief_id,
                    revision.revision as i64,
                    revision.event_id,
                    revision.content,
                    serde_json::to_string(&revision.fields).map_err(|e| e.to_string())?,
                    basis_state,
                    reason,
                ],
            )
            .map_err(err)?;
            if let super::schema::BeliefBasis::Linked { links } = &revision.basis {
                for (ordinal, link) in links.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO belief_basis_links VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![
                            belief.belief_id,
                            revision.revision as i64,
                            ordinal as i64,
                            link.observation_event_id,
                            basis_role_str(link.role),
                        ],
                    )
                    .map_err(err)?;
                }
            }
        }
    }
    for observation in state.observations.values() {
        let (resolution, subject_entity, raw_ref) = match &observation.subject {
            super::schema::SubjectRef::Resolved { entity_id, .. } => {
                ("resolved", Some(entity_id.clone()), None)
            }
            super::schema::SubjectRef::Unresolved { raw_ref, .. } => {
                ("unresolved", None, Some(raw_ref.clone()))
            }
            super::schema::SubjectRef::None => ("none", None, None),
        };
        tx.execute(
            "INSERT INTO observations VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            rusqlite::params![
                observation.event_id,
                observation.seq as i64,
                observation_kind_str(observation.kind),
                observation.source_id,
                observation.source_registration_event_id,
                resolution,
                subject_entity,
                raw_ref,
                observation.effective_entity,
                observation.effective_resolution_event,
                observation.authority.map(authority_str),
                observation.assertion_basis.map(assertion_basis_str),
                observation.actor,
            ],
        )
        .map_err(err)?;
        for (ordinal, (edge, parent)) in observation.lineage_parents.iter().enumerate() {
            tx.execute(
                "INSERT INTO lineage_edges VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    observation.event_id,
                    ordinal as i64,
                    lineage_str(*edge),
                    parent
                ],
            )
            .map_err(err)?;
        }
    }
    for row in &state.resolutions {
        tx.execute(
            "INSERT INTO observation_subject_resolutions VALUES (?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![
                row.event_id,
                row.seq as i64,
                row.observation_event_id,
                row.action,
                row.from_entity_id,
                row.to_entity_id,
                tier_str(row.resolver_tier),
            ],
        )
        .map_err(err)?;
    }
    for ((left, right), row) in &state.independence {
        tx.execute(
            "INSERT INTO observation_independence VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![left, right, row.event_id, row.proof_kind],
        )
        .map_err(err)?;
    }
    for (observation, revision_event) in &state.derived_belief_sources {
        tx.execute(
            "INSERT INTO derived_belief_sources VALUES (?1, ?2)",
            rusqlite::params![observation, revision_event],
        )
        .map_err(err)?;
    }
    for relation in state.relations.values() {
        tx.execute(
            "INSERT INTO relations VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                relation.relation_id,
                relation.from,
                relation.to,
                relation.relation.as_str(),
                relation.live,
                relation.last_add_event_id,
                relation.last_event_id,
            ],
        )
        .map_err(err)?;
    }
    for (ordinal, anomaly) in state.anomalies.iter().enumerate() {
        tx.execute(
            "INSERT INTO reducer_anomalies VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                ordinal as i64,
                anomaly.seq as i64,
                anomaly.event_id,
                anomaly.batch_id,
                anomaly.code,
                anomaly.detail,
            ],
        )
        .map_err(err)?;
    }
    Ok(())
}

fn capability_str(c: super::schema::AuthorityCapability) -> &'static str {
    match c {
        super::schema::AuthorityCapability::ContentOnly => "content_only",
        super::schema::AuthorityCapability::HumanAssertion => "human_assertion",
        super::schema::AuthorityCapability::DirectSystemArtifact => "direct_system_artifact",
    }
}

fn basis_role_str(r: super::schema::BasisRole) -> &'static str {
    match r {
        super::schema::BasisRole::Supports => "supports",
        super::schema::BasisRole::Opposes => "opposes",
        super::schema::BasisRole::Context => "context",
    }
}

fn observation_kind_str(k: super::schema::ObservationKind) -> &'static str {
    match k {
        super::schema::ObservationKind::SourceSnapshot => "source_snapshot",
        super::schema::ObservationKind::SystemEvent => "system_event",
        super::schema::ObservationKind::ExtractedAssertion => "extracted_assertion",
        super::schema::ObservationKind::DerivedContent => "derived_content",
        super::schema::ObservationKind::HumanAssertion => "human_assertion",
    }
}

fn authority_str(a: super::schema::AuthorityProvenance) -> &'static str {
    match a {
        super::schema::AuthorityProvenance::TrustedHumanCapture => "trusted_human_capture",
        super::schema::AuthorityProvenance::RegisteredDirectArtifact => {
            "registered_direct_artifact"
        }
        super::schema::AuthorityProvenance::AgentInferred => "agent_inferred",
    }
}

fn assertion_basis_str(b: super::schema::AssertionBasis) -> &'static str {
    match b {
        super::schema::AssertionBasis::Firsthand => "firsthand",
        super::schema::AssertionBasis::ResponsibleOwner => "responsible_owner",
        super::schema::AssertionBasis::Reported => "reported",
        super::schema::AssertionBasis::Inferred => "inferred",
        super::schema::AssertionBasis::Unknown => "unknown",
    }
}

fn tier_str(t: super::schema::ResolverTier) -> &'static str {
    match t {
        super::schema::ResolverTier::ExactId => "exact_id",
        super::schema::ResolverTier::KnownAlias => "known_alias",
        super::schema::ResolverTier::ExplicitRelation => "explicit_relation",
        super::schema::ResolverTier::NormalizedMatch => "normalized_match",
    }
}

fn lineage_str(l: super::schema::LineageKind) -> &'static str {
    match l {
        super::schema::LineageKind::ReportedBy => "reported_by",
        super::schema::LineageKind::DerivedFrom => "derived_from",
        super::schema::LineageKind::CopiedFrom => "copied_from",
        super::schema::LineageKind::SummarizedFrom => "summarized_from",
    }
}

/// SQLite integers are i64; ledger seqs are u64. The conversions are total
/// for any ledger a single writer can produce, and loud if they ever stop
/// being so.
fn to_sql_seq(seq: u64) -> Result<i64, String> {
    i64::try_from(seq).map_err(|_| format!("seq {seq} exceeds the index's integer range"))
}

fn from_sql_seq(seq: i64) -> Result<u64, String> {
    u64::try_from(seq).map_err(|_| format!("negative seq {seq} in the index"))
}

/// Delete the database and its WAL sidecars — the whole cache, atomically
/// enough for a file that is never authoritative.
fn remove_index_files(path: &Path) -> Result<(), String> {
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        match std::fs::remove_file(PathBuf::from(&name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::writer::LedgerWriter;
    use super::super::{ledger_dir, read_ledger};
    use super::*;
    use crate::vault::testutil;

    const WRITER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";

    fn seeded(label: &str, events: u64) -> (PathBuf, PathBuf) {
        let vault = testutil::temp_vault(label);
        let config = testutil::temp_vault(&format!("{label}-config"));
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        for i in 0..events {
            writer
                .append(
                    "vault.write",
                    serde_json::json!({ "path": format!("n{i}.md") }),
                )
                .unwrap();
        }
        (vault, config)
    }

    #[test]
    fn replay_is_incremental_and_remembers_the_head() {
        let (vault, config) = seeded("idx-replay", 3);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let mut index = Index::open(&config, &read.store.store_id).unwrap();
        index.replay(&read, WRITER).unwrap();
        assert_eq!(index.event_count().unwrap(), 3);
        assert_eq!(index.max_seq().unwrap(), Some(3));

        // Two more events; replay again — only the delta is new.
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        writer
            .append("vault.write", serde_json::json!({"path": "x.md"}))
            .unwrap();
        writer
            .append("vault.delete", serde_json::json!({"path": "x.md"}))
            .unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        index.replay(&read, WRITER).unwrap();
        assert_eq!(index.event_count().unwrap(), 5);

        let remembered = index.remembered().unwrap().expect("head remembered");
        assert_eq!(remembered.store_id, read.store.store_id);
        assert_eq!(remembered.head_seq, Some(5));
        assert_eq!(remembered.head_hash, read.head_hash);
        // The remembered head satisfies the M21.4 classifier.
        assert_eq!(
            super::super::recovery::classify(&ledger_dir(&vault), Some(WRITER), Some(&remembered))
                .verdict,
            super::super::recovery::Verdict::Valid
        );
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn rebuild_from_zero_is_byte_identical() {
        let (vault, config) = seeded("idx-deterministic", 4);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let index = Index::open(&config, &read.store.store_id).unwrap();
        let index = index.rebuild(&read, WRITER).unwrap();
        let path = index.path().to_path_buf();
        drop(index);
        let first = std::fs::read(&path).unwrap();

        let index = Index::open(&config, &read.store.store_id).unwrap();
        let index = index.rebuild(&read, WRITER).unwrap();
        drop(index);
        let second = std::fs::read(&path).unwrap();
        assert_eq!(first, second, "rebuild-from-zero must be deterministic");
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn a_corrupt_index_is_deleted_and_rebuilt_never_trusted() {
        let (vault, config) = seeded("idx-corrupt", 4);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let mut index = Index::open(&config, &read.store.store_id).unwrap();
        index.replay(&read, WRITER).unwrap();
        let path = index.path().to_path_buf();
        drop(index);

        // Truncate the database mid-file.
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();

        let mut index = Index::open(&config, &read.store.store_id).unwrap();
        assert_eq!(index.event_count().unwrap(), 0, "damaged cache starts over");
        index.replay(&read, WRITER).unwrap();
        assert_eq!(index.event_count().unwrap(), 4);
        assert_eq!(index.max_seq().unwrap(), Some(4));
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn incremental_and_from_zero_agree_on_content() {
        let (vault, config) = seeded("idx-content", 3);
        let read3 = read_ledger(&ledger_dir(&vault)).unwrap();
        let mut incremental = Index::open(&config, &read3.store.store_id).unwrap();
        incremental.replay(&read3, WRITER).unwrap();
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        writer
            .append("vault.write", serde_json::json!({"path": "late.md"}))
            .unwrap();
        drop(writer);
        let read4 = read_ledger(&ledger_dir(&vault)).unwrap();
        incremental.replay(&read4, WRITER).unwrap();
        let incremental_rows = incremental.dump_events().unwrap();
        // Nothing exists in the cache that segments cannot reproduce: a
        // from-zero rebuild has exactly the same content.
        let rebuilt = incremental.rebuild(&read4, WRITER).unwrap();
        assert_eq!(rebuilt.dump_events().unwrap(), incremental_rows);
        assert_eq!(rebuilt.event_count().unwrap(), 4);
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn epistemic_tables_materialize_and_rebuild_byte_identically() {
        use crate::ledger::schema::{self, tests as schema_tests};
        let vault = testutil::temp_vault("idx-epistemic");
        let config = testutil::temp_vault("idx-epistemic-config");
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        // One belief (its store-agnostic fixture ids validate structurally;
        // the basis must be explicit-unsupported since no observation is
        // committed) plus a plumbing event that creates no entity state.
        let mut belief = schema_tests::belief_created();
        belief.basis = schema::BeliefBasis::Unsupported {
            reason: "index fixture without observations".into(),
        };
        writer
            .append(
                schema::KIND_BELIEF_CREATED,
                serde_json::to_value(&belief).unwrap(),
            )
            .unwrap();
        writer
            .append("vault.write", serde_json::json!({ "path": "a.md" }))
            .unwrap();
        drop(writer);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let mut index = Index::open(&config, &read.store.store_id).unwrap();
        index.replay(&read, WRITER).unwrap();
        let dump = index.dump_epistemic().unwrap();
        assert!(dump.contains("== beliefs"));
        assert!(
            dump.contains(&belief.belief_id),
            "the belief materialized: {dump}"
        );
        assert!(dump.contains("belief|"), "state_versions row exists");

        // Rebuild from zero twice: byte-identical files, identical dumps.
        let index = index.rebuild(&read, WRITER).unwrap();
        let path = index.path().to_path_buf();
        let rebuilt_dump = index.dump_epistemic().unwrap();
        assert_eq!(
            rebuilt_dump, dump,
            "incremental and from-zero agree on content"
        );
        drop(index);
        let first = std::fs::read(&path).unwrap();
        let index = Index::open(&config, &read.store.store_id).unwrap();
        let index = index.rebuild(&read, WRITER).unwrap();
        drop(index);
        let second = std::fs::read(&path).unwrap();
        assert_eq!(
            first, second,
            "epistemic rebuild-from-zero is deterministic"
        );
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn replay_refuses_a_ledger_behind_or_beside_the_index() {
        let (vault, config) = seeded("idx-diverge", 4);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let mut index = Index::open(&config, &read.store.store_id).unwrap();
        index.replay(&read, WRITER).unwrap();

        // A "restored" ledger: same store, shorter history.
        let mut behind = read_ledger(&ledger_dir(&vault)).unwrap();
        behind.frames.truncate(2);
        behind.head_seq = Some(2);
        let err = index.replay(&behind, WRITER).unwrap_err();
        assert!(err.contains("behind the index"), "{err}");

        // A rewritten history: same length, different bytes at the cursor.
        let mut rewritten = read_ledger(&ledger_dir(&vault)).unwrap();
        rewritten.frames[3].hash = "im-a-different-history".to_string();
        let err = index.replay(&rewritten, WRITER).unwrap_err();
        assert!(err.contains("disagrees with the index"), "{err}");

        // The honest ledger still replays (a no-op — cursor is the head).
        index.replay(&read, WRITER).unwrap();
        assert_eq!(index.event_count().unwrap(), 4);
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }
}
