//! Native admission boundary. Real producer hooks remain unregistered.
use super::{service::AuthorityDb, types::*};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Weak,
    },
};

// No Deserialize, public fields, string factory, RunGrant conversion or callback.
// Only the native authentication owners may eventually produce this capability.
#[derive(Clone)]
pub(super) struct NativeAdmissionProof {
    facts: NativeFacts,
    owner_live: Weak<AtomicBool>,
    caller_live: Weak<AtomicBool>,
    opening_generation: Weak<AtomicU64>,
}
#[derive(Clone)]
struct NativeFacts {
    data_dir: PathBuf,
    runtime_identity: (u64, u64),
    canonical_vault: PathBuf,
    vault_id: String,
    store_uuid: String,
    app_session_id: String,
    generation: u64,
    run_id: String,
    actor_id: String,
    cli_session_id: Option<String>,
    parent_run_id: Option<String>,
    client_id: Option<String>,
    child_job_id: Option<String>,
    source_kind: String,
    owner_person: String,
}
pub(super) struct AdmittedActionSubject {
    scope: ActionSubjectView,
    owner_person: String,
    can_call: bool,
}
impl AdmittedActionSubject {
    pub(super) fn scope(&self) -> &ActionSubjectView {
        &self.scope
    }
    pub(super) fn owner_person(&self) -> &str {
        &self.owner_person
    }
    pub(super) fn can_call(&self) -> bool {
        self.can_call
    }
}
pub(super) fn denied() -> ActionError {
    error(
        ActionErrorCode::Denied,
        "Native action authority was not admitted.",
    )
}
pub(super) fn unavailable() -> ActionError {
    error(
        ActionErrorCode::Unavailable,
        "Native action authority is unavailable.",
    )
}
use super::schema::admission_rules;

fn physical_identity(path: &std::path::Path) -> Result<(u64, u64), ActionError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path).map_err(|_| unavailable())?;
        if !metadata.is_file() {
            return Err(unavailable());
        }
        Ok((metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(unavailable())
    }
}
fn validate_context(db: AuthorityDb<'_>, proof: &NativeAdmissionProof) -> Result<(), ActionError> {
    let p = &proof.facts;
    let rules = admission_rules();
    let l = &rules.limits;
    if !proof.owner_live.upgrade().is_some_and(|v|v.load(Ordering::SeqCst))
        || !proof.caller_live.upgrade().is_some_and(|v|v.load(Ordering::SeqCst))
        || proof.opening_generation.upgrade().is_none_or(|v|v.load(Ordering::SeqCst)!=p.generation)
        || p.owner_person!=rules.owner_storage_key
        || !rules.source_kinds.contains(&p.source_kind)
        // M95 must supply a real job/claim producer before this source is admitted.
        || p.child_job_id.is_some() || p.source_kind=="job"
        || (p.source_kind=="client")!=p.client_id.is_some()
        || (p.source_kind=="run")!=p.cli_session_id.is_some()
        || [&p.vault_id,&p.store_uuid,&p.run_id,&p.actor_id].iter().any(|s|s.is_empty()||s.len()>l.identity_bytes)
        || p.app_session_id.is_empty()||p.app_session_id.len()>l.process_session_bytes
    {
        return Err(denied());
    }
    let path = p
        .canonical_vault
        .canonicalize()
        .map_err(|_| unavailable())?;
    if path != p.canonical_vault
        || path.as_os_str().len() > l.canonical_path_bytes
        || crate::runtime::scope::derive_vault_id(&path) != p.vault_id
    {
        return Err(denied());
    }
    let database: String = db
        .query(
            "SELECT file FROM pragma_database_list WHERE name='main'",
            &[],
            |r| r.get(0),
        )
        .map_err(|_| unavailable())?;
    if physical_identity(std::path::Path::new(&database))? != p.runtime_identity
        || physical_identity(&crate::runtime::runtime_db_path(&p.data_dir))? != p.runtime_identity
    {
        return Err(denied());
    }
    Ok(())
}
fn lineage_error(error: super::native_lineage::LineageError) -> ActionError {
    match error {
        super::native_lineage::LineageError::Denied => denied(),
        super::native_lineage::LineageError::Unavailable => unavailable(),
    }
}
impl NativeFacts {
    fn binding(&self) -> super::native_lineage::NativeBinding<'_> {
        super::native_lineage::NativeBinding {
            run_id: &self.run_id,
            vault_id: &self.vault_id,
            store_uuid: &self.store_uuid,
            canonical_vault: &self.canonical_vault,
            owner_person: &self.owner_person,
            actor_id: &self.actor_id,
            source_kind: &self.source_kind,
            app_session_id: &self.app_session_id,
            cli_session_id: self.cli_session_id.as_deref(),
            parent_run_id: self.parent_run_id.as_deref(),
            client_id: self.client_id.as_deref(),
            child_job_id: self.child_job_id.as_deref(),
        }
    }
}
fn resolve_inner(
    db: AuthorityDb<'_>,
    proof: Option<&NativeAdmissionProof>,
    history: bool,
) -> Result<AdmittedActionSubject, ActionError> {
    let proof = proof.ok_or_else(denied)?;
    validate_context(db, proof)?;
    let p = &proof.facts;
    let resolved =
        super::native_lineage::resolve_lineage(db, &p.binding(), history).map_err(lineage_error)?;
    let r = resolved.row;
    let can_call = resolved.can_call;
    Ok(AdmittedActionSubject {
        scope: ActionSubjectView {
            vault_id: r.vault_id,
            run_id: r.run_id,
            actor_id: r.actor_id,
            client_id: r.client_id,
            child_job_id: r.child_job_id,
        },
        owner_person: r.owner_person,
        can_call,
    })
}
pub(super) fn resolve(
    db: AuthorityDb<'_>,
    proof: Option<&NativeAdmissionProof>,
) -> Result<AdmittedActionSubject, ActionError> {
    resolve_inner(db, proof, false)
}
// A live native caller may inspect its own natural-completion history; an old
// token/run id cannot mint this capability. Cross-run owner history awaits its
// attended native owner-operation producer, not a grant ownership shortcut.
pub(super) fn resolve_history(
    db: AuthorityDb<'_>,
    proof: Option<&NativeAdmissionProof>,
) -> Result<AdmittedActionSubject, ActionError> {
    resolve_inner(db, proof, true)
}
pub(super) fn record_authenticated(
    db: AuthorityDb<'_>,
    proof: Option<&NativeAdmissionProof>,
) -> Result<AdmittedActionSubject, ActionError> {
    let proof = proof.ok_or_else(denied)?;
    validate_context(db, proof)?;
    let AuthorityDb::Writer(conn) = db else {
        return Err(unavailable());
    };
    if !conn.is_autocommit() {
        return Err(unavailable());
    }
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| unavailable())?;
    super::native_lineage::insert_if_absent(
        &tx,
        &proof.facts.binding(),
        &crate::connections::opaque_id(),
        &crate::runtime::now_utc(),
    )
    .map_err(lineage_error)?;
    let admitted = resolve(AuthorityDb::Writer(&tx), Some(proof))?;
    tx.commit().map_err(|_| unavailable())?;
    Ok(admitted)
}

