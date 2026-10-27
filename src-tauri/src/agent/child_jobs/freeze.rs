//! Transient local-researcher contract, consumed by the retained-owner freeze.
//! No authority constructor, token, subject, process or body persistence.
use super::{
    limits,
    types::{ChildJobSpec, EvidenceRef},
};
use crate::mcp::RunGrant;
use sha2::{Digest, Sha256};
use std::{
    fs::Metadata,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FreezeRefusal {
    Unavailable,
    InvalidSpec,
    InvalidSource,
    EmptyScope,
    EmptyTools,
    EvidenceUnavailable,
    RequestKeyConflict,
    Deadline,
    #[cfg(feature = "native-read-smoke")]
    UnsupportedMode,
    #[cfg(feature = "native-read-smoke")]
    BackendIsolationUnverified,
}
impl From<crate::runtime::child_jobs::Refusal> for FreezeRefusal {
    fn from(error: crate::runtime::child_jobs::Refusal) -> Self {
        use crate::runtime::child_jobs::Refusal;
        match error {
            Refusal::InvalidSpec => Self::InvalidSpec,
            Refusal::RequestKeyConflict => Self::RequestKeyConflict,
            Refusal::Deadline => Self::Deadline,
            _ => Self::Unavailable,
        }
    }
}
pub(crate) fn now() -> Result<u64, FreezeRefusal> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| FreezeRefusal::Unavailable)
}
fn check_deadline(deadline: u64) -> Result<(), FreezeRefusal> {
    if now()? >= deadline {
        Err(FreezeRefusal::Deadline)
    } else {
        Ok(())
    }
}
fn unavailable<T>(_: T) -> FreezeRefusal {
    FreezeRefusal::EvidenceUnavailable
}

#[derive(Clone, PartialEq, Eq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    size: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl FileIdentity {
    #[cfg(unix)]
    fn read(metadata: &Metadata) -> Result<Self, FreezeRefusal> {
        use std::os::unix::fs::MetadataExt;
        if !metadata.is_file() {
            return Err(FreezeRefusal::EvidenceUnavailable);
        }
        Ok(Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            size: metadata.len(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        })
    }
    #[cfg(not(unix))]
    fn read(_metadata: &Metadata) -> Result<Self, FreezeRefusal> {
        Err(FreezeRefusal::Unavailable)
    }
}
struct EvidenceObservation {
    reference: EvidenceRef,
    landing: PathBuf,
    identity: FileIdentity,
}

