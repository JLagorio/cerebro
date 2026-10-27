//! Explicit debug/macOS action smoke only. Fixed fake metadata/provider, never authority.
//! No SecretValue, SecretStore, Keychain, process or network constructor.
use super::*;
use std::sync::{atomic::AtomicU64, Mutex, Weak};
const LOGIN: &str = "cerebro-action-smoke";
const REPOSITORY: &str = "cerebro-native-smoke/disposable-issue";
const TITLE: &str = "M96 isolated native held action";
const BODY: &str = "Fixed fake effect. No GitHub request was sent.";
struct BindingFixture {
    owner: Weak<NativeOwnerState>,
    seal: Weak<()>,
    native_run: String,
    reference: crate::connections::metadata::SecretRef,
}
#[derive(Default)]
pub(crate) struct Fixture {
    binding: Mutex<Option<BindingFixture>>,
    entries: AtomicU64,
}
pub(crate) fn input() -> String {
    serde_json::json!({"repository":REPOSITORY,"title":TITLE,"body":BODY}).to_string()
}
fn output() -> String {
    serde_json::json!({"issueId":"4242","repository":REPOSITORY,"number":1,"url":"https://github.com/cerebro-native-smoke/disposable-issue/issues/1","title":TITLE,"body":BODY}).to_string()
}
pub(crate) fn output_digest() -> Result<String, ActionError> {
    let definition = crate::actions::compiled_catalog::compiled_catalog()
        .map_err(|_| kernel::unavailable())?
        .definitions()
        .into_iter()
        .find(|definition| definition.action_id.0 == "github.issue.create")
        .ok_or_else(kernel::unavailable)?;
    let output = output();
    let output = schema::validate_output(&definition, &output)?
        .value
        .canonical();
    use sha2::Digest;
    Ok(format!("{:x}", sha2::Sha256::digest(output.as_bytes())))
}
/// The real native window/original publication admits this fixture-only metadata
/// seed. No caller receives an origin, subject, grant, writer or secret capability.
pub(crate) fn seed(app: &AppHandle, window: &WebviewWindow, run: u64) -> Result<(), ActionError> {
    let origin = Origin::capture(app, window, run)?;
    let fixture = app.try_state::<Fixture>().ok_or_else(kernel::unavailable)?;
    // This lock is profile-only and never held across the authority/storage guard.
    if fixture
        .binding
        .lock()
        .map_err(|_| kernel::unavailable())?
        .is_some()
    {
        return unavailable();
    }
    let reference=origin.mutate(app,|conn,_,_|{
  use crate::connections::metadata::{AccountBinding,ConnectionHealth,ConnectionStatus,RemoteRevocation,SecretRef};
  let connection=ConnectionId(crate::ledger::new_id128());let account=AccountId(crate::ledger::new_id128());
  let reference=SecretRef{id:crate::ledger::new_id128(),account_id:account.clone(),issuer:crate::actions::github_issues::account_issuer().into(),subject:"4242424242".into(),secret_revision:1};
  let status=ConnectionStatus{connection_id:connection.clone(),revision:1,login:LOGIN.into(),health:ConnectionHealth::Ready,account:Some(AccountBinding{account_id:account,subject:reference.subject.clone(),issuer:reference.issuer.clone(),account_revision:1,scope_digest:"a".repeat(64)}),secret_revision:1,revocation_generation:0,observed_at:chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),cleanup_pending:false,remote_revocation:RemoteRevocation::NotAttempted};
  let count:i64=conn.query_row("SELECT count(*) FROM managed_connections",[],|row|row.get(0)).map_err(|_|kernel::unavailable())?;
  if count!=0{return unavailable();}
  conn.execute("INSERT INTO managed_connections(connection_id,person,status,secret_ref) VALUES(?1,?2,?3,?4)",rusqlite::params![connection.0,native_rules::admission_rules().owner_storage_key,serde_json::to_string(&status).map_err(|_|kernel::unavailable())?,serde_json::to_string(&reference).map_err(|_|kernel::unavailable())?]).map_err(|_|kernel::unavailable())?;
  Ok(reference)
 })?;
    let Origin::Attended(attended) = &origin else {
        return unavailable();
    };
    let binding = BindingFixture {
        owner: Arc::downgrade(origin.owner()),
        seal: Arc::downgrade(&attended.origin.runtime_seal),
        native_run: origin.native_run().into(),
        reference,
    };
    let mut slot = fixture.binding.lock().map_err(|_| kernel::unavailable())?;
    if slot.is_some() {
        return unavailable();
    }
    *slot = Some(binding);
    Ok(())
}
pub(crate) fn entries(app: &AppHandle) -> Result<u64, ActionError> {
    Ok(app
        .try_state::<Fixture>()
        .ok_or_else(kernel::unavailable)?
        .entries
        .load(Ordering::SeqCst))
}
/// Sole fake dependency, reached only after actual native known-committed Claim,
/// physical action lease and real preflight. This is not a capability producer.
pub(super) fn execute(app: &AppHandle, submission: &Submission) -> kernel::Observation {
    let checked = (|| -> Result<(), ActionError> {
        let fixture = app.try_state::<Fixture>().ok_or_else(kernel::unavailable)?;
        let slot = fixture.binding.lock().map_err(|_| kernel::unavailable())?;
        let binding = slot.as_ref().ok_or_else(kernel::unavailable)?;
        let owner = binding.owner.upgrade().ok_or_else(kernel::unavailable)?;
        let seal = binding.seal.upgrade().ok_or_else(kernel::unavailable)?;
        if !Arc::ptr_eq(&owner, submission.origin.owner())
            || !Arc::ptr_eq(&seal, &submission.runtime_seal)
            || binding.native_run != submission.origin.native_run()
            || binding.reference != submission.data.reference
        {
            return unavailable();
        }
        let plan = &submission.data.plan;
        let definition = crate::actions::compiled_catalog::compiled_catalog()
            .map_err(|_| kernel::unavailable())?
            .definitions()
            .into_iter()
            .find(|definition| definition.action_id.0 == "github.issue.create")
            .ok_or_else(kernel::unavailable)?;
        let expected = crate::actions::github_issues::prepare(&definition, &input())?;
        if plan.target() != expected.target() || plan.preview() != expected.preview() {
            return unavailable();
        }
        if fixture.entries.fetch_add(1, Ordering::SeqCst) != 0 {
            return unavailable();
        }
        Ok(())
    })();
    if checked.is_err() {
        return kernel::Observation::Unknown;
    }
    // The fixed fixture result passes through the real output validation and
    // receipt settlement. This profile never calls a remote provider.
    kernel::Observation::Succeeded {
        output: output(),
        remote_effect_reference: None,
    }
}