#[cfg(test)]
pub(in crate::actions) mod fixture {
    use super::*;
    // This test-only door is deliberately not a native authentication claim.
    pub(in crate::actions) struct Door {
        proof: NativeAdmissionProof,
        owner: Arc<AtomicBool>,
        caller: Arc<AtomicBool>,
        generation: Arc<AtomicU64>,
    }
    pub(in crate::actions) struct Facts {
        pub data_dir: PathBuf,
        pub canonical_vault: PathBuf,
        pub vault_id: String,
        pub store_uuid: String,
        pub app_session_id: String,
        pub run_id: String,
        pub actor_id: String,
        pub cli_session_id: Option<String>,
        pub parent_run_id: Option<String>,
        pub client_id: Option<String>,
    }
    impl Door {
        pub(in crate::actions) fn new(f: Facts) -> Self {
            let owner = Arc::new(AtomicBool::new(true));
            let caller = Arc::new(AtomicBool::new(true));
            let generation = Arc::new(AtomicU64::new(1));
            #[cfg(unix)]
            let runtime_identity = {
                use std::os::unix::fs::MetadataExt;
                let metadata =
                    std::fs::metadata(crate::runtime::runtime_db_path(&f.data_dir)).unwrap();
                (metadata.dev(), metadata.ino())
            };
            #[cfg(not(unix))]
            let runtime_identity = (0, 0); // Fixture only; no platform authority is admitted.
            let source_kind = if f.client_id.is_some() {
                "client"
            } else {
                "run"
            }
            .to_string();
            Self {
                proof: NativeAdmissionProof {
                    facts: NativeFacts {
                        data_dir: f.data_dir,
                        runtime_identity,
                        canonical_vault: f.canonical_vault,
                        vault_id: f.vault_id,
                        store_uuid: f.store_uuid,
                        app_session_id: f.app_session_id,
                        generation: 1,
                        run_id: f.run_id,
                        actor_id: f.actor_id,
                        cli_session_id: f.cli_session_id,
                        parent_run_id: f.parent_run_id,
                        client_id: f.client_id,
                        child_job_id: None,
                        source_kind,
                        owner_person: "human:me".into(),
                    },
                    owner_live: Arc::downgrade(&owner),
                    caller_live: Arc::downgrade(&caller),
                    opening_generation: Arc::downgrade(&generation),
                },
                owner,
                caller,
                generation,
            }
        }
        pub(in crate::actions) fn proof(&self) -> NativeAdmissionProof {
            self.proof.clone()
        }
        pub(in crate::actions) fn close_owner(&self) {
            self.owner.store(false, Ordering::SeqCst);
        }
        pub(in crate::actions) fn close_caller(&self) {
            self.caller.store(false, Ordering::SeqCst);
        }
        pub(in crate::actions) fn change_generation(&self) {
            self.generation.store(2, Ordering::SeqCst);
        }
        pub(in crate::actions) fn forged(&self, field: &str) -> NativeAdmissionProof {
            let mut p = self.proof();
            match field {
                "database" => p.facts.runtime_identity = (0, 0),
                "vault" => p.facts.vault_id = "forged".into(),
                "store" => p.facts.store_uuid = "forged".into(),
                "run" => p.facts.run_id = "forged".into(),
                "actor" => p.facts.actor_id = "forged".into(),
                "session" => p.facts.cli_session_id = Some("forged-session".into()),
                "parent" => p.facts.parent_run_id = Some("forged".into()),
                "client" => p.facts.client_id = Some("ffffffffffffffffffffffffffffffff".into()),
                "owner" => p.facts.owner_person = "human:other".into(),
                "job" => p.facts.child_job_id = Some("forged-job".into()),
                _ => panic!("unknown forged field"),
            };
            p
        }
    }
}