pub(crate) struct PreparedFreeze {
    pub instructions: &'static str,
    pub instruction_source_version: String,
    pub policy_digest: String,
    pub read_scope: Vec<String>,
    pub tools: Vec<String>,
    pub evidence: Vec<EvidenceRef>,
    observations: Vec<EvidenceObservation>,
}
fn bounded_axis(values: Option<&[String]>, policy: &limits::Limits) -> Result<(), FreezeRefusal> {
    if let Some(values) = values {
        let mut total = 0usize;
        if values.len() > policy.max_spec_bytes {
            return Err(FreezeRefusal::Unavailable);
        }
        for value in values {
            total = total
                .checked_add(value.len())
                .ok_or(FreezeRefusal::Unavailable)?;
            if value.len() > policy.max_path_bytes
                || total > policy.max_spec_bytes
                || value.chars().any(char::is_control)
                || value.contains('\\')
            {
                return Err(FreezeRefusal::Unavailable);
            }
        }
    }
    Ok(())
}
fn validate_parent_folders(
    values: Option<&[String]>,
    policy: &limits::Limits,
) -> Result<(), FreezeRefusal> {
    bounded_axis(values, policy)?;
    if values.is_some_and(|values| {
        values.iter().any(|value| {
            let folder = value.trim_matches('/');
            folder.is_empty()
                || value.trim() != value
                || value.contains(':')
                || folder
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
        })
    }) {
        return Err(FreezeRefusal::Unavailable);
    }
    Ok(())
}
fn validate_parent_tools(
    values: Option<&[String]>,
    policy: &limits::Limits,
) -> Result<(), FreezeRefusal> {
    bounded_axis(values, policy)?;
    if let Some(values) = values {
        let manifest = crate::policy::tools::manifest();
        for value in values {
            if value.is_empty()
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            {
                return Err(FreezeRefusal::Unavailable);
            }
            // Known unsafe/effect/CLI tools are excluded later. Unknown names
            // never disappear through the intersection, even beside a reader.
            if manifest.tools.iter().any(|row| row.name == *value)
                || crate::policy::tools::cli_tool(value).is_some()
            {
                continue;
            }
            let table = crate::policy::table::PolicyTable::load()
                .map_err(|_| FreezeRefusal::Unavailable)?;
            if crate::policy::tools::generated_op(value, &table).is_none() {
                return Err(FreezeRefusal::Unavailable);
            }
        }
    }
    Ok(())
}
fn intersection(
    parent: &Option<Vec<String>>,
    requested: &[String],
    deadline: u64,
) -> Result<Vec<String>, FreezeRefusal> {
    // Reuse the dispatcher's folder/separator semantics, including a known
    // unrestricted None. An unavailable publication never reaches this function.
    if parent.as_ref().is_some_and(|folders| {
        folders.iter().any(|folder| {
            let folder = folder.trim_matches('/');
            !folder.is_empty()
                && folder
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
        })
    }) {
        return Err(FreezeRefusal::Unavailable);
    }
    let requested_axis = Some(requested.to_vec());
    let mut scope = Vec::new();
    for path in requested {
        check_deadline(deadline)?;
        if crate::mcp::scope_admits(parent, path) {
            scope.push(path.clone());
        }
    }
    if let Some(parent) = parent {
        for folder in parent {
            check_deadline(deadline)?;
            let folder = folder.trim_matches('/');
            if !folder.is_empty() && crate::mcp::scope_admits(&requested_axis, folder) {
                scope.push(folder.to_owned());
            }
        }
    }
    scope.sort();
    scope.dedup();
    // Remove redundant descendants without changing the dispatcher's meaning.
    let mut minimal = Some(Vec::new());
    for folder in scope {
        check_deadline(deadline)?;
        if !crate::mcp::scope_admits(&minimal, &folder) {
            minimal
                .as_mut()
                .ok_or(FreezeRefusal::Unavailable)?
                .push(folder);
        }
    }
    let minimal = minimal.ok_or(FreezeRefusal::Unavailable)?;
    if minimal.is_empty() {
        return Err(FreezeRefusal::EmptyScope);
    }
    Ok(minimal)
}
fn local_readable(scope: &[String], path: &str) -> bool {
    // Parent attended status is deliberately absent: a future child holds no
    // attended conversation or account/connector authority for protected mail.
    !crate::mail::is_mail_path(path) && crate::mcp::scope_admits(&Some(scope.to_vec()), path)
}
fn open_evidence(
    root: &Path,
    scope: &[String],
    path: &str,
) -> Result<crate::files::bytes::OpenedFile, FreezeRefusal> {
    if !local_readable(scope, path) {
        return Err(FreezeRefusal::EvidenceUnavailable);
    }
    // Existing reader rejects hidden spellings/landings and opens each resolved
    // component beneath an anchored root with O_NOFOLLOW. It does not read a body.
    let opened = crate::files::extract::vault_file(root, path).map_err(unavailable)?;
    if opened.root != root {
        return Err(FreezeRefusal::EvidenceUnavailable);
    }
    let landing = opened
        .path
        .strip_prefix(&opened.root)
        .map_err(unavailable)?
        .to_str()
        .ok_or(FreezeRefusal::EvidenceUnavailable)?;
    if !local_readable(scope, landing) {
        return Err(FreezeRefusal::EvidenceUnavailable);
    }
    Ok(opened)
}
fn hash_evidence(
    root: &Path,
    scope: &[String],
    reference: &EvidenceRef,
    deadline: u64,
    policy: &limits::Limits,
    total: &mut u64,
    mut after_chunk: impl FnMut(),
) -> Result<EvidenceObservation, FreezeRefusal> {
    check_deadline(deadline)?;
    let mut opened = open_evidence(root, scope, &reference.path)?;
    let before = FileIdentity::read(&opened.file.metadata().map_err(unavailable)?)?;
    if before.size > policy.max_evidence_file_bytes
        || total
            .checked_add(before.size)
            .is_none_or(|sum| sum > policy.max_evidence_total_bytes)
    {
        return Err(FreezeRefusal::EvidenceUnavailable);
    }
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 8192];
    loop {
        check_deadline(deadline)?;
        let read = opened.file.read(&mut buffer).map_err(unavailable)?;
        if read == 0 {
            break;
        }
        count = count
            .checked_add(read as u64)
            .ok_or(FreezeRefusal::EvidenceUnavailable)?;
        *total = total
            .checked_add(read as u64)
            .ok_or(FreezeRefusal::EvidenceUnavailable)?;
        if count > policy.max_evidence_file_bytes || *total > policy.max_evidence_total_bytes {
            return Err(FreezeRefusal::EvidenceUnavailable);
        }
        hash.update(&buffer[..read]);
        after_chunk();
    }
    let after = FileIdentity::read(&opened.file.metadata().map_err(unavailable)?)?;
    if before != after
        || count != before.size
        || format!("{:x}", hash.finalize()) != reference.sha256
    {
        return Err(FreezeRefusal::EvidenceUnavailable);
    }
    let observation = EvidenceObservation {
        reference: reference.clone(),
        landing: opened.path,
        identity: before,
    };
    recheck_evidence(root, scope, &observation, deadline)?;
    Ok(observation)
}
fn recheck_evidence(
    root: &Path,
    scope: &[String],
    observation: &EvidenceObservation,
    deadline: u64,
) -> Result<(), FreezeRefusal> {
    check_deadline(deadline)?;
    let current = open_evidence(root, scope, &observation.reference.path)?;
    if current.path != observation.landing
        || FileIdentity::read(&current.file.metadata().map_err(unavailable)?)?
            != observation.identity
    {
        return Err(FreezeRefusal::EvidenceUnavailable);
    }
    Ok(())
}
fn tagged(hash: &mut Sha256, tag: &[u8], bytes: &[u8]) {
    hash.update(tag);
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}
fn policy_digest() -> String {
    policy_digest_for_brief(&crate::agent::cli_agents::subagent_brief())
}
fn policy_digest_for_brief(brief: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"CEREBRO-M95-LOCAL-RESEARCHER-POLICY\0v1\0");
    for (tag, bytes) in [
        (b"limits\0".as_slice(), limits::POLICY_JSON),
        (
            b"presets\0".as_slice(),
            crate::policy::subagents::SUBAGENTS_JSON,
        ),
        (b"tools\0".as_slice(), crate::policy::tools::TOOLS_JSON),
        (
            b"mail\0".as_slice(),
            include_str!("../../../../shared/policy/mail.v1.json"),
        ),
        (
            b"files\0".as_slice(),
            include_str!("../../../../shared/files/bytes.v1.json"),
        ),
        (
            b"proposal-policy\0".as_slice(),
            include_str!("../../../../shared/policy/policy.v3.json"),
        ),
        (b"subagent-brief\0".as_slice(), brief),
    ] {
        tagged(&mut hash, tag, bytes.as_bytes());
    }
    format!("{:x}", hash.finalize())
}
impl PreparedFreeze {
    pub(crate) fn prepare(
        root: &Path,
        parent: &RunGrant,
        spec: &ChildJobSpec,
    ) -> Result<Self, FreezeRefusal> {
        spec.validate_intrinsic()
            .map_err(|_| FreezeRefusal::InvalidSpec)?;
        check_deadline(spec.deadline_at)?;
        let policy = limits::load().map_err(|_| FreezeRefusal::Unavailable)?;
        if parent.vault.as_deref() != Some(root) || parent.run_id != spec.parent_run_id {
            return Err(FreezeRefusal::Unavailable);
        }
        validate_parent_folders(parent.scope.as_deref(), &policy)?;
        validate_parent_folders(parent.read_scope.as_deref(), &policy)?;
        validate_parent_tools(parent.tools.as_deref(), &policy)?;
        let preset = crate::policy::subagents::presets()
            .iter()
            .find(|preset| preset.name == "cerebro-researcher")
            .ok_or(FreezeRefusal::InvalidSource)?;
        let instructions = crate::agent::cli_agents::preset_prompt(&preset.name)
            .ok_or(FreezeRefusal::InvalidSource)?;
        if instructions.is_empty()
            || instructions.len() > policy.max_spec_bytes
            || crate::ledger::sha256_hex(instructions.as_bytes()) != spec.instruction_source_version
        {
            return Err(FreezeRefusal::InvalidSource);
        }
        let read_scope = intersection(
            &parent.read_scope,
            &spec.requested_grant.read_scope,
            spec.deadline_at,
        )?;
        let manifest = crate::policy::tools::manifest();
        let mut tools: Vec<String> = manifest
            .tools
            .iter()
            .filter(|row| {
                row.kind == crate::policy::tools::Kind::ReadOnly
                    && manifest.door(&row.door).is_some_and(|door| !door.writes)
                    && row
                        .toolset
                        .as_ref()
                        .is_some_and(|set| preset.toolsets.contains(set))
                    && parent
                        .tools
                        .as_ref()
                        .is_none_or(|held| held.contains(&row.name))
            })
            .map(|row| row.name.clone())
            .collect();
        tools.sort();
        tools.dedup();
        if tools.is_empty() {
            return Err(FreezeRefusal::EmptyTools);
        }
        let mut total = 0;
        let mut observations = Vec::new();
        for reference in &spec.input_evidence_refs {
            observations.push(hash_evidence(
                root,
                &read_scope,
                reference,
                spec.deadline_at,
                &policy,
                &mut total,
                || {},
            )?);
        }
        let prepared = Self {
            instructions,
            instruction_source_version: spec.instruction_source_version.clone(),
            policy_digest: policy_digest(),
            read_scope,
            tools,
            evidence: spec.input_evidence_refs.clone(),
            observations,
        };
        prepared.recheck(root, spec.deadline_at)?;
        Ok(prepared)
    }
    pub(crate) fn recheck(&self, root: &Path, deadline: u64) -> Result<(), FreezeRefusal> {
        check_deadline(deadline)?;
        // The compiled source is immutable within a process. Still compare the
        // actual loader/policy on every replay; no fallback source is admitted.
        let source = crate::agent::cli_agents::preset_prompt("cerebro-researcher")
            .ok_or(FreezeRefusal::InvalidSource)?;
        if source != self.instructions
            || crate::ledger::sha256_hex(source.as_bytes()) != self.instruction_source_version
            || policy_digest() != self.policy_digest
        {
            return Err(FreezeRefusal::InvalidSource);
        }
        for observation in &self.observations {
            recheck_evidence(root, &self.read_scope, observation, deadline)?;
        }
        check_deadline(deadline)
    }
    // The only public digest entry consumes the exact pre-lock MCP observation
    // and the native lineage row verified in the retained owner transaction.
    pub(crate) fn digest(
        &self,
        allocation: &crate::runtime::child_jobs::Allocation,
        parent: &crate::mcp::NativePublicationObservation,
        native: &crate::runtime::native_runs::NativeRun,
    ) -> String {
        self.digest_with_parent(allocation, &parent.binding_digest(native))
    }
    fn digest_with_parent(
        &self,
        allocation: &crate::runtime::child_jobs::Allocation,
        parent_binding: &str,
    ) -> String {
        let mut hash = Sha256::new();
        hash.update(b"CEREBRO-M95-GRANT-FREEZE\0v1\0");
        for (tag, value) in [
            (b"job\0".as_slice(), allocation.job_id.as_str()),
            (b"run\0".as_slice(), allocation.run_id.as_str()),
            (b"session\0".as_slice(), allocation.session_id.as_str()),
            (b"request\0".as_slice(), allocation.request_digest.as_str()),
            (b"parent-observation\0".as_slice(), parent_binding),
            (
                b"source\0".as_slice(),
                self.instruction_source_version.as_str(),
            ),
            (b"policy\0".as_slice(), self.policy_digest.as_str()),
        ] {
            tagged(&mut hash, tag, value.as_bytes());
        }
        hash.update(allocation.deadline_at.to_be_bytes());
        for (tag, values) in [
            (b"scope\0".as_slice(), &self.read_scope),
            (b"tools\0".as_slice(), &self.tools),
        ] {
            hash.update(tag);
            hash.update((values.len() as u64).to_be_bytes());
            for value in values {
                tagged(&mut hash, b"item\0", value.as_bytes());
            }
        }
        hash.update(b"verified-evidence\0");
        hash.update((self.evidence.len() as u64).to_be_bytes());
        for reference in &self.evidence {
            tagged(&mut hash, b"path\0", reference.path.as_bytes());
            tagged(&mut hash, b"sha256\0", reference.sha256.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }
}

#[cfg(test)]
#[path = "freeze_tests.rs"]
mod tests;
